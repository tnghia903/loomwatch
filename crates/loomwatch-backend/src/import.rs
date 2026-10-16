//! `loomwatchd import-postgres`: bring the run history an earlier `LoomWatch` kept in PostgreSQL
//! into the SQLite file.
//!
//! Every table is copied as it is, row for row: the same ids, the same timestamps, the same JSON.
//! Two things change on the way, both lossless: JSON text is stored compact, and each event's raw
//! frame is stored in the archive's own encoding (`archive/codec.rs`). The session list's summary
//! fills itself as events go in (the `run_events_summarise` trigger).
//!
//! It is safe to run again, and safe on a file that already holds history: a row whose id is
//! already in the file is skipped, never overwritten, and the report counts it. Everything goes in
//! one transaction, so an import that fails leaves the file as it was. PostgreSQL is only read.
//!
//! The source may be any version of the old archive: a table or column an older version did not
//! have yet is simply not copied, and gets the default the new table gives it.

use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::Value;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Connection as _, Row as _};

use crate::archive::codec;
use crate::db::Db;

/// The tables of the old archive and the key each is read in order of.
const TABLES: [(&str, &str); 8] = [
    ("run_events", "id"),
    ("runs", "run_id"),
    ("context_packets", "id"),
    ("memory_notes", "id"),
    ("memory_audit", "id"),
    ("checkpoints", "id"),
    ("operator_questions", "id"),
    ("chat_messages", "id"),
];

/// Rows read from PostgreSQL at a time. Events can be megabytes each.
const PAGE: i64 = 200;

/// What one import did.
#[derive(Debug)]
pub struct ImportReport {
    /// The PostgreSQL database, without its password.
    pub source: String,
    pub database: PathBuf,
    pub tables: Vec<TableReport>,
    /// The file held run history before the import.
    pub had_history: bool,
}

#[derive(Debug)]
pub struct TableReport {
    pub table: &'static str,
    /// `None` when the source has no such table (it predates it).
    pub copied: Option<u64>,
    pub skipped: u64,
}

impl ImportReport {
    #[must_use]
    pub fn copied(&self) -> u64 {
        self.tables.iter().filter_map(|table| table.copied).sum()
    }

    #[must_use]
    pub fn skipped(&self) -> u64 {
        self.tables.iter().map(|table| table.skipped).sum()
    }
}

impl fmt::Display for ImportReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            formatter,
            "Imported the run history from {} into {}.",
            self.source,
            self.database.display()
        )?;
        for table in &self.tables {
            match table.copied {
                Some(copied) => writeln!(
                    formatter,
                    "  {:<20} {copied:>8} copied{}",
                    table.table,
                    if table.skipped > 0 {
                        format!(", {} already here", table.skipped)
                    } else {
                        String::new()
                    }
                )?,
                None => writeln!(
                    formatter,
                    "  {:<20}        - not in that database (an older LoomWatch)",
                    table.table
                )?,
            }
        }
        if self.skipped() > 0 {
            write!(
                formatter,
                "{} rows were already in the file and were left as they are.",
                self.skipped()
            )?;
        } else if self.had_history {
            write!(
                formatter,
                "The file already held run history; the imported rows were added beside it."
            )?;
        } else {
            write!(formatter, "Nothing was changed in PostgreSQL.")?;
        }
        Ok(())
    }
}

