use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use sqlx::sqlite::{SqlitePool, SqliteRow};
use tokio::sync::{mpsc, oneshot, watch};

use crate::db::{self, Db};
use crate::{EventKind, RunEvent};

pub(crate) mod codec;

/// The ordered event archive, in the SQLite database.
#[derive(Clone, Debug)]
pub struct EventArchive {
    db: Db,
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

const EVENT_COLUMNS: &str = "id, session_id, agent_id, seq, ts, kind, payload, raw";

/// [`EVENT_COLUMNS`] with `raw` only for the kinds a [`Frames::Lean`] page keeps it on. Decided
/// in SQL, so a frame left out is not even read from the file, let alone decompressed.
const LEAN_EVENT_COLUMNS: &str = "id, session_id, agent_id, seq, ts, kind, payload, \
     CASE WHEN kind IN ('message', 'session_meta', 'turn_end') THEN raw END AS raw";

/// Which events in a page of a trace carry their raw ACP frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Frames {
    /// Every event's, as archived.
    All,
    /// Only those of the kinds the browser reads a frame of: `message`, `session_meta` and
    /// `turn_end` (its token usage). Every other event goes without, exactly like an event that
    /// never had one. Most of a real trace's bytes were frames of `tool_update` events, which
    /// repeat the tool output their payload already holds.
    Lean,
}

impl EventArchive {
    /// Open the archive in the database file at `path`, creating it when it is not there.
    ///
    /// # Errors
    ///
    /// Returns an error when the database cannot be opened or brought up to date.
    pub async fn open(path: &Path) -> Result<Self> {
        Ok(Self::new(Db::open(path).await?))
    }

    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The database the archive is in.
    #[must_use]
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// The Notebook on the same database.
    ///
    /// The archive owns the database handle, so this is where a caller gets one — but every note
    /// read and write lives in [`crate::memory::Notebook`], not here. That split is the "one write
    /// authority" rule in `docs/TEAM_MEMORY.md` §9: `run_events` is append-only evidence and
    /// `memory_notes` is revisioned state, and mixing their SQL in one type is how the second set
    /// of rules gets quietly broken by a convenience method on the first.
    #[must_use]
    pub fn notebook(&self) -> crate::memory::Notebook {
        crate::memory::Notebook::new(self.db.clone())
    }

    /// The `runs` table on the same database.
    ///
    /// Like [`Self::notebook`], this is only where the handle comes from: the run record's SQL
    /// lives in [`crate::runs::RunStore`], because `run_events` is append-only evidence and a run
    /// record is mutable state, and one type holding both is how the append-only rule gets broken
    /// by a convenience method.
    #[must_use]
    pub fn run_store(&self) -> crate::runs::RunStore {
        crate::runs::RunStore::new(self.db.clone())
    }

    /// The `operator_questions` table on the same database — the queue behind "waiting for you".
    ///
    /// Same split again: an open question is mutable state with an `answered_at` that gets
    /// stamped, and the *answer* is evidence that lands in `run_events` as a user `message`.
    #[must_use]
    pub fn questions(&self) -> crate::operator::OperatorQuestions {
        crate::operator::OperatorQuestions::new(self.db.clone())
    }

    /// Append one event and wait until it is written, enforcing the session sequence constraint.
    ///
    /// A run's own events go through `EventLog` (`engine/recorder.rs`), which hands them to the
    /// writer without waiting; this is for a caller that has to know the row is there.
    ///
    /// # Errors
    ///
    /// Returns an error for sequence conversion or database failures, including a `seq` the
    /// session already has.
    pub async fn append(&self, event: &RunEvent) -> Result<()> {
        let (done, written) = oneshot::channel();
        self.db
            .events()
            .send(event.clone(), Done::Wait(done))
            .await?;
        written
            .await
            .map_err(|_| anyhow::anyhow!("the archive writer stopped before writing the event"))?
            .map_err(anyhow::Error::msg)
            .context("failed to append event to the archive")
    }

    /// Hand one event to the writer without waiting for it to be written.
    ///
    /// Events are written in the order they are handed over, so a log that hands them over in
    /// `seq` order has them written in `seq` order. A write that fails is recorded in `failure`,
    /// which the log reports on its next append.
    pub(crate) async fn enqueue(&self, event: RunEvent, failure: &Arc<WriteFailure>) -> Result<()> {
        self.db
            .events()
            .send(event, Done::Report(Arc::clone(failure)))
            .await
    }

