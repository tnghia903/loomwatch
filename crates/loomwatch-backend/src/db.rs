//! The one SQLite file `LoomWatch` keeps its archive in: run events, run records, the Notebook,
//! questions and the team chats.
//!
//! One file in the state folder rather than a database server, so installing `LoomWatch` needs
//! nothing else running. The daemon is the only program that writes it, and it does so through
//! one connection: SQLite allows one writer at a time anyway, and one connection in this process
//! means writers queue here instead of failing as busy. Reads use a few read-only connections of
//! their own, which WAL lets run beside the writer. Run events are written by a batching writer
//! ([`crate::archive`]) on that same connection.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::migrate::{MigrateError, Migrator};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{ConnectOptions, Connection};

use crate::archive::EventWriter;

pub(crate) static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// The file's name in the state folder, unless `--database` or `LOOMWATCH_DATABASE` names another.
pub const FILE_NAME: &str = "loomwatch.db";

/// How long a statement waits for a lock another connection holds, such as a backup reading the
/// file, before it fails.
const BUSY_TIMEOUT: Duration = Duration::from_secs(10);
/// Read-only connections. Enough for the UI's parallel requests and a live view or two.
const READERS: u32 = 4;
/// Page cache per connection, in KiB (SQLite's negative `cache_size`).
const WRITER_CACHE_KIB: i64 = 8 * 1024;
const READER_CACHE_KIB: i64 = 4 * 1024;
/// The WAL file is cut back to this after a checkpoint, so one big write (an import) does not
/// leave it that big for good.
const WAL_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

/// The database, shared by every store. Cheap to clone.
#[derive(Clone)]
pub struct Db {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    reader: SqlitePool,
    writer: SqlitePool,
    events: EventWriter,
    /// A test database's folder, removed with the last clone.
    _scratch: Option<Scratch>,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Db")
            .field("path", &self.inner.path)
            .finish_non_exhaustive()
    }
}

/// `<state_dir>/loomwatch.db`.
#[must_use]
pub fn default_path(state_dir: &Path) -> PathBuf {
    state_dir.join(FILE_NAME)
}

impl Db {
    /// Open the database at `path`, creating it (private to this account) and bringing its
    /// tables up to date.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be created or opened, or when it was written by a
    /// newer `LoomWatch` whose tables this one does not know.
    pub async fn open(path: &Path) -> Result<Self> {
        Self::open_with(path, None).await
    }

    async fn open_with(path: &Path, scratch: Option<Scratch>) -> Result<Self> {
        create_private(path)?;
        let writer = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .test_before_acquire(false)
            .connect_with(writer_options(path))
            .await
            .with_context(|| format!("cannot open the database {}", path.display()))?;
        migrate(&writer, path).await?;
        let reader = SqlitePoolOptions::new()
            .max_connections(READERS)
            .test_before_acquire(false)
            .connect_lazy_with(reader_options(path));
        let events = EventWriter::spawn(writer.clone());
        Ok(Self {
            inner: Arc::new(Inner {
                path: path.to_owned(),
                reader,
                writer,
                events,
                _scratch: scratch,
            }),
        })
    }

    /// A database of its own in a fresh temporary folder, removed when the last clone goes.
    ///
    /// # Panics
    ///
    /// Panics when the temporary folder or the database cannot be made: there is no test to run
    /// without one.
    #[cfg(test)]
    pub async fn temp() -> Self {
        let scratch = Scratch(
            std::env::temp_dir().join(format!("loomwatch-db-{}", uuid::Uuid::new_v4().simple())),
        );
        let path = scratch.0.join(FILE_NAME);
        Self::open_with(&path, Some(scratch))
            .await
            .expect("a test database opens")
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// The read-only connections.
    pub(crate) fn reader(&self) -> &SqlitePool {
        &self.inner.reader
    }

    /// The one connection that writes.
    pub(crate) fn writer(&self) -> &SqlitePool {
        &self.inner.writer
    }

    pub(crate) fn events(&self) -> &EventWriter {
        &self.inner.events
    }

    /// Wait until every run event handed to the writer before this call is written.
    ///
    /// Every read of `run_events` calls this first, so a reader always sees what was appended
    /// before it asked, however the writer batches.
    pub async fn flush_events(&self) {
        self.inner.events.flush().await;
    }
}

/// Settings every connection shares.
fn base_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(BUSY_TIMEOUT)
        .foreign_keys(true)
        .pragma("temp_store", "memory")
        // Chat search: case-insensitive in every alphabet, which `LIKE` is not.
        .with_regexp()
        // Statements are cached per connection and not logged one by one.
        .disable_statement_logging()
}

fn writer_options(path: &Path) -> SqliteConnectOptions {
    base_options(path)
        .create_if_missing(true)
        // Readers never wait for the writer, and a commit appends to the log instead of
        // rewriting pages.
        .journal_mode(SqliteJournalMode::Wal)
        // In WAL mode a commit is durable once the log is synced at checkpoint: an app crash
        // loses nothing, a power cut can lose the last commits but never corrupts the file.
        .synchronous(SqliteSynchronous::Normal)
        .pragma("cache_size", (-WRITER_CACHE_KIB).to_string())
        .pragma("journal_size_limit", WAL_LIMIT_BYTES.to_string())
        .optimize_on_close(true, None)
}

fn reader_options(path: &Path) -> SqliteConnectOptions {
    base_options(path)
        .read_only(true)
        .pragma("cache_size", (-READER_CACHE_KIB).to_string())
}

