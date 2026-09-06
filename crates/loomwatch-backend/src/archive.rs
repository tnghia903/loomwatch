use anyhow::{Context, Result, ensure};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Row, migrate::Migrator};

use crate::{EventKind, RunEvent};

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// Postgres-backed, ordered event archive.
#[derive(Clone)]
pub struct EventArchive {
    pool: PgPool,
}

impl EventArchive {
    /// Connect to Postgres and apply all pending versioned migrations.
    ///
    /// # Errors
    ///
    /// Returns an error when Postgres cannot be reached or migrated.
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await
            .context("failed to connect to Postgres event archive")?;
        MIGRATOR
            .run(&pool)
            .await
            .context("failed to migrate Postgres event archive")?;
        Ok(Self { pool })
    }

    #[cfg(test)]
    pub(crate) fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Append one event while enforcing the session sequence constraint.
    ///
    /// # Errors
    ///
    /// Returns an error for sequence conversion or Postgres failures.
    pub async fn append(&self, event: &RunEvent) -> Result<()> {
        let sequence = i64::try_from(event.seq).context("event sequence exceeds BIGINT")?;
        sqlx::query(
            "INSERT INTO run_events
             (id, session_id, agent_id, seq, ts, kind, payload, raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(&event.id)
        .bind(&event.session_id)
        .bind(&event.agent_id)
        .bind(sequence)
        .bind(&event.ts)
        .bind(event.kind.as_str())
        .bind(&event.payload)
        .bind(&event.raw)
        .execute(&self.pool)
        .await
        .context("failed to append event to Postgres archive")?;
        Ok(())
    }

    /// Load a session in canonical replay order.
    ///
    /// # Errors
    ///
    /// Returns an error for Postgres, conversion, or event-kind failures.
    pub async fn load_session(&self, session_id: &str) -> Result<Vec<RunEvent>> {
        let rows = sqlx::query(
            "SELECT id, session_id, agent_id, seq, ts, kind, payload, raw
             FROM run_events WHERE session_id = $1 ORDER BY seq ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .with_context(|| format!("failed to load Postgres session {session_id}"))?;
        rows.iter().map(decode_event).collect()
    }

    /// Assert that a session is non-empty and has a contiguous sequence.
    ///
    /// # Errors
    ///
    /// Returns an error when loading fails or the archived sequence is incomplete.
    pub async fn verify_session(&self, session_id: &str) -> Result<Vec<RunEvent>> {
        let events = self.load_session(session_id).await?;
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

fn decode_event(row: &PgRow) -> Result<RunEvent> {
    let sequence: i64 = row.try_get("seq")?;
    let kind: String = row.try_get("kind")?;
    Ok(RunEvent {
        id: row.try_get("id")?,
        session_id: row.try_get("session_id")?,
        agent_id: row.try_get("agent_id")?,
        seq: u64::try_from(sequence).context("archive contains a negative event sequence")?,
        ts: row.try_get("ts")?,
        kind: parse_event_kind(&kind)?,
        payload: row.try_get("payload")?,
        raw: row.try_get("raw")?,
    })
}

fn parse_event_kind(kind: &str) -> Result<EventKind> {
    match kind {
        "message" => Ok(EventKind::Message),
        "thought" => Ok(EventKind::Thought),
        "tool_call" => Ok(EventKind::ToolCall),
        "tool_update" => Ok(EventKind::ToolUpdate),
        "plan" => Ok(EventKind::Plan),
        "permission" => Ok(EventKind::Permission),
        "session_meta" => Ok(EventKind::SessionMeta),
        "usage" => Ok(EventKind::Usage),
        "turn_end" => Ok(EventKind::TurnEnd),
        "process" => Ok(EventKind::Process),
        other => anyhow::bail!("archive contains unknown event kind {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[sqlx::test(migrations = "../../migrations")]
    async fn persists_and_recovers_events(pool: PgPool) -> Result<()> {
        let archive = EventArchive::from_pool(pool.clone());
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

        archive.append(&event).await?;
        drop(archive);
        let reopened = EventArchive::from_pool(pool);
        assert_eq!(reopened.verify_session("session").await?, [event]);
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn rejects_duplicate_session_sequences(pool: PgPool) -> Result<()> {
        let archive = EventArchive::from_pool(pool);
        let event = RunEvent {
            id: "event-1".into(),
            session_id: "session".into(),
            agent_id: "agent".into(),
            seq: 0,
            ts: "2026-09-05T00:00:00Z".into(),
            kind: EventKind::Message,
            payload: json!({"role": "user"}),
            raw: None,
        };
        archive.append(&event).await?;
        let duplicate = RunEvent {
            id: "event-2".into(),
            ..event
        };
        let error = archive
            .append(&duplicate)
            .await
            .expect_err("duplicate session sequence must fail");
        assert!(
            error
                .chain()
                .any(|cause| cause.to_string().contains("duplicate key value")),
            "unexpected duplicate error: {error:#}"
        );
        Ok(())
    }
}
