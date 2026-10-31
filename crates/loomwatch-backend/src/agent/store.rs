//! Parked agents, kept in the database.
//!
//! An agent waiting for its next turn (a hand-off, the operator's answer, a scheduled continue)
//! is only data: its [`Snapshot`]. Keeping it here means nothing runs while it waits and nothing
//! of it is held in memory. A row is there exactly while its agent is parked: reopening takes it
//! out, parking again puts it back, and the run ending forgets whatever is left.

use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use sqlx::Row;

use super::session::Snapshot;
use crate::db::Db;

/// zstd's fast level: a snapshot is mostly text and compresses well at any level.
const LEVEL: i32 = 3;
/// A snapshot larger than this once unpacked is not one this daemon wrote.
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;

/// Where parked agents are kept.
#[derive(Debug, Clone)]
pub struct SessionStore {
    db: Db,
}

impl SessionStore {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Keeps `snapshot` for `agent_id` in the run `run_session_id`, replacing what was kept.
    ///
    /// # Errors
    ///
    /// When it cannot be encoded or written.
    pub async fn save(
        &self,
        run_session_id: &str,
        agent_id: &str,
        snapshot: &Snapshot,
    ) -> Result<()> {
        let json = serde_json::to_vec(snapshot).context("cannot encode a parked agent")?;
        let packed =
            zstd::bulk::compress(&json, LEVEL).context("cannot compress a parked agent")?;
        sqlx::query(
            "INSERT INTO agent_sessions (session_id, run_session_id, agent_id, snapshot, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (session_id) DO UPDATE SET
                 run_session_id = excluded.run_session_id,
                 agent_id = excluded.agent_id,
                 snapshot = excluded.snapshot,
                 updated_at = excluded.updated_at",
        )
        .bind(&snapshot.session_id)
        .bind(run_session_id)
        .bind(agent_id)
        .bind(packed)
        .bind(Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true))
        .execute(self.db.writer())
        .await
        .context("cannot keep a parked agent")?;
        Ok(())
    }

    /// The parked agent with this session id, if one is kept.
    ///
    /// # Errors
    ///
    /// When the database fails or what it holds can't be read back.
    pub async fn load(&self, session_id: &str) -> Result<Option<Snapshot>> {
        let row = sqlx::query("SELECT snapshot FROM agent_sessions WHERE session_id = $1")
            .bind(session_id)
            .fetch_optional(self.db.reader())
            .await
            .context("cannot read a parked agent")?;
        row.map(|row| unpack(&row)).transpose()
    }

    /// Takes the parked agent with this session id out, to reopen it: once taken it is no longer
    /// parked, so a second reopen finds nothing.
    ///
    /// # Errors
    ///
    /// When the database fails or what it held can't be read back.
    pub async fn take(&self, session_id: &str) -> Result<Option<Snapshot>> {
        let row =
            sqlx::query("DELETE FROM agent_sessions WHERE session_id = $1 RETURNING snapshot")
                .bind(session_id)
                .fetch_optional(self.db.writer())
                .await
                .context("cannot reopen a parked agent")?;
        row.map(|row| unpack(&row)).transpose()
    }

    /// Forgets one parked agent: the stop it waited at is over, and nothing will reopen it.
    ///
    /// # Errors
    ///
    /// When the database fails.
    pub async fn forget(&self, session_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM agent_sessions WHERE session_id = $1")
            .bind(session_id)
            .execute(self.db.writer())
            .await
            .context("cannot forget a parked agent")?;
        Ok(())
    }

    /// Forgets every agent parked for a run: it has ended, and nothing will resume them.
    ///
    /// # Errors
    ///
    /// When the database fails.
    pub async fn forget_run(&self, run_session_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM agent_sessions WHERE run_session_id = $1")
            .bind(run_session_id)
            .execute(self.db.writer())
            .await
            .context("cannot forget a run's parked agents")?;
        Ok(())
    }
}

/// The snapshot a row holds.
fn unpack(row: &sqlx::sqlite::SqliteRow) -> Result<Snapshot> {
    let packed: Vec<u8> = row.try_get("snapshot")?;
    let size = match zstd::zstd_safe::get_frame_content_size(&packed) {
        Ok(Some(size)) if size <= MAX_SNAPSHOT_BYTES => usize::try_from(size)?,
        _ => anyhow::bail!("a parked agent's record is damaged"),
    };
    let json = zstd::bulk::decompress(&packed, size).context("cannot unpack a parked agent")?;
    serde_json::from_slice(&json).context("cannot read a parked agent")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::provider::{Message, Usage};
    use std::collections::BTreeMap;

    fn snapshot(id: &str, text: &str) -> Snapshot {
        Snapshot {
            session_id: id.to_owned(),
            model: "anthropic/claude-haiku-5.5".to_owned(),
            effort: Some("low".to_owned()),
            history: vec![
                Message::System {
                    content: "Be brief.".to_owned(),
                },
                Message::User {
                    content: text.to_owned(),
                    pictures: Vec::new(),
                },
            ],
            outputs: BTreeMap::from([("big".to_owned(), "x".repeat(50_000))]),
            usage: Usage {
                input_tokens: 10,
                cost_usd: 0.01,
                ..Usage::default()
            },
            messages_written: 3,
            links: vec!["https://arxiv.org/html/2609.03874v1".to_owned()],
            web: true,
        }
    }

    #[tokio::test]
    async fn a_parked_agent_comes_back_as_it_was_and_goes_with_its_run() {
        let store = SessionStore::new(Db::temp().await);
        assert!(store.load("a").await.unwrap().is_none());
        store
            .save("run-1", "writer", &snapshot("a", "first"))
            .await
            .unwrap();
        store
            .save("run-1", "writer", &snapshot("a", "second"))
            .await
            .unwrap();
        store
            .save("run-2", "editor", &snapshot("b", "other"))
            .await
            .unwrap();
        assert_eq!(
            store.load("a").await.unwrap(),
            Some(snapshot("a", "second"))
        );

        store.forget_run("run-1").await.unwrap();
        assert!(store.load("a").await.unwrap().is_none());
        assert_eq!(store.load("b").await.unwrap(), Some(snapshot("b", "other")));
    }

    #[tokio::test]
    async fn a_parked_agent_is_taken_once_and_forgotten_alone() {
        let store = SessionStore::new(Db::temp().await);
        store
            .save("run-1", "writer", &snapshot("a", "first"))
            .await
            .unwrap();
        store
            .save("run-1", "editor", &snapshot("b", "other"))
            .await
            .unwrap();

        assert_eq!(store.take("a").await.unwrap(), Some(snapshot("a", "first")));
        assert!(
            store.take("a").await.unwrap().is_none(),
            "a reopened agent is no longer parked"
        );

        store.forget("b").await.unwrap();
        assert!(store.load("b").await.unwrap().is_none());
        store.forget("never-parked").await.unwrap();
    }
}
