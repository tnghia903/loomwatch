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
use sqlx::postgres::PgRow;
#[cfg(test)]
use sqlx::postgres::{PgPool, PgPoolOptions};
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
    let mut postgres = sqlx::PgConnection::connect(url)
        .await
        .with_context(|| format!("cannot reach PostgreSQL at {source}"))?;
    let has_archive: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = current_schema() AND table_name = 'run_events')",
    )
    .fetch_one(&mut postgres)
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
    let copied = copy_all(&mut postgres, &mut connection, &source).await;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await?;
    let tables = copied?;
    drop(connection);
    postgres.close().await.ok();
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
    postgres: &mut sqlx::PgConnection,
    connection: &mut sqlx::SqliteConnection,
    source: &str,
) -> Result<Vec<TableReport>> {
    let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
    let mut tables = Vec::new();
    for (table, key) in TABLES {
        let report = copy_table(&mut *postgres, &mut transaction, table, key)
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
    postgres: &mut sqlx::PgConnection,
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
    .fetch_all(&mut *postgres)
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
        let rows = sqlx::query(&read)
            .bind(&after)
            .fetch_all(&mut *postgres)
            .await?;
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
    use serde_json::json;

    use super::*;
    use crate::archive::EventArchive;

    /// The PostgreSQL archive's migrations, in order: the source schema the import reads.
    const POSTGRES_SCHEMA: [&str; 8] = [
        include_str!("../../../migrations/postgres/20260906000000_create_run_events.sql"),
        include_str!("../../../migrations/postgres/20260913000000_create_context_packets.sql"),
        include_str!("../../../migrations/postgres/20260913120000_create_memory_notes.sql"),
        include_str!("../../../migrations/postgres/20260913140000_create_runs.sql"),
        include_str!("../../../migrations/postgres/20260913160000_checkpoint_provenance.sql"),
        include_str!("../../../migrations/postgres/20260913180000_create_operator_questions.sql"),
        include_str!("../../../migrations/postgres/20261006000000_team_chat.sql"),
        include_str!("../../../migrations/postgres/20261016000000_run_team_revision.sql"),
    ];

    /// The session listing as the PostgreSQL archive computed it, over every event, every time.
    /// The summary table must agree with it row for row.
    const POSTGRES_LISTING: &str = "
        SELECT summary.session_id, summary.started_at, summary.updated_at,
               summary.event_count, summary.agent_count,
               first_event.agent_id AS first_agent_id, prompt_event.prompt, task_event.task
        FROM (
            SELECT session_id, MIN(ts) AS started_at, MAX(ts) AS updated_at,
                   COUNT(*) AS event_count, COUNT(DISTINCT agent_id) AS agent_count
            FROM run_events GROUP BY session_id
        ) AS summary
        LEFT JOIN LATERAL (
            SELECT agent_id FROM run_events AS e WHERE e.session_id = summary.session_id
            ORDER BY e.seq ASC LIMIT 1
        ) AS first_event ON TRUE
        LEFT JOIN LATERAL (
            SELECT COALESCE(e.payload #>> '{content,text}',
                            CASE WHEN jsonb_typeof(e.payload -> 'content') = 'string'
                                 THEN e.payload ->> 'content' END) AS prompt
            FROM run_events AS e
            WHERE e.session_id = summary.session_id AND e.kind = 'message'
              AND e.payload ->> 'role' = 'user'
            ORDER BY e.seq ASC LIMIT 1
        ) AS prompt_event ON TRUE
        LEFT JOIN LATERAL (
            SELECT (SELECT section ->> 'text' FROM jsonb_array_elements(e.payload -> 'sections')
                    AS section WHERE section ->> 'kind' = 'task' LIMIT 1) AS task
            FROM run_events AS e
            WHERE e.session_id = summary.session_id AND e.kind = 'session_meta'
              AND e.payload ->> 'phase' = 'prompt_sections'
            ORDER BY e.seq ASC LIMIT 1
        ) AS task_event ON TRUE
        ORDER BY summary.updated_at DESC, summary.session_id";

    /// A scratch database on the server `LOOMWATCH_TEST_POSTGRES_URL` names, dropped afterwards.
    struct Scratch {
        server: PgPool,
        name: String,
        url: String,
    }

    impl Scratch {
        async fn create(server_url: &str) -> Result<(Self, PgPool)> {
            let server = PgPoolOptions::new()
                .max_connections(1)
                .connect(server_url)
                .await?;
            let name = format!("lw_import_test_{}", uuid::Uuid::new_v4().simple());
            sqlx::query(&format!("CREATE DATABASE {name}"))
                .execute(&server)
                .await?;
            let mut url = url::Url::parse(server_url)?;
            url.set_path(&name);
            let pool = PgPoolOptions::new()
                .max_connections(2)
                .connect(url.as_str())
                .await?;
            Ok((
                Self {
                    server,
                    name,
                    url: url.to_string(),
                },
                pool,
            ))
        }

        async fn drop(self, pool: PgPool) -> Result<()> {
            pool.close().await;
            sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
                .execute(&self.server)
                .await?;
            Ok(())
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn event(
        pool: &PgPool,
        id: &str,
        session: &str,
        agent: &str,
        seq: i64,
        kind: &str,
        payload: &Value,
        raw: Option<&Value>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO run_events (id, session_id, agent_id, seq, ts, kind, payload, raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(id)
        .bind(session)
        .bind(agent)
        .bind(seq)
        .bind(format!("2026-10-0{}T10:00:{seq:02}.123456Z", seq % 3 + 1))
        .bind(kind)
        .bind(payload)
        .bind(raw)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Fill every table of the old archive the way the daemon wrote them.
    #[allow(clippy::too_many_lines)]
    async fn fill(pool: &PgPool) -> Result<()> {
        let output = "line of output\n".repeat(400);
        let content = json!([{"type": "content", "content": {"type": "text", "text": output}}]);
        let update = json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "c1", "kind": "execute",
            "status": "completed", "rawOutput": output, "content": content,
            "_meta": {"claudeCode": {"toolResponse": {"stdout": output, "stderr": ""}}}
        });
        let tool = json!({"callId": "c1", "toolKind": "execute", "status": "completed",
                          "rawOutput": output, "content": content});
        let frame = |update: &Value| {
            json!({"jsonrpc": "2.0", "method": "session/update",
                   "params": {"sessionId": "acp", "update": update}})
        };
        let sections = json!({"phase": "prompt_sections", "sections": [
            {"kind": "role", "text": "You build."}, {"kind": "task", "text": "ship it"}]});
        event(
            pool,
            "a0",
            "run-a",
            "lead",
            0,
            "session_meta",
            &sections,
            None,
        )
        .await?;
        let prompt = json!({"role": "user", "content": {"type": "text", "text": "ship it"}});
        event(pool, "a1", "run-a", "lead", 1, "message", &prompt, None).await?;
        let chunk = json!({"sessionUpdate": "agent_message_chunk",
                           "content": {"type": "text", "text": "Đã xong"}, "messageId": "m1"});
        let said = json!({"role": "agent", "content": {"type": "text", "text": "Đã xong"},
                          "messageId": "m1"});
        event(
            pool,
            "a2",
            "run-a",
            "helper",
            2,
            "message",
            &said,
            Some(&frame(&chunk)),
        )
        .await?;
        event(
            pool,
            "a3",
            "run-a",
            "helper",
            3,
            "tool_update",
            &tool,
            Some(&frame(&update)),
        )
        .await?;
        // JSON null and no frame at all are different things, and both must survive.
        event(
            pool,
            "a4",
            "run-a",
            "lead",
            4,
            "turn_end",
            &json!({"stopReason": "end_turn"}),
            Some(&Value::Null),
        )
        .await?;
        let answer = json!({"role": "user", "content": {"type": "text", "text": "yes, go"}});
        let answered = json!({"source": "loomwatch", "phase": "operator_answer", "sendBack": "b"});
        event(
            pool,
            "a5",
            "run-a",
            "operator",
            5,
            "message",
            &answer,
            Some(&answered),
        )
        .await?;
        event(
            pool,
            "b0",
            "run-b",
            "solo",
            0,
            "message",
            &json!({"role": "user", "content": "plain prompt"}),
            None,
        )
        .await?;
        sqlx::raw_sql(
            r#"
            INSERT INTO runs (run_id, session_id, team_path, prompt, status, mode, entrypoint,
                              responder, agent_ids, created_at, trigger, waiting_on, team_key, only_agent)
            VALUES ('run-a', 'run-a', 't.yaml', 'ship it', 'succeeded', 'team', 'lead', 'lead',
                    '["lead","helper"]', '2026-10-01T10:00:00Z', 'manual', NULL, 'team', NULL),
                   ('run-b', 'run-b', 't.yaml', 'plain prompt', 'failed', 'pipeline', 'solo', 'solo',
                    '[]', '2026-10-02T10:00:00Z', 'schedule', '{"node": "x"}', NULL, 'solo');
            INSERT INTO context_packets VALUES
                ('p1', 'run-a', 'helper', 0, '2026-10-01T10:00:01Z', 'packet',
                 '[{"kind":"brief","label":"b","rationale":"pinned","chars":6}]', 100, 6);
            INSERT INTO memory_notes (id, note_key, team_id, run_id, author_agent_id, kind, title,
                                      body, sources, state, revision, supersedes, revised_by,
                                      idempotency_key, created_at) VALUES
                ('n1', 'n1', 'team', 'run-a', 'lead', 'decision', 'Use SQLite', 'one file',
                 '["adr"]', 'active', 1, NULL, 'lead', 'k1', '2026-10-01T10:00:02Z'),
                ('n2', 'n1', 'team', NULL, 'lead', 'decision', 'Use SQLite', 'one file',
                 '["adr"]', 'kept', 2, 'n1', 'operator', NULL, '2026-10-01T10:00:03Z');
            INSERT INTO memory_audit VALUES
                ('au1', '2026-10-01T10:00:03Z', 'team', 'n2', 'keep', 'operator', NULL, '{"from": 1}');
            INSERT INTO checkpoints (id, run_id, agent_id, invocation, done, next, blockers,
                                     artifacts, seq_high_water, ts, source, team_revision) VALUES
                ('c1', 'run-a', 'lead', 0, 'built', 'ship', NULL,
                 '[{"path": "a.txt", "sha256": "00"}]', 4, '2026-10-01T10:00:04Z', 'coordinator',
                 'sha256:ab');
            INSERT INTO operator_questions VALUES
                ('q1', 'run-a', 'operator', 'Ship?', NULL, '2026-10-01T10:00:04Z',
                 '2026-10-01T10:00:05Z', 'a5');
            INSERT INTO chat_messages VALUES
                ('m1', 'team', 't.yaml', 'ship it', '2026-10-01T09:59:59Z', 'team', 'run-a', NULL,
                 NULL, TRUE);
            "#,
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// The import contract, against a real PostgreSQL: every row of every table arrives, events
    /// read back exactly as PostgreSQL held them, the session list agrees with the old query,
    /// and a second import changes nothing.
    #[tokio::test]
    #[ignore = "needs PostgreSQL: set LOOMWATCH_TEST_POSTGRES_URL to a server it may create a database on"]
    async fn every_table_arrives_whole_and_a_second_import_changes_nothing() -> Result<()> {
        let server_url = std::env::var("LOOMWATCH_TEST_POSTGRES_URL")
            .context("set LOOMWATCH_TEST_POSTGRES_URL")?;
        let (scratch, pool) = Scratch::create(&server_url).await?;
        let outcome = async {
            for sql in POSTGRES_SCHEMA {
                sqlx::raw_sql(sql).execute(&pool).await?;
            }
            fill(&pool).await?;
            let db = Db::temp().await;
            let report = import_postgres(&scratch.url, db.path()).await?;
            assert_eq!(report.copied(), 16, "{report}");
            assert_eq!(report.skipped(), 0);
            assert!(!report.had_history);
            if let Some(password) = url::Url::parse(&scratch.url)?.password() {
                assert!(
                    !format!("{report:?}").contains(password),
                    "the password is never shown"
                );
            }

            // Events: exactly what PostgreSQL held, frame for frame.
            let archive = EventArchive::new(Db::open(db.path()).await?);
            for session in ["run-a", "run-b"] {
                let rows = sqlx::query(
                    "SELECT id, payload, raw FROM run_events WHERE session_id = $1 ORDER BY seq",
                )
                .bind(session)
                .fetch_all(&pool)
                .await?;
                let events = archive.verify_session(session).await?;
                assert_eq!(events.len(), rows.len());
                for (event, row) in events.iter().zip(&rows) {
                    assert_eq!(event.id, row.try_get::<String, _>("id")?);
                    assert_eq!(event.payload, row.try_get::<Value, _>("payload")?);
                    assert_eq!(event.raw, row.try_get::<Option<Value>, _>("raw")?);
                }
            }
            let null_frame = archive.load_session("run-a").await?;
            assert_eq!(null_frame[4].raw, Some(Value::Null));
            assert_eq!(null_frame[0].raw, None);

            // The session list, from the summary the import filled, as the old query had it.
            let listed = archive.list_sessions().await?;
            let expected = sqlx::query(POSTGRES_LISTING).fetch_all(&pool).await?;
            assert_eq!(listed.len(), expected.len());
            for (session, row) in listed.iter().zip(&expected) {
                assert_eq!(session.session_id, row.try_get::<String, _>("session_id")?);
                assert_eq!(session.started_at, row.try_get::<String, _>("started_at")?);
                assert_eq!(session.updated_at, row.try_get::<String, _>("updated_at")?);
                assert_eq!(session.event_count, row.try_get::<i64, _>("event_count")?);
                assert_eq!(session.agent_count, row.try_get::<i64, _>("agent_count")?);
                assert_eq!(
                    session.first_agent_id,
                    row.try_get::<Option<String>, _>("first_agent_id")?
                );
                assert_eq!(session.prompt, row.try_get::<Option<String>, _>("prompt")?);
                assert_eq!(session.task, row.try_get::<Option<String>, _>("task")?);
            }

            // The rest, through the stores that read them.
            let runs = archive.run_store().recent().await?;
            assert_eq!(runs.len(), 2);
            assert_eq!(runs[1].record.waiting_on, Some(json!({"node": "x"})));
            assert_eq!(runs[0].record.agent_ids, ["lead", "helper"]);
            let notebook = archive.notebook();
            let notes = notebook
                .search(
                    &crate::memory::NoteScope::new("team", None),
                    "sqlite",
                    None,
                    10,
                )
                .await
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            assert_eq!(
                notes
                    .iter()
                    .map(|note| note.id.as_str())
                    .collect::<Vec<_>>(),
                ["n2"],
                "the kept head revision, found by the new full-text index"
            );
            let checkpoint = notebook
                .checkpoint("c1")
                .await
                .map_err(|error| anyhow::anyhow!("{error}"))?
                .context("the checkpoint arrived")?;
            assert_eq!(checkpoint.team_revision.as_deref(), Some("sha256:ab"));
            assert_eq!(archive.context_packets("run-a", None).await?.len(), 1);
            let questions = archive
                .questions()
                .list("run-a")
                .await
                .map_err(|error| anyhow::anyhow!("{error:?}"))?;
            assert_eq!(questions[0].answer_event_id.as_deref(), Some("a5"));

            // Again: nothing new, nothing overwritten, and it says so.
            let again = import_postgres(&scratch.url, db.path()).await?;
            assert_eq!(again.copied(), 0);
            assert_eq!(again.skipped(), 16);
            assert!(again.had_history);
            assert!(format!("{again}").contains("16 rows were already in the file"));
            assert_eq!(archive.list_sessions().await?[0].event_count, 6);
            Ok::<(), anyhow::Error>(())
        }
        .await;
        scratch.drop(pool).await?;
        outcome
    }

    /// A database an older `LoomWatch` left, before the team chat existed: the tables and columns
    /// it has are copied, and the rest get their defaults.
    #[tokio::test]
    #[ignore = "needs PostgreSQL: set LOOMWATCH_TEST_POSTGRES_URL to a server it may create a database on"]
    async fn an_older_archive_without_the_newer_tables_imports() -> Result<()> {
        let server_url = std::env::var("LOOMWATCH_TEST_POSTGRES_URL")
            .context("set LOOMWATCH_TEST_POSTGRES_URL")?;
        let (scratch, pool) = Scratch::create(&server_url).await?;
        let outcome = async {
            for sql in &POSTGRES_SCHEMA[..4] {
                sqlx::raw_sql(sql).execute(&pool).await?;
            }
            event(
                &pool,
                "x0",
                "old",
                "lead",
                0,
                "message",
                &json!({"role": "user", "content": "hello"}),
                None,
            )
            .await?;
            let db = Db::temp().await;
            let report = import_postgres(&scratch.url, db.path()).await?;
            assert_eq!(report.copied(), 1);
            let missing = report
                .tables
                .iter()
                .filter(|table| table.copied.is_none())
                .map(|table| table.table)
                .collect::<Vec<_>>();
            assert_eq!(missing, ["operator_questions", "chat_messages"]);
            assert!(format!("{report}").contains("not in that database"));
            Ok::<(), anyhow::Error>(())
        }
        .await;
        scratch.drop(pool).await?;
        outcome
    }

    #[tokio::test]
    async fn a_database_with_no_loomwatch_history_is_refused_before_anything_is_written() {
        let db = Db::temp().await;
        let target = db.path().with_file_name("never-made.db");
        let error = import_postgres("postgres://nobody@127.0.0.1:1/none", &target)
            .await
            .expect_err("nothing to reach");
        assert!(
            format!("{error:#}")
                .contains("cannot reach PostgreSQL at postgres://nobody@127.0.0.1:1/none"),
            "{error:#}"
        );
        assert!(
            !target.exists(),
            "no file is made for an import that cannot start"
        );
    }

    #[test]
    fn the_source_is_named_without_its_password() {
        assert_eq!(
            redacted("postgres://loomwatch:s3cret@127.0.0.1:5435/loomwatch"),
            "postgres://loomwatch@127.0.0.1:5435/loomwatch"
        );
        assert_eq!(redacted("not a url"), "the given PostgreSQL database");
    }
}
