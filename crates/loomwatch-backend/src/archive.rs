use anyhow::{Context, Result, ensure};
use serde::Serialize;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Row, migrate::Migrator};

use crate::{EventKind, RunEvent};

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// Postgres-backed, ordered event archive.
#[derive(Clone, Debug)]
pub struct EventArchive {
    pool: PgPool,
}

/// Bounded session discovery for the local evidence viewer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub started_at: String,
    pub updated_at: String,
    pub event_count: i64,
    pub agent_count: i64,
    /// Text of the first archived `message` event whose `role` is `user` — the prompt the
    /// run was started with. `None` until one is archived.
    pub prompt: Option<String>,
    /// `agent_id` of the lowest-`seq` event: the entrypoint or first pipeline node.
    pub first_agent_id: Option<String>,
    /// The operator's own words, read from the first archived `prompt_sections` record's `task`
    /// section.
    ///
    /// [`Self::prompt`] is the whole first user message, which for any `LoomWatch`-composed run
    /// is the role, the capabilities, the memory packet *and* the task. The UI wants the task, and
    /// before this it recovered it with a client-side `legacyOperatorPrompt` fallback for runs the
    /// daemon had forgotten. `None` for a run archived before phase 1 added the record — which is
    /// exactly when that fallback is still needed, and why it stays.
    pub task: Option<String>,
}