async fn migrate(pool: &SqlitePool, path: &Path) -> Result<()> {
    match MIGRATOR.run(pool).await {
        Ok(()) => Ok(()),
        Err(MigrateError::VersionMissing(version)) => Err(anyhow::anyhow!(
            "the database {} was set up by a newer LoomWatch (layout {version}), which this one \
             cannot read. Run the newer LoomWatch, or restore a backup made before it.",
            path.display()
        )),
        Err(error) => Err(anyhow::Error::new(error)
            .context(format!("cannot set up the database {}", path.display()))),
    }
}

/// Make the file's folder, and the file itself, readable by this account only, before SQLite
/// opens it. SQLite gives its `-wal` and `-shm` files the database file's permissions.
fn create_private(path: &Path) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        let mut folder = std::fs::DirBuilder::new();
        folder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut folder, 0o700);
        folder
            .create(parent)
            .with_context(|| format!("cannot create the folder {}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut file, 0o600);
    match file.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("cannot create the database {}", path.display()))
        }
    }
}

/// Write a consistent copy of the database at `source` to `dest`, which must not exist yet.
///
/// Safe while `LoomWatch` runs: the copy is one read transaction (`VACUUM INTO`), so it is the
/// database as it stood at one moment, compacted, and never a half-written state.
///
/// # Errors
///
/// Returns an error when there is no database at `source`, `dest` already exists, or the copy
/// cannot be written.
pub async fn backup(source: &Path, dest: &Path) -> Result<()> {
    anyhow::ensure!(
        source.is_file(),
        "there is no database at {}",
        source.display()
    );
    anyhow::ensure!(
        !dest.exists(),
        "{} already exists; name a new file for the copy",
        dest.display()
    );
    let target = dest
        .to_str()
        .with_context(|| format!("{} is not a name SQLite can write to", dest.display()))?;
    let mut connection = base_options(source)
        .read_only(true)
        .connect()
        .await
        .with_context(|| format!("cannot open the database {}", source.display()))?;
    sqlx::query("VACUUM INTO ?")
        .bind(target)
        .execute(&mut connection)
        .await
        .with_context(|| format!("cannot write the copy {}", dest.display()))?;
    connection.close().await.ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("cannot make {} private", dest.display()))?;
    }
    Ok(())
}

/// The newest table layout (migration version) the database at `path` was brought up to, or
/// `None` when there is no database there yet. Read without changing anything.
///
/// # Errors
///
/// Returns an error when the file exists but cannot be read as a database.
pub async fn layout(path: &Path) -> Result<Option<i64>> {
    if !path.is_file() {
        return Ok(None);
    }
    let mut connection = base_options(path)
        .read_only(true)
        .connect()
        .await
        .with_context(|| format!("cannot open the database {}", path.display()))?;
    let set_up: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master
                        WHERE type = 'table' AND name = '_sqlx_migrations')",
    )
    .fetch_one(&mut connection)
    .await?;
    let version = if set_up {
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success")
            .fetch_one(&mut connection)
            .await?
    } else {
        None
    };
    connection.close().await.ok();
    Ok(version)
}

/// Whether a write failed on a UNIQUE or PRIMARY KEY constraint.
pub(crate) fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
}

/// A list bound as one parameter, for `IN (SELECT value FROM json_each(?))`.
pub(crate) fn json_list(items: &[String]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_owned())
}

/// A test database's folder, removed when dropped.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_new_database_is_private_and_in_wal_mode() -> Result<()> {
        let db = Db::temp().await;
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(db.writer())
            .await?;
        assert_eq!(mode, "wal");
        let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
            .fetch_one(db.writer())
            .await?;
        assert_eq!(synchronous, 1, "NORMAL");
        let keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(db.reader())
            .await?;
        assert_eq!(keys, 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(db.path())?.permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let refused = sqlx::query("DELETE FROM runs")
            .execute(db.reader())
            .await
            .expect_err("reads cannot write");
        assert!(refused.to_string().contains("readonly"), "{refused}");
        Ok(())
    }

    #[tokio::test]
    async fn a_backup_is_a_consistent_private_copy_and_layout_reads_without_writing() -> Result<()>
    {
        let db = Db::temp().await;
        sqlx::query(
            "INSERT INTO chat_messages (id, team_key, team_path, text, created_at, route)
             VALUES ('m', 'k', 'p.yaml', 'hello', '2026-10-17T00:00:00Z', 'team_note')",
        )
        .execute(db.writer())
        .await?;
        let copy = db.path().with_file_name("copy.db");
        backup(db.path(), &copy).await?;
        assert!(
            backup(db.path(), &copy).await.is_err(),
            "never overwrites a file"
        );
        let copied = Db::open(&copy).await?;
        let text: String = sqlx::query_scalar("SELECT text FROM chat_messages")
            .fetch_one(copied.reader())
            .await?;
        assert_eq!(text, "hello");
        let newest = MIGRATOR.iter().map(|migration| migration.version).max();
        assert_eq!(layout(&copy).await?, newest);
        assert_eq!(layout(&copy.with_file_name("missing.db")).await?, None);
        assert!(!copy.with_file_name("missing.db").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(&copy)?.permissions().mode() & 0o777,
                0o600
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_database_from_a_newer_loomwatch_is_refused_plainly() -> Result<()> {
        let db = Db::temp().await;
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (99999999999999, 'from the future', 1, x'00', 0)",
        )
        .execute(db.writer())
        .await?;
        let error = Db::open(db.path()).await.expect_err("refused");
        assert!(
            format!("{error:#}").contains("set up by a newer LoomWatch"),
            "{error:#}"
        );
        Ok(())
    }
}