/// Copy every table of the PostgreSQL archive at `url` into the database file at `database`.
///
/// # Errors
///
/// Returns an error, having changed nothing, when PostgreSQL cannot be reached or holds no
/// `LoomWatch` history, when the file cannot be opened, or when any row cannot be copied.
pub async fn import_postgres(url: &str, database: &Path) -> Result<ImportReport> {
    let source = redacted(url);
    let postgres = PgPoolOptions::new()
        .max_connections(1)
        .connect(url)
        .await
        .with_context(|| format!("cannot reach PostgreSQL at {source}"))?;
    let has_archive: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = current_schema() AND table_name = 'run_events')",
    )
    .fetch_one(&postgres)
    .await
    .with_context(|| format!("cannot read PostgreSQL at {source}"))?;
    if !has_archive {
        bail!("the PostgreSQL database at {source} holds no LoomWatch run history");
    }
    let db = Db::open(database).await?;
    let mut connection = db.writer().acquire().await?;
    let had_history = holds_history(&mut connection).await?;
    // Rows go in in key order, not in the order the Notebook's revisions refer to each other, so
    // the reference from a revision to the one it supersedes is checked once at the end instead.
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await?;
    let copied = copy_all(&postgres, &mut connection, &source).await;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await?;
    let tables = copied?;
    drop(connection);
    postgres.close().await;
    // The import wrote the whole history through the write-ahead log; fold it into the file now.
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(db.writer())
        .await?;
    sqlx::query("PRAGMA optimize").execute(db.writer()).await?;
    Ok(ImportReport {
        source,
        database: database.to_owned(),
        tables,
        had_history,
    })
}

