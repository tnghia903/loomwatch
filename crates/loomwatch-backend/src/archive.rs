use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result, anyhow, ensure};
use rusqlite::{Connection, params};

use crate::{EventKind, RunEvent};

/// SQLite-backed, ordered event archive.
pub struct EventArchive {
    connection: Mutex<Connection>,
}

impl EventArchive {
    /// Open an archive and enable WAL journaling.
    ///
    /// # Errors
    ///
    /// Returns an error when SQLite cannot open or initialize the database.
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)
            .with_context(|| format!("failed to open SQLite archive {}", path.display()))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        // WAL + NORMAL remains durable across process crashes while avoiding a full
        // disk sync for every implicitly committed streamed event.
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS run_events (
                id           TEXT PRIMARY KEY,
                session_id   TEXT NOT NULL,
                agent_id     TEXT NOT NULL,
                seq          INTEGER NOT NULL CHECK (seq >= 0),
                ts           TEXT NOT NULL,
                kind         TEXT NOT NULL CHECK (kind IN (
                    'message', 'thought', 'tool_call', 'tool_update', 'plan',
                    'permission', 'session_meta', 'usage', 'turn_end', 'process'
                )),
                payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
                raw_json     TEXT CHECK (raw_json IS NULL OR json_valid(raw_json)),
                UNIQUE (session_id, seq)
             );
             CREATE INDEX IF NOT EXISTS run_events_session_seq
                 ON run_events(session_id, seq);",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Append one event while enforcing the session sequence constraint.
    ///
    /// # Errors
    ///
    /// Returns an error for serialization, locking, conversion, or SQLite failures.
    pub fn append(&self, event: &RunEvent) -> Result<()> {
        let payload = serde_json::to_string(&event.payload)?;
        let raw = event.raw.as_ref().map(serde_json::to_string).transpose()?;
        let sequence = i64::try_from(event.seq).context("event sequence exceeds SQLite integer")?;
        self.connection
            .lock()
            .map_err(|_| anyhow!("archive mutex poisoned"))?
            .execute(
                "INSERT INTO run_events
                 (id, session_id, agent_id, seq, ts, kind, payload_json, raw_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    event.id,
                    event.session_id,
                    event.agent_id,
                    sequence,
                    event.ts,
                    event.kind.as_str(),
                    payload,
                    raw
                ],
            )?;
        Ok(())
    }

    /// Load a session in canonical replay order.
    ///
    /// # Errors
    ///
    /// Returns an error for locking, SQLite, conversion, or payload decoding failures.
    pub fn load_session(&self, session_id: &str) -> Result<Vec<RunEvent>> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("archive mutex poisoned"))?;
        let mut statement = connection.prepare(
            "SELECT id, session_id, agent_id, seq, ts, kind, payload_json, raw_json
             FROM run_events WHERE session_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = statement.query_map([session_id], |row| {
            let kind: String = row.get(5)?;
            let payload_json: String = row.get(6)?;
            let payload = serde_json::from_str(&payload_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    payload_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let raw_json: Option<String> = row.get(7)?;
            let raw = raw_json
                .map(|raw| {
                    serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            raw.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?;
            let kind = match kind.as_str() {
                "message" => EventKind::Message,
                "thought" => EventKind::Thought,
                "tool_call" => EventKind::ToolCall,
                "tool_update" => EventKind::ToolUpdate,
                "plan" => EventKind::Plan,
                "permission" => EventKind::Permission,
                "session_meta" => EventKind::SessionMeta,
                "usage" => EventKind::Usage,
                "turn_end" => EventKind::TurnEnd,
                "process" => EventKind::Process,
                other => {
                    return Err(rusqlite::Error::FromSqlConversionFailure(
                        other.len(),
                        rusqlite::types::Type::Text,
                        format!("unknown event kind {other}").into(),
                    ));
                }
            };
            let seq: i64 = row.get(3)?;
            Ok(RunEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                agent_id: row.get(2)?,
                seq: u64::try_from(seq).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        8,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?,
                ts: row.get(4)?,
                kind,
                payload,
                raw,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    /// Read SQLite's active journal mode.
    ///
    /// # Errors
    ///
    /// Returns an error when the mutex or SQLite pragma query fails.
    pub fn journal_mode(&self) -> Result<String> {
        let mode = self
            .connection
            .lock()
            .map_err(|_| anyhow!("archive mutex poisoned"))?
            .pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        Ok(mode)
    }

    /// Assert that a session is non-empty and has a contiguous sequence.
    ///
    /// # Errors
    ///
    /// Returns an error when loading fails or the archived sequence is incomplete.
    pub fn verify_session(&self, session_id: &str) -> Result<Vec<RunEvent>> {
        let events = self.load_session(session_id)?;
        ensure!(
            !events.is_empty(),
            "session {session_id} has no archived events"
        );
        for (expected, event) in events.iter().enumerate() {
            ensure!(
                event.seq == expected as u64,
                "session {session_id} has a sequence gap at event {}",
                event.id
            );
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn persists_and_recovers_events_in_wal_mode() {
        let temp = tempdir().expect("tempdir");
        let database = temp.path().join("events.sqlite3");
        let event = RunEvent {
            id: "session:0".into(),
            session_id: "session".into(),
            agent_id: "agent".into(),
            seq: 0,
            ts: "2026-09-05T00:00:00Z".into(),
            kind: EventKind::Message,
            payload: json!({
                "role": "user",
                "content": {"type": "text", "text": "hello"}
            }),
            raw: Some(json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {}
            })),
        };
        {
            let archive = EventArchive::open(&database).expect("open archive");
            assert_eq!(archive.journal_mode().expect("journal mode"), "wal");
            let synchronous: i64 = archive
                .connection
                .lock()
                .expect("archive mutex")
                .pragma_query_value(None, "synchronous", |row| row.get(0))
                .expect("synchronous level");
            assert_eq!(synchronous, 1, "WAL archive must use NORMAL sync");
            archive.append(&event).expect("append event");
        }
        let reopened = EventArchive::open(&database).expect("reopen archive");
        assert_eq!(
            reopened.verify_session("session").expect("session"),
            [event]
        );
    }
}