/// One stored context packet, as the packet inspector reads it.
///
/// Deliberately not [`crate::memory::ContextPacket`]: that type is what the renderer produced in
/// memory, this is what the archive holds, and the difference — an invocation and a timestamp —
/// is exactly what the panel needs to say "supplied 14:40:12".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredContextPacket {
    pub agent_id: String,
    pub invocation: u32,
    pub created_at: String,
    pub text: String,
    pub sections: Vec<crate::memory::PacketSection>,
    pub budget_chars: u32,
    pub used_chars: u32,
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

    /// The Notebook on the same pool.
    ///
    /// The archive owns the connection pool, so this is where a caller gets one — but every note
    /// read and write lives in [`crate::memory::Notebook`], not here. That split is the "one write
    /// authority" rule in `docs/TEAM_MEMORY.md` §9: `run_events` is append-only evidence and
    /// `memory_notes` is revisioned state, and mixing their SQL in one type is how the second set
    /// of rules gets quietly broken by a convenience method on the first.
    #[must_use]
    pub fn notebook(&self) -> crate::memory::Notebook {
        crate::memory::Notebook::new(self.pool.clone())
    }

    /// The `runs` table on the same pool.
    ///
    /// Like [`Self::notebook`], this is only where the pool comes from: the run record's SQL lives
    /// in [`crate::runs::RunStore`], because `run_events` is append-only evidence and a run record
    /// is mutable state, and one type holding both is how the append-only rule gets broken by a
    /// convenience method.
    #[must_use]
    pub fn run_store(&self) -> crate::runs::RunStore {
        crate::runs::RunStore::new(self.pool.clone())
    }

    /// The `operator_questions` table on the same pool — the queue behind "waiting for you".
    ///
    /// Same split again: an open question is mutable state with an `answered_at` that gets
    /// stamped, and the *answer* is evidence that lands in `run_events` as a user `message`.
    #[must_use]
    pub fn questions(&self) -> crate::operator::OperatorQuestions {
        crate::operator::OperatorQuestions::new(self.pool.clone())
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

    /// Record what one agent was supplied from team memory, before it is sent.
    ///
    /// Written before `session/prompt`, never after: the point of the record is that "what the
    /// agent was given" is a stored fact rather than something reconstructed from the prompt
    /// afterwards.
    ///
    /// The invocation number is allocated by Postgres from the rows already there, so the caller
    /// does not have to track how many times an agent has been started in this run — the Team Bus
    /// can start the same helper more than once, concurrently. Two concurrent allocations can pick
    /// the same number under `READ COMMITTED`; the unique constraint catches that and the insert
    /// is retried, which is why the invariant is worth keeping rather than dropping.
    ///
    /// # Errors
    ///
    /// Returns an error for conversion or Postgres failures, including a unique violation that
    /// persists after the bounded retries.
    pub async fn store_context_packet(
        &self,
        session_id: &str,
        packet: &crate::memory::ContextPacket,
    ) -> Result<()> {
        let budget = i32::try_from(packet.budget_chars).context("budgetChars exceeds INTEGER")?;
        let used = i32::try_from(packet.used_chars).context("usedChars exceeds INTEGER")?;
        let sections =
            serde_json::to_value(&packet.sections).context("failed to encode packet sections")?;
        let mut last_error = None;
        for _ in 0..5 {
            let result = sqlx::query(
                "INSERT INTO context_packets
                 (id, session_id, agent_id, invocation, created_at, text, sections, budget_chars, used_chars)
                 SELECT $1, $2, $3,
                        COALESCE((SELECT MAX(invocation) + 1 FROM context_packets
                                  WHERE session_id = $2 AND agent_id = $3), 0),
                        $4, $5, $6, $7, $8",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(session_id)
            .bind(&packet.agent_id)
            .bind(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .bind(&packet.text)
            .bind(&sections)
            .bind(budget)
            .bind(used)
            .execute(&self.pool)
            .await;
            match result {
                Ok(_) => return Ok(()),
                Err(error) if is_unique_violation(&error) => last_error = Some(error),
                Err(error) => {
                    return Err(
                        anyhow::Error::new(error).context("failed to store the context packet")
                    );
                }
            }
        }
        // The loop only reaches here after at least one unique violation, so `last_error` is
        // always set — but building the error from the option rather than unwrapping it keeps this
        // function panic-free by construction.
        Err(last_error
            .map_or_else(
                || anyhow::anyhow!("the context packet insert was not attempted"),
                anyhow::Error::new,
            )
            .context("failed to store the context packet after retrying its invocation number"))
    }

    /// Every stored packet for one run, oldest first, optionally narrowed to one agent.
    ///
    /// # Errors
    ///
    /// Returns an error for Postgres or decoding failures.
    pub async fn context_packets(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
    ) -> Result<Vec<StoredContextPacket>> {
        let rows = sqlx::query(
            "SELECT agent_id, invocation, created_at, text, sections, budget_chars, used_chars
             FROM context_packets
             WHERE session_id = $1 AND ($2::TEXT IS NULL OR agent_id = $2)
             ORDER BY agent_id ASC, invocation ASC",
        )
        .bind(session_id)
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await
        .with_context(|| format!("failed to load context packets for session {session_id}"))?;
        rows.iter().map(decode_packet).collect()
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

    /// List the most recently active archive sessions.
    ///
    /// # Errors
    /// Returns an error if the archive cannot be queried or decoded.
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>> {
        // The prompt and first agent come from two lateral lookups per session, each bounded
        // to one row by the `(session_id, seq)` index, so listing never loads whole sessions.
        // A user message's `content` is normally `{type, text}` but may also be a bare string.
        let rows = sqlx::query(
            "SELECT summary.session_id, summary.started_at, summary.updated_at,
                    summary.event_count, summary.agent_count,
                    first_event.agent_id AS first_agent_id,
                    prompt_event.prompt,
                    task_event.task
             FROM (
                 SELECT session_id, MIN(ts) AS started_at, MAX(ts) AS updated_at,
                        COUNT(*) AS event_count, COUNT(DISTINCT agent_id) AS agent_count
                 FROM run_events GROUP BY session_id
             ) AS summary
             LEFT JOIN LATERAL (
                 SELECT agent_id FROM run_events AS e
                 WHERE e.session_id = summary.session_id
                 ORDER BY e.seq ASC LIMIT 1
             ) AS first_event ON TRUE
             LEFT JOIN LATERAL (
                 SELECT COALESCE(
                            e.payload #>> '{content,text}',
                            CASE WHEN jsonb_typeof(e.payload -> 'content') = 'string'
                                 THEN e.payload ->> 'content' END
                        ) AS prompt
                 FROM run_events AS e
                 WHERE e.session_id = summary.session_id
                   AND e.kind = 'message'
                   AND e.payload ->> 'role' = 'user'
                 ORDER BY e.seq ASC LIMIT 1
             ) AS prompt_event ON TRUE
             LEFT JOIN LATERAL (
                 SELECT (
                            SELECT section ->> 'text'
                            FROM jsonb_array_elements(e.payload -> 'sections') AS section
                            WHERE section ->> 'kind' = 'task'
                            LIMIT 1
                        ) AS task
                 FROM run_events AS e
                 WHERE e.session_id = summary.session_id
                   AND e.kind = 'session_meta'
                   AND e.payload ->> 'phase' = 'prompt_sections'
                 ORDER BY e.seq ASC LIMIT 1
             ) AS task_event ON TRUE
             ORDER BY summary.updated_at DESC, summary.session_id
             LIMIT 100",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(SessionSummary {
                    session_id: row.try_get("session_id")?,
                    started_at: row.try_get("started_at")?,
                    updated_at: row.try_get("updated_at")?,
                    event_count: row.try_get("event_count")?,
                    agent_count: row.try_get("agent_count")?,
                    prompt: row.try_get("prompt")?,
                    first_agent_id: row.try_get("first_agent_id")?,
                    task: row.try_get("task")?,
                })
            })
            .collect()
    }

    /// Read a bounded page after an exclusive sequence cursor. `-1` starts at zero.
    ///
    /// # Errors
    /// Returns an error for invalid bounds, database failures, or invalid archived events.
    pub async fn event_page(
        &self,
        session_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<RunEvent>> {
        ensure!(
            after_seq >= -1 && (1..=500).contains(&limit),
            "invalid event page bounds"
        );
        let rows = sqlx::query(
            "SELECT id, session_id, agent_id, seq, ts, kind, payload, raw
             FROM run_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
        )
        .bind(session_id)
        .bind(after_seq)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
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

/// Postgres SQLSTATE 23505 — two concurrent packet inserts picked the same invocation number.
fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "23505")
}

fn decode_packet(row: &PgRow) -> Result<StoredContextPacket> {
    let invocation: i32 = row.try_get("invocation")?;
    let budget: i32 = row.try_get("budget_chars")?;
    let used: i32 = row.try_get("used_chars")?;
    let sections: serde_json::Value = row.try_get("sections")?;
    Ok(StoredContextPacket {
        agent_id: row.try_get("agent_id")?,
        invocation: u32::try_from(invocation)
            .context("archive contains a negative packet invocation")?,
        created_at: row.try_get("created_at")?,
        text: row.try_get("text")?,
        sections: serde_json::from_value(sections)
            .context("archive contains packet sections this build cannot read")?,
        budget_chars: u32::try_from(budget).context("archive contains a negative packet budget")?,
        used_chars: u32::try_from(used).context("archive contains a negative packet size")?,
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
    use serde_json::{Value, json};
    use sqlx::postgres::PgConnectOptions;

    use super::*;

    #[sqlx::test(migrations = "../../migrations")]
    async fn session_discovery_and_pages_preserve_exact_evidence(pool: PgPool) -> Result<()> {
        let archive = EventArchive::from_pool(pool);
        for seq in 0..3 {
            archive
                .append(&RunEvent {
                    id: format!("page:{seq}"),
                    session_id: "page".into(),
                    agent_id: "lead".into(),
                    seq,
                    ts: format!("2026-09-10T00:00:0{seq}Z"),
                    kind: EventKind::Message,
                    payload: json!({"role":"agent", "content":{"type":"text","text":"chunk"}}),
                    raw: Some(json!({"jsonrpc":"2.0", "method":"session/update"})),
                })
                .await?;
        }
        let sessions = archive.list_sessions().await?;
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].event_count, 3);
        assert_eq!(sessions[0].agent_count, 1);
        assert_eq!(sessions[0].first_agent_id.as_deref(), Some("lead"));
        assert_eq!(
            sessions[0].prompt, None,
            "agent messages are not the run's prompt"
        );
        let first = archive.event_page("page", -1, 2).await?;
        let second = archive.event_page("page", 1, 2).await?;
        assert_eq!(first.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(second[0].seq, 2);
        assert_eq!(
            first.into_iter().chain(second).collect::<Vec<_>>(),
            archive.verify_session("page").await?
        );
        assert!(archive.event_page("page", 2, 2).await?.is_empty());
        assert!(archive.event_page("page", -2, 2).await.is_err());
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn session_listing_reports_the_first_user_prompt_and_first_agent(
        pool: PgPool,
    ) -> Result<()> {
        let archive = EventArchive::from_pool(pool);
        let event =
            |session: &str, seq: u64, agent: &str, kind: EventKind, payload: Value| RunEvent {
                id: format!("{session}:{seq}"),
                session_id: session.into(),
                agent_id: agent.into(),
                seq,
                ts: format!("2026-09-10T00:00:{seq:02}Z"),
                kind,
                payload,
                raw: None,
            };
        // Structured content, preceded by a spawned marker from the entrypoint and an agent
        // message that must not be mistaken for the prompt.
        archive
            .append(&event(
                "structured",
                0,
                "researcher",
                EventKind::Process,
                json!({"phase":"spawned","pid":1}),
            ))
            .await?;
        archive
            .append(&event(
                "structured",
                1,
                "researcher",
                EventKind::Message,
                json!({"role":"agent","content":{"type":"text","text":"not the prompt"}}),
            ))
            .await?;
        archive
            .append(&event(
                "structured",
                2,
                "reviewer",
                EventKind::Message,
                json!({"role":"user","content":{"type":"text","text":"first prompt"}}),
            ))
            .await?;
        archive
            .append(&event(
                "structured",
                3,
                "reviewer",
                EventKind::Message,
                json!({"role":"user","content":{"type":"text","text":"second prompt"}}),
            ))
            .await?;
        // Bare-string content.
        archive
            .append(&event(
                "plain",
                0,
                "lead",
                EventKind::Message,
                json!({"role":"user","content":"plain prompt"}),
            ))
            .await?;
        // A session with no user message at all.
        archive
            .append(&event(
                "silent",
                0,
                "lead",
                EventKind::Process,
                json!({"phase":"spawned","pid":2}),
            ))
            .await?;

        let sessions = archive.list_sessions().await?;
        let by_id = |id: &str| {
            sessions
                .iter()
                .find(|session| session.session_id == id)
                .expect("listed session")
        };
        assert_eq!(by_id("structured").prompt.as_deref(), Some("first prompt"));
        assert_eq!(
            by_id("structured").first_agent_id.as_deref(),
            Some("researcher")
        );
        assert_eq!(by_id("plain").prompt.as_deref(), Some("plain prompt"));
        assert_eq!(by_id("plain").first_agent_id.as_deref(), Some("lead"));
        assert_eq!(by_id("silent").prompt, None);
        assert_eq!(by_id("silent").first_agent_id.as_deref(), Some("lead"));
        let json = serde_json::to_value(by_id("silent"))?;
        assert!(json["prompt"].is_null(), "absent prompt serializes as null");
        assert_eq!(json["firstAgentId"], "lead", "response stays camelCase");
        Ok(())
    }

    /// The listing reports the operator's own words, not the whole composed prompt.
    ///
    /// `prompt` is the first user message, which for a `LoomWatch`-composed run is the role, the
    /// capabilities, the memory packet *and* the task. The UI wants the task, and before this it
    /// reconstructed it client-side. Reading the `prompt_sections` record the daemon already
    /// archives is the same move phase 1 made for the packet inspector: the daemon composed the
    /// prompt, so the daemon says what it was made of.
    #[sqlx::test(migrations = "../../migrations")]
    async fn session_listing_reports_the_recorded_task_section(pool: PgPool) -> Result<()> {
        let archive = EventArchive::from_pool(pool);
        let event = |session: &str, seq: u64, kind: EventKind, payload: Value| RunEvent {
            id: format!("{session}:{seq}"),
            session_id: session.into(),
            agent_id: "lead".into(),
            seq,
            ts: format!("2026-09-13T00:00:{seq:02}Z"),
            kind,
            payload,
            raw: None,
        };
        archive
            .append(&event(
                "composed",
                0,
                EventKind::SessionMeta,
                json!({
                    "phase": "prompt_sections",
                    "sections": [
                        {"kind": "role", "heading": "## Your assigned role", "text": "You research."},
                        {"kind": "memory", "heading": "## What the team knows", "text": "Never touch main."},
                        {"kind": "task", "heading": "## Task", "text": "compare the adapters"}
                    ]
                }),
            ))
            .await?;
        archive
            .append(&event(
                "composed",
                1,
                EventKind::Message,
                json!({
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": "## Your assigned role\nYou research.\n\n## Task\ncompare the adapters"
                    }
                }),
            ))
            .await?;
        // A run with no record at all: the listing must carry an honest absence rather than
        // guessing, because that absence is what keeps the client's legacy fallback justified.
        archive
            .append(&event(
                "legacy",
                0,
                EventKind::Message,
                json!({"role": "user", "content": {"type": "text", "text": "just a prompt"}}),
            ))
            .await?;

        let sessions = archive.list_sessions().await?;
        let composed = sessions
            .iter()
            .find(|session| session.session_id == "composed")
            .expect("the composed run is listed");
        assert_eq!(composed.task.as_deref(), Some("compare the adapters"));
        assert!(
            composed
                .prompt
                .as_deref()
                .is_some_and(|prompt| prompt.contains("## Your assigned role")),
            "the whole first user message is still reported, unchanged: {:?}",
            composed.prompt
        );
        let legacy = sessions
            .iter()
            .find(|session| session.session_id == "legacy")
            .expect("the legacy run is listed");
        assert_eq!(legacy.task, None);
        assert_eq!(legacy.prompt.as_deref(), Some("just a prompt"));
        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn connect_migrates_and_round_trips(
        _pool_options: PgPoolOptions,
        connect_options: PgConnectOptions,
    ) -> Result<()> {
        let database = connect_options
            .get_database()
            .context("SQLx test database has no name")?;
        let mut database_url = url::Url::parse(
            &std::env::var("DATABASE_URL").context("DATABASE_URL must be set for SQLx tests")?,
        )
        .context("DATABASE_URL is not a valid URL")?;
        database_url.set_path(database);

        let archive = EventArchive::connect(database_url.as_str()).await?;
        let event = RunEvent {
            id: "connected-session:0".into(),
            session_id: "connected-session".into(),
            agent_id: "agent".into(),
            seq: 0,
            ts: "2026-09-06T00:00:00Z".into(),
            kind: EventKind::Message,
            payload: json!({"role": "user", "content": "hello"}),
            raw: None,
        };

        archive.append(&event).await?;
        assert_eq!(archive.verify_session("connected-session").await?, [event]);
        Ok(())
    }

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