async fn copy_all(
    postgres: &PgPool,
    connection: &mut sqlx::SqliteConnection,
    source: &str,
) -> Result<Vec<TableReport>> {
    let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
    let mut tables = Vec::new();
    for (table, key) in TABLES {
        let report = copy_table(postgres, &mut transaction, table, key)
            .await
            .with_context(|| format!("cannot copy the table {table}"))?;
        tables.push(report);
    }
    let dangling: i64 = sqlx::query_scalar("SELECT count(*) FROM pragma_foreign_key_check")
        .fetch_one(&mut *transaction)
        .await?;
    if dangling > 0 {
        bail!(
            "{dangling} Notebook revisions would point at revisions the file does not hold, so \
             nothing was imported. Import into a new file instead (move this one aside first)."
        );
    }
    let copied: u64 = tables.iter().filter_map(|table| table.copied).sum();
    let skipped: u64 = tables.iter().map(|table| table.skipped).sum();
    sqlx::query(
        "INSERT INTO imports (id, source, imported_at, rows_copied, rows_skipped)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(source)
    .bind(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .bind(i64::try_from(copied).unwrap_or(i64::MAX))
    .bind(i64::try_from(skipped).unwrap_or(i64::MAX))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(tables)
}

/// How a column is read from PostgreSQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Integer,
    Boolean,
    Json,
    Text,
}

/// One value on its way from PostgreSQL to SQLite.
enum Cell {
    Null,
    Integer(i64),
    Boolean(bool),
    Text(String),
    Blob(Vec<u8>),
}

async fn copy_table(
    postgres: &PgPool,
    sqlite: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &'static str,
    key: &str,
) -> Result<TableReport> {
    let source_columns: Vec<(String, String)> = sqlx::query_as(
        "SELECT column_name::text, data_type::text FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1
         ORDER BY ordinal_position",
    )
    .bind(table)
    .fetch_all(postgres)
    .await?;
    if source_columns.is_empty() {
        return Ok(TableReport {
            table,
            copied: None,
            skipped: 0,
        });
    }
    let target_columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info($1)")
        .bind(table)
        .fetch_all(&mut **sqlite)
        .await?;
    // The columns both have. The old full-text column (`search`) has no counterpart: the new
    // index fills itself from title and body.
    let columns = source_columns
        .iter()
        .filter(|(name, _)| target_columns.contains(name))
        .map(|(name, data_type)| {
            let kind = match data_type.as_str() {
                "bigint" | "integer" | "smallint" => Kind::Integer,
                "boolean" => Kind::Boolean,
                "json" | "jsonb" => Kind::Json,
                _ => Kind::Text,
            };
            (name.clone(), kind)
        })
        .collect::<Vec<_>>();
    if !columns.iter().any(|(name, _)| name == key) {
        bail!("the table has no {key} column");
    }
    let select = columns
        .iter()
        .map(|(name, kind)| match kind {
            Kind::Integer => format!("\"{name}\"::bigint AS \"{name}\""),
            Kind::Boolean => format!("\"{name}\""),
            Kind::Json | Kind::Text => format!("\"{name}\"::text AS \"{name}\""),
        })
        .collect::<Vec<_>>()
        .join(", ");
    // Pages follow the primary key's own index and collation, so each page is an index range.
    let read = format!(
        "SELECT {select} FROM \"{table}\" WHERE \"{key}\" > $1 ORDER BY \"{key}\" LIMIT {PAGE}"
    );
    let insert = format!(
        "INSERT INTO {table} ({}) VALUES ({}) ON CONFLICT DO NOTHING",
        columns
            .iter()
            .map(|(name, _)| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", "),
        (1..=columns.len())
            .map(|index| format!("${index}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut after = String::new();
    let mut copied = 0u64;
    let mut skipped = 0u64;
    loop {
        let rows = sqlx::query(&read).bind(&after).fetch_all(postgres).await?;
        let Some(last) = rows.last() else {
            break;
        };
        after = last.try_get(key)?;
        for row in &rows {
            let cells = read_row(table, row, &columns)?;
            let mut query = sqlx::query(&insert);
            for cell in cells {
                query = match cell {
                    Cell::Null => query.bind(None::<String>),
                    Cell::Integer(value) => query.bind(value),
                    Cell::Boolean(value) => query.bind(value),
                    Cell::Text(value) => query.bind(value),
                    Cell::Blob(value) => query.bind(value),
                };
            }
            if query.execute(&mut **sqlite).await?.rows_affected() == 1 {
                copied += 1;
            } else {
                skipped += 1;
            }
        }
        if i64::try_from(rows.len()).unwrap_or(PAGE) < PAGE {
            break;
        }
    }
    Ok(TableReport {
        table,
        copied: Some(copied),
        skipped,
    })
}

fn read_row(table: &str, row: &PgRow, columns: &[(String, Kind)]) -> Result<Vec<Cell>> {
    let mut cells = Vec::with_capacity(columns.len());
    let mut payload = None;
    for (name, kind) in columns {
        let cell = match kind {
            Kind::Integer => row
                .try_get::<Option<i64>, _>(name.as_str())?
                .map_or(Cell::Null, Cell::Integer),
            Kind::Boolean => row
                .try_get::<Option<bool>, _>(name.as_str())?
                .map_or(Cell::Null, Cell::Boolean),
            Kind::Text => row
                .try_get::<Option<String>, _>(name.as_str())?
                .map_or(Cell::Null, Cell::Text),
            Kind::Json => match row.try_get::<Option<String>, _>(name.as_str())? {
                None => Cell::Null,
                Some(text) => {
                    let value: Value = serde_json::from_str(&text)
                        .with_context(|| format!("{name} is not valid JSON"))?;
                    if table == "run_events" && name == "payload" {
                        payload = Some(value.clone());
                    }
                    if table == "run_events" && name == "raw" {
                        // `payload` comes first in every version of the table.
                        let payload = payload
                            .as_ref()
                            .context("an event's raw frame came before its payload")?;
                        Cell::Blob(codec::encode(payload, &value)?)
                    } else {
                        Cell::Text(serde_json::to_string(&value)?)
                    }
                }
            },
        };
        cells.push(cell);
    }
    Ok(cells)
}

/// Whether the file already holds any of the history an import brings.
async fn holds_history(connection: &mut sqlx::SqliteConnection) -> Result<bool> {
    for (table, _) in TABLES {
        let any: bool = sqlx::query_scalar(&format!("SELECT EXISTS (SELECT 1 FROM {table})"))
            .fetch_one(&mut *connection)
            .await?;
        if any {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The URL without its password, to name the source in messages and in the `imports` record.
fn redacted(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            if parsed.password().is_some() {
                let _ = parsed.set_password(None);
            }
            parsed.to_string()
        }
        Err(_) => "the given PostgreSQL database".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_source_is_named_without_its_password() {
        assert_eq!(
            redacted("postgres://loomwatch:s3cret@127.0.0.1:5435/loomwatch"),
            "postgres://loomwatch@127.0.0.1:5435/loomwatch"
        );
        assert_eq!(redacted("not a url"), "the given PostgreSQL database");
    }
}