    /// Wait until every event handed over before this call is written.
    pub async fn flush(&self) {
        self.db.flush_events().await;
    }

    /// A signal that changes each time the writer commits a batch of events, to any session.
    ///
    /// A live view waits on this instead of polling: it reads what is written, marks the signal
    /// seen, and reads again when it changes. It is a counter rather than a notification, so a
    /// batch committed while the view was busy sending still shows as a change.
    pub(crate) fn written(&self) -> watch::Receiver<u64> {
        self.db.events().written()
    }

    /// Record what one agent was supplied from team memory, before it is sent.
    ///
    /// Written before `session/prompt`, never after: the point of the record is that "what the
    /// agent was given" is a stored fact rather than something reconstructed from the prompt
    /// afterwards.
    ///
    /// The invocation number is allocated from the rows already there, so the caller does not
    /// have to track how many times an agent has been started in this run — the Team Bus can
    /// start the same helper more than once, concurrently. The database has one writer, so two
    /// allocations cannot pick the same number; the unique constraint and the retry stay as the
    /// guarantee should that ever change.
    ///
    /// # Errors
    ///
    /// Returns an error for conversion or database failures, including a unique violation that
    /// persists after the bounded retries.
    pub async fn store_context_packet(
        &self,
        session_id: &str,
        packet: &crate::memory::ContextPacket,
    ) -> Result<()> {
        let budget = i64::from(packet.budget_chars);
        let used = i64::try_from(packet.used_chars).context("usedChars exceeds INTEGER")?;
        let sections =
            serde_json::to_string(&packet.sections).context("failed to encode packet sections")?;
        // Everything this session handed the writer goes in first, so the packet's row follows
        // the events recorded before it. Taking the one writing connection while the writer task
        // waits for it with a batch in hand held both for the pool's whole acquire timeout.
        self.flush().await;
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
            .execute(self.db.writer())
            .await;
            match result {
                Ok(_) => return Ok(()),
                Err(error) if db::is_unique_violation(&error) => last_error = Some(error),
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
    /// Returns an error for database or decoding failures.
    pub async fn context_packets(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
    ) -> Result<Vec<StoredContextPacket>> {
        let rows = sqlx::query(
            "SELECT agent_id, invocation, created_at, text, sections, budget_chars, used_chars
             FROM context_packets
             WHERE session_id = $1 AND ($2 IS NULL OR agent_id = $2)
             ORDER BY agent_id ASC, invocation ASC",
        )
        .bind(session_id)
        .bind(agent_id)
        .fetch_all(self.db.reader())
        .await
        .with_context(|| format!("failed to load context packets for session {session_id}"))?;
        rows.iter().map(decode_packet).collect()
    }

    /// Load a session in canonical replay order.
    ///
    /// # Errors
    ///
    /// Returns an error for database, conversion, or event-kind failures.
    pub async fn load_session(&self, session_id: &str) -> Result<Vec<RunEvent>> {
        self.flush().await;
        let rows = sqlx::query(&format!(
            "SELECT {EVENT_COLUMNS} FROM run_events WHERE session_id = $1 ORDER BY seq ASC"
        ))
        .bind(session_id)
        .fetch_all(self.db.reader())
        .await
        .with_context(|| format!("failed to load session {session_id}"))?;
        rows.iter().map(decode_event).collect()
    }

    /// List the most recently active archive sessions.
    ///
    /// Read from `run_sessions`, which the database keeps as events are written, so this costs
    /// the same at ten events or ten million.
    ///
    /// # Errors
    /// Returns an error if the archive cannot be queried or decoded.
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>> {
        self.flush().await;
        let rows = sqlx::query(
            "SELECT session_id, started_at, updated_at, event_count, agent_count,
                    first_agent_id, prompt, task
             FROM run_sessions
             ORDER BY updated_at DESC, session_id
             LIMIT 100",
        )
        .fetch_all(self.db.reader())
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
        self.trace_page(session_id, after_seq, limit, Frames::All)
            .await
    }

    /// [`Self::event_page`], keeping the raw ACP frames `frames` says to.
    ///
    /// # Errors
    /// Returns an error for invalid bounds, database failures, or invalid archived events.
    pub(crate) async fn trace_page(
        &self,
        session_id: &str,
        after_seq: i64,
        limit: i64,
        frames: Frames,
    ) -> Result<Vec<RunEvent>> {
        self.flush().await;
        self.written_page(session_id, after_seq, limit, frames)
            .await
    }

    /// [`Self::trace_page`] over what the writer has already committed, without asking it to
    /// write what it holds. A live view that follows [`Self::written`] reads this way, so following
    /// a run never makes the writer commit early.
    ///
    /// # Errors
    /// Returns an error for invalid bounds, database failures, or invalid archived events.
    pub(crate) async fn written_page(
        &self,
        session_id: &str,
        after_seq: i64,
        limit: i64,
        frames: Frames,
    ) -> Result<Vec<RunEvent>> {
        ensure!(
            after_seq >= -1 && (1..=500).contains(&limit),
            "invalid event page bounds"
        );
        let columns = match frames {
            Frames::All => EVENT_COLUMNS,
            Frames::Lean => LEAN_EVENT_COLUMNS,
        };
        let rows = sqlx::query(&format!(
            "SELECT {columns} FROM run_events
             WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3"
        ))
        .bind(session_id)
        .bind(after_seq)
        .bind(limit)
        .fetch_all(self.db.reader())
        .await?;
        rows.iter().map(decode_event).collect()
    }

    /// Assert that a session is non-empty and has a contiguous sequence, and say how many events
    /// it has.
    ///
    /// Counted, not loaded: `seq` is unique per session and never negative, so the session is
    /// whole exactly when its lowest `seq` is 0 and its highest is one less than its count. A run
    /// checks this as it ends, and loading every frame it archived only to count them was most of
    /// what ending a long run cost.
    ///
    /// # Errors
    ///
    /// Returns an error when the archive cannot be read or the archived sequence is incomplete.
    pub async fn verify_session(&self, session_id: &str) -> Result<usize> {
        self.flush().await;
        let (count, first, last): (i64, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT count(*), min(seq), max(seq) FROM run_events WHERE session_id = $1",
        )
        .bind(session_id)
        .fetch_one(self.db.reader())
        .await
        .with_context(|| format!("failed to load session {session_id}"))?;
        if let Some(reason) = self.db.events().lost(session_id) {
            anyhow::bail!(
                "session {session_id} lost an event that could not be archived: {reason}"
            );
        }
        ensure!(count > 0, "session {session_id} has no archived events");
        if first != Some(0) || last != Some(count - 1) {
            // Every sequence in place yet the counts disagree means a sequence held twice.
            let id = self
                .first_out_of_place(session_id)
                .await?
                .unwrap_or_else(|| "with a repeated sequence".to_owned());
            anyhow::bail!("session {session_id} has a sequence gap at event {id}");
        }
        usize::try_from(count).context("archive contains a negative event count")
    }

    /// How many events a session has archived, whole or not.
    ///
    /// # Errors
    ///
    /// Returns an error when the archive cannot be read.
    pub(crate) async fn event_count(&self, session_id: &str) -> Result<usize> {
        self.flush().await;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM run_events WHERE session_id = $1")
                .bind(session_id)
                .fetch_one(self.db.reader())
                .await
                .with_context(|| format!("failed to load session {session_id}"))?;
        usize::try_from(count).context("archive contains a negative event count")
    }

    /// [`Self::verify_session`], then the session itself, for a caller that reads the events.
    ///
    /// # Errors
    ///
    /// Returns an error when loading fails or the archived sequence is incomplete.
    pub async fn load_verified_session(&self, session_id: &str) -> Result<Vec<RunEvent>> {
        self.verify_session(session_id).await?;
        self.load_session(session_id).await
    }

    /// The id of a session's first event, in `seq` order, whose `seq` is not its position: the
    /// event a gap is reported at. Only asked once a gap is known to be there.
    async fn first_out_of_place(&self, session_id: &str) -> Result<Option<String>> {
        sqlx::query_scalar(
            "SELECT id FROM (
                 SELECT id, seq, row_number() OVER (ORDER BY seq) - 1 AS position
                 FROM run_events WHERE session_id = $1
             )
             WHERE seq <> position ORDER BY seq LIMIT 1",
        )
        .bind(session_id)
        .fetch_optional(self.db.reader())
        .await
        .with_context(|| format!("failed to load session {session_id}"))
    }

    /// The `payload` of a session's `kind` events, newest first, optionally only `agent_id`'s and
    /// at most `limit` of them.
    ///
    /// For a question about the last few events of one kind, such as how the run's process ended,
    /// that would otherwise load and decode the whole session. The raw frames are not read.
    ///
    /// # Errors
    ///
    /// Returns an error for database failures or a payload that is not JSON.
    pub(crate) async fn latest_payloads(
        &self,
        session_id: &str,
        kind: EventKind,
        agent_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>> {
        self.flush().await;
        let rows: Vec<Value> = sqlx::query_scalar(
            "SELECT payload FROM run_events
             WHERE session_id = $1 AND kind = $2 AND ($3 IS NULL OR agent_id = $3)
             ORDER BY seq DESC LIMIT $4",
        )
        .bind(session_id)
        .bind(kind.as_str())
        .bind(agent_id)
        // SQLite reads a negative LIMIT as none.
        .bind(limit.map_or(-1, i64::from))
        .fetch_all(self.db.reader())
        .await
        .with_context(|| format!("failed to load session {session_id}"))?;
        Ok(rows)
    }
}

/// An archived event's `payload` and `raw`, as stored.
pub(crate) fn decode_payload_and_raw(row: &SqliteRow) -> Result<(Value, Option<Value>)> {
    let payload: Value = row.try_get("payload")?;
    let raw = row
        .try_get::<Option<&[u8]>, _>("raw")?
        .map(|stored| codec::decode(&payload, stored))
        .transpose()?;
    Ok((payload, raw))
}

fn decode_event(row: &SqliteRow) -> Result<RunEvent> {
    let sequence: i64 = row.try_get("seq")?;
    let kind: String = row.try_get("kind")?;
    let id: String = row.try_get("id")?;
    let (payload, raw) = decode_payload_and_raw(row)
        .with_context(|| format!("archived event {id} cannot be read"))?;
    Ok(RunEvent {
        id,
        session_id: row.try_get("session_id")?,
        agent_id: row.try_get("agent_id")?,
        seq: u64::try_from(sequence).context("archive contains a negative event sequence")?,
        ts: row.try_get("ts")?,
        kind: parse_event_kind(&kind)?,
        payload,
        raw,
    })
}

fn decode_packet(row: &SqliteRow) -> Result<StoredContextPacket> {
    let invocation: i64 = row.try_get("invocation")?;
    let budget: i64 = row.try_get("budget_chars")?;
    let used: i64 = row.try_get("used_chars")?;
    let sections: Value = row.try_get("sections")?;
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

// ---------------------------------------------------------------------------------------------
// The run event writer
// ---------------------------------------------------------------------------------------------

/// How long the writer gathers events before it writes them in one transaction.
///
/// An agent streaming its reply sends a frame per few tokens, and a busy team peaks near two
/// hundred a second. One transaction per event was most of what writing them cost; one per tenth
/// of a second, or per [`BATCH_MAX`] events, makes a burst a handful of commits. Nothing waits for
/// the window to close: readers flush first ([`Db::flush_events`]), and a live view is woken by
/// the commit itself ([`EventArchive::written`]).
pub(crate) const BATCH_WINDOW: Duration = Duration::from_millis(100);
/// Events in one transaction, at most.
pub(crate) const BATCH_MAX: usize = 256;
/// Events handed over and not yet written, at most, before appending waits for the writer.
const QUEUE: usize = 4096;

/// A write that failed after the log that asked for it had moved on, kept for its next append.
#[derive(Debug, Default)]
pub(crate) struct WriteFailure(Mutex<Option<String>>);

impl WriteFailure {
    fn record(&self, message: String) {
        let mut first = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        first.get_or_insert(message);
    }

    /// The first write that failed, if one did.
    ///
    /// # Errors
    ///
    /// Returns that failure, every time it is asked: a run with a hole in its archive must not
    /// carry on as if it had none.
    pub(crate) fn check(&self) -> Result<()> {
        match &*self.0.lock().unwrap_or_else(PoisonError::into_inner) {
            Some(message) => Err(anyhow::anyhow!(
                "an earlier event could not be archived: {message}"
            )),
            None => Ok(()),
        }
    }
}

/// What to do once an event is written, or is not.
pub(crate) enum Done {
    /// Someone is waiting for the result.
    Wait(oneshot::Sender<Result<(), String>>),
    /// Nobody waits; a failure is recorded for the log's next append.
    Report(Arc<WriteFailure>),
}

enum Command {
    Append(RunEvent, Done),
    Flush(oneshot::Sender<()>),
}

/// The one path run events take into the database: a task that writes them in batches, in the
/// order they were handed over, on the database's one writing connection.
#[derive(Debug)]
pub(crate) struct EventWriter {
    commands: mpsc::Sender<Command>,
    shared: Arc<WriterShared>,
}

/// What the writer task and the handles to it both see.
#[derive(Debug, Default)]
struct WriterShared {
    /// Sessions that lost an event nobody was waiting on, with the first reason. Checked when a
    /// session is verified, so a run whose last events were never written cannot pass for whole:
    /// a missing tail leaves no gap in `seq` to notice.
    lost: Mutex<std::collections::HashMap<String, String>>,
    /// Transactions committed so far. Live views wait for it to change ([`EventArchive::written`]),
    /// and the batching test counts it.
    written: watch::Sender<u64>,
}

impl WriterShared {
    /// A batch is committed: wake everyone following the archive. `send_modify` rather than
    /// `send`, which would leave the count alone while nobody is following.
    fn committed(&self) {
        self.written.send_modify(|count| *count += 1);
    }

    fn lost(&self, session_id: &str, message: &str) {
        self.lost
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(session_id.to_owned())
            .or_insert_with(|| message.to_owned());
    }
}

impl EventWriter {
    pub(crate) fn spawn(pool: SqlitePool) -> Self {
        let (commands, receiver) = mpsc::channel(QUEUE);
        let shared = Arc::new(WriterShared::default());
        tokio::spawn(run_writer(pool, receiver, Arc::clone(&shared)));
        Self { commands, shared }
    }

    /// How many transactions the writer has committed.
    #[cfg(test)]
    pub(crate) fn commits(&self) -> u64 {
        *self.shared.written.borrow()
    }

    /// How many live views are following the archive right now.
    #[cfg(test)]
    pub(crate) fn followers(&self) -> usize {
        self.shared.written.receiver_count()
    }

    fn written(&self) -> watch::Receiver<u64> {
        self.shared.written.subscribe()
    }

    /// Why `session_id` lost an event, if it did.
    fn lost(&self, session_id: &str) -> Option<String> {
        self.shared
            .lost
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session_id)
            .cloned()
    }

    async fn send(&self, event: RunEvent, done: Done) -> Result<()> {
        self.commands
            .send(Command::Append(event, done))
            .await
            .map_err(|_| anyhow::anyhow!("the archive writer has stopped"))
    }

    /// Resolve once everything handed over before this call is written (or has failed).
    pub(crate) async fn flush(&self) {
        let (done, flushed) = oneshot::channel();
        if self.commands.send(Command::Flush(done)).await.is_ok() {
            let _ = flushed.await;
        }
    }
}

async fn run_writer(
    pool: SqlitePool,
    mut commands: mpsc::Receiver<Command>,
    shared: Arc<WriterShared>,
) {
    let mut open = true;
    while open {
        let Some(first) = commands.recv().await else {
            break;
        };
        let mut batch = Vec::new();
        let mut flushed = Vec::new();
        // A flush, or someone waiting on an append, writes now rather than at the window's end.
        let mut now = take(first, &mut batch, &mut flushed);
        let deadline = tokio::time::Instant::now() + BATCH_WINDOW;
        while !now && batch.len() < BATCH_MAX {
            match tokio::time::timeout_at(deadline, commands.recv()).await {
                Ok(Some(command)) => now = take(command, &mut batch, &mut flushed),
                Ok(None) => {
                    open = false;
                    break;
                }
                Err(_) => break,
            }
        }
        if !batch.is_empty() && write_batch(&pool, batch, &shared).await {
            shared.committed();
        }
        for done in flushed {
            let _ = done.send(());
        }
    }
}

/// Add one command to the batch. True when it asks for the batch to be written now.
fn take(
    command: Command,
    batch: &mut Vec<(RunEvent, Done)>,
    flushed: &mut Vec<oneshot::Sender<()>>,
) -> bool {
    match command {
        Command::Append(event, done) => {
            let now = matches!(done, Done::Wait(_));
            batch.push((event, done));
            now
        }
        Command::Flush(done) => {
            flushed.push(done);
            true
        }
    }
}

/// One event as its row is written.
struct EncodedEvent {
    seq: i64,
    payload: String,
    raw: Option<Vec<u8>>,
}

fn encode_event(event: &RunEvent) -> Result<EncodedEvent, String> {
    let seq = i64::try_from(event.seq).map_err(|_| "event sequence exceeds INTEGER".to_owned())?;
    let payload = serde_json::to_string(&event.payload).map_err(|error| error.to_string())?;
    let raw = event
        .raw
        .as_ref()
        .map(|raw| codec::encode(&event.payload, raw))
        .transpose()
        .map_err(|error| format!("{error:#}"))?;
    Ok(EncodedEvent { seq, payload, raw })
}

/// Write a batch in one transaction, then tell each event's caller how it went. True when the
/// transaction committed.
///
/// An event the database refuses (a `seq` its session already has) fails alone and the rest are
/// written: SQLite undoes only the refused statement. Anything else fails the whole batch.
async fn write_batch(
    pool: &SqlitePool,
    batch: Vec<(RunEvent, Done)>,
    shared: &WriterShared,
) -> bool {
    // Serializing and compressing a large frame takes milliseconds; not on the async threads.
    let encoded = tokio::task::spawn_blocking(move || {
        batch
            .into_iter()
            .map(|(event, done)| {
                let row = encode_event(&event);
                (event, done, row)
            })
            .collect::<Vec<_>>()
    })
    .await;
    let Ok(encoded) = encoded else {
        // Encoding panicked. The callers' completions went with it: a waiting caller hears the
        // writer stopped, a log never hears, and the session's sequence check catches the hole.
        eprintln!("loomwatchd: the archive writer could not encode a batch of events");
        return false;
    };
    let mut outcomes = Vec::with_capacity(encoded.len());
    let mut transaction = match pool.begin_with("BEGIN IMMEDIATE").await {
        Ok(transaction) => transaction,
        Err(error) => {
            let message = error.to_string();
            for (event, done, _) in encoded {
                outcomes.push((event, done, Err(message.clone())));
            }
            report(outcomes, shared);
            return false;
        }
    };
    let mut failed_batch = None;
    for (event, done, row) in encoded {
        if let Some(message) = &failed_batch {
            outcomes.push((event, done, Err(String::clone(message))));
            continue;
        }
        let result = match row {
            Err(message) => Err(message),
            Ok(row) => match insert(&mut transaction, &event, row).await {
                Ok(()) => Ok(()),
                Err(error) if refused(&error) => Err(error.to_string()),
                Err(error) => {
                    failed_batch = Some(error.to_string());
                    Err(error.to_string())
                }
            },
        };
        outcomes.push((event, done, result));
    }
    let failure = match failed_batch {
        Some(message) => {
            let _ = transaction.rollback().await;
            Some(message)
        }
        None => transaction
            .commit()
            .await
            .err()
            .map(|error| error.to_string()),
    };
    let committed = failure.is_none();
    if let Some(message) = failure {
        for (_, _, result) in &mut outcomes {
            if result.is_ok() {
                *result = Err(message.clone());
            }
        }
    }
    report(outcomes, shared);
    committed
}

async fn insert(
    transaction: &mut sqlx::Transaction<'static, sqlx::Sqlite>,
    event: &RunEvent,
    row: EncodedEvent,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO run_events (id, session_id, agent_id, seq, ts, kind, payload, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&event.id)
    .bind(&event.session_id)
    .bind(&event.agent_id)
    .bind(row.seq)
    .bind(&event.ts)
    .bind(event.kind.as_str())
    .bind(row.payload)
    .bind(row.raw)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// A constraint refused this one row; the transaction is still good.
fn refused(error: &sqlx::Error) -> bool {
    use sqlx::error::ErrorKind;
    error.as_database_error().is_some_and(|error| {
        matches!(
            error.kind(),
            ErrorKind::UniqueViolation
                | ErrorKind::ForeignKeyViolation
                | ErrorKind::NotNullViolation
                | ErrorKind::CheckViolation
        )
    })
}

fn report(outcomes: Vec<(RunEvent, Done, Result<(), String>)>, shared: &WriterShared) {
    for (event, done, result) in outcomes {
        match done {
            Done::Wait(waiting) => {
                let _ = waiting.send(result);
            }
            Done::Report(failure) => {
                if let Err(message) = result {
                    eprintln!(
                        "loomwatchd: could not archive event {} (seq {}) of session {}: {message}",
                        event.id, event.seq, event.session_id
                    );
                    shared.lost(&event.session_id, &message);
                    failure.record(message);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn event(session: &str, seq: u64) -> RunEvent {
        RunEvent {
            id: format!("{session}:{seq}"),
            session_id: session.into(),
            agent_id: "lead".into(),
            seq,
            ts: format!("2026-09-10T00:00:{:02}Z", seq % 60),
            kind: EventKind::Message,
            payload: json!({"role":"agent", "content":{"type":"text","text":"chunk"}}),
            raw: Some(json!({"jsonrpc":"2.0", "method":"session/update"})),
        }
    }

    #[tokio::test]
    async fn session_discovery_and_pages_preserve_exact_evidence() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
        for seq in 0..3 {
            archive.append(&event("page", seq)).await?;
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
            archive.load_verified_session("page").await?
        );
        assert!(archive.event_page("page", 2, 2).await?.is_empty());
        assert!(archive.event_page("page", -2, 2).await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn session_listing_reports_the_first_user_prompt_and_first_agent() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
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
        assert_eq!(by_id("structured").agent_count, 2);
        assert_eq!(by_id("structured").event_count, 4);
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
    #[tokio::test]
    async fn session_listing_reports_the_recorded_task_section() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
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

    /// The summary the listing reads is the same as one computed from every event, whatever
    /// order the events arrive in: an import copies rows in no particular order.
    #[tokio::test]
    async fn the_session_summary_agrees_with_the_events_in_any_insert_order() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
        let make = |seq: u64, agent: &str, kind: EventKind, payload: Value| RunEvent {
            id: format!("mixed:{seq}"),
            session_id: "mixed".into(),
            agent_id: agent.into(),
            seq,
            ts: format!("2026-09-14T00:00:{seq:02}Z"),
            kind,
            payload,
            raw: None,
        };
        for event in [
            make(
                4,
                "b",
                EventKind::Message,
                json!({"role":"user","content":{"type":"text","text":"later"}}),
            ),
            make(
                3,
                "c",
                EventKind::SessionMeta,
                json!({"phase":"prompt_sections","sections":[{"kind":"task","text":"t3"}]}),
            ),
            make(
                1,
                "a",
                EventKind::Message,
                json!({"role":"user","content":{"type":"text","text":"earliest"}}),
            ),
            make(
                0,
                "a",
                EventKind::SessionMeta,
                json!({"phase":"prompt_sections","sections":[{"kind":"role","text":"r"},{"kind":"task","text":"t0"}]}),
            ),
            make(2, "b", EventKind::Process, json!({"phase":"spawned"})),
        ] {
            archive.append(&event).await?;
        }
        let sessions = archive.list_sessions().await?;
        assert_eq!(sessions.len(), 1);
        let summary = &sessions[0];
        assert_eq!(summary.started_at, "2026-09-14T00:00:00Z");
        assert_eq!(summary.updated_at, "2026-09-14T00:00:04Z");
        assert_eq!(summary.event_count, 5);
        assert_eq!(summary.agent_count, 3);
        assert_eq!(summary.first_agent_id.as_deref(), Some("a"));
        assert_eq!(summary.prompt.as_deref(), Some("earliest"));
        assert_eq!(summary.task.as_deref(), Some("t0"));
        Ok(())
    }

    #[tokio::test]
    async fn persists_and_recovers_events() -> Result<()> {
        let db = Db::temp().await;
        let archive = EventArchive::new(db.clone());
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
        let reopened = EventArchive::open(db.path()).await?;
        assert_eq!(reopened.load_verified_session("session").await?, [event]);
        Ok(())
    }

    #[tokio::test]
    async fn rejects_duplicate_session_sequences() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
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
                .any(|cause| cause.to_string().contains("UNIQUE constraint failed")),
            "unexpected duplicate error: {error:#}"
        );
        Ok(())
    }

    /// The batching contract: events handed over without waiting are written in the order they
    /// were handed over, many to a transaction, and a reader that asks sees all of them at once.
    #[tokio::test]
    async fn queued_events_are_written_in_order_in_few_transactions_and_seen_by_the_next_read()
    -> Result<()> {
        let db = Db::temp().await;
        let archive = EventArchive::new(db.clone());
        let failure = Arc::new(WriteFailure::default());
        let total = 600u64;
        for seq in 0..total {
            let mut next = event("burst", seq);
            next.raw = Some(json!({"jsonrpc": "2.0", "method": "session/update",
                                   "params": {"update": next.payload.clone()}}));
            archive.enqueue(next, &failure).await?;
        }
        // Without waiting for any window: the read itself flushes.
        let events = archive.load_verified_session("burst").await?;
        assert_eq!(events.len(), 600);
        assert!(events.iter().enumerate().all(|(i, e)| e.seq == i as u64));
        assert_eq!(events[7], {
            let mut expected = event("burst", 7);
            expected.raw = Some(json!({"jsonrpc": "2.0", "method": "session/update",
                                       "params": {"update": expected.payload.clone()}}));
            expected
        });
        // Rows went in in seq order: rowid order is insertion order.
        let order: Vec<i64> = sqlx::query_scalar(
            "SELECT seq FROM run_events WHERE session_id = 'burst' ORDER BY rowid",
        )
        .fetch_all(db.reader())
        .await?;
        assert_eq!(order, (0..600).collect::<Vec<i64>>());
        failure.check()?;
        let commits = db.events().commits();
        assert!(
            commits <= total / 100,
            "600 queued events took {commits} transactions"
        );
        Ok(())
    }

    /// A queued event the database refuses fails alone, is reported on the log's next append,
    /// and does not take the rest of its batch with it.
    #[tokio::test]
    async fn a_refused_queued_event_fails_alone_and_is_reported_next_time() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
        let failure = Arc::new(WriteFailure::default());
        archive.enqueue(event("dup", 0), &failure).await?;
        archive
            .enqueue(
                RunEvent {
                    id: "another".into(),
                    ..event("dup", 0)
                },
                &failure,
            )
            .await?;
        archive.enqueue(event("dup", 1), &failure).await?;
        let events = archive.load_session("dup").await?;
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [0, 1]);
        let error = failure.check().expect_err("the refusal is kept");
        assert!(
            format!("{error:#}").contains("UNIQUE constraint failed"),
            "{error:#}"
        );
        // Even with no gap in `seq` to see, the session is not passed off as whole.
        let error = archive
            .verify_session("dup")
            .await
            .expect_err("lost an event");
        assert!(format!("{error:#}").contains("lost an event"), "{error:#}");
        Ok(())
    }

    /// The check counts rather than loads, and still finds what loading found: a session with no
    /// events, a hole in the middle, and one that does not start at 0, each named at the first
    /// event out of place.
    #[tokio::test]
    async fn verifying_counts_the_session_and_names_the_first_event_after_a_gap() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
        for seq in 0..4 {
            archive.append(&event("whole", seq)).await?;
        }
        for seq in [0, 1, 3, 4] {
            archive.append(&event("holed", seq)).await?;
        }
        for seq in [1, 2] {
            archive.append(&event("late", seq)).await?;
        }
        assert_eq!(archive.verify_session("whole").await?, 4);
        assert_eq!(archive.load_verified_session("whole").await?.len(), 4);
        let error = |session: &'static str| {
            let archive = archive.clone();
            async move {
                format!(
                    "{:#}",
                    archive
                        .verify_session(session)
                        .await
                        .expect_err("not whole")
                )
            }
        };
        assert_eq!(
            error("holed").await,
            "session holed has a sequence gap at event holed:3"
        );
        assert_eq!(
            error("late").await,
            "session late has a sequence gap at event late:1"
        );
        assert_eq!(
            error("missing").await,
            "session missing has no archived events"
        );
        assert!(archive.load_verified_session("holed").await.is_err());
        Ok(())
    }

    /// Without a reader asking, a lone event is still written within the window.
    #[tokio::test]
    async fn a_lone_queued_event_is_written_within_the_window() -> Result<()> {
        let db = Db::temp().await;
        let archive = EventArchive::new(db.clone());
        let failure = Arc::new(WriteFailure::default());
        archive.enqueue(event("lone", 0), &failure).await?;
        tokio::time::sleep(BATCH_WINDOW * 3).await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM run_events")
            .fetch_one(db.reader())
            .await?;
        assert_eq!(count, 1);
        Ok(())
    }
}
