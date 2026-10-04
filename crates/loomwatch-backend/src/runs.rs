//! Loopback-only run control: start a team from the browser, watch it through the exact
//! archive stream, and stop it. See `docs/decisions/0008-run-control-api.md`.
//!
//! A run's `runId` is minted here, before any harness exists, and doubles as the archive
//! `sessionId` every event of the run lands under — so a client can open
//! `/api/session/stream?session=<runId>` the moment `POST /api/runs` returns. The registry
//! is in-memory and lives as long as the daemon; it is not the immutable run record of
//! `RUN_PROVENANCE_CONTRACT.md`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, PoisonError, RwLock};
use std::time::Duration;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path as RoutePath, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::api::{ApiError, normalized_relative_path, resolve_existing_team_path};
use crate::approvals::{Approval, ReviewLine, TeamApprovals};
use crate::archive::EventArchive;
use crate::config::{DEFAULT_RUN_NOTION_TITLE, TeamConfig};
use crate::notion::{PublishError, Publisher};
use crate::operator::{OperatorAnswer, OperatorDesk, OperatorError};
use crate::watch_api::{ARCHIVE_DISABLED_MESSAGE, local_evidence};
use crate::{EventKind, SessionOutcome};

/// Same grace period the CLI gives a harness after its turn (`--exit-timeout-seconds 10`).
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Upper bound on a prompt body; the CLI passes prompts as one argument and has no cap.
const MAX_PROMPT_BYTES: usize = 64 * 1024;
/// How often a starting run looks for its first archived `process: spawned` event.
const SPAWN_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// CONTRACT §4: a normal turn with no response terminalizes as `failed` under this code —
/// the one failure kind the contract names for the runner's own outcome.
const MISSING_CANONICAL_RESPONSE: &str = "missing_canonical_response";
const PROCESS_CRASHED: &str = "process_crashed";
const PROTOCOL_FAILURE: &str = "protocol_failure";
const SPAWN_FAILED: &str = "spawn_failed";
/// Stable pre-acceptance codes from `RUN_PROVENANCE_CONTRACT` §11.
const STALE_TEAM_REVISION: &str = "stale_team_revision";
/// A run refused until the operator reviews what the team file starts (ADR 0048).
const TEAM_NEEDS_REVIEW: &str = "team_needs_review";
const IDEMPOTENCY_CONFLICT: &str = "idempotency_conflict";
/// What a record left non-terminal by a previous process is failed with at boot. Operator-facing
/// prose, not a code: the contract defines no code for a supervisor that went away, and the UI
/// already renders a `failed` record with its error verbatim.
pub const INTERRUPTED_BY_RESTART: &str = "interrupted by daemon restart";

/// Lifecycle of one run. Transitions only move forward; terminal states never change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Starting,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Queued => 0,
            Self::Starting => 1,
            Self::Running => 2,
            Self::Succeeded | Self::Failed | Self::Cancelled => 3,
        }
    }
}

/// What started a run: an operator through `POST /api/runs`, or a team file's `schedule`
/// block (timed fire or "run the routine now").
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunTrigger {
    #[default]
    Manual,
    Schedule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryTarget {
    Notion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    /// A new page holds the reply; `url` points at it.
    Published,
    /// A page with this title already existed; `url` points at that page.
    Skipped,
    /// Nothing was delivered; `message` says why.
    Failed,
}

/// Where a routine run's canonical reply went once the run finished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub target: DeliveryTarget,
    pub status: DeliveryStatus,
    pub url: Option<String>,
    pub page_id: Option<String>,
    /// Operator-facing outcome, never empty.
    pub message: String,
    pub delivered_at: String,
}

impl Delivery {
    /// A Notion outcome stamped with the current time.
    #[must_use]
    pub fn notion(
        status: DeliveryStatus,
        url: Option<String>,
        page_id: Option<String>,
        message: String,
    ) -> Self {
        Self {
            target: DeliveryTarget::Notion,
            status,
            url,
            page_id,
            message,
            delivered_at: now(),
        }
    }
}

/// One run as the HTTP API reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    /// UUID v4 minted by `LoomWatch` before any process exists.
    pub run_id: String,
    /// Always equal to `run_id`: the archive session every event of this run lands under.
    pub session_id: String,
    /// Normalised path relative to the teams root, `/`-separated.
    pub team_path: String,
    pub prompt: String,
    pub status: RunStatus,
    /// `"team"` when the file has no edges, `"pipeline"` otherwise.
    pub mode: String,
    pub entrypoint: String,
    /// Whose reply is the run's canonical answer: the entrypoint in team mode, the last
    /// node of the topological order in pipeline mode.
    pub responder: String,
    /// Agent IDs in file order.
    pub agent_ids: Vec<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// The runner's error, verbatim, once `failed`.
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    /// The daemon's stable machine-readable error code, once `failed` (CONTRACT §3). `None`
    /// when the failure kind has no contract-defined code — absence is carried honestly,
    /// never a minted token.
    pub error_code: Option<String>,
    /// The daemon's terminal stop reason, verbatim, when one is known (CONTRACT §3).
    pub stop_reason: Option<String>,
    pub event_count: Option<usize>,
    /// The canonical reply once `succeeded`.
    pub reply: Option<String>,
    #[serde(default)]
    pub trigger: RunTrigger,
    /// Set after a run's reply has been delivered (or not): automatically once a run whose team
    /// delivers succeeds (ADR 0010, ADR 0038), or when the operator sends it by hand.
    #[serde(default)]
    pub delivery: Option<Delivery>,
    /// The Notion page title this run's reply is published under once it succeeds, fixed at
    /// launch from the team's `deliver` (or a routine's `schedule.deliver`); absent when the run
    /// delivers nowhere. It is what lets a client say "sending to Notion" between the run's end
    /// and its `delivery`. Not stored: a record read back after a restart has its `delivery`
    /// already or never will.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver_title: Option<String>,
    /// The run this one continues from. Its stages before [`Self::start_at`] are replayed from
    /// `context_packets` rather than re-run.
    ///
    /// A field and a column in this change, with **no behaviour**: `POST /api/runs` gains it in
    /// Canvas B. Shipping the record shape first is what makes that a handler change instead of a
    /// handler change plus a migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follows_run_id: Option<String>,
    /// The stage id a follow-up starts executing at. `None` means from the beginning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    /// The run this one is a retry of. Retry is the explicit from-zero action, so this is lineage
    /// for the history thread and never a replay instruction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of_run_id: Option<String>,
    /// What the run is waiting for, when it is waiting: `{node, agent, since, question}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_on: Option<Value>,
    /// Requests an agent's app is blocked on until the operator answers (ADR 0040). Live only:
    /// emptied when the run ends and never stored, since a restart ends every run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permission_requests: Vec<crate::permissions::PermissionRequest>,
}

impl RunRecord {
    /// Build a `queued` record for a validated team.
    ///
    /// # Errors
    ///
    /// Returns an error when the team's pipeline order cannot be computed, which
    /// [`TeamConfig::load`] has normally already ruled out.
    pub fn queued(
        team_path: String,
        prompt: String,
        team: &TeamConfig,
        trigger: RunTrigger,
    ) -> anyhow::Result<Self> {
        let mode = if team.edges.is_empty() {
            "team"
        } else {
            "pipeline"
        };
        let responder = team.responder_id()?;
        let run_id = Uuid::new_v4().to_string();
        Ok(Self {
            session_id: run_id.clone(),
            run_id,
            team_path,
            prompt,
            status: RunStatus::Queued,
            mode: mode.to_owned(),
            entrypoint: team.entrypoint.clone(),
            responder,
            agent_ids: team.agents.iter().map(|agent| agent.id.clone()).collect(),
            created_at: now(),
            started_at: None,
            finished_at: None,
            error: None,
            exit_code: None,
            error_code: None,
            stop_reason: None,
            event_count: None,
            reply: None,
            trigger,
            delivery: None,
            deliver_title: None,
            follows_run_id: None,
            start_at: None,
            retry_of_run_id: None,
            waiting_on: None,
            permission_requests: Vec::new(),
        })
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Result of [`RunRegistry::cancel`].
#[derive(Debug)]
pub enum CancelOutcome {
    /// The run was live; its task has been aborted and the record marked `cancelled`.
    Cancelled(RunRecord),
    /// The run had already reached a terminal state; nothing changed.
    AlreadyFinished(RunRecord),
    NotFound,
}

struct RunEntry {
    record: RunRecord,
    handle: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct RegistryInner {
    runs: BTreeMap<String, RunEntry>,
    /// Insertion order, oldest first.
    order: Vec<String>,
    /// Start keys are scoped to the loopback principal. `LoomWatch` currently has one local
    /// principal; when authentication lands this becomes a `(principal, key)` index.
    start_keys: BTreeMap<String, StartKeyRecord>,
    /// The rendezvous behind "waiting for you", keyed by run: where the run task is parked, and
    /// the channel `POST /api/runs/{id}/answers` hands the answer to.
    ///
    /// In the registry rather than in a module of its own because `waiting_on` is a field of the
    /// run record and the registry is the authority on those; a second home for "is this run
    /// waiting" would be a second answer to the question. It is deliberately **not** persisted as
    /// a channel: a daemon restart fails every non-terminal record, so a wait cannot outlive the
    /// process that was holding it.
    waiting: BTreeMap<String, Vec<WaitingSlot>>,
    /// Sessions this daemon is keeping answerable, keyed `run_id\0agent_id`, so the operator's own
    /// follow-up can reach one without going through the Team Bus's HTTP surface.
    live: BTreeMap<String, mpsc::Sender<crate::operator::LiveTurn>>,
    /// The other half of each open permission request (ADR 0040), keyed by request id: the
    /// channel `POST /api/runs/{id}/permissions` hands the operator's decision to.
    asking: BTreeMap<String, oneshot::Sender<crate::permissions::PermissionDecision>>,
    /// What the operator allowed for the rest of a run, keyed `run_id\0agent_id\0scope`, where the
    /// scope is a tool kind or one MCP tool (`permissions::grant_scope`).
    allowed_for_run: BTreeSet<String>,
}

/// One run parked on the operator.
struct WaitingSlot {
    node: String,
    waiting_on: Value,
    answer: oneshot::Sender<crate::operator::OperatorAnswer>,
}

fn live_key(run_id: &str, agent_id: &str) -> String {
    format!("{run_id}\0{agent_id}")
}

#[derive(Debug, Clone)]
struct StartKeyRecord {
    fingerprint: String,
    run_id: String,
}

#[derive(Debug)]
enum StartKeyOutcome {
    Accepted,
    Duplicate(Box<RunRecord>),
    Conflict(String),
}

/// The `runs` table: the run record, as opposed to the run's evidence.
///
/// Separate from [`crate::archive::EventArchive`] on purpose. `run_events` is append-only
/// evidence with a sequence invariant; a `runs` row is mutable state whose status moves forward
/// and whose delivery is stamped after the run finishes. One type holding both sets of SQL is how
/// the append-only rule gets quietly broken by a convenience method.
#[derive(Clone)]
pub struct RunStore {
    pool: sqlx::PgPool,
}

/// How many records a cold cache loads at boot. The history list is bounded anyway (the archive's
/// own listing caps at 100), and a daemon that has run ten thousand teams should not pay for all
/// of them to answer "what did I run this week".
const RELOAD_LIMIT: i64 = 500;

impl RunStore {
    #[must_use]
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    /// Write the whole record, creating it or replacing what is stored.
    ///
    /// An upsert rather than an insert plus a set of targeted updates: the in-memory registry is
    /// the authority on a record's shape and already enforces the forward-only transition rules,
    /// so persistence has exactly one job — make the row equal the record. A partial update path
    /// would be a second place those rules could be got wrong.
    ///
    /// # Errors
    ///
    /// Returns an error when the record cannot be encoded or Postgres fails.
    pub async fn upsert(
        &self,
        record: &RunRecord,
        start_key: Option<&str>,
        start_fingerprint: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let agent_ids = serde_json::to_value(&record.agent_ids).unwrap_or(Value::Null);
        let delivery = record
            .delivery
            .as_ref()
            .and_then(|delivery| serde_json::to_value(delivery).ok());
        sqlx::query(
            "INSERT INTO runs
             (run_id, session_id, team_path, prompt, status, mode, entrypoint, responder,
              agent_ids, created_at, started_at, finished_at, error, exit_code, error_code,
              stop_reason, event_count, reply, trigger, delivery, follows_run_id, start_at,
              retry_of_run_id, waiting_on, start_key, start_fingerprint)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                     $18, $19, $20, $21, $22, $23, $24, $25, $26)
             ON CONFLICT (run_id) DO UPDATE SET
               status = EXCLUDED.status,
               started_at = EXCLUDED.started_at,
               finished_at = EXCLUDED.finished_at,
               error = EXCLUDED.error,
               exit_code = EXCLUDED.exit_code,
               error_code = EXCLUDED.error_code,
               stop_reason = EXCLUDED.stop_reason,
               event_count = EXCLUDED.event_count,
               reply = EXCLUDED.reply,
               delivery = EXCLUDED.delivery,
               follows_run_id = EXCLUDED.follows_run_id,
               start_at = EXCLUDED.start_at,
               retry_of_run_id = EXCLUDED.retry_of_run_id,
               waiting_on = EXCLUDED.waiting_on,
               -- Never cleared by a later write: the key binds for the lifetime of the run, and a
               -- transition that carries no key must not unbind it.
               start_key = COALESCE(EXCLUDED.start_key, runs.start_key),
               start_fingerprint =
                   COALESCE(EXCLUDED.start_fingerprint, runs.start_fingerprint)",
        )
        .bind(&record.run_id)
        .bind(&record.session_id)
        .bind(&record.team_path)
        .bind(&record.prompt)
        .bind(status_str(record.status))
        .bind(&record.mode)
        .bind(&record.entrypoint)
        .bind(&record.responder)
        .bind(&agent_ids)
        .bind(&record.created_at)
        .bind(&record.started_at)
        .bind(&record.finished_at)
        .bind(&record.error)
        .bind(record.exit_code)
        .bind(&record.error_code)
        .bind(&record.stop_reason)
        .bind(
            record
                .event_count
                .and_then(|count| i32::try_from(count).ok()),
        )
        .bind(&record.reply)
        .bind(match record.trigger {
            RunTrigger::Manual => "manual",
            RunTrigger::Schedule => "schedule",
        })
        .bind(&delivery)
        .bind(&record.follows_run_id)
        .bind(&record.start_at)
        .bind(&record.retry_of_run_id)
        .bind(&record.waiting_on)
        .bind(start_key)
        .bind(start_fingerprint)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The most recent records, oldest first, with the start key each was submitted under.
    ///
    /// Oldest first because [`RunRegistry`] keeps insertion order and reverses it to list; loading
    /// in the order the runs were created is what makes a reloaded cache list the same way a live
    /// one does.
    ///
    /// # Errors
    ///
    /// Returns an error when Postgres fails or a row cannot be decoded.
    pub async fn recent(&self) -> Result<Vec<StoredRun>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT * FROM (
                 SELECT * FROM runs ORDER BY created_at DESC, run_id DESC LIMIT $1
             ) AS recent ORDER BY created_at ASC, run_id ASC",
        )
        .bind(RELOAD_LIMIT)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_run).collect()
    }
}

/// One stored run: the record, plus the idempotency binding it was submitted under.
pub struct StoredRun {
    pub record: RunRecord,
    pub start_key: Option<String>,
    pub start_fingerprint: Option<String>,
}

const fn status_str(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Queued => "queued",
        RunStatus::Starting => "starting",
        RunStatus::Running => "running",
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
    }
}

fn decode_run(row: &sqlx::postgres::PgRow) -> Result<StoredRun, sqlx::Error> {
    use sqlx::Row as _;
    let status: String = row.try_get("status")?;
    let trigger: String = row.try_get("trigger")?;
    let agent_ids: Value = row.try_get("agent_ids")?;
    let delivery: Option<Value> = row.try_get("delivery")?;
    let event_count: Option<i32> = row.try_get("event_count")?;
    Ok(StoredRun {
        record: RunRecord {
            run_id: row.try_get("run_id")?,
            session_id: row.try_get("session_id")?,
            team_path: row.try_get("team_path")?,
            prompt: row.try_get("prompt")?,
            status: match status.as_str() {
                "queued" => RunStatus::Queued,
                "starting" => RunStatus::Starting,
                "running" => RunStatus::Running,
                "succeeded" => RunStatus::Succeeded,
                "failed" => RunStatus::Failed,
                // The CHECK constraint leaves nothing else, and a stored status the daemon does
                // not recognise must not resurrect a run as live.
                _ => RunStatus::Cancelled,
            },
            mode: row.try_get("mode")?,
            entrypoint: row.try_get("entrypoint")?,
            responder: row.try_get("responder")?,
            agent_ids: serde_json::from_value(agent_ids).unwrap_or_default(),
            created_at: row.try_get("created_at")?,
            started_at: row.try_get("started_at")?,
            finished_at: row.try_get("finished_at")?,
            error: row.try_get("error")?,
            exit_code: row.try_get("exit_code")?,
            error_code: row.try_get("error_code")?,
            stop_reason: row.try_get("stop_reason")?,
            event_count: event_count.and_then(|count| usize::try_from(count).ok()),
            reply: row.try_get("reply")?,
            trigger: if trigger == "schedule" {
                RunTrigger::Schedule
            } else {
                RunTrigger::Manual
            },
            delivery: delivery.and_then(|value| serde_json::from_value(value).ok()),
            deliver_title: None,
            follows_run_id: row.try_get("follows_run_id")?,
            start_at: row.try_get("start_at")?,
            retry_of_run_id: row.try_get("retry_of_run_id")?,
            waiting_on: row.try_get("waiting_on")?,
            permission_requests: Vec::new(),
        },
        start_key: row.try_get("start_key")?,
        start_fingerprint: row.try_get("start_fingerprint")?,
    })
}

/// Every run the daemon knows, cached in memory and — when an archive is configured — durable.
///
/// The cache is the authority on a record's *shape*: it enforces the forward-only transition
/// rules, and [`RunStore::upsert`] only ever makes the row equal the record. Persistence is
/// therefore explicit rather than automatic: the async call sites that change a record call
/// [`Self::persist`] after it, and a registry with no store is exactly the in-memory registry
/// this was before, which is what the synchronous transition methods and every existing test
/// depend on.
#[derive(Clone, Default)]
pub struct RunRegistry {
    inner: Arc<RwLock<RegistryInner>>,
    store: Option<RunStore>,
    /// Where a finished run's reply is published (ADR 0038). Installed once at startup by the
    /// scheduler, shared by every clone; absent in tests and the CLI, where a delivery reports
    /// that publishing is unavailable rather than reaching the keychain.
    publisher: Arc<OnceLock<Arc<Publisher>>>,
    /// The team revisions the operator approved to run here (ADR 0048). Installed once at startup,
    /// before the scheduler's first tick; absent in tests and the CLI, which run what they are given.
    approvals: Arc<OnceLock<Arc<TeamApprovals>>>,
}

/// Opaque: the records are the API's to report, and the REST router's state only needs to be
/// printable as a whole.
impl std::fmt::Debug for RunRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RunRegistry")
            .field("durable", &self.store.is_some())
            .finish_non_exhaustive()
    }
}

impl RunRegistry {
    /// A registry backed by the `runs` table. Records still live in the cache; this is what makes
    /// them outlive the process.
    #[must_use]
    pub fn durable(store: RunStore) -> Self {
        Self {
            inner: Arc::default(),
            store: Some(store),
            publisher: Arc::default(),
            approvals: Arc::default(),
        }
    }

    /// Install the publisher every run's delivery goes through. The first call wins; the
    /// daemon makes exactly one.
    pub(crate) fn set_publisher(&self, publisher: Arc<Publisher>) {
        let _first = self.publisher.set(publisher);
    }

    fn publisher(&self) -> Option<Arc<Publisher>> {
        self.publisher.get().cloned()
    }

    /// Install the record of approved team revisions every run is checked against (ADR 0048). The
    /// first call wins; the daemon makes exactly one, before the scheduler starts.
    pub fn set_approvals(&self, approvals: Arc<TeamApprovals>) {
        let _first = self.approvals.set(approvals);
    }

    /// The approvals record, when the daemon installed one.
    pub(crate) fn approvals(&self) -> Option<Arc<TeamApprovals>> {
        self.approvals.get().cloned()
    }

    /// Write one cached record through to Postgres. A no-op without a store.
    ///
    /// Called after a transition rather than inside it, because the transition methods are
    /// synchronous and used from both async handlers and synchronous tests. A failed write is
    /// returned rather than swallowed: a run whose record did not persist is a run the next boot
    /// will not know about, and the caller is the only thing that can say whether that matters
    /// enough to fail the request.
    ///
    /// # Errors
    ///
    /// Returns an error when Postgres fails.
    pub async fn persist(&self, run_id: &str) -> Result<(), sqlx::Error> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        let binding = {
            let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
            let Some(entry) = inner.runs.get(run_id) else {
                return Ok(());
            };
            let key = inner
                .start_keys
                .iter()
                .find(|(_, bound)| bound.run_id == run_id)
                .map(|(key, bound)| (key.clone(), bound.fingerprint.clone()));
            (entry.record.clone(), key)
        };
        let (record, key) = binding;
        store
            .upsert(
                &record,
                key.as_ref().map(|(key, _)| key.as_str()),
                key.as_ref().map(|(_, fingerprint)| fingerprint.as_str()),
            )
            .await
    }

    /// Fill a cold cache from the `runs` table. Returns how many records were recovered.
    ///
    /// Called once at boot. A recovered run is a *record*, never a live task: its
    /// [`RunEntry::handle`] is `None`, so cancelling it changes the record and aborts nothing,
    /// which is the truth after a restart.
    ///
    /// # Errors
    ///
    /// Returns an error when Postgres fails or a row cannot be decoded.
    pub async fn reload(&self) -> Result<usize, sqlx::Error> {
        let Some(store) = &self.store else {
            return Ok(0);
        };
        let stored = store.recent().await?;
        let interrupted = {
            let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
            let mut recovered = 0usize;
            let mut interrupted = Vec::new();
            for run in stored {
                let run_id = run.record.run_id.clone();
                if inner.runs.contains_key(&run_id) {
                    continue;
                }
                if let (Some(key), Some(fingerprint)) = (run.start_key, run.start_fingerprint) {
                    inner.start_keys.insert(
                        key,
                        StartKeyRecord {
                            fingerprint,
                            run_id: run_id.clone(),
                        },
                    );
                }
                let mut record = run.record;
                // A record left `queued`, `starting` or `running` by a *previous process* is not a
                // run whose state is unknown — it is a run whose supervisor is gone. This process
                // has no task handle for it, nothing will ever advance it, and the contract's own
                // state diagram sends a supervisor failure to `failed`. ADR 0015 deferred this and
                // named the columns it would need; ADR 0016 takes the decision.
                //
                // The claim made here is about the *daemon*, not about the harness: the error says
                // the run was interrupted by a restart, and `error_code` stays absent because the
                // contract defines no code for this and a minted token would be worse than none.
                if !record.status.is_terminal() {
                    record.status = RunStatus::Failed;
                    record.finished_at = Some(now());
                    record.error = Some(INTERRUPTED_BY_RESTART.to_owned());
                    interrupted.push(run_id.clone());
                }
                inner.runs.insert(
                    run_id.clone(),
                    RunEntry {
                        record,
                        handle: None,
                    },
                );
                inner.order.push(run_id);
                recovered += 1;
            }
            (recovered, interrupted)
        };
        let (recovered, interrupted) = interrupted;
        // Written back outside the lock: a reconciled status the next boot would have to redo is
        // not a reconciliation, and `persist` takes the read lock itself.
        for run_id in &interrupted {
            self.persist(run_id).await?;
        }
        if !interrupted.is_empty() {
            println!(
                "marked {} interrupted run record{} failed",
                interrupted.len(),
                if interrupted.len() == 1 { "" } else { "s" }
            );
        }
        Ok(recovered)
    }

    /// Register a new run. Its `run_id` must be unique.
    pub fn insert(&self, record: RunRecord) {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        let run_id = record.run_id.clone();
        inner.runs.insert(
            run_id.clone(),
            RunEntry {
                record,
                handle: None,
            },
        );
        inner.order.push(run_id);
    }

    /// Atomically bind a start key to a request fingerprint and insert its run. The lock
    /// makes two concurrent submissions with the same key enqueue at most once.
    fn insert_started(&self, record: RunRecord, key: &str, fingerprint: &str) -> StartKeyOutcome {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(bound) = inner.start_keys.get(key) {
            let run = inner
                .runs
                .get(&bound.run_id)
                .map(|entry| entry.record.clone());
            return if bound.fingerprint == fingerprint {
                run.map_or_else(
                    || StartKeyOutcome::Conflict(bound.run_id.clone()),
                    |record| StartKeyOutcome::Duplicate(Box::new(record)),
                )
            } else {
                StartKeyOutcome::Conflict(bound.run_id.clone())
            };
        }

        let run_id = record.run_id.clone();
        inner.runs.insert(
            run_id.clone(),
            RunEntry {
                record,
                handle: None,
            },
        );
        inner.order.push(run_id.clone());
        inner.start_keys.insert(
            key.to_owned(),
            StartKeyRecord {
                fingerprint: fingerprint.to_owned(),
                run_id,
            },
        );
        StartKeyOutcome::Accepted
    }

    fn find_started(&self, key: &str, fingerprint: &str) -> Option<StartKeyOutcome> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        let bound = inner.start_keys.get(key)?;
        Some(if bound.fingerprint == fingerprint {
            inner.runs.get(&bound.run_id).map_or_else(
                || StartKeyOutcome::Conflict(bound.run_id.clone()),
                |entry| StartKeyOutcome::Duplicate(Box::new(entry.record.clone())),
            )
        } else {
            StartKeyOutcome::Conflict(bound.run_id.clone())
        })
    }

    fn get_by_start_key(&self, key: &str) -> Option<RunRecord> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        let run_id = &inner.start_keys.get(key)?.run_id;
        inner.runs.get(run_id).map(|entry| entry.record.clone())
    }

    /// Remember the task driving a run so [`Self::cancel`] can abort it.
    pub fn attach(&self, run_id: &str, handle: JoinHandle<()>) {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = inner.runs.get_mut(run_id) {
            entry.handle = Some(handle);
        }
    }

    #[must_use]
    pub fn get(&self, run_id: &str) -> Option<RunRecord> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        inner.runs.get(run_id).map(|entry| entry.record.clone())
    }

    /// Every run, newest first.
    #[must_use]
    pub fn list(&self) -> Vec<RunRecord> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        inner
            .order
            .iter()
            .rev()
            .filter_map(|run_id| inner.runs.get(run_id))
            .map(|entry| entry.record.clone())
            .collect()
    }

    /// The newest run of `team_path` (normalised, relative to the teams root) that has not
    /// finished. A run waiting on the operator is `running`, so it counts; a record a previous
    /// process left unfinished does not, because [`Self::reload`] marked it failed.
    #[must_use]
    pub fn live_run_for(&self, team_path: &str) -> Option<RunRecord> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        inner
            .order
            .iter()
            .rev()
            .filter_map(|run_id| inner.runs.get(run_id))
            .find(|entry| entry.record.team_path == team_path && !entry.record.status.is_terminal())
            .map(|entry| entry.record.clone())
    }

    /// `queued → starting`; stamps `started_at`. `false` when the run was cancelled first.
    #[must_use]
    pub fn mark_starting(&self, run_id: &str) -> bool {
        self.advance(run_id, RunStatus::Starting, |record| {
            record.started_at = Some(now());
        })
    }

    /// `queued|starting → running`, once the first `process: spawned` event is archived.
    #[must_use]
    pub fn mark_running(&self, run_id: &str) -> bool {
        self.advance(run_id, RunStatus::Running, |_| {})
    }

    /// Terminal `succeeded` with the runner's outcome.
    #[must_use]
    pub fn mark_succeeded(
        &self,
        run_id: &str,
        outcome: &SessionOutcome,
        stop_reason: Option<String>,
    ) -> bool {
        self.advance(run_id, RunStatus::Succeeded, |record| {
            record.finished_at = Some(now());
            record.stop_reason = stop_reason;
            record.exit_code = Some(outcome.exit_code);
            record.event_count = Some(outcome.event_count);
            record.reply = Some(outcome.reply.clone());
        })
    }

    /// Terminal `failed`: the runner's error verbatim when something failed (null when the
    /// failure is a classification like CONTRACT §4's empty canonical reply), a stable
    /// machine-readable code when the failure kind has one, the terminal stop reason when
    /// the archive knows one, and whatever the archive recorded.
    #[must_use]
    pub fn mark_failed(
        &self,
        run_id: &str,
        error: Option<String>,
        error_code: Option<String>,
        stop_reason: Option<String>,
        exit_code: Option<i32>,
        event_count: Option<usize>,
    ) -> bool {
        self.advance(run_id, RunStatus::Failed, |record| {
            record.finished_at = Some(now());
            record.error = error;
            record.error_code = error_code;
            record.stop_reason = stop_reason;
            record.exit_code = exit_code;
            record.event_count = event_count;
        })
    }

    /// Open a permission request on a live run so the operator can answer it (ADR 0040), and hand
    /// back the end its decision arrives on. `None` when nobody can be asked: the run is unknown
    /// or finished, or it is a routine, whose runs have no one watching — those decline at once,
    /// as every request did before ADR 0040.
    pub(crate) fn open_permission_request(
        &self,
        run_id: &str,
        request: crate::permissions::PermissionRequest,
    ) -> Option<oneshot::Receiver<crate::permissions::PermissionDecision>> {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        let entry = inner.runs.get_mut(run_id)?;
        if entry.record.status.is_terminal() || entry.record.trigger == RunTrigger::Schedule {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        let id = request.id.clone();
        entry.record.permission_requests.push(request);
        inner.asking.insert(id, sender);
        Some(receiver)
    }

    /// Take a request off the record once it is answered, timed out or abandoned.
    pub(crate) fn close_permission_request(&self, run_id: &str, request_id: &str) {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        inner.asking.remove(request_id);
        if let Some(entry) = inner.runs.get_mut(run_id) {
            entry
                .record
                .permission_requests
                .retain(|request| request.id != request_id);
        }
    }

    /// Whether the operator already allowed `scope` for `agent` for the rest of this run.
    pub(crate) fn allowed_for_run(&self, run_id: &str, agent: &str, scope: &str) -> bool {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        inner
            .allowed_for_run
            .contains(&format!("{run_id}\0{agent}\0{scope}"))
    }

    /// The operator's answer to one open permission request, handed to the agent waiting on it.
    /// Answers the run as it is once the request is closed.
    ///
    /// # Errors
    ///
    /// Not found when the run or the request is unknown — already answered, declined after the
    /// wait, or the run ended.
    pub fn answer_permission(
        &self,
        run_id: &str,
        request_id: &str,
        decision: crate::permissions::PermissionDecision,
    ) -> Result<RunRecord, OperatorError> {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = inner.runs.get_mut(run_id) else {
            return Err(OperatorError::not_found(format!(
                "run {run_id} does not exist"
            )));
        };
        let Some(position) = entry
            .record
            .permission_requests
            .iter()
            .position(|request| request.id == request_id)
        else {
            return Err(OperatorError::not_found(
                "That request is no longer waiting: it was answered, or declined when nobody \
                 answered in time.",
            ));
        };
        let request = entry.record.permission_requests.remove(position);
        let record = entry.record.clone();
        if decision == crate::permissions::PermissionDecision::AllowRun {
            inner
                .allowed_for_run
                .insert(format!("{run_id}\0{}\0{}", request.agent, request.scope));
        }
        if let Some(sender) = inner.asking.remove(request_id) {
            let _delivered = sender.send(decision);
        }
        Ok(record)
    }

    /// Record where a run's reply went. Unlike status this is not a lifecycle transition:
    /// it is allowed on terminal records (delivery happens after the run finishes) and a
    /// later call overwrites an earlier outcome. `false` only when the run is unknown.
    pub fn set_delivery(&self, run_id: &str, delivery: Delivery) -> bool {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        match inner.runs.get_mut(run_id) {
            Some(entry) => {
                entry.record.delivery = Some(delivery);
                true
            }
            None => false,
        }
    }

    /// Abort a live run's task and mark it `cancelled`. Dropping the task drops its
    /// [`crate::acp::AcpProcess`], whose child was spawned with `kill_on_drop`, and its
    /// Team Bus teardown guard, which aborts delegated helpers the same way.
    pub fn cancel(&self, run_id: &str) -> CancelOutcome {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = inner.runs.get_mut(run_id) else {
            return CancelOutcome::NotFound;
        };
        if entry.record.status.is_terminal() {
            return CancelOutcome::AlreadyFinished(entry.record.clone());
        }
        if let Some(handle) = entry.handle.take() {
            handle.abort();
        }
        entry.record.waiting_on = None;
        entry.record.status = RunStatus::Cancelled;
        entry.record.finished_at = Some(now());
        let open = std::mem::take(&mut entry.record.permission_requests);
        let cancelled = entry.record.clone();
        forget_permissions(&mut inner, run_id, &open);
        CancelOutcome::Cancelled(cancelled)
    }

    /// Park a run on the operator: remember where the answer has to go, and stamp `waiting_on`.
    ///
    /// `false` when this run is already waiting on something — one open stop per run, which is
    /// what makes "the run is waiting for you" a sentence with one referent. The run's *status*
    /// is untouched: a parked run is still `running`, because nothing has failed and nothing is
    /// queued.
    pub(crate) fn register_wait(
        &self,
        run_id: &str,
        node: &str,
        answer: oneshot::Sender<OperatorAnswer>,
        waiting_on: Value,
    ) -> bool {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        if inner
            .runs
            .get(run_id)
            .is_some_and(|entry| entry.record.status.is_terminal())
            || inner
                .waiting
                .get(run_id)
                .is_some_and(|slots| slots.iter().any(|slot| slot.node == node))
        {
            return false;
        }
        let slots = inner.waiting.entry(run_id.to_owned()).or_default();
        slots.push(WaitingSlot {
            node: node.to_owned(),
            answer,
            waiting_on,
        });
        let first = slots[0].waiting_on.clone();
        if let Some(entry) = inner.runs.get_mut(run_id) {
            entry.record.waiting_on = Some(first);
        }
        true
    }

    /// Consume only the addressed question, advancing the visible queue atomically.
    pub(crate) fn take_wait(
        &self,
        run_id: &str,
        node: &str,
    ) -> Result<oneshot::Sender<OperatorAnswer>, OperatorError> {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        if inner
            .runs
            .get(run_id)
            .is_some_and(|entry| entry.record.status.is_terminal())
        {
            return Err(OperatorError::conflict(format!(
                "run {run_id} is already finished."
            )));
        }
        let slots = inner.waiting.get_mut(run_id).ok_or_else(|| {
            OperatorError::conflict(format!("run {run_id} is not waiting for an answer."))
        })?;
        let index = slots
            .iter()
            .position(|slot| slot.node == node)
            .ok_or_else(|| {
                OperatorError::conflict(format!("run {run_id} is not waiting on {node}."))
            })?;
        let slot = slots.remove(index);
        let next = slots.first().map(|slot| slot.waiting_on.clone());
        if slots.is_empty() {
            inner.waiting.remove(run_id);
        }
        if let Some(entry) = inner.runs.get_mut(run_id) {
            entry.record.waiting_on = next;
        }
        Ok(slot.answer)
    }

    pub(crate) fn waiting_for(&self, run_id: &str, node: &str) -> Option<Value> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        inner
            .waiting
            .get(run_id)?
            .iter()
            .find(|slot| slot.node == node)
            .map(|slot| slot.waiting_on.clone())
    }

    /// Update a queued question without overwriting a different agent's visible question.
    pub(crate) fn set_waiting_on(&self, run_id: &str, waiting_on: Option<Value>) -> bool {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        let Some(value) = waiting_on else {
            return false;
        };
        let Some(node) = value.get("node").and_then(Value::as_str) else {
            return false;
        };
        let Some(slots) = inner.waiting.get_mut(run_id) else {
            return false;
        };
        let Some(slot) = slots.iter_mut().find(|slot| slot.node == node) else {
            return false;
        };
        slot.waiting_on = value;
        let first = slots[0].waiting_on.clone();
        if let Some(entry) = inner.runs.get_mut(run_id) {
            if entry.record.status.is_terminal() {
                return false;
            }
            entry.record.waiting_on = Some(first);
        }
        true
    }

    /// Remember a session that can still take a turn, so the operator's follow-up can reach it.
    pub(crate) fn attach_live(
        &self,
        run_id: &str,
        agent_id: &str,
        sender: mpsc::Sender<crate::operator::LiveTurn>,
    ) {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        inner.live.insert(live_key(run_id, agent_id), sender);
    }

    pub(crate) fn detach_live(&self, run_id: &str, agent_id: &str) {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        inner.live.remove(&live_key(run_id, agent_id));
    }

    pub(crate) fn live_agent(
        &self,
        run_id: &str,
        agent_id: &str,
    ) -> Option<mpsc::Sender<crate::operator::LiveTurn>> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        inner.live.get(&live_key(run_id, agent_id)).cloned()
    }

    /// Persist, reporting a failure to the log rather than to the caller. The operator flow never
    /// fails an answer because a record could not be written: the answer is already archived in
    /// `run_events`, which is the half that matters.
    pub(crate) async fn persist_quietly(&self, run_id: &str) {
        persist_or_log(self, run_id).await;
    }

    /// The narrow handle onto the waiting room the pipeline and the Team Bus are given.
    #[must_use]
    pub fn operator_desk(&self, archive: Option<&EventArchive>) -> OperatorDesk {
        OperatorDesk::new(self.clone(), archive.map(EventArchive::questions))
    }

    /// Apply a forward-only transition. Terminal records are never modified, and a status
    /// can never move backwards (a late `running` after `failed` is dropped).
    fn advance(&self, run_id: &str, next: RunStatus, apply: impl FnOnce(&mut RunRecord)) -> bool {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = inner.runs.get_mut(run_id) else {
            return false;
        };
        let current = entry.record.status;
        if current.is_terminal() || next.rank() <= current.rank() {
            return false;
        }
        entry.record.status = next;
        apply(&mut entry.record);
        if next.is_terminal() {
            entry.record.waiting_on = None;
            entry.handle = None;
            let open = std::mem::take(&mut entry.record.permission_requests);
            forget_permissions(&mut inner, run_id, &open);
        }
        true
    }
}

/// Drop what a finished run's permission requests held. Dropping a sender is what tells a blocked
/// agent's asker the run is gone; the run's "allow for this run" grants go with it.
fn forget_permissions(
    inner: &mut RegistryInner,
    run_id: &str,
    open: &[crate::permissions::PermissionRequest],
) {
    for request in open {
        inner.asking.remove(&request.id);
    }
    let prefix = format!("{run_id}\0");
    inner
        .allowed_for_run
        .retain(|key| !key.starts_with(&prefix));
}

#[derive(Clone)]
struct RunsState {
    archive: Option<EventArchive>,
    teams_root: PathBuf,
    registry: RunRegistry,
}

/// Build the run-control router. `teams_root` must be the same canonical root the team
/// editor uses (`main` canonicalises once and hands it to both); a non-canonical path is
/// canonicalised here as a fallback. Every route is loopback-only and never cached.
pub fn router(archive: Option<EventArchive>, teams_root: PathBuf, registry: RunRegistry) -> Router {
    let teams_root = fs::canonicalize(&teams_root).unwrap_or(teams_root);
    Router::new()
        .route("/api/runs", post(start_run).get(list_runs))
        .route("/api/runs/{id}", get(get_run))
        .route("/api/runs/{id}/context", get(get_run_context))
        .route("/api/runs/{id}/checkpoints", get(get_run_checkpoints))
        .route("/api/runs/{id}/questions", get(get_run_questions))
        .route("/api/runs/{id}/answers", post(answer_run))
        .route("/api/runs/{id}/agents/{agent}/ask", post(ask_agent))
        .route("/api/runs/{id}/cancel", post(cancel_run))
        .route("/api/runs/{id}/deliver", post(deliver_run))
        .route("/api/runs/{id}/permissions", post(answer_permission))
        .route("/api/team/approve", post(approve_team))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(RunsState {
            archive,
            teams_root,
            registry,
        })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRunRequest {
    team_path: String,
    prompt: String,
    /// Optional during the compatibility rollout; the UI sends the revision returned by
    /// its conditional save. The contract's longer field name remains accepted as an alias.
    #[serde(default, alias = "expectedTeamRevision")]
    expected_revision: Option<String>,
    /// One key for the lifetime of a submit attempt. `clientRequestId` is the name used by
    /// the provenance contract and remains accepted while the composer adopts `startKey`.
    #[serde(default, alias = "clientRequestId")]
    start_key: Option<String>,
    /// Canvas B, decision 8: the run this one continues. Its stages before [`Self::start_at`] are
    /// replayed from the archive rather than re-executed.
    #[serde(default)]
    follows_run_id: Option<String>,
    /// The stage execution starts at. Must be a stage of the followed team's pipeline order;
    /// `None` means the whole pipeline, which is the only shape team mode allows.
    #[serde(default)]
    start_at: Option<String>,
    /// Memory phase 3: "Start a new run from this checkpoint". Implies the checkpoint's run as the
    /// run followed and the checkpoint's agent as the stage to start at, so a client sends this
    /// alone.
    #[serde(default)]
    from_checkpoint_id: Option<String>,
    /// The run this one is a retry of: the same prompt, from zero.
    ///
    /// Lineage, never a replay instruction — nothing is skipped and nothing is seeded. It is
    /// deliberately **not** checked against the registry the way `followsRunId` is: a retry of a
    /// run the daemon has forgotten is still a retry, the thread keeps an orphan at the top level,
    /// and refusing would make the label worse rather than the data better.
    #[serde(default)]
    retry_of_run_id: Option<String>,
}

#[derive(Debug)]
enum StartRunOutcome {
    Accepted(RunRecord),
    Duplicate(RunRecord),
    IdempotencyConflict { run_id: String },
}

#[derive(Debug)]
enum LaunchError {
    Api(ApiError),
    StaleRevision { current: String },
    NeedsReview(Box<NeedsReview>),
}

/// What the operator is shown before trusting a team file nobody approved here (ADR 0048).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NeedsReview {
    team_path: String,
    team_name: String,
    /// Approving this exact revision is what `POST /api/team/approve` takes.
    team_revision: String,
    review: Vec<ReviewLine>,
}

impl From<ApiError> for LaunchError {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl LaunchError {
    fn into_api_error(self) -> ApiError {
        match self {
            Self::Api(error) => error,
            Self::StaleRevision { current } => ApiError::new(
                StatusCode::CONFLICT,
                format!("team revision is stale; current revision is {current}"),
            ),
            Self::NeedsReview(review) => ApiError::new(
                StatusCode::CONFLICT,
                format!(
                    "{} was added or changed outside LoomWatch, so it doesn't run until you've \
                     checked what it runs. Open it in LoomWatch and run it once to review it.",
                    review.team_name
                ),
            ),
        }
    }
}

async fn start_run(
    State(state): State<RunsState>,
    body: Result<Json<StartRunRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid run request: {}", rejection.body_text()),
        )
    })?;
    let outcome = launch_manual(
        &state.registry,
        state.archive.clone(),
        &state.teams_root,
        &request,
    )
    .await;
    match outcome {
        Ok(StartRunOutcome::Accepted(record)) => {
            // Persist before answering: a record the operator has been given a run id for has to
            // outlive the process, and the start key it was bound to has to outlive it too or a
            // resubmit after a restart starts a second run.
            persist_or_log(&state.registry, &record.run_id).await;
            Ok((StatusCode::ACCEPTED, Json(record)).into_response())
        }
        Ok(StartRunOutcome::Duplicate(record)) => {
            Ok((StatusCode::OK, Json(record)).into_response())
        }
        Ok(StartRunOutcome::IdempotencyConflict { run_id }) => Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "start key is already bound to a different request",
                "code": IDEMPOTENCY_CONFLICT,
                "runId": run_id,
            })),
        )
            .into_response()),
        Err(LaunchError::StaleRevision { current }) => Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "the team file changed before the run could start",
                "code": STALE_TEAM_REVISION,
                "currentTeamRevision": current,
            })),
        )
            .into_response()),
        Err(LaunchError::NeedsReview(review)) => {
            let mut body = serde_json::to_value(&*review).unwrap_or_else(|_| json!({}));
            body["error"] = json!("Review what this team runs before it starts.");
            body["code"] = json!(TEAM_NEEDS_REVIEW);
            Ok((StatusCode::CONFLICT, Json(body)).into_response())
        }
        Err(LaunchError::Api(error)) => Err(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApproveTeamRequest {
    team_path: String,
    /// The revision the operator was shown in the review. A file that changed since is not
    /// approved, so nobody approves bytes they never saw.
    team_revision: String,
}

/// `POST /api/team/approve`: the operator read what a team file runs and chose to trust it
/// (ADR 0048). Approves exactly the revision they were shown; a file that changed since answers
/// 409 `stale_team_revision` with the current revision, and the UI shows the review again.
async fn approve_team(
    State(state): State<RunsState>,
    body: Result<Json<ApproveTeamRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid approval: {}", rejection.body_text()),
        )
    })?;
    let resolved = resolve_existing_team_path(&state.teams_root, Path::new(&request.team_path))?;
    let relative = normalized_relative_path(&state.teams_root, &resolved).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "team path {} is not a UTF-8 path below the teams root",
                request.team_path
            ),
        )
    })?;
    let bytes = fs::read(&resolved).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("failed to read team file {}: {error}", resolved.display()),
        )
    })?;
    let current = team_revision(&bytes);
    if current != request.team_revision {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "the team file changed after you reviewed it",
                "code": STALE_TEAM_REVISION,
                "currentTeamRevision": current,
            })),
        )
            .into_response());
    }
    if let Some(approvals) = state.registry.approvals() {
        approvals
            .approve(&relative, &current, Approval::Reviewed)
            .map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("LoomWatch could not keep your approval: {error}"),
                )
            })?;
    }
    Ok((
        StatusCode::OK,
        Json(json!({ "teamPath": relative, "teamRevision": current })),
    )
        .into_response())
}

async fn launch_manual(
    registry: &RunRegistry,
    archive: Option<EventArchive>,
    teams_root: &Path,
    request: &StartRunRequest,
) -> Result<StartRunOutcome, LaunchError> {
    let expected_revision = request.expected_revision.as_deref();
    let start_key = request.start_key.as_deref();
    let fingerprint = start_key.map(|_| {
        let base = start_fingerprint(&request.team_path, &request.prompt, expected_revision);
        if request.follows_run_id.is_none()
            && request.start_at.is_none()
            && request.from_checkpoint_id.is_none()
            && request.retry_of_run_id.is_none()
        {
            base
        } else {
            json!([
                base,
                request.follows_run_id,
                request.start_at,
                request.from_checkpoint_id,
                request.retry_of_run_id
            ])
            .to_string()
        }
    });
    if let (Some(key), Some(fingerprint)) = (start_key, fingerprint.as_deref()) {
        if key.is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "startKey must not be empty.".to_owned(),
            )
            .into());
        }
        if let Some(outcome) = registry.find_started(key, fingerprint) {
            return Ok(match outcome {
                StartKeyOutcome::Duplicate(record) => StartRunOutcome::Duplicate(*record),
                StartKeyOutcome::Conflict(run_id) => {
                    StartRunOutcome::IdempotencyConflict { run_id }
                }
                StartKeyOutcome::Accepted => unreachable!("lookup never accepts a start key"),
            });
        }
    }

    let approvals = registry.approvals();
    let mut prepared = prepare_run(
        archive,
        teams_root,
        Path::new(&request.team_path),
        &request.prompt,
        RunTrigger::Manual,
        expected_revision,
        approvals.as_deref(),
    )?;
    // Resolve and check the lineage *before* the run is registered or a harness spawns. Every
    // refusal here is a 4xx on a run that never existed, which is the only place they can be
    // without having already cost the operator a process.
    resolve_continuation(registry, &mut prepared, request).await?;
    // Retry lineage is a column, not a `Map` in the browser: a reloaded page still says
    // "Retry of Run 07". Written after `resolve_continuation` so an explicit `retryOfRunId` wins
    // over the one a checkpoint continuation derives, which is the more specific claim.
    if let Some(retried) = request
        .retry_of_run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        prepared.record.retry_of_run_id = Some(retried.to_owned());
    }
    let record = prepared.record.clone();
    let run_id = record.run_id.clone();
    if let (Some(key), Some(fingerprint)) = (start_key, fingerprint.as_deref()) {
        match registry.insert_started(record.clone(), key, fingerprint) {
            StartKeyOutcome::Accepted => {}
            StartKeyOutcome::Duplicate(existing) => {
                return Ok(StartRunOutcome::Duplicate(*existing));
            }
            StartKeyOutcome::Conflict(run_id) => {
                return Ok(StartRunOutcome::IdempotencyConflict { run_id });
            }
        }
    } else {
        registry.insert(record);
    }
    spawn_prepared(registry, prepared, &run_id);
    registry
        .get(&run_id)
        .map(StartRunOutcome::Accepted)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("run {run_id} vanished from the registry"),
            )
            .into()
        })
}

/// Resolve `followsRunId` / `startAt` / `fromCheckpointId` into a checked [`crate::RunLineage`],
/// and stamp the lineage columns on the record.
///
/// Every refusal in here is deliberate and deliberately early:
///
/// * **The followed run must be in the `runs` table.** An archive-only session has evidence but no
///   record, so nothing can say which team file it executed — and replaying its handovers into a
///   different team's pipeline is how a follow-up produces confident nonsense.
/// * **It must be the same team file.** Same reason, one step less obvious.
/// * **`startAt` must be a stage of the current pipeline order**, checked against the order of the
///   revision *this* run is pinned to, not against whatever is on disk.
/// * **Team mode allows only the whole pipeline.** There is no configured order to start part way
///   through; `edges: []` means the entrypoint decides, and "from the third agent" is not a thing
///   the file expresses.
/// * **A skipped stage with no stored handover refuses the run, naming the stage.** Continuing
///   without it would silently hand the first executed stage nothing where it had been handed a
///   page, and it would look like a successful cheap follow-up.
///
/// The handover is read from the followed run's archived **prompt record** (`prompt_sections`'
/// `stage_results` section), not from `context_packets`: a packet holds the memory section, and the
/// handover a stage was given is in the prompt record. That is the only place the exact text lives.
async fn resolve_continuation(
    registry: &RunRegistry,
    prepared: &mut PreparedRun,
    request: &StartRunRequest,
) -> Result<(), LaunchError> {
    let bad = |message: String| LaunchError::Api(ApiError::new(StatusCode::BAD_REQUEST, message));
    let notebook = prepared.archive.notebook();

    // "Start a new run from this checkpoint" sends only the checkpoint id; the run it follows and
    // the stage it starts at are properties of the checkpoint, not choices the client makes.
    let checkpoint = match request.from_checkpoint_id.as_deref() {
        None => None,
        Some(id) => Some(
            notebook
                .checkpoint(id)
                .await
                .map_err(|error| {
                    LaunchError::Api(ApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        error.message,
                    ))
                })?
                .ok_or_else(|| {
                    LaunchError::Api(ApiError::new(
                        StatusCode::NOT_FOUND,
                        format!("checkpoint {id} does not exist."),
                    ))
                })?,
        ),
    };
    let follows = request
        .follows_run_id
        .clone()
        .or_else(|| checkpoint.as_ref().map(|point| point.run_id.clone()));
    let start_at = request.start_at.clone().or_else(|| {
        // In team mode a checkpoint's stage is *not* a `startAt`: there is no configured order, so
        // there is nothing to skip and nothing to replay. The run simply opens with the
        // checkpoint. Deriving one anyway would make "Start a new run from this checkpoint" refuse
        // itself on every team-mode team.
        checkpoint
            .as_ref()
            .filter(|_| !prepared.order.is_empty())
            .map(|point| point.agent_id.clone())
    });
    let Some(follows) = follows else {
        if start_at.is_some() {
            return Err(bad(
                "startAt names a stage to begin at but no run to continue. Send followsRunId too."
                    .to_owned(),
            ));
        }
        return Ok(());
    };

    let followed = registry.get(&follows).ok_or_else(|| {
        LaunchError::Api(ApiError::new(
            StatusCode::NOT_FOUND,
            format!(
                "run {follows} is not in the runs table, so there is nothing to continue. A run \
                 the daemon has forgotten can be replayed but not followed."
            ),
        ))
    })?;
    if followed.team_path != prepared.record.team_path {
        return Err(bad(format!(
            "run {follows} ran {}, not {}. A follow-up continues the same team file.",
            followed.team_path, prepared.record.team_path
        )));
    }

    check_start_at(start_at.as_deref(), &prepared.order)?;

    let mut lineage = crate::RunLineage {
        start_at: start_at.clone(),
        ..std::mem::take(&mut prepared.lineage)
    };
    // Decision 8: following a *failed* run is allowed, and its output section is then simply
    // absent. Refusing would force a re-run of the stages that did not fail, which is the
    // expensive half of a bad trade.
    lineage.previous_output = followed
        .reply
        .as_deref()
        .map(str::trim)
        .filter(|reply| !reply.is_empty())
        .map(str::to_owned);
    if let Some(point) = checkpoint {
        let stale = crate::memory::checkpoint_staleness(
            &point,
            Some(&prepared.revision),
            crate::memory_root(&prepared.resolved),
        );
        lineage.checkpoint = Some((point, stale));
    }

    seed_replayed_handovers(
        &prepared.archive,
        &follows,
        &prepared.order,
        &prepared.predecessors,
        &mut lineage,
    )
    .await?;

    prepared.record.follows_run_id = Some(follows.clone());
    prepared.record.start_at.clone_from(&lineage.start_at);
    // A run started from a checkpoint is lineage on both axes: it replays like a follow-up, and it
    // is an attempt at the same work the earlier run was doing. The history thread shows the
    // follow-up relationship; `retry_of_run_id` is what says the two attempts are the same job.
    if request.from_checkpoint_id.is_some() {
        prepared.record.retry_of_run_id = Some(follows);
    }
    prepared.lineage = lineage;
    Ok(())
}

/// Refuse a `startAt` this pipeline cannot honour, before anything is created.
fn check_start_at(start_at: Option<&str>, order: &[String]) -> Result<(), LaunchError> {
    let Some(stage) = start_at else {
        return Ok(());
    };
    let bad = |message: String| LaunchError::Api(ApiError::new(StatusCode::BAD_REQUEST, message));
    if order.is_empty() {
        return Err(bad(format!(
            "this team has no configured edges, so it runs in team mode and has no stage to \
             start at. Follow it up as a whole pipeline instead of from {stage}."
        )));
    }
    if !order.iter().any(|id| id == stage) {
        return Err(bad(format!(
            "{stage} is not a stage of this pipeline. Its stages, in order, are: {}.",
            order.join(", ")
        )));
    }
    Ok(())
}

/// Seed the handover every stage fed by a *skipped* stage will be given, from the followed run.
///
/// A missing one refuses the run and names the stage: continuing without it would hand that stage
/// nothing where it had been handed a page, and it would look like a cheap follow-up that worked.
async fn seed_replayed_handovers(
    archive: &EventArchive,
    follows: &str,
    order: &[String],
    predecessors: &BTreeMap<String, Vec<String>>,
    lineage: &mut crate::RunLineage,
) -> Result<(), LaunchError> {
    let start_index = lineage.start_index(order);
    if start_index == 0 {
        return Ok(());
    }
    let skipped = &order[..start_index];
    let stored = stored_stage_results(archive, follows).await?;
    let directions = stored_prompt_section(
        archive,
        follows,
        crate::memory::PromptSectionKind::Direction,
    )
    .await?;
    for stage in &order[start_index..] {
        let feeding = predecessors.get(stage).map_or(&[][..], Vec::as_slice);
        let (replayed, live): (Vec<&String>, Vec<&String>) =
            feeding.iter().partition(|from| skipped.contains(from));
        if replayed.is_empty() {
            // Fed entirely by stages this run executes: nothing to replay.
            continue;
        }
        if !live.is_empty() {
            // A DAG join with predecessors on both sides of the boundary. What the archive stored
            // is the *joined* text, so replaying it would overwrite the half this run is about to
            // produce with the old one — a follow-up that silently ignored the work it just did.
            // Splitting the stored text back into per-predecessor parts is not possible: the join
            // is rendered, not structured. So this is refused, and the refusal says what to do.
            return Err(LaunchError::Api(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!(
                    "{stage} is fed by {} (which this follow-up would replay) and by {} (which it \
                     would re-run), and a replayed handover cannot be merged with one this run \
                     produces. Follow the run as a whole pipeline, or start at {stage}.",
                    replayed
                        .iter()
                        .map(|id| id.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    live.iter()
                        .map(|id| id.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            )));
        }
        let handover = stored.get(stage).cloned().ok_or_else(|| {
            LaunchError::Api(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!(
                    "run {follows} stored no handover for {stage}, so starting at {} would hand \
                     it nothing where it was handed its predecessors' results. Follow the run as \
                     a whole pipeline instead.",
                    lineage.start_at.as_deref().unwrap_or(stage)
                ),
            ))
        })?;
        lineage
            .replayed_stage_results
            .insert(stage.clone(), handover);
        if let Some(direction) = directions.get(stage) {
            lineage
                .replayed_directions
                .insert(stage.clone(), direction.clone());
        }
    }
    Ok(())
}

/// Every stage of one run and the `## Results from preceding stages` text it was given, read from
/// the archived prompt record.
async fn stored_stage_results(
    archive: &EventArchive,
    run_id: &str,
) -> Result<BTreeMap<String, String>, LaunchError> {
    stored_prompt_section(
        archive,
        run_id,
        crate::memory::PromptSectionKind::StageResults,
    )
    .await
}

async fn stored_prompt_section(
    archive: &EventArchive,
    run_id: &str,
    kind: crate::memory::PromptSectionKind,
) -> Result<BTreeMap<String, String>, LaunchError> {
    let events = archive.load_session(run_id).await.map_err(|error| {
        LaunchError::Api(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read run {run_id} to replay its handovers: {error:#}"),
        ))
    })?;
    let mut stored = BTreeMap::new();
    for event in &events {
        if event.kind != EventKind::SessionMeta || event.payload["phase"] != "prompt_sections" {
            continue;
        }
        let Ok(sections) = serde_json::from_value::<Vec<crate::memory::PromptSection>>(
            event.payload["sections"].clone(),
        ) else {
            continue;
        };
        if let Some(section) = sections.into_iter().find(|section| section.kind == kind) {
            stored.insert(event.agent_id.clone(), section.text);
        }
    }
    Ok(stored)
}

/// Validate a start request and launch the run: the one path every run takes, whether an
/// operator posted it or the scheduler fired it. `team_path` is resolved against
/// `teams_root` exactly as `POST /api/runs` resolves its body. Errors map to the
/// handler's statuses: 400 (blank or oversized prompt, not a regular file), 403 (outside
/// the root), 404 (missing), 422 (team validation), 503 (no archive).
///
/// # Errors
///
/// Returns the `ApiError` the handler would have answered with.
pub(crate) fn launch(
    registry: &RunRegistry,
    archive: Option<EventArchive>,
    teams_root: &Path,
    team_path: &Path,
    prompt: &str,
    trigger: RunTrigger,
) -> Result<RunRecord, ApiError> {
    let approvals = registry.approvals();
    let prepared = prepare_run(
        archive,
        teams_root,
        team_path,
        prompt,
        trigger,
        None,
        approvals.as_deref(),
    )
    .map_err(LaunchError::into_api_error)?;
    let record = prepared.record.clone();
    let run_id = record.run_id.clone();
    registry.insert(record);
    spawn_prepared(registry, prepared, &run_id);
    registry.get(&run_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("run {run_id} vanished from the registry"),
        )
    })
}

struct PreparedRun {
    record: RunRecord,
    archive: EventArchive,
    resolved: PathBuf,
    /// The canonical teams root, carried so the run can resolve `memory.inherits` — inherited
    /// teams and packs are bounded by the root, not by the team's own directory.
    teams_root: PathBuf,
    prompt: String,
    /// The pipeline order this run will execute, empty in team mode. Carried so a follow-up's
    /// `startAt` is checked against the order of the team file the run is *pinned to*, not against
    /// whatever is on disk when the request is served.
    order: Vec<String>,
    /// Each stage's **configured** predecessors, in edge order. The pipeline order alone cannot
    /// say who feeds whom — it is one linearization of a DAG — and a follow-up has to know exactly
    /// that to decide what it may replay.
    predecessors: BTreeMap<String, Vec<String>>,
    /// The team file's `sha256:` digest, recorded on every checkpoint this run writes.
    revision: String,
    /// What this run continues, once `POST /api/runs` has resolved and checked it.
    lineage: crate::RunLineage,
}

fn prepare_run(
    archive: Option<EventArchive>,
    teams_root: &Path,
    team_path: &Path,
    prompt: &str,
    trigger: RunTrigger,
    expected_revision: Option<&str>,
    approvals: Option<&TeamApprovals>,
) -> Result<PreparedRun, LaunchError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "prompt must not be empty.".to_owned(),
        )
        .into());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("prompt exceeds {MAX_PROMPT_BYTES} bytes."),
        )
        .into());
    }
    let resolved = resolve_existing_team_path(teams_root, team_path)?;
    if !resolved.is_file() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("team path {} is not a regular file", team_path.display()),
        )
        .into());
    }
    let relative = normalized_relative_path(teams_root, &resolved).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "team path {} is not a UTF-8 path below the teams root",
                team_path.display()
            ),
        )
    })?;
    let bytes = fs::read(&resolved).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("failed to read team file {}: {error}", resolved.display()),
        )
    })?;
    let current_revision = team_revision(&bytes);
    if expected_revision.is_some_and(|expected| expected != current_revision) {
        return Err(LaunchError::StaleRevision {
            current: current_revision,
        });
    }
    let source = std::str::from_utf8(&bytes).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("team file {} is not UTF-8: {error}", resolved.display()),
        )
    })?;
    let team = TeamConfig::parse(source)
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}")))?;
    check_approved(approvals, &relative, &current_revision, &team, &resolved)?;
    let Some(archive) = archive else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ARCHIVE_DISABLED_MESSAGE.to_owned(),
        )
        .into());
    };
    let mut record = RunRecord::queued(relative, prompt.to_owned(), &team, trigger)
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}")))?;
    // Fixed now, from the bytes this run executes: editing the team mid-run changes the next
    // run's delivery, not this one's.
    record.deliver_title = team.notion_delivery_title(
        trigger == RunTrigger::Schedule,
        &team_display_name(&team, &resolved),
        Utc::now(),
    );
    let order = if team.edges.is_empty() {
        Vec::new()
    } else {
        team.pipeline_order().map_err(|error| {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}"))
        })?
    };
    let mut predecessors: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in &team.edges {
        predecessors
            .entry(edge.to.clone())
            .or_default()
            .push(edge.from.clone());
    }
    Ok(PreparedRun {
        record,
        archive,
        resolved,
        teams_root: teams_root.to_path_buf(),
        prompt: prompt.to_owned(),
        order,
        predecessors,
        // Every run records the revision it executes on every checkpoint it writes, follow-up or
        // not: that is what makes a *later* continuation able to say whether the team file moved.
        // Setting it here rather than in `resolve_continuation` is why a plain run's checkpoints
        // carry it too.
        lineage: crate::RunLineage {
            team_revision: Some(current_revision.clone()),
            ..crate::RunLineage::default()
        },
        revision: current_revision,
    })
}

/// A team file nobody approved here starts nothing, scheduled or not (ADR 0048): it came from
/// outside `LoomWatch`, or changed there, and the operator has not seen what it runs.
fn check_approved(
    approvals: Option<&TeamApprovals>,
    relative: &str,
    revision: &str,
    team: &TeamConfig,
    resolved: &Path,
) -> Result<(), LaunchError> {
    match approvals {
        Some(approvals) if !approvals.is_approved(relative, revision) => {
            Err(LaunchError::NeedsReview(Box::new(NeedsReview {
                team_name: team_display_name(team, resolved),
                team_path: relative.to_owned(),
                team_revision: revision.to_owned(),
                review: crate::approvals::review(team),
            })))
        }
        _ => Ok(()),
    }
}

fn spawn_prepared(registry: &RunRegistry, prepared: PreparedRun, run_id: &str) {
    if let Some(title) = prepared.record.deliver_title.clone() {
        tokio::spawn(deliver_when_finished(
            registry.clone(),
            run_id.to_owned(),
            title,
        ));
    }
    let mut lineage = prepared.lineage;
    // Every run started through the API can reach a person; a `loomwatchd run` from the CLI
    // cannot, and a team file with a review stop is refused there rather than hanging.
    lineage.operator = Some(registry.operator_desk(Some(&prepared.archive)));
    let handle = tokio::spawn(execute(
        registry.clone(),
        prepared.archive,
        prepared.resolved,
        prepared.teams_root,
        prepared.prompt,
        run_id.to_owned(),
        Arc::new(lineage),
    ));
    registry.attach(run_id, handle);
}

fn team_revision(bytes: &[u8]) -> String {
    crate::approvals::revision(bytes)
}

// ---------------------------------------------------------------------------------------
// Delivery (ADR 0010, ADR 0038)
// ---------------------------------------------------------------------------------------

/// How often a delivery task looks for its run to finish.
const DELIVERY_POLL: Duration = Duration::from_millis(1000);
/// Delivery message when the duplicate-title guard skipped publishing.
pub(crate) const DUPLICATE_MESSAGE: &str = "A page with this title already exists.";
/// Delivery message when this daemon has no publisher (tests, a build without one).
const NO_PUBLISHER_MESSAGE: &str = "This LoomWatch cannot publish to Notion.";
/// Notion refuses a title longer than one rich-text item.
const MAX_TITLE_CHARS: usize = 2000;

/// The team's name for `{{team}}`, or its file stem when the file names none.
fn team_display_name(team: &TeamConfig, path: &Path) -> String {
    if team.name.trim().is_empty() {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("team")
            .to_owned()
    } else {
        team.name.clone()
    }
}

/// Wait for a run to finish and, when it succeeded with a reply, publish that reply under
/// `title` and record the outcome on the run. Every trigger goes through here, so a routine and
/// a run started by hand deliver the same way.
async fn deliver_when_finished(registry: RunRegistry, run_id: String, title: String) {
    let record = loop {
        match registry.get(&run_id) {
            Some(record) if record.status.is_terminal() => break record,
            Some(_) => tokio::time::sleep(DELIVERY_POLL).await,
            None => return,
        }
    };
    let Some(reply) = record
        .reply
        .as_deref()
        .filter(|reply| !reply.trim().is_empty())
    else {
        return;
    };
    if record.status != RunStatus::Succeeded {
        return;
    }
    let delivery = publish_reply(registry.publisher().as_deref(), &title, reply).await;
    record_delivery(&registry, &run_id, delivery).await;
}

/// Store a delivery on its run, persist it, and say what happened in the daemon log.
async fn record_delivery(registry: &RunRegistry, run_id: &str, delivery: Delivery) {
    let _known = registry.set_delivery(run_id, delivery.clone());
    persist_or_log(registry, run_id).await;
    println!(
        "delivery: run {run_id} {}: {}{}",
        serde_json::to_value(delivery.status)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default(),
        delivery.message,
        delivery
            .url
            .as_deref()
            .map_or_else(String::new, |url| format!(" {url}"))
    );
}

/// Publish `markdown` as a Notion page titled `title` and describe the outcome.
pub(crate) async fn publish_reply(
    publisher: Option<&Publisher>,
    title: &str,
    markdown: &str,
) -> Delivery {
    let Some(publisher) = publisher else {
        return Delivery::notion(
            DeliveryStatus::Failed,
            None,
            None,
            NO_PUBLISHER_MESSAGE.to_owned(),
        );
    };
    match publisher.publish(title, markdown).await {
        Ok(page) => Delivery::notion(
            DeliveryStatus::Published,
            Some(page.url),
            Some(page.page_id),
            format!("Published {title:?}."),
        ),
        Err(PublishError::Duplicate { page_id, url }) => Delivery::notion(
            DeliveryStatus::Skipped,
            Some(url),
            Some(page_id),
            DUPLICATE_MESSAGE.to_owned(),
        ),
        Err(PublishError::Failed(message)) => {
            Delivery::notion(DeliveryStatus::Failed, None, None, message)
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliverRunRequest {
    /// The page title, verbatim. Absent: the run's own delivery title, else the team's
    /// `deliver` template (or [`DEFAULT_RUN_NOTION_TITLE`]) expanded now.
    #[serde(default)]
    title: Option<String>,
}

/// `POST /api/runs/{id}/deliver`: send a finished run's reply to Notion now, whatever the team
/// file says — the operator's "Send to Notion". Answers the run with its new `delivery`; a
/// refused or failed publish is still `200`, because the delivery records why.
async fn deliver_run(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
    body: Result<Json<DeliverRunRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let request = match body {
        Ok(Json(request)) => request,
        // An empty body is "use the default title"; anything else unreadable is a mistake.
        Err(JsonRejection::MissingJsonContentType(_)) => DeliverRunRequest::default(),
        Err(rejection) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("invalid delivery request: {}", rejection.body_text()),
            ));
        }
    };
    let Some(record) = state.registry.get(&run_id) else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("run {run_id} does not exist"),
        ));
    };
    if !record.status.is_terminal() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "The run is still going. Send its answer once it finishes.".to_owned(),
        ));
    }
    if record.status == RunStatus::Succeeded
        && record.deliver_title.is_some()
        && record.delivery.is_none()
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "This answer is already on its way to Notion.".to_owned(),
        ));
    }
    let Some(reply) = record
        .reply
        .as_deref()
        .filter(|reply| !reply.trim().is_empty())
    else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "This run has no answer to send.".to_owned(),
        ));
    };
    let title = match request.title.as_deref().map(str::trim) {
        Some("") => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "The page title must not be empty.".to_owned(),
            ));
        }
        Some(title) if title.chars().count() > MAX_TITLE_CHARS => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("The page title must be at most {MAX_TITLE_CHARS} characters."),
            ));
        }
        Some(title) => title.to_owned(),
        None => record
            .deliver_title
            .clone()
            .unwrap_or_else(|| default_delivery_title(&state.teams_root, &record.team_path)),
    };
    let delivery = publish_reply(state.registry.publisher().as_deref(), &title, reply).await;
    record_delivery(&state.registry, &run_id, delivery).await;
    let record = state.registry.get(&run_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("run {run_id} vanished from the registry"),
        )
    })?;
    Ok((StatusCode::OK, Json(record)).into_response())
}

/// The title a hand-sent answer gets: the team's `deliver` template when the file still loads,
/// else [`DEFAULT_RUN_NOTION_TITLE`] named after the file.
fn default_delivery_title(teams_root: &Path, team_path: &str) -> String {
    let path = teams_root.join(team_path);
    let now = Utc::now();
    if let Ok(team) = TeamConfig::load(&path) {
        let name = team_display_name(&team, &path);
        return team
            .notion_delivery_title(false, &name, now)
            .unwrap_or_else(|| {
                crate::config::expand_template(DEFAULT_RUN_NOTION_TITLE, &name, now, None)
            });
    }
    let name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("team");
    crate::config::expand_template(DEFAULT_RUN_NOTION_TITLE, name, now, None)
}

/// Canonical JSON is straightforward for this fixed three-string object: keys are emitted
/// lexicographically and `serde_json` supplies JSON string escaping without normalisation.
fn start_fingerprint(team_path: &str, prompt: &str, expected_revision: Option<&str>) -> String {
    let revision = expected_revision.map_or_else(
        || "null".to_owned(),
        |value| serde_json::to_string(value).expect("a string always serializes"),
    );
    let prompt = serde_json::to_string(prompt).expect("a string always serializes");
    let team_path = serde_json::to_string(team_path).expect("a string always serializes");
    let canonical =
        format!("{{\"expectedRevision\":{revision},\"prompt\":{prompt},\"teamPath\":{team_path}}}");
    format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()))
}

/// Drive one run to a terminal state. Runs as its own task so `cancel` can abort it.
#[allow(clippy::too_many_arguments)]
async fn execute(
    registry: RunRegistry,
    archive: EventArchive,
    team_path: PathBuf,
    teams_root: PathBuf,
    prompt: String,
    run_id: String,
    lineage: Arc<crate::RunLineage>,
) {
    if !registry.mark_starting(&run_id) {
        // Cancelled between insertion and the first poll: never start a process for it. The
        // cancelled record is still worth persisting — a run that never started is a fact.
        persist_or_log(&registry, &run_id).await;
        return;
    }
    persist_or_log(&registry, &run_id).await;
    let run = crate::run_team_session_with_session_id(
        &team_path,
        Some(&teams_root),
        archive.clone(),
        &prompt,
        EXIT_TIMEOUT,
        run_id.clone(),
        &lineage,
    );
    tokio::pin!(run);
    let mut ticker = tokio::time::interval(SPAWN_POLL_INTERVAL);
    let mut spawned = false;
    let result = loop {
        tokio::select! {
            result = &mut run => break result,
            _ = ticker.tick(), if !spawned => {
                if first_process_spawned(&archive, &run_id).await {
                    spawned = true;
                    // A cancel can race any of these transitions; the registry keeps
                    // terminal states frozen, so a refused transition needs no handling.
                    let _applied = registry.mark_running(&run_id);
                    persist_or_log(&registry, &run_id).await;
                }
            }
        }
    };
    let responder = registry.get(&run_id).map(|record| record.responder);
    let _applied = match result {
        // CONTRACT §4: a normal turn with no response is `failed`
        // (`missing_canonical_response`), never a success with an empty reply. Nothing
        // failed, so `error` stays null and the stop reason names the final turn.
        Ok(outcome) if outcome.exit_code == 0 && outcome.reply.is_empty() => {
            let (_, _, stop_reason) = archived_exit(&archive, &run_id, responder.as_deref()).await;
            registry.mark_failed(
                &run_id,
                None,
                Some(MISSING_CANONICAL_RESPONSE.to_owned()),
                stop_reason,
                Some(outcome.exit_code),
                Some(outcome.event_count),
            )
        }
        Ok(outcome) => {
            let (_, _, stop_reason) = archived_exit(&archive, &run_id, responder.as_deref()).await;
            registry.mark_succeeded(&run_id, &outcome, stop_reason)
        }
        Err(error) => {
            let (exit_code, event_count, stop_reason) =
                archived_exit(&archive, &run_id, responder.as_deref()).await;
            let error_code = stable_error_code(&archive, &run_id, &error).await;
            // The run died — a request timeout, a crashed harness, a protocol fault — so whichever
            // stage was in flight never reached its boundary and never answered the checkpoint
            // request. Leave the trail the coordinator *can* leave, from what the archive holds.
            record_abandoned_checkpoints(&archive, &run_id, &lineage).await;
            registry.mark_failed(
                &run_id,
                Some(format!("{error:#}")),
                Some(error_code.to_owned()),
                stop_reason,
                exit_code,
                event_count,
            )
        }
    };
    persist_or_log(&registry, &run_id).await;
}

/// Leave a `coordinator` checkpoint for every agent of a dead run that did not write one itself.
///
/// This is the half of channel 4 that makes a run killed by the ten-minute ACP request timeout
/// continuable: the stage never got to answer, so `done` is the last thing it actually said in the
/// archive and `next` is empty — *unknown*, which the packet states in those words rather than
/// inventing a plan. An agent that already checkpointed keeps its own, stronger row.
///
/// Failures here are logged, never propagated: the run has already failed, and failing to record
/// why must not change what the operator is told about it.
async fn record_abandoned_checkpoints(
    archive: &EventArchive,
    run_id: &str,
    lineage: &crate::RunLineage,
) {
    let notebook = archive.notebook();
    let already = match notebook.agents_with_checkpoints(run_id).await {
        Ok(agents) => agents,
        Err(error) => {
            eprintln!(
                "warning: could not read run {run_id}'s checkpoints: {}",
                error.message
            );
            return;
        }
    };
    let Ok(events) = archive.load_session(run_id).await else {
        return;
    };
    // Every agent the archive saw, and the last thing each of them said. `agent_message` chunks
    // land as `Message` events with `role: "agent"`; the last one is the closest thing to "what
    // this stage had produced when the run died". They are joined by the live reply's rule, so
    // separate messages and turns stay separate paragraphs.
    let mut last_reply: BTreeMap<String, crate::acp::ReplyText> = BTreeMap::new();
    let mut seen: Vec<String> = Vec::new();
    for event in &events {
        if event.agent_id.is_empty() {
            continue;
        }
        if !seen.iter().any(|id| id == &event.agent_id) {
            seen.push(event.agent_id.clone());
        }
        let reply = last_reply.entry(event.agent_id.clone()).or_default();
        match event.kind {
            EventKind::Message if event.payload["role"] == "agent" => {
                if let Some(text) = event
                    .payload
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                {
                    reply.push(text, event.payload["messageId"].as_str());
                }
            }
            EventKind::Message => reply.end_message(),
            EventKind::ToolCall
            | EventKind::ToolUpdate
            | EventKind::Plan
            | EventKind::Permission => {
                reply.note_activity();
            }
            _ => {}
        }
    }
    for agent_id in seen {
        if already.iter().any(|id| id == &agent_id) {
            continue;
        }
        let request = crate::memory::CheckpointWrite {
            run_id: run_id.to_owned(),
            agent_id: agent_id.clone(),
            done: last_reply
                .get_mut(&agent_id)
                .map(crate::acp::ReplyText::take)
                .unwrap_or_default(),
            // Deliberately empty. The run ended abnormally, so nothing said what came next, and
            // a sentence here would be the daemon's guess wearing a stage's voice.
            next: String::new(),
            blockers: None,
            artifacts: Vec::new(),
            seq_high_water: i64::try_from(events.len()).ok(),
            source: crate::memory::CheckpointSource::Coordinator,
            team_revision: lineage.team_revision.clone(),
        };
        if let Err(error) = notebook.write_checkpoint(&request).await {
            eprintln!(
                "warning: could not record a coordinator checkpoint for {agent_id} in run \
                 {run_id}: {}",
                error.message
            );
        }
    }
}

/// Persist a record, reporting a failure to the log rather than to the caller.
///
/// A run's *execution* must not fail because its record could not be written: the evidence is
/// already in `run_events` and the operator is watching the stream. What must not happen is the
/// failure being silent, which is why it prints rather than being discarded.
async fn persist_or_log(registry: &RunRegistry, run_id: &str) {
    if let Err(error) = registry.persist(run_id).await {
        eprintln!("warning: could not persist run {run_id}: {error}");
    }
}

/// Whether the run's first archived event is the entrypoint's `process: spawned` marker.
async fn first_process_spawned(archive: &EventArchive, session_id: &str) -> bool {
    archive
        .event_page(session_id, -1, 1)
        .await
        .ok()
        .and_then(|page| page.into_iter().next())
        .is_some_and(|event| {
            event.kind == EventKind::Process && event.payload["phase"] == "spawned"
        })
}

/// What the archive knows about a finished run: the last terminal `process` marker's exit
/// code, how many events were archived, and the canonical responder's final `turn_end`
/// stop reason, when one was recorded.
async fn archived_exit(
    archive: &EventArchive,
    session_id: &str,
    responder: Option<&str>,
) -> (Option<i32>, Option<usize>, Option<String>) {
    let Ok(events) = archive.load_session(session_id).await else {
        return (None, None, None);
    };
    let exit_code = events
        .iter()
        .rev()
        .filter(|event| event.kind == EventKind::Process)
        .find_map(|event| event.payload.get("exitCode").and_then(Value::as_i64))
        .and_then(|code| i32::try_from(code).ok());
    let event_count = (!events.is_empty()).then_some(events.len());
    let stop_reason = responder.and_then(|responder| {
        events
            .iter()
            .rev()
            .find(|event| event.kind == EventKind::TurnEnd && event.agent_id == responder)
            .and_then(|event| event.payload.get("stopReason"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    (exit_code, event_count, stop_reason)
}

/// Classify a failed runner result using the process evidence the ACP driver records. A
/// protocol failure writes `session execution failed` into its crash marker; a completed
/// turn whose child exits unsuccessfully writes a plain `process: crashed` marker instead.
/// Spawn failures retain their structured context in the anyhow chain, including failures
/// from delegated or later pipeline processes after another process has already started.
async fn stable_error_code(
    archive: &EventArchive,
    session_id: &str,
    error: &anyhow::Error,
) -> &'static str {
    let events = archive.load_session(session_id).await.unwrap_or_default();
    let terminal_process = events.iter().rev().find(|event| {
        event.kind == EventKind::Process
            && matches!(event.payload["phase"].as_str(), Some("exited" | "crashed"))
    });
    let process_crashed = terminal_process.is_some_and(|event| event.payload["phase"] == "crashed");
    let crash_message = terminal_process
        .and_then(|event| event.payload.get("message"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    classify_failure_code(error, process_crashed, crash_message.as_deref())
}

fn classify_failure_code(
    error: &anyhow::Error,
    process_crashed: bool,
    crash_message: Option<&str>,
) -> &'static str {
    let spawn_context = error
        .chain()
        .any(|cause| cause.to_string().contains("failed to spawn ACP harness"));
    if spawn_context {
        return SPAWN_FAILED;
    }
    let protocol_marker =
        crash_message.is_some_and(|message| message.contains("session execution failed"));
    if process_crashed && !protocol_marker {
        PROCESS_CRASHED
    } else {
        PROTOCOL_FAILURE
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunsQuery {
    start_key: Option<String>,
}

async fn list_runs(
    State(state): State<RunsState>,
    Query(query): Query<RunsQuery>,
) -> Result<Response, ApiError> {
    if let Some(key) = query.start_key {
        if key.is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "startKey must not be empty.".to_owned(),
            ));
        }
        return state
            .registry
            .get_by_start_key(&key)
            .map(|record| Json(record).into_response())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::NOT_FOUND,
                    format!("no run exists for start key {key}"),
                )
            });
    }
    Ok(Json(state.registry.list()).into_response())
}

async fn get_run(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
) -> Result<Json<Value>, ApiError> {
    let record = state.registry.get(&run_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("run {run_id} does not exist"),
        )
    })?;
    let replyable: Vec<_> = {
        let inner = state
            .registry
            .inner
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        inner
            .live
            .keys()
            .filter_map(|key| key.strip_prefix(&format!("{run_id}\0")))
            .map(str::to_owned)
            .collect()
    };
    let mut value = serde_json::to_value(record).expect("run records are JSON values");
    value["replyableAgents"] = json!(replyable);
    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
struct ContextQuery {
    /// Narrow to one agent. Omitted returns every agent's packets for this run, which is what
    /// the Memory panel needs to say who was given what.
    #[serde(default)]
    agent: Option<String>,
}

/// `GET /api/runs/{id}/context?agent=` — what each agent was supplied, as stored before it was
/// sent.
///
/// The run id is the archive session id by construction (see [`RunRecord::session_id`]), so this
/// reads back for a replayed run exactly as it does for a live one, and an unknown run is an
/// empty list rather than a 404: a run from before packets existed supplied nothing, which is a
/// true answer and not an error.
async fn get_run_context(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
    Query(query): Query<ContextQuery>,
) -> Result<Json<Vec<crate::archive::StoredContextPacket>>, ApiError> {
    let archive = state.archive.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ARCHIVE_DISABLED_MESSAGE.to_owned(),
        )
    })?;
    let packets = archive
        .context_packets(&run_id, query.agent.as_deref())
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read the context packets for run {run_id}: {error:#}"),
            )
        })?;
    Ok(Json(packets))
}

/// `GET /api/runs/{id}/checkpoints?agent=` — where each of a run's stages stopped.
///
/// Read by the strip that offers "Start a new run from this checkpoint", which needs the
/// checkpoint's own words and its id. Like the packet read, an unknown run is an empty list rather
/// than a 404: a run from before checkpoints existed left none, which is a true answer.
async fn get_run_checkpoints(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
    Query(query): Query<ContextQuery>,
) -> Result<Json<Vec<crate::memory::Checkpoint>>, ApiError> {
    let archive = state.archive.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ARCHIVE_DISABLED_MESSAGE.to_owned(),
        )
    })?;
    archive
        .notebook()
        .checkpoints(&run_id, query.agent.as_deref())
        .await
        .map(Json)
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.message))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerRequest {
    /// The node the answer is for: the operator node of a review stop, or the agent that asked.
    /// Required, and checked, because an answer delivered to the wrong stop is worse than a
    /// refused one — the operator would have approved something they never read.
    node: String,
    text: String,
    /// "Send back to <predecessor>": the note goes to the stage before the stop instead of
    /// forward, and the stop runs again on what that stage produces next.
    #[serde(default)]
    send_back: Option<String>,
}

/// `POST /api/runs/{id}/answers` — answer a review stop or a parked `ask_user`.
///
/// The run task does the archiving, not this handler: the archive `seq` is that task's counter,
/// and a second log over the same session would restart it at zero. What this mints is the *id*
/// the answer's `message` event will carry, so the question row can be stamped with it and the
/// question and the evidence it produced read as one thing.
async fn answer_run(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
    body: Result<Json<AnswerRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid answer: {}", rejection.body_text()),
        )
    })?;
    if request.text.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "An answer must say something. Type what the team should do.".to_owned(),
        ));
    }
    let desk = state.registry.operator_desk(state.archive.as_ref());
    let waiting = desk.waiting(&run_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            format!("Run {run_id} is not waiting for an answer."),
        )
    })?;
    if waiting.node != request.node {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "Run {run_id} is waiting on {}, not on {}.",
                waiting.node, request.node
            ),
        ));
    }
    if let Some(target) = request.send_back.as_deref()
        && waiting.handover_from.as_deref() != Some(target)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "Send back must name the predecessor of this review stop.".to_owned(),
        ));
    }
    if request.send_back.is_some() && !waiting.send_back_available {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "There is no session left to send a note back to: {} Answer the stop instead, or \
                 start a new run from the checkpoint.",
                waiting.park_note
            ),
        ));
    }
    let continuation = if waiting.kind == crate::operator::StopKind::Question
        && waiting.park == crate::operator::ParkTier::Released
    {
        Some(continue_released_question(&state, &run_id, &waiting, &request).await?)
    } else {
        None
    };
    desk.deliver(
        &run_id,
        &request.node,
        OperatorAnswer {
            text: request.text,
            send_back: request.send_back,
            answer_event_id: Uuid::new_v4().to_string(),
        },
    )
    .await
    .map(|record| {
        let mut response =
            (StatusCode::ACCEPTED, Json(continuation.unwrap_or(record))).into_response();
        if waiting.park == crate::operator::ParkTier::Released
            && waiting.kind == crate::operator::StopKind::Question
        {
            response.headers_mut().insert(
                "x-loomwatch-continuation-of",
                run_id.parse().expect("run ids are valid header values"),
            );
        }
        response
    })
    .map_err(operator_status)
}

/// A released question becomes a new checkpoint continuation, explicitly identified in the response.
async fn continue_released_question(
    state: &RunsState,
    run_id: &str,
    waiting: &crate::operator::WaitingOn,
    request: &AnswerRequest,
) -> Result<RunRecord, ApiError> {
    let previous = state.registry.get(run_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("Run {run_id} does not exist."),
        )
    })?;
    let checkpoint = latest_checkpoint_id(state.archive.as_ref(), run_id, &request.node)
        .await
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "This session was released without a checkpoint. Start a new run with your answer."
                    .to_owned(),
            )
        })?;
    let start = StartRunRequest {
        team_path: previous.team_path,
        prompt: format!(
            "{}\n\n## Direction from you\nThe answer to your question ({}) is:\n{}",
            previous.prompt, waiting.question, request.text
        ),
        expected_revision: None,
        start_key: Some(format!(
            "answer:{run_id}:{}",
            waiting.question_id.as_deref().unwrap_or(&waiting.since)
        )),
        follows_run_id: None,
        start_at: None,
        from_checkpoint_id: Some(checkpoint),
        retry_of_run_id: None,
    };
    match launch_manual(
        &state.registry,
        state.archive.clone(),
        &state.teams_root,
        &start,
    )
    .await
    .map_err(LaunchError::into_api_error)?
    {
        StartRunOutcome::Accepted(record) | StartRunOutcome::Duplicate(record) => {
            persist_or_log(&state.registry, &record.run_id).await;
            Ok(record)
        }
        StartRunOutcome::IdempotencyConflict { .. } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "This question already started a continuation with a different answer.".to_owned(),
        )),
    }
}

#[derive(Debug, Deserialize)]
struct AskAgentRequest {
    text: String,
}

/// `POST /api/runs/{id}/agents/{agent}/ask` — the operator's own follow-up to an agent that did
/// **not** ask.
///
/// The same `ask_live` a stage uses, with the operator as the caller. 409 when the session has
/// been released, carrying the latest checkpoint id: "that conversation is over, here is where it
/// stopped" is the only honest answer, and it is also an actionable one.
async fn ask_agent(
    State(state): State<RunsState>,
    RoutePath((run_id, agent_id)): RoutePath<(String, String)>,
    body: Result<Json<AskAgentRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid follow-up: {}", rejection.body_text()),
        )
    })?;
    if request.text.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "A follow-up must say something.".to_owned(),
        ));
    }
    let desk = state.registry.operator_desk(state.archive.as_ref());
    match desk.ask_live(&run_id, &agent_id, &request.text).await {
        Ok(reply) => Ok((
            StatusCode::OK,
            Json(json!({"agent": agent_id, "reply": reply})),
        )
            .into_response()),
        Err(error) if error.conflict => {
            let checkpoint = latest_checkpoint_id(state.archive.as_ref(), &run_id, &agent_id).await;
            Ok((
                StatusCode::CONFLICT,
                Json(json!({
                    "error": error.message,
                    "agent": agent_id,
                    "checkpointId": checkpoint,
                })),
            )
                .into_response())
        }
        Err(error) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.message,
        )),
    }
}

/// The newest checkpoint one agent of one run left, for a 409 that has to say where to continue
/// from. `None` when there is no archive, or the agent never checkpointed.
async fn latest_checkpoint_id(
    archive: Option<&EventArchive>,
    run_id: &str,
    agent_id: &str,
) -> Option<String> {
    archive?
        .notebook()
        .checkpoints(run_id, Some(agent_id))
        .await
        .ok()?
        .into_iter()
        .next_back()
        .map(|checkpoint| checkpoint.id)
}

/// `GET /api/runs/{id}/questions` — the queue behind "waiting for you", open and answered.
async fn get_run_questions(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
) -> Result<Response, ApiError> {
    let archive = state.archive.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ARCHIVE_DISABLED_MESSAGE.to_owned(),
        )
    })?;
    archive
        .questions()
        .list(&run_id)
        .await
        .map(|questions| Json(questions).into_response())
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.message))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionAnswer {
    request_id: String,
    decision: crate::permissions::PermissionDecision,
}

/// `POST /api/runs/{id}/permissions` (ADR 0040): the operator's answer to one request an agent's
/// app is blocked on. `200` with the run once the agent has it; 404 when that request is no longer
/// waiting.
async fn answer_permission(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
    body: Result<Json<PermissionAnswer>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(answer) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid permission answer: {}", rejection.body_text()),
        )
    })?;
    let record = state
        .registry
        .answer_permission(&run_id, &answer.request_id, answer.decision)
        .map_err(operator_status)?;
    Ok((StatusCode::OK, Json(record)).into_response())
}

fn operator_status(error: OperatorError) -> ApiError {
    ApiError::new(
        if error.conflict {
            StatusCode::CONFLICT
        } else {
            StatusCode::NOT_FOUND
        },
        error.message,
    )
}

async fn cancel_run(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
) -> Response {
    match state.registry.cancel(&run_id) {
        CancelOutcome::Cancelled(record) => {
            persist_or_log(&state.registry, &run_id).await;
            // A cancelled run used to leave nothing to continue from. `cancel` aborts the run
            // task, so `execute` never reaches its abnormal-end sweep — the sweep has to be run
            // from here instead. It is safe to run twice: `record_abandoned_checkpoints` skips
            // every agent that already has a checkpoint, which is how a stage that reached its own
            // boundary keeps its own, stronger row.
            if let Some(archive) = state.archive.as_ref() {
                let lineage = crate::RunLineage {
                    team_revision: None,
                    ..crate::RunLineage::default()
                };
                record_abandoned_checkpoints(archive, &run_id, &lineage).await;
            }
            (StatusCode::OK, Json(record)).into_response()
        }
        CancelOutcome::AlreadyFinished(record) => {
            (StatusCode::CONFLICT, Json(record)).into_response()
        }
        CancelOutcome::NotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            format!("run {run_id} does not exist"),
        )
        .into_response(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;

    use super::*;
    use crate::test_support::process_is_alive;

    /// A fake ACP harness that answers `initialize`, `session/new`, `session/prompt` (with
    /// one agent chunk `done`) and `session/close`, then exits 0.
    pub(crate) const COMPLETING_HARNESS: &str = r#"#!/bin/sh
set -eu
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"harness-session","configOptions":[]}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"harness-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
"#;

    /// A fake harness that negotiates a session and then hangs inside `session/prompt`.
    /// `exec` makes the recorded pid the sleeping process itself, so "is the harness gone"
    /// is a question about exactly the process `kill_on_drop` must have killed.
    pub(crate) const SLEEPING_HARNESS: &str = r#"#!/bin/sh
set -eu
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sleepy","configOptions":[]}}'
IFS= read -r _
exec sleep 60
"#;

    /// A fake harness that completes the protocol cleanly — normal `end_turn`, clean
    /// exit — but emits no agent text: CONTRACT §4's normal turn with no response.
    const EMPTY_REPLY_HARNESS: &str = r#"#!/bin/sh
set -eu
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"quiet","configOptions":[]}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
"#;

    pub(crate) struct TeamsDir(pub(crate) PathBuf);

    impl TeamsDir {
        pub(crate) fn new() -> Self {
            let path = std::env::temp_dir().join(format!("loomwatch-runs-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create temporary teams root");
            Self(fs::canonicalize(&path).expect("canonical teams root"))
        }

        pub(crate) fn write_harness(&self, name: &str, script: &str) -> PathBuf {
            let path = self.0.join(name);
            let mut file = fs::File::create(&path).expect("create harness script");
            file.write_all(script.as_bytes()).expect("write harness");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .expect("mark harness executable");
            }
            path
        }

        /// A two-stage pipeline whose stages answer the full ADR 0013 + memory-phase-3 turn
        /// sequence: work, handover (first stage only), checkpoint, close.
        pub(crate) fn write_pipeline_team(&self, name: &str) -> PathBuf {
            let stage = |session: &str, reply: &str, handover: bool| {
                let (handover_turn, checkpoint_id, close_id) = if handover {
                    (
                        format!(
                            "IFS= read -r _\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"sessionId\":\"{session}\",\"update\":{{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{{\"type\":\"text\",\"text\":\"{reply} handover\"}}}}}}}}'\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{{\"stopReason\":\"end_turn\"}}}}'\n"
                        ),
                        5,
                        6,
                    )
                } else {
                    (String::new(), 4, 5)
                };
                let script = format!(
                    "#!/bin/sh\nset -eu\nIFS= read -r _\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"protocolVersion\":1}}}}'\nIFS= read -r _\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"sessionId\":\"{session}\",\"configOptions\":[]}}}}'\nIFS= read -r _\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"sessionId\":\"{session}\",\"update\":{{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{{\"type\":\"text\",\"text\":\"{reply}\"}}}}}}}}'\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{{\"stopReason\":\"end_turn\"}}}}'\n{handover_turn}IFS= read -r _\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"sessionId\":\"{session}\",\"update\":{{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{{\"type\":\"text\",\"text\":\"\\n## Done\\n{reply}\\n\\n## Next\\nnothing\"}}}}}}}}'\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":{checkpoint_id},\"result\":{{\"stopReason\":\"end_turn\"}}}}'\nIFS= read -r _\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":{close_id},\"result\":{{}}}}'\n"
                );
                self.write_harness(&format!("{session}.sh"), &script)
            };
            let first = stage("stage-a", "a done", true);
            let second = stage("stage-b", "b done", false);
            let yaml = format!(
                "schemaVersion: 1\nid: chain\nname: Two-stage chain\nentrypoint: a\nagents:\n  - id: a\n    name: A\n    role: first\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\n  - id: b\n    name: B\n    role: second\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\nedges:\n  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: 2026-09-13T00:00:00Z\n",
                first.display(),
                second.display()
            );
            let path = self.0.join(name);
            fs::write(&path, yaml).expect("write pipeline team file");
            path
        }

        fn write_team(&self, name: &str, harness: &Path) -> PathBuf {
            let yaml = format!(
                "schemaVersion: 1\nid: fake\nname: Fake harness team\nentrypoint: solo\nagents:\n  - id: solo\n    name: Solo\n    role: answer directly\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\n",
                harness.display()
            );
            let path = self.0.join(name);
            fs::write(&path, yaml).expect("write team file");
            path
        }
    }

    impl Drop for TeamsDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn post_json(uri: &str, body: &Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", "localhost")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn get_local(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header("host", "localhost")
            .body(Body::empty())
            .unwrap()
    }

    async fn json_body(response: Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).expect("JSON body")
    }

    async fn wait_for(
        registry: &RunRegistry,
        run_id: &str,
        done: impl Fn(&RunRecord) -> bool,
    ) -> RunRecord {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(record) = registry.get(run_id)
                    && done(&record)
                {
                    return record;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("run reached the awaited state in time")
    }

    fn permission_request(id: &str, kind: &str) -> crate::permissions::PermissionRequest {
        crate::permissions::PermissionRequest {
            id: id.to_owned(),
            agent: "a".to_owned(),
            name: "A".to_owned(),
            title: "Web search".to_owned(),
            kind: kind.to_owned(),
            switch: crate::permissions::switch_for(kind).map(str::to_owned),
            detail: None,
            since: now(),
            expires_at: now(),
            scope: kind.to_owned(),
        }
    }

    /// ADR 0040: a person-started run can be asked, a routine cannot; an answer reaches the waiting
    /// agent once and only once; "allow for this run" is remembered per agent and kind until the
    /// run ends; and ending a run lets go of everything it was waiting on.
    #[tokio::test]
    async fn permission_requests_are_asked_answered_once_and_dropped_with_the_run() {
        use crate::permissions::PermissionDecision;
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .unwrap();
        let registry = RunRegistry::default();
        let manual =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        let routine =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Schedule).unwrap();
        let (manual_id, routine_id) = (manual.run_id.clone(), routine.run_id.clone());
        registry.insert(manual);
        registry.insert(routine);

        assert!(
            registry
                .open_permission_request(&routine_id, permission_request("r1", "fetch"))
                .is_none(),
            "nobody watches a routine"
        );
        assert!(
            registry
                .open_permission_request("no-such-run", permission_request("x", "fetch"))
                .is_none()
        );

        let answer = registry
            .open_permission_request(&manual_id, permission_request("p1", "fetch"))
            .expect("a person-started run can ask");
        let wire = serde_json::to_value(registry.get(&manual_id).unwrap()).unwrap();
        assert_eq!(wire["permissionRequests"][0]["id"], "p1");
        assert_eq!(wire["permissionRequests"][0]["switch"], "web");
        assert!(!registry.allowed_for_run(&manual_id, "a", "fetch"));
        let record = registry
            .answer_permission(&manual_id, "p1", PermissionDecision::AllowRun)
            .expect("open");
        assert!(record.permission_requests.is_empty());
        assert_eq!(answer.await.unwrap(), PermissionDecision::AllowRun);
        assert!(registry.allowed_for_run(&manual_id, "a", "fetch"));
        assert!(!registry.allowed_for_run(&manual_id, "a", "execute"));
        // An MCP tool the app calls `execute` is granted as that tool, never as every command.
        let mut tool = permission_request("p-tool", "execute");
        tool.scope = "mcp:notion.search".to_owned();
        let tool_answer = registry
            .open_permission_request(&manual_id, tool)
            .expect("open");
        registry
            .answer_permission(&manual_id, "p-tool", PermissionDecision::AllowRun)
            .expect("open");
        assert_eq!(tool_answer.await.unwrap(), PermissionDecision::AllowRun);
        assert!(registry.allowed_for_run(&manual_id, "a", "mcp:notion.search"));
        assert!(!registry.allowed_for_run(&manual_id, "a", "execute"));
        assert!(!registry.allowed_for_run(&manual_id, "b", "fetch"));
        let again = registry.answer_permission(&manual_id, "p1", PermissionDecision::Deny);
        assert!(
            again.is_err(),
            "an answered request cannot be answered twice"
        );

        let abandoned = registry
            .open_permission_request(&manual_id, permission_request("p2", "execute"))
            .expect("open");
        assert!(
            matches!(registry.cancel(&manual_id), CancelOutcome::Cancelled(record) if record.permission_requests.is_empty())
        );
        assert!(
            abandoned.await.is_err(),
            "the waiting agent learns the run is gone"
        );
        assert!(
            !registry.allowed_for_run(&manual_id, "a", "fetch"),
            "grants end with the run"
        );
        assert!(
            registry
                .open_permission_request(&manual_id, permission_request("p3", "fetch"))
                .is_none(),
            "a finished run asks nothing"
        );
    }

    /// `POST /api/runs/{id}/permissions`: the answer reaches the waiting agent and the run comes
    /// back without the request; a stale or malformed answer says so.
    #[tokio::test]
    async fn the_permissions_endpoint_hands_the_answer_over() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .unwrap();
        let dir = TeamsDir::new();
        let registry = RunRegistry::default();
        let record =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        let run_id = record.run_id.clone();
        registry.insert(record);
        let waiting = registry
            .open_permission_request(&run_id, permission_request("p1", "fetch"))
            .expect("open");
        let app = router(None, dir.0.clone(), registry.clone());
        let answer = |body: Value| {
            let app = app.clone();
            let uri = format!("/api/runs/{run_id}/permissions");
            async move {
                let response = app.oneshot(post_json(&uri, &body)).await.unwrap();
                (response.status(), json_body(response).await)
            }
        };

        let (status, body) = answer(json!({"requestId": "p1", "decision": "allow_once"})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["permissionRequests"], Value::Null, "{body}");
        assert_eq!(
            waiting.await.unwrap(),
            crate::permissions::PermissionDecision::AllowOnce
        );
        let (status, body) = answer(json!({"requestId": "p1", "decision": "deny"})).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("no longer waiting")
        );
        let (status, _) = answer(json!({"requestId": "p1", "decision": "maybe"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn registry_transitions_are_monotonic_and_terminal_states_never_change() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n  - id: b\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\nedges:\n  - {from: a, to: b, layer: configured, kind: sequence, ts: \"2026-09-10T00:00:00Z\"}\n",
        )
        .unwrap();
        let record =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        assert_eq!(record.session_id, record.run_id);
        assert_eq!(record.mode, "pipeline");
        assert_eq!(record.responder, "b");
        assert_eq!(record.agent_ids, ["a", "b"]);
        let id = record.run_id.clone();
        let registry = RunRegistry::default();
        registry.insert(record);

        assert!(!registry.mark_running("missing"));
        assert!(registry.mark_starting(&id));
        assert!(!registry.mark_starting(&id), "starting is not repeatable");
        assert!(registry.get(&id).unwrap().started_at.is_some());
        assert!(registry.mark_running(&id));
        assert!(!registry.mark_starting(&id), "status never moves backwards");
        let outcome = SessionOutcome {
            session_id: id.clone(),
            event_count: 7,
            exit_code: 0,
            reply: "answer".into(),
        };
        assert!(registry.mark_succeeded(&id, &outcome, Some("end_turn".into())));
        let done = registry.get(&id).unwrap();
        assert_eq!(done.status, RunStatus::Succeeded);
        assert_eq!(done.reply.as_deref(), Some("answer"));
        assert_eq!(done.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(done.event_count, Some(7));
        assert!(done.finished_at.is_some());
        assert!(!registry.mark_failed(&id, Some("late".into()), None, None, None, None));
        assert!(!registry.mark_running(&id));
        assert!(matches!(
            registry.cancel(&id),
            CancelOutcome::AlreadyFinished(record) if record == done
        ));
        assert_eq!(
            registry.get(&id).unwrap(),
            done,
            "terminal records are frozen"
        );
        assert!(matches!(
            registry.cancel("missing"),
            CancelOutcome::NotFound
        ));

        let second =
            RunRecord::queued("t.yaml".into(), "again".into(), &team, RunTrigger::Manual).unwrap();
        let second_id = second.run_id.clone();
        registry.insert(second);
        assert!(matches!(
            registry.cancel(&second_id),
            CancelOutcome::Cancelled(_)
        ));
        assert!(
            !registry.mark_starting(&second_id),
            "a cancelled run must never start"
        );
        let listed: Vec<String> = registry.list().into_iter().map(|r| r.run_id).collect();
        assert_eq!(listed, [second_id, id], "newest first");
        assert_eq!(
            serde_json::to_value(RunStatus::Succeeded).unwrap(),
            json!("succeeded")
        );
    }

    #[test]
    fn queued_record_uses_the_explicit_team_responder() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nresponder: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n  - id: b\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\nedges:\n  - {from: a, to: b, layer: configured, kind: sequence, ts: \"2026-09-10T00:00:00Z\"}\n",
        )
        .expect("team with explicit responder");

        let record =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        assert_eq!(record.responder, "a");
    }

    /// Run records, their lineage and their start keys survive a registry reload — which is what
    /// a daemon restart is, from the registry's point of view.
    ///
    /// Two things this pins beyond "the row round-trips":
    ///
    /// * A recovered run holds **no task handle**, because there is no task: cancelling it after a
    ///   restart changes the record and aborts nothing, which is the truth rather than a lie that
    ///   would make the operator think a process was killed.
    /// * The recovered start key still collapses a resubmission. A key that did not survive would
    ///   turn the operator's retried submit into a second run.
    #[sqlx::test(migrations = "../../migrations")]
    async fn run_records_and_their_start_keys_survive_a_registry_reload(pool: sqlx::PgPool) {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .expect("a valid team");
        let archive = EventArchive::from_pool(pool);
        let first = RunRegistry::durable(archive.run_store());

        let mut record = RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual)
            .expect("queued");
        record.retry_of_run_id = Some("an-earlier-run".to_owned());
        record.follows_run_id = Some("the-run-before".to_owned());
        record.start_at = Some("b".to_owned());
        record.waiting_on = Some(json!({"agent": "a", "question": "which budget?"}));
        let id = record.run_id.clone();
        let fingerprint = start_fingerprint("t.yaml", "go", None);
        assert!(matches!(
            first.insert_started(record, "submit-1", &fingerprint),
            StartKeyOutcome::Accepted
        ));
        assert!(first.mark_starting(&id));
        let outcome = SessionOutcome {
            session_id: id.clone(),
            event_count: 7,
            exit_code: 0,
            reply: "answer".into(),
        };
        assert!(first.mark_running(&id));
        assert!(first.mark_succeeded(&id, &outcome, Some("end_turn".into())));
        first.persist(&id).await.expect("persist");
        let live = first.get(&id).expect("the live record");

        // A second registry on the same pool is what the next boot sees.
        let next = RunRegistry::durable(archive.run_store());
        assert!(next.get(&id).is_none(), "a cold cache knows nothing yet");
        assert_eq!(next.reload().await.expect("reload"), 1);
        let recovered = next.get(&id).expect("the recovered record");
        assert_eq!(recovered, live, "the record survives unchanged");
        assert_eq!(recovered.retry_of_run_id.as_deref(), Some("an-earlier-run"));
        assert_eq!(recovered.follows_run_id.as_deref(), Some("the-run-before"));
        assert_eq!(recovered.start_at.as_deref(), Some("b"));
        assert_eq!(
            recovered.waiting_on, None,
            "a completed run cannot still ask for an answer"
        );
        assert_eq!(
            next.list()
                .iter()
                .map(|record| record.run_id.as_str())
                .collect::<Vec<_>>(),
            [id.as_str()]
        );

        // The start key came back with it, so a resubmit is still a duplicate.
        assert!(matches!(
            next.find_started("submit-1", &fingerprint),
            Some(StartKeyOutcome::Duplicate(record)) if record.run_id == id
        ));
        // A different request under the same key is still a conflict, not a second run.
        assert!(matches!(
            next.find_started("submit-1", &start_fingerprint("t.yaml", "something else", None)),
            Some(StartKeyOutcome::Conflict(conflicting)) if conflicting == id
        ));
        // Reloading twice does not duplicate the cached record.
        assert_eq!(next.reload().await.expect("reload"), 0);
        assert_eq!(next.list().len(), 1);

        // Counterfactual: a registry with no store persists nothing and recovers nothing.
        let volatile = RunRegistry::default();
        let orphan = RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual)
            .expect("queued");
        let orphan_id = orphan.run_id.clone();
        volatile.insert(orphan);
        volatile.persist(&orphan_id).await.expect("a no-op");
        assert_eq!(volatile.reload().await.expect("a no-op"), 0);
        let fresh = RunRegistry::durable(archive.run_store());
        fresh.reload().await.expect("reload");
        assert!(
            fresh.get(&orphan_id).is_none(),
            "an in-memory registry writes nothing to the table"
        );
    }

    /// A record left `queued`/`starting`/`running` by a process that is gone cannot be running.
    ///
    /// ADR 0015 deferred this and named the columns; ADR 0016 takes the decision. The claim is
    /// about the *daemon*, not the harness, and the reconciliation is written back so the boot
    /// after this one does not have to do it again.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_daemon_restart_marks_a_record_no_process_owns_as_failed(pool: sqlx::PgPool) {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .expect("a valid team");
        let archive = EventArchive::from_pool(pool);
        let first = RunRegistry::durable(archive.run_store());

        // One record for each non-terminal status, plus one that finished normally.
        let mut ids = Vec::new();
        for status in [RunStatus::Queued, RunStatus::Starting, RunStatus::Running] {
            let record = RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual)
                .expect("queued");
            let id = record.run_id.clone();
            first.insert(record);
            if status != RunStatus::Queued {
                assert!(first.mark_starting(&id));
            }
            if status == RunStatus::Running {
                assert!(first.mark_running(&id));
            }
            first.persist(&id).await.expect("persist");
            ids.push(id);
        }
        let finished = RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual)
            .expect("queued");
        let finished_id = finished.run_id.clone();
        first.insert(finished);
        assert!(first.mark_starting(&finished_id));
        assert!(first.mark_succeeded(
            &finished_id,
            &SessionOutcome {
                session_id: finished_id.clone(),
                event_count: 2,
                exit_code: 0,
                reply: "answer".into(),
            },
            None,
        ));
        first.persist(&finished_id).await.expect("persist");

        let next = RunRegistry::durable(archive.run_store());
        assert_eq!(next.reload().await.expect("reload"), 4);
        for id in &ids {
            let recovered = next.get(id).expect("recovered");
            assert_eq!(recovered.status, RunStatus::Failed, "{recovered:?}");
            assert_eq!(recovered.error.as_deref(), Some(INTERRUPTED_BY_RESTART));
            assert!(recovered.finished_at.is_some());
            assert_eq!(
                recovered.error_code, None,
                "the contract defines no code for a supervisor that went away, and a minted token \
                 would be worse than none"
            );
        }
        // A terminal record is untouched — the rewrite is for records nothing can advance.
        let untouched = next.get(&finished_id).expect("recovered");
        assert_eq!(untouched.status, RunStatus::Succeeded);
        assert_eq!(untouched.error, None);

        // And it was written back: the boot after this one sees `failed`, not `running` again.
        let third = RunRegistry::durable(archive.run_store());
        assert_eq!(third.reload().await.expect("reload"), 4);
        assert_eq!(
            third.get(&ids[2]).expect("recovered").status,
            RunStatus::Failed
        );
    }

    /// Canvas B's validation, all of it, through the endpoint that has to refuse before a harness
    /// spawns. Each of these would otherwise be a run that started and then did the wrong thing.
    /// ADR 0038: a team with a top-level `deliver` publishes the answer of a run started by hand,
    /// not only a routine's; a team without one publishes nothing until the operator sends it;
    /// and the explicit send names its own refusals.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_hand_started_run_delivers_when_the_team_does_and_on_request_otherwise(
        pool: sqlx::PgPool,
    ) {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        let plain = dir.write_team("plain.yaml", &harness);
        let delivering = fs::read_to_string(&plain).unwrap().replace(
            "entrypoint: solo\n",
            "entrypoint: solo\ndeliver:\n  notion: {}\n",
        );
        fs::write(dir.0.join("delivering.yaml"), delivering).unwrap();
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        registry.set_publisher(Arc::new(Publisher::disconnected()));
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());
        let start = |team: &'static str| {
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(post_json(
                        "/api/runs",
                        &json!({"teamPath": team, "prompt": "say done"}),
                    ))
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::ACCEPTED);
                serde_json::from_value::<RunRecord>(json_body(response).await).unwrap()
            }
        };

        let delivered = start("delivering.yaml").await;
        assert_eq!(delivered.trigger, RunTrigger::Manual);
        let title = delivered.deliver_title.clone().expect("a delivery title");
        assert!(
            title.starts_with("Fake harness team — ") && !title.contains("{{"),
            "the default per-run title, expanded: {title}"
        );
        let done = wait_for(&registry, &delivered.run_id, |r| r.delivery.is_some()).await;
        assert_eq!(done.status, RunStatus::Succeeded);
        let delivery = done.delivery.expect("delivered");
        assert_eq!(delivery.status, DeliveryStatus::Failed);
        assert_eq!(delivery.message, crate::notion::NOT_CONNECTED_MESSAGE);

        let quiet = start("plain.yaml").await;
        assert_eq!(quiet.deliver_title, None);
        let finished = wait_for(&registry, &quiet.run_id, |r| r.status.is_terminal()).await;
        tokio::time::sleep(DELIVERY_POLL * 2).await;
        assert_eq!(
            registry.get(&quiet.run_id).unwrap().delivery,
            None,
            "a team that does not deliver publishes nothing by itself"
        );
        assert_eq!(finished.status, RunStatus::Succeeded);

        let send = |id: String, body: Value| {
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(post_json(&format!("/api/runs/{id}/deliver"), &body))
                    .await
                    .unwrap();
                (response.status(), json_body(response).await)
            }
        };
        let (status, body) = send(quiet.run_id.clone(), json!({})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["delivery"]["status"], "failed");
        assert_eq!(
            body["delivery"]["message"],
            crate::notion::NOT_CONNECTED_MESSAGE
        );
        assert_eq!(
            registry.get(&quiet.run_id).unwrap().delivery,
            serde_json::from_value(body["delivery"].clone()).unwrap(),
            "the send is recorded on the run"
        );
        let (status, body) = send(quiet.run_id.clone(), json!({"title": "  "})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (status, _) = send("no-such-run".to_owned(), json!({})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, body) = send(quiet.run_id.clone(), json!({"page": "x"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unknown fields: {body}");

        // Counterfactual: without a publisher the send still answers, and says why nothing went.
        let bare = RunRegistry::default();
        let bare_app = router(Some(archive), dir.0.clone(), bare.clone());
        let response = bare_app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({"teamPath": "delivering.yaml", "prompt": "say done"}),
            ))
            .await
            .unwrap();
        let record: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        let done = wait_for(&bare, &record.run_id, |r| r.delivery.is_some()).await;
        assert_eq!(
            done.delivery.unwrap().message,
            NO_PUBLISHER_MESSAGE,
            "no publisher is reported, not hidden"
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn a_follow_up_is_refused_before_it_starts_when_it_cannot_be_honoured(
        pool: sqlx::PgPool,
    ) {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        // `write_team` writes a single-agent team with no edges, so this team runs in team mode.
        dir.write_team("team.yaml", &harness);
        dir.write_team("other.yaml", &harness);
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());

        // A run to follow, so "the followed run must exist" is the only thing under test below.
        let first: RunRecord = serde_json::from_value(
            json_body(
                app.clone()
                    .oneshot(post_json(
                        "/api/runs",
                        &json!({"teamPath": "team.yaml", "prompt": "say done"}),
                    ))
                    .await
                    .unwrap(),
            )
            .await,
        )
        .unwrap();
        wait_for(&registry, &first.run_id, |r| r.status.is_terminal()).await;

        let refusal = |body: Value| {
            let app = app.clone();
            async move {
                let response = app.oneshot(post_json("/api/runs", &body)).await.unwrap();
                let status = response.status();
                let message = json_body(response).await["error"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                (status, message)
            }
        };

        // Team mode has no configured order, so there is no stage to start at.
        let (status, message) = refusal(json!({
            "teamPath": "team.yaml",
            "prompt": "shorter",
            "followsRunId": first.run_id,
            "startAt": "solo",
        }))
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(message.contains("runs in team mode"), "{message}");

        // A run the daemon has forgotten can be replayed, not followed.
        let (status, message) = refusal(json!({
            "teamPath": "team.yaml",
            "prompt": "shorter",
            "followsRunId": "a-run-that-never-existed",
        }))
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(message.contains("is not in the runs table"), "{message}");

        // A followed run from a different team file would replay another team's handovers.
        let (status, message) = refusal(json!({
            "teamPath": "other.yaml",
            "prompt": "shorter",
            "followsRunId": first.run_id,
        }))
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            message.contains("continues the same team file"),
            "{message}"
        );

        // `startAt` with nothing to continue names a stage in a run that does not exist.
        let (status, message) = refusal(json!({
            "teamPath": "team.yaml",
            "prompt": "shorter",
            "startAt": "solo",
        }))
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(message.contains("no run to continue"), "{message}");

        // An unknown checkpoint id.
        let (status, message) = refusal(json!({
            "teamPath": "team.yaml",
            "prompt": "shorter",
            "fromCheckpointId": "cp-that-never-was",
        }))
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(message.contains("does not exist"), "{message}");

        // And the counterfactual: a whole-pipeline follow-up of the same run is accepted, and its
        // record carries the lineage.
        let accepted: RunRecord = serde_json::from_value(
            json_body(
                app.clone()
                    .oneshot(post_json(
                        "/api/runs",
                        &json!({
                            "teamPath": "team.yaml",
                            "prompt": "shorter",
                            "followsRunId": first.run_id,
                        }),
                    ))
                    .await
                    .unwrap(),
            )
            .await,
        )
        .unwrap();
        assert_eq!(
            accepted.follows_run_id.as_deref(),
            Some(first.run_id.as_str())
        );
        assert_eq!(
            accepted.start_at, None,
            "a whole-pipeline follow-up skips nothing"
        );
        wait_for(&registry, &accepted.run_id, |r| r.status.is_terminal()).await;
    }

    /// "from b" needs the handover b was given the first time. A followed run that stored none
    /// refuses the new run and **names the stage**, rather than starting b with nothing where it
    /// had been handed a page — which would look like a cheap follow-up that worked.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_skipped_stage_with_no_stored_handover_refuses_the_run_naming_the_stage(
        pool: sqlx::PgPool,
    ) {
        let dir = TeamsDir::new();
        dir.write_pipeline_team("chain.yaml");
        let team = TeamConfig::load(&dir.0.join("chain.yaml")).expect("a valid pipeline");
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());

        // A record for a run with no archived events at all: the runs table knows it, the archive
        // holds nothing, so there is no stored handover for b.
        let mut forgotten =
            RunRecord::queued("chain.yaml".into(), "go".into(), &team, RunTrigger::Manual)
                .expect("queued");
        forgotten.status = RunStatus::Succeeded;
        forgotten.reply = Some("an answer with no evidence behind it".to_owned());
        let forgotten_id = forgotten.run_id.clone();
        registry.insert(forgotten);

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({
                    "teamPath": "chain.yaml",
                    "prompt": "shorter",
                    "followsRunId": forgotten_id,
                    "startAt": "b",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let message = json_body(response).await["error"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        assert!(message.contains("stored no handover for b"), "{message}");
        assert!(message.contains("whole pipeline"), "{message}");
        assert_eq!(
            registry.list().len(),
            1,
            "a refused follow-up creates no run"
        );

        // Counterfactual: run the pipeline for real, and "from b" is then accepted — so the
        // refusal is about the missing handover, not about `startAt` being unsupported.
        let real: RunRecord = serde_json::from_value(
            json_body(
                app.clone()
                    .oneshot(post_json(
                        "/api/runs",
                        &json!({"teamPath": "chain.yaml", "prompt": "write it"}),
                    ))
                    .await
                    .unwrap(),
            )
            .await,
        )
        .unwrap();
        let finished = wait_for(&registry, &real.run_id, |r| r.status.is_terminal()).await;
        assert_eq!(finished.status, RunStatus::Succeeded, "{finished:?}");

        // Memory phase 3: **every** stage boundary left a checkpoint, asked for in the stage's own
        // warm session — including the last stage, which has no handover turn and would otherwise
        // be the one stage "Start a new run from this checkpoint" could never offer.
        let boundaries = archive
            .notebook()
            .checkpoints(&real.run_id, None)
            .await
            .expect("read the run's checkpoints");
        assert_eq!(
            boundaries
                .iter()
                .map(|point| (point.agent_id.as_str(), point.done.as_str(), point.source))
                .collect::<Vec<_>>(),
            [
                ("a", "a done", crate::memory::CheckpointSource::Agent),
                ("b", "b done", crate::memory::CheckpointSource::Agent),
            ],
            "{boundaries:?}"
        );
        for point in &boundaries {
            assert_eq!(point.next, "nothing", "{point:?}");
            assert!(
                point
                    .team_revision
                    .as_deref()
                    .is_some_and(|revision| revision.starts_with("sha256:")),
                "a boundary checkpoint records the revision it was written against: {point:?}"
            );
            assert!(point.seq_high_water.is_some_and(|seq| seq > 0), "{point:?}");
        }

        let accepted = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({
                    "teamPath": "chain.yaml",
                    "prompt": "shorter",
                    "followsRunId": real.run_id,
                    "startAt": "b",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
        let record: RunRecord = serde_json::from_value(json_body(accepted).await).unwrap();
        assert_eq!(record.start_at.as_deref(), Some("b"));
        let done = wait_for(&registry, &record.run_id, |r| r.status.is_terminal()).await;
        assert_eq!(done.status, RunStatus::Succeeded, "{done:?}");
        let spawned: Vec<String> = archive
            .load_session(&record.run_id)
            .await
            .expect("events")
            .into_iter()
            .filter(|event| event.kind == EventKind::Process && event.payload["phase"] == "spawned")
            .map(|event| event.agent_id)
            .collect();
        assert_eq!(
            spawned,
            ["b"],
            "only the stage the follow-up starts at runs"
        );
        // And the stage it did run was given the previous run's answer and its stored handover.
        let packet_prompt = archive
            .load_session(&record.run_id)
            .await
            .expect("events")
            .into_iter()
            .find(|event| event.kind == EventKind::Message && event.payload["role"] == "user")
            .expect("b archives its opening prompt")
            .payload["content"]["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        assert!(
            packet_prompt.contains("## Previous output"),
            "{packet_prompt}"
        );
        assert!(packet_prompt.contains("b done"), "{packet_prompt}");
        assert!(packet_prompt.contains("a done handover"), "{packet_prompt}");
    }

    /// A DAG join whose predecessors straddle the `startAt` boundary is refused, by name.
    ///
    /// The archive stores each stage's `## Results from preceding stages` **rendered**, not split
    /// per predecessor, so replaying a join's stored text would overwrite the half this run is
    /// about to produce with the old one — a follow-up that quietly ignored the work it just did.
    ///
    /// This calls the real `seed_replayed_handovers` against a real archive holding a real
    /// `prompt_sections` record, so it fails if the rule changes. Its counterfactual is the same
    /// diamond one stage later, where every predecessor of every executed stage is skipped and the
    /// replay is unambiguous.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_join_fed_from_both_sides_of_the_boundary_is_refused_by_name(pool: sqlx::PgPool) {
        // a ─┬─► b ─┬─► d
        //    └─► c ─┘
        let order: Vec<String> = ["a", "b", "c", "d"]
            .iter()
            .map(|id| (*id).to_owned())
            .collect();
        let predecessors: BTreeMap<String, Vec<String>> = BTreeMap::from([
            ("b".to_owned(), vec!["a".to_owned()]),
            ("c".to_owned(), vec!["a".to_owned()]),
            ("d".to_owned(), vec!["b".to_owned(), "c".to_owned()]),
        ]);
        let archive = EventArchive::from_pool(pool);
        // The followed run's archived prompt record: every stage but the entrypoint was handed
        // its predecessors' results, which is what a replay reads.
        for (seq, stage) in (0u64..).zip(["b", "c", "d"]) {
            archive
                .append(&crate::RunEvent {
                    id: format!("e{seq}"),
                    session_id: "diamond-run".to_owned(),
                    agent_id: stage.to_owned(),
                    seq,
                    ts: "2026-09-13T00:00:00.000Z".to_owned(),
                    kind: EventKind::SessionMeta,
                    payload: json!({
                        "phase": "prompt_sections",
                        "sections": [{
                            "kind": "stage_results",
                            "heading": "## Results from preceding stages",
                            "text": format!("what {stage} was handed"),
                        }],
                    }),
                    raw: None,
                })
                .await
                .expect("archive the prompt record");
        }

        let seed = |start_at: &str| {
            let mut lineage = crate::RunLineage {
                start_at: Some(start_at.to_owned()),
                ..crate::RunLineage::default()
            };
            let archive = archive.clone();
            let order = order.clone();
            let predecessors = predecessors.clone();
            async move {
                let result = seed_replayed_handovers(
                    &archive,
                    "diamond-run",
                    &order,
                    &predecessors,
                    &mut lineage,
                )
                .await;
                (result.err().map(LaunchError::into_api_error), lineage)
            }
        };

        // "from c": `d` is fed by `b` (skipped) and `c` (about to run). Refused, by name.
        let (refused, _) = seed("c").await;
        let message = refused.expect("a split join is refused").message;
        assert!(message.starts_with("d is fed by b"), "{message}");
        assert!(message.contains("start at d"), "{message}");

        // "from d": both of `d`'s predecessors are skipped, so the join replays unambiguously.
        let (error, lineage) = seed("d").await;
        assert!(error.is_none(), "{error:?}");
        assert_eq!(
            lineage.replayed_stage_results,
            BTreeMap::from([("d".to_owned(), "what d was handed".to_owned())])
        );

        // "from b": both branch heads are fed by the skipped entrypoint; `d` is fed only by stages
        // this run executes, so it replays nothing.
        let (error, lineage) = seed("b").await;
        assert!(error.is_none(), "{error:?}");
        assert_eq!(
            lineage.replayed_stage_results.keys().collect::<Vec<_>>(),
            ["b", "c"]
        );
    }

    /// A run that dies mid-turn leaves a **coordinator** checkpoint assembled from the archive, and
    /// the next run started from it opens with it.
    ///
    /// The harness streams one chunk and then exits without answering `session/prompt`, which is
    /// the same shape as a turn killed by the ten-minute ACP request timeout — the stage never
    /// reaches its boundary and never answers the checkpoint request — and reaches it in
    /// milliseconds instead of ten minutes.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_run_that_died_mid_turn_leaves_a_coordinator_checkpoint_the_next_run_opens_with(
        pool: sqlx::PgPool,
    ) {
        const DYING_HARNESS: &str = r#"#!/bin/sh
set -eu
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"dying","configOptions":[]}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"dying","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"half of section three"}}}}'
exit 7
"#;
        let dir = TeamsDir::new();
        let dying = dir.write_harness("dying.sh", DYING_HARNESS);
        dir.write_team("dying.yaml", &dying);
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());

        let died: RunRecord = serde_json::from_value(
            json_body(
                app.clone()
                    .oneshot(post_json(
                        "/api/runs",
                        &json!({"teamPath": "dying.yaml", "prompt": "draft the report"}),
                    ))
                    .await
                    .unwrap(),
            )
            .await,
        )
        .unwrap();
        let terminal = wait_for(&registry, &died.run_id, |r| r.status.is_terminal()).await;
        assert_eq!(terminal.status, RunStatus::Failed, "{terminal:?}");

        let checkpoints = archive
            .notebook()
            .checkpoints(&died.run_id, None)
            .await
            .expect("read the run's checkpoints");
        assert_eq!(checkpoints.len(), 1, "{checkpoints:?}");
        let point = &checkpoints[0];
        assert_eq!(point.agent_id, "solo");
        assert_eq!(point.source, crate::memory::CheckpointSource::Coordinator);
        assert_eq!(
            point.done, "half of section three",
            "`done` is the last thing the archive holds, not a summary of it"
        );
        assert!(
            point.next.is_empty(),
            "nothing said what came next, so nothing claims to: {point:?}"
        );
        assert!(point.team_revision.is_some(), "{point:?}");

        // It is served, so the strip that offers to continue can read it.
        let served = json_body(
            app.clone()
                .oneshot(get_local(&format!(
                    "/api/runs/{}/checkpoints?agent=solo",
                    died.run_id
                )))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(served[0]["id"], point.id);
        assert_eq!(served[0]["source"], "coordinator");

        // "Start a new run from this checkpoint": a new run, whose packet opens with it.
        let working = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        dir.write_team("dying.yaml", &working);
        let continued: RunRecord = serde_json::from_value(
            json_body(
                app.clone()
                    .oneshot(post_json(
                        "/api/runs",
                        &json!({
                            "teamPath": "dying.yaml",
                            "prompt": "finish section three",
                            "fromCheckpointId": point.id,
                        }),
                    ))
                    .await
                    .unwrap(),
            )
            .await,
        )
        .unwrap();
        assert_eq!(
            continued.follows_run_id.as_deref(),
            Some(died.run_id.as_str())
        );
        assert_eq!(
            continued.retry_of_run_id.as_deref(),
            Some(died.run_id.as_str()),
            "a checkpoint continuation is another attempt at the same job"
        );
        assert_eq!(
            continued.start_at, None,
            "team mode has no order to start part way through, so nothing is skipped"
        );
        wait_for(&registry, &continued.run_id, |r| r.status.is_terminal()).await;

        let packets = archive
            .context_packets(&continued.run_id, Some("solo"))
            .await
            .expect("the packet was stored");
        assert!(
            packets[0].text.contains("half of section three"),
            "the next run's packet opens with the checkpoint: {:?}",
            packets[0].text
        );
        let section = packets[0]
            .sections
            .iter()
            .find(|section| section.kind == crate::memory::PacketSectionKind::Checkpoint)
            .expect("a checkpoint section");
        assert!(
            section.rationale.contains("Assembled by LoomWatch"),
            "{}",
            section.rationale
        );
        // The team file was rewritten between the two runs, so the checkpoint is honestly stale.
        assert!(
            section.rationale.contains("stale · "),
            "{}",
            section.rationale
        );
    }

    #[test]
    fn start_keys_collapse_duplicates_and_bind_to_the_exact_request_fingerprint() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .unwrap();
        let original =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        let original_id = original.run_id.clone();
        let duplicate =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        let conflict =
            RunRecord::queued("t.yaml".into(), "other".into(), &team, RunTrigger::Manual).unwrap();
        let registry = RunRegistry::default();
        let fingerprint = start_fingerprint("t.yaml", "go", Some("sha256:one"));
        let different = start_fingerprint("t.yaml", "go ", Some("sha256:one"));

        assert!(matches!(
            registry.insert_started(original, "attempt-1", &fingerprint),
            StartKeyOutcome::Accepted
        ));
        assert!(matches!(
            registry.insert_started(duplicate, "attempt-1", &fingerprint),
            StartKeyOutcome::Duplicate(record) if record.run_id == original_id
        ));
        assert!(matches!(
            registry.insert_started(conflict, "attempt-1", &different),
            StartKeyOutcome::Conflict(run_id) if run_id == original_id
        ));
        assert_eq!(registry.list().len(), 1, "one key enqueues only one run");
        assert_eq!(
            registry.get_by_start_key("attempt-1").unwrap().run_id,
            original_id
        );
        assert_ne!(
            fingerprint, different,
            "fingerprints use exact decoded strings"
        );
    }

    #[test]
    fn failed_runs_carry_the_code_and_stop_reason_the_daemon_reported() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .unwrap();
        let record =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        let id = record.run_id.clone();
        let wire = serde_json::to_value(&record).unwrap();
        assert_eq!(wire["errorCode"], Value::Null, "queued has no code yet");
        assert_eq!(wire["stopReason"], Value::Null);
        let registry = RunRegistry::default();
        registry.insert(record);
        assert!(registry.mark_starting(&id) && registry.mark_running(&id));
        assert!(registry.mark_failed(
            &id,
            Some("ACP session x child exited with code 1".into()),
            Some(MISSING_CANONICAL_RESPONSE.into()),
            Some("end_turn".into()),
            Some(1),
            Some(4),
        ));
        let failed = registry.get(&id).unwrap();
        assert_eq!(failed.status, RunStatus::Failed);
        assert_eq!(
            failed.error.as_deref(),
            Some("ACP session x child exited with code 1")
        );
        assert_eq!(
            failed.error_code.as_deref(),
            Some(MISSING_CANONICAL_RESPONSE)
        );
        assert_eq!(failed.stop_reason.as_deref(), Some("end_turn"));
        let wire = serde_json::to_value(&failed).unwrap();
        assert_eq!(wire["errorCode"], MISSING_CANONICAL_RESPONSE);
        assert_eq!(wire["stopReason"], "end_turn");

        // Callers provide a stable code separately from the diagnostic prose.
        let other =
            RunRecord::queued("t.yaml".into(), "again".into(), &team, RunTrigger::Manual).unwrap();
        let other_id = other.run_id.clone();
        registry.insert(other);
        assert!(registry.mark_starting(&other_id) && registry.mark_running(&other_id));
        assert!(registry.mark_failed(
            &other_id,
            Some("boom".into()),
            Some(PROTOCOL_FAILURE.into()),
            None,
            None,
            None
        ));
        let failed = registry.get(&other_id).unwrap();
        assert_eq!(failed.error.as_deref(), Some("boom"));
        assert_eq!(failed.error_code.as_deref(), Some(PROTOCOL_FAILURE));
        assert_eq!(failed.stop_reason, None);
    }

    #[test]
    fn delivery_is_recorded_on_finished_runs_and_null_until_then() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .unwrap();
        let record =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Schedule).unwrap();
        let id = record.run_id.clone();
        let wire = serde_json::to_value(&record).unwrap();
        assert_eq!(wire["trigger"], "schedule");
        assert_eq!(
            wire["delivery"],
            Value::Null,
            "present as null, never omitted"
        );
        assert_eq!(
            serde_json::to_value(RunTrigger::Manual).unwrap(),
            json!("manual")
        );

        let registry = RunRegistry::default();
        registry.insert(record);
        assert!(registry.mark_starting(&id) && registry.mark_running(&id));
        let outcome = SessionOutcome {
            session_id: id.clone(),
            event_count: 3,
            exit_code: 0,
            reply: "# Digest".into(),
        };
        assert!(registry.mark_succeeded(&id, &outcome, None));

        assert!(!registry.set_delivery(
            "missing",
            Delivery::notion(DeliveryStatus::Failed, None, None, "x".into())
        ));
        let failed = Delivery::notion(DeliveryStatus::Failed, None, None, "not connected".into());
        assert!(
            registry.set_delivery(&id, failed.clone()),
            "allowed on terminal records"
        );
        assert_eq!(registry.get(&id).unwrap().delivery, Some(failed));
        let published = Delivery::notion(
            DeliveryStatus::Published,
            Some("https://www.notion.so/abc".into()),
            Some("abc".into()),
            "Published".into(),
        );
        assert!(
            registry.set_delivery(&id, published.clone()),
            "a later call overwrites"
        );
        let record = registry.get(&id).unwrap();
        assert_eq!(record.delivery, Some(published));
        assert_eq!(
            record.status,
            RunStatus::Succeeded,
            "delivery never touches status"
        );
        let wire = serde_json::to_value(&record).unwrap();
        assert_eq!(wire["delivery"]["target"], "notion");
        assert_eq!(wire["delivery"]["status"], "published");
        assert_eq!(wire["delivery"]["url"], "https://www.notion.so/abc");
        assert_eq!(wire["delivery"]["pageId"], "abc");
        assert!(
            wire["delivery"]["deliveredAt"]
                .as_str()
                .unwrap()
                .ends_with('Z')
        );
    }

    #[test]
    fn runner_failures_have_distinct_stable_codes() {
        let spawn = anyhow::anyhow!("failed to spawn ACP harness for agent solo");
        assert_eq!(classify_failure_code(&spawn, false, None), SPAWN_FAILED);

        let crash = anyhow::anyhow!("child exited unsuccessfully");
        assert_eq!(
            classify_failure_code(&crash, true, Some("stderr: boom")),
            PROCESS_CRASHED
        );

        let protocol = anyhow::anyhow!("ACP session/prompt failed");
        assert_eq!(
            classify_failure_code(
                &protocol,
                true,
                Some("session execution failed: invalid JSON")
            ),
            PROTOCOL_FAILURE
        );
    }

    #[tokio::test]
    async fn start_rejects_malformed_prompts_and_bodies() {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        dir.write_team("team.yaml", &harness);
        let app = router(None, dir.0.clone(), RunRegistry::default());
        for (body, expected) in [
            (json!({"teamPath": "team.yaml", "prompt": "   \n"}), "empty"),
            (
                json!({"teamPath": "team.yaml", "prompt": "x".repeat(MAX_PROMPT_BYTES + 1)}),
                "exceeds",
            ),
            (json!({"prompt": "hello"}), "invalid run request"),
        ] {
            let response = app
                .clone()
                .oneshot(post_json("/api/runs", &body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let error = json_body(response).await["error"]
                .as_str()
                .unwrap()
                .to_owned();
            assert!(error.contains(expected), "{error}");
        }
    }

    /// ADR 0048: a team file that appeared after the teams folder was first opened — downloaded,
    /// unzipped, written by an agent — starts nothing until the operator approves the revision
    /// they were shown. The check runs before the archive's, so without a database an approved
    /// team gets as far as "archive disabled" and an unapproved one never does.
    #[tokio::test]
    async fn a_team_nobody_approved_is_reviewed_before_it_runs() {
        let dir = TeamsDir::new();
        let approvals_home = TeamsDir::new();
        let registry = RunRegistry::default();
        registry.set_approvals(Arc::new(
            TeamApprovals::open(&approvals_home.0, &dir.0).expect("open approvals"),
        ));
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        let team_path = dir.write_team("downloaded.yaml", &harness);
        let revision = team_revision(&fs::read(&team_path).unwrap());
        let app = router(None, dir.0.clone(), registry.clone());
        let start = json!({"teamPath": "downloaded.yaml", "prompt": "hello"});

        let refused = app
            .clone()
            .oneshot(post_json("/api/runs", &start))
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        let body = json_body(refused).await;
        assert_eq!(body["code"], TEAM_NEEDS_REVIEW);
        assert_eq!(body["teamPath"], "downloaded.yaml");
        assert_eq!(body["teamRevision"], revision);
        assert_eq!(body["teamName"], "Fake harness team");
        let first = &body["review"][0];
        assert_eq!(
            first["warn"], true,
            "a /bin/sh harness is not an app LoomWatch knows"
        );
        assert!(
            first["text"]
                .as_str()
                .unwrap()
                .starts_with("Solo runs `/bin/sh ")
        );
        assert!(registry.list().is_empty(), "a refused team starts no run");

        let unseen = json!({"teamPath": "downloaded.yaml", "teamRevision": "sha256:other"});
        let not_shown = app
            .clone()
            .oneshot(post_json("/api/team/approve", &unseen))
            .await
            .unwrap();
        assert_eq!(not_shown.status(), StatusCode::CONFLICT);
        assert_eq!(json_body(not_shown).await["code"], STALE_TEAM_REVISION);

        let approve = json!({"teamPath": "downloaded.yaml", "teamRevision": revision});
        let approved = app
            .clone()
            .oneshot(post_json("/api/team/approve", &approve))
            .await
            .unwrap();
        assert_eq!(approved.status(), StatusCode::OK);
        let started = app
            .clone()
            .oneshot(post_json("/api/runs", &start))
            .await
            .unwrap();
        assert_eq!(
            started.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "past the review, the run only lacks a database"
        );

        // A change made outside LoomWatch needs a new review.
        fs::write(
            &team_path,
            fs::read_to_string(&team_path).unwrap() + "# edited\n",
        )
        .unwrap();
        let changed = app.oneshot(post_json("/api/runs", &start)).await.unwrap();
        assert_eq!(changed.status(), StatusCode::CONFLICT);
        assert_eq!(json_body(changed).await["code"], TEAM_NEEDS_REVIEW);
    }

    /// Teams already in the folder when `LoomWatch` first opened it keep running unreviewed, and
    /// the scheduler's and Control's path (`launch`) refuses an unapproved team with words.
    #[tokio::test]
    async fn teams_that_were_already_there_run_and_launch_refuses_new_ones() {
        let dir = TeamsDir::new();
        let approvals_home = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        dir.write_team("mine.yaml", &harness);
        let registry = RunRegistry::default();
        registry.set_approvals(Arc::new(
            TeamApprovals::open(&approvals_home.0, &dir.0).expect("open approvals"),
        ));
        dir.write_team("downloaded.yaml", &harness);

        let mine = launch(
            &registry,
            None,
            &dir.0,
            Path::new("mine.yaml"),
            "hi",
            RunTrigger::Schedule,
        )
        .expect_err("no archive in this test");
        assert_eq!(mine.status, StatusCode::SERVICE_UNAVAILABLE);
        let downloaded = launch(
            &registry,
            None,
            &dir.0,
            Path::new("downloaded.yaml"),
            "hi",
            RunTrigger::Schedule,
        )
        .expect_err("an unapproved team is refused");
        assert_eq!(downloaded.status, StatusCode::CONFLICT);
        assert!(
            downloaded.message.contains("outside LoomWatch"),
            "{}",
            downloaded.message
        );
    }

    #[tokio::test]
    async fn expected_revision_conflict_returns_a_stable_code_and_creates_no_run() {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        let team_path = dir.write_team("team.yaml", &harness);
        let current = team_revision(&fs::read(team_path).unwrap());
        let registry = RunRegistry::default();
        let app = router(None, dir.0.clone(), registry.clone());

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({
                    "teamPath": "team.yaml",
                    "prompt": "hello",
                    "expectedRevision": "sha256:stale",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let problem = json_body(response).await;
        assert_eq!(problem["code"], STALE_TEAM_REVISION);
        assert_eq!(problem["currentTeamRevision"], current);
        assert!(
            registry.list().is_empty(),
            "a conflict must not create a run"
        );

        let response = app
            .oneshot(post_json(
                "/api/runs",
                &json!({
                    "teamPath": "team.yaml",
                    "prompt": "hello",
                    "expectedTeamRevision": current,
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "the contract alias passes the revision guard and reaches the legacy archive check"
        );
        assert!(registry.list().is_empty());
    }

    #[tokio::test]
    async fn a_start_key_can_be_recovered_by_get() {
        let dir = TeamsDir::new();
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .unwrap();
        let record =
            RunRecord::queued("t.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        let run_id = record.run_id.clone();
        let registry = RunRegistry::default();
        let fingerprint = start_fingerprint("t.yaml", "go", None);
        assert!(matches!(
            registry.insert_started(record, "attempt 1", &fingerprint),
            StartKeyOutcome::Accepted
        ));
        let app = router(None, dir.0.clone(), registry.clone());

        let response = app
            .clone()
            .oneshot(get_local("/api/runs?startKey=attempt%201"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["runId"], run_id);

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({
                    "teamPath": "t.yaml",
                    "prompt": "go",
                    "clientRequestId": "attempt 1",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "a retry returns the first run"
        );
        assert_eq!(json_body(response).await["runId"], run_id);
        assert_eq!(registry.list().len(), 1);

        let response = app
            .oneshot(post_json(
                "/api/runs",
                &json!({
                    "teamPath": "t.yaml",
                    "prompt": "different",
                    "startKey": "attempt 1",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let problem = json_body(response).await;
        assert_eq!(problem["code"], IDEMPOTENCY_CONFLICT);
        assert_eq!(problem["runId"], run_id);
        assert_eq!(
            registry.list().len(),
            1,
            "a conflicting reuse creates no run"
        );
    }

    #[tokio::test]
    async fn start_rejects_paths_that_escape_or_are_not_team_files() {
        let dir = TeamsDir::new();
        let teams_root = dir.0.join("teams");
        fs::create_dir(&teams_root).unwrap();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        let outside = dir.write_team("outside.yaml", &harness);
        fs::create_dir(teams_root.join("folder")).unwrap();
        let app = router(None, teams_root, RunRegistry::default());
        for (path, expected) in [
            ("../outside.yaml", StatusCode::FORBIDDEN),
            (outside.to_str().unwrap(), StatusCode::FORBIDDEN),
            ("missing.yaml", StatusCode::NOT_FOUND),
            ("folder", StatusCode::BAD_REQUEST),
            (".", StatusCode::FORBIDDEN),
        ] {
            let response = app
                .clone()
                .oneshot(post_json(
                    "/api/runs",
                    &json!({"teamPath": path, "prompt": "hello"}),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "path {path:?}");
        }
    }

    #[tokio::test]
    async fn start_reports_an_invalid_team_and_a_missing_archive() {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        dir.write_team("team.yaml", &harness);
        fs::write(
            dir.0.join("broken.yaml"),
            "schemaVersion: 1\nentrypoint: ghost\nagents: []\n",
        )
        .unwrap();
        let app = router(None, dir.0.clone(), RunRegistry::default());

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({"teamPath": "broken.yaml", "prompt": "hello"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error = json_body(response).await["error"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            error.contains("entrypoint agent \"ghost\" does not exist"),
            "{error}"
        );

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({"teamPath": "./team.yaml", "prompt": "hello"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json_body(response).await["error"], ARCHIVE_DISABLED_MESSAGE);

        let response = app.oneshot(get_local("/api/runs/nope")).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rejects_remote_origins_and_rebinding_hosts() {
        for (host, origin) in [
            ("evil.example", "http://evil.example"),
            ("localhost:3000", "http://evil.example"),
            ("localhost:3000", "null"),
        ] {
            let response = router(None, std::env::temp_dir(), RunRegistry::default())
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/runs")
                        .header("host", host)
                        .header("origin", origin)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            json!({"teamPath": "team.yaml", "prompt": "hi"}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn run_end_to_end_archives_under_the_pre_minted_id(pool: sqlx::PgPool) {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        dir.write_team("team.yaml", &harness);
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({"teamPath": "./team.yaml", "prompt": "  say done  "}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let accepted: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        assert_eq!(accepted.session_id, accepted.run_id);
        assert_eq!(accepted.team_path, "team.yaml");
        assert_eq!(accepted.prompt, "say done");
        assert_eq!(accepted.mode, "team");
        assert_eq!(accepted.entrypoint, "solo");
        assert_eq!(accepted.responder, "solo");
        assert_eq!(accepted.agent_ids, ["solo"]);
        assert!(!accepted.status.is_terminal());

        let done = wait_for(&registry, &accepted.run_id, |r| r.status.is_terminal()).await;
        assert_eq!(done.status, RunStatus::Succeeded, "{done:?}");
        assert_eq!(done.reply.as_deref(), Some("done"));
        assert_eq!(done.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(done.exit_code, Some(0));
        assert!(done.started_at.is_some() && done.finished_at.is_some());

        let events = archive.verify_session(&accepted.run_id).await.unwrap();
        assert_eq!(done.event_count, Some(events.len()));
        assert!(
            events
                .iter()
                .all(|event| event.session_id == accepted.run_id)
        );
        assert_eq!(events[0].kind, EventKind::Process);
        assert_eq!(events[0].payload["phase"], "spawned");
        assert_eq!(events.last().unwrap().payload["phase"], "exited");
        assert_eq!(
            events[0].raw, None,
            "the pre-minted id is not injected into raw frames"
        );
        let session_new = events
            .iter()
            .find(|event| event.payload["phase"] == "session_new")
            .unwrap();
        assert_eq!(
            session_new.raw.as_ref().unwrap()["result"]["sessionId"],
            "harness-session",
            "raw frames keep the harness's own ACP session id"
        );

        let listed = json_body(app.clone().oneshot(get_local("/api/runs")).await.unwrap()).await;
        assert_eq!(listed[0]["runId"], accepted.run_id);
        assert_eq!(listed[0]["status"], "succeeded");
        let fetched = json_body(
            app.oneshot(get_local(&format!("/api/runs/{}", accepted.run_id)))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(fetched["sessionId"], accepted.run_id);
        assert_eq!(fetched["reply"], "done");
        assert_eq!(fetched["stopReason"], "end_turn");

        let sessions = archive.list_sessions().await.unwrap();
        let session = sessions
            .iter()
            .find(|session| session.session_id == accepted.run_id)
            .expect("run is discoverable as an archive session");
        assert_eq!(session.first_agent_id.as_deref(), Some("solo"));
        assert_eq!(
            session.prompt.as_deref(),
            Some("## Your assigned role\nanswer directly\n\n## Task\nsay done")
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn a_normal_turn_with_no_response_fails_as_missing_canonical_response(
        pool: sqlx::PgPool,
    ) {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("quiet.sh", EMPTY_REPLY_HARNESS);
        dir.write_team("team.yaml", &harness);
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({"teamPath": "team.yaml", "prompt": "say done"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let accepted: RunRecord = serde_json::from_value(json_body(response).await).unwrap();

        let done = wait_for(&registry, &accepted.run_id, |r| r.status.is_terminal()).await;
        assert_eq!(done.status, RunStatus::Failed, "{done:?}");
        assert_eq!(
            done.error, None,
            "nothing failed; the turn merely produced no answer"
        );
        assert_eq!(done.error_code.as_deref(), Some(MISSING_CANONICAL_RESPONSE));
        assert_eq!(done.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(done.exit_code, Some(0));
        assert_eq!(done.reply, None);
        assert!(done.event_count.is_some());

        let fetched = json_body(
            app.oneshot(get_local(&format!("/api/runs/{}", accepted.run_id)))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(fetched["errorCode"], MISSING_CANONICAL_RESPONSE);
        assert_eq!(fetched["stopReason"], "end_turn");
        assert!(fetched["error"].is_null());
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn cancel_aborts_the_run_and_kills_the_harness(pool: sqlx::PgPool) {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("sleepy.sh", SLEEPING_HARNESS);
        dir.write_team("team.yaml", &harness);
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/runs",
                &json!({"teamPath": "team.yaml", "prompt": "sleep"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let accepted: RunRecord = serde_json::from_value(json_body(response).await).unwrap();

        let running = wait_for(&registry, &accepted.run_id, |r| {
            r.status == RunStatus::Running
        })
        .await;
        assert!(running.started_at.is_some());
        let spawned = archive.event_page(&accepted.run_id, -1, 1).await.unwrap();
        assert_eq!(spawned[0].payload["phase"], "spawned");
        let pid = u32::try_from(spawned[0].payload["pid"].as_u64().unwrap()).unwrap();
        assert!(process_is_alive(pid), "harness {pid} should be sleeping");

        let response = app
            .clone()
            .oneshot(post_json(
                &format!("/api/runs/{}/cancel", accepted.run_id),
                &json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cancelled: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        assert_eq!(cancelled.status, RunStatus::Cancelled);
        assert!(cancelled.finished_at.is_some());
        let checkpoints = archive
            .notebook()
            .checkpoints(&accepted.run_id, Some("solo"))
            .await
            .unwrap();
        assert_eq!(
            checkpoints.len(),
            1,
            "cancellation must leave a recovery point"
        );
        assert_eq!(
            checkpoints[0].source,
            crate::memory::CheckpointSource::Coordinator
        );
        record_abandoned_checkpoints(&archive, &accepted.run_id, &crate::RunLineage::default())
            .await;
        assert_eq!(
            archive
                .notebook()
                .checkpoints(&accepted.run_id, Some("solo"))
                .await
                .unwrap()
                .len(),
            1,
            "a repeated cancellation sweep must not duplicate the checkpoint"
        );

        tokio::time::timeout(Duration::from_secs(10), async {
            while process_is_alive(pid) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("aborting the run task must kill the harness through kill_on_drop");

        let response = app
            .clone()
            .oneshot(post_json(
                &format!("/api/runs/{}/cancel", accepted.run_id),
                &json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(json_body(response).await["status"], "cancelled");
        let fetched = json_body(
            app.oneshot(get_local(&format!("/api/runs/{}", accepted.run_id)))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(fetched["status"], "cancelled");
        assert_eq!(
            registry.get(&accepted.run_id).unwrap().status,
            RunStatus::Cancelled
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn answers_validate_the_address_and_advance_the_question_queue(pool: sqlx::PgPool) {
        use crate::operator::{ParkTier, StopKind, WaitingOn};
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        dir.write_team("team.yaml", &harness);
        let team = TeamConfig::load(&dir.0.join("team.yaml")).unwrap();
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::durable(archive.run_store());
        let record =
            RunRecord::queued("team.yaml".into(), "go".into(), &team, RunTrigger::Manual).unwrap();
        let run_id = record.run_id.clone();
        registry.insert(record);
        assert!(registry.mark_starting(&run_id));
        assert!(registry.mark_running(&run_id));
        let desk = registry.operator_desk(Some(&archive));
        let waiting = |node: &str| WaitingOn {
            node: node.into(),
            name: node.into(),
            kind: StopKind::Question,
            since: now(),
            question: "Which budget?".into(),
            context: None,
            handover_from: None,
            park: ParkTier::KeptAlive,
            park_note: "kept alive".into(),
            send_back_available: false,
            question_id: None,
        };
        let first = desk.park(&run_id, waiting("solo")).await.unwrap();
        assert!(
            desk.park(&run_id, waiting("solo"))
                .await
                .err()
                .expect("duplicate question refused")
                .conflict
        );
        let second = desk.park(&run_id, waiting("helper")).await.unwrap();
        let mut update = waiting("helper");
        update.park = ParkTier::Released;
        desk.repark(&run_id, &update).await;
        assert_eq!(desk.waiting(&run_id).unwrap().node, "solo");
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());
        let endpoint = format!("/api/runs/{run_id}/answers");
        for body in [
            json!({"node":"wrong", "text":"yes"}),
            json!({"node":"solo", "text":"yes", "sendBack":"solo"}),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(post_json(&endpoint, &body))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::CONFLICT
            );
        }
        assert_eq!(
            app.clone()
                .oneshot(post_json(&endpoint, &json!({"node":"solo", "text":"   "})))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let response = app
            .clone()
            .oneshot(post_json(
                &endpoint,
                &json!({"node":"solo", "text":"Use the smaller one"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(json_body(response).await["waitingOn"]["node"], "helper");
        assert_eq!(first.answer().await.unwrap().text, "Use the smaller one");
        assert_eq!(
            app.clone()
                .oneshot(post_json(
                    &endpoint,
                    &json!({"node":"solo", "text":"duplicate"})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        desk.deliver(
            &run_id,
            "helper",
            OperatorAnswer {
                text: "done".into(),
                send_back: None,
                answer_event_id: "answer-2".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(second.answer().await.unwrap().text, "done");
        assert!(desk.waiting(&run_id).is_none());
        let stored = RunRegistry::durable(archive.run_store());
        stored.reload().await.unwrap();
        assert!(stored.get(&run_id).unwrap().waiting_on.is_none());
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn a_follow_up_replays_operator_direction_separately_from_the_handover(
        pool: sqlx::PgPool,
    ) {
        let archive = EventArchive::from_pool(pool);
        crate::EventLog::new(archive.clone(), "reviewed".into())
            .append(
                "writer",
                EventKind::SessionMeta,
                json!({"phase":"prompt_sections", "sections":[
                    {"kind":"stage_results", "heading":"Results", "text":"source material"},
                    {"kind":"direction", "heading":"Direction", "text":"Do not publish the draft"}
                ]}),
                None,
            )
            .await
            .unwrap();
        let mut lineage = crate::RunLineage {
            start_at: Some("writer".into()),
            ..crate::RunLineage::default()
        };
        seed_replayed_handovers(
            &archive,
            "reviewed",
            &["review".into(), "writer".into()],
            &BTreeMap::from([("writer".into(), vec!["review".into()])]),
            &mut lineage,
        )
        .await
        .unwrap();
        assert_eq!(
            lineage.replayed_directions["writer"],
            "Do not publish the draft"
        );
        assert_eq!(lineage.replayed_stage_results["writer"], "source material");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn a_released_question_starts_a_checkpoint_continuation_and_identifies_it(
        pool: sqlx::PgPool,
    ) {
        use crate::memory::{CheckpointSource, CheckpointWrite};
        use crate::operator::{ParkTier, StopKind, WaitingOn};
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        dir.write_team("team.yaml", &harness);
        let team = TeamConfig::load(&dir.0.join("team.yaml")).unwrap();
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::durable(archive.run_store());
        let record = RunRecord::queued(
            "team.yaml".into(),
            "Finish the report".into(),
            &team,
            RunTrigger::Manual,
        )
        .unwrap();
        let run_id = record.run_id.clone();
        registry.insert(record);
        assert!(registry.mark_starting(&run_id));
        assert!(registry.mark_running(&run_id));
        archive
            .notebook()
            .write_checkpoint(&CheckpointWrite {
                run_id: run_id.clone(),
                agent_id: "solo".into(),
                done: "First draft prepared".into(),
                next: String::new(),
                blockers: None,
                artifacts: vec![],
                seq_high_water: Some(0),
                source: CheckpointSource::Coordinator,
                team_revision: None,
            })
            .await
            .unwrap();
        let desk = registry.operator_desk(Some(&archive));
        let receiver = desk
            .park(
                &run_id,
                WaitingOn {
                    node: "solo".into(),
                    name: "Solo".into(),
                    kind: StopKind::Question,
                    since: now(),
                    question: "Which audience?".into(),
                    context: None,
                    handover_from: None,
                    park: ParkTier::Released,
                    park_note: "released".into(),
                    send_back_available: false,
                    question_id: None,
                },
            )
            .await
            .unwrap();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());
        let response = app
            .clone()
            .oneshot(post_json(
                &format!("/api/runs/{run_id}/answers"),
                &json!({"node":"solo", "text":"Write for new users"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers()["x-loomwatch-continuation-of"], run_id);
        let next: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        assert_ne!(next.run_id, run_id);
        assert_eq!(next.follows_run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!(receiver.answer().await.unwrap().text, "Write for new users");
        let done = wait_for(&registry, &next.run_id, |record| {
            record.status.is_terminal()
        })
        .await;
        assert_eq!(done.status, RunStatus::Succeeded, "{done:?}");
        let packets = archive
            .context_packets(&next.run_id, Some("solo"))
            .await
            .unwrap();
        assert!(format!("{packets:?}").contains("First draft prepared"));
        let events = archive.load_session(&next.run_id).await.unwrap();
        assert!(events.iter().any(|event| {
            event.kind == EventKind::Message
                && event.payload["role"] == "user"
                && event.payload["content"]["text"]
                    .as_str()
                    .is_some_and(|text| {
                        text.contains("Write for new users")
                            && text.contains("## Direction from you")
                    })
        }));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn team_mode_checkpoints_without_replacing_its_answer(pool: sqlx::PgPool) {
        let dir = TeamsDir::new();
        let script = COMPLETING_HARNESS.replace(
            "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{}}'",
            r###"printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"harness-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"## Done\nDraft ready\n\n## Next\nReview it"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}'"###
        );
        let harness = dir.write_harness("memory.sh", &script);
        let path = dir.write_team("team.yaml", &harness);
        let yaml = fs::read_to_string(&path).unwrap();
        fs::write(
            path,
            format!("{yaml}\nmemory:\n  deliverAs: packet-only\n  notebook:\n    enabled: true\n"),
        )
        .unwrap();
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());
        let response = app
            .oneshot(post_json(
                "/api/runs",
                &json!({"teamPath":"team.yaml", "prompt":"Write the draft"}),
            ))
            .await
            .unwrap();
        let started: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        let done = wait_for(&registry, &started.run_id, |record| {
            record.status.is_terminal()
        })
        .await;
        assert_eq!(done.status, RunStatus::Succeeded, "{done:?}");
        assert_eq!(done.reply.as_deref(), Some("done"));
        let points = archive
            .notebook()
            .checkpoints(&done.run_id, Some("solo"))
            .await
            .unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].done, "Draft ready");
        let events = archive.load_session(&done.run_id).await.unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.kind == EventKind::SessionMeta
                    && event.payload["phase"] == "turn_purpose"
                    && event.payload["purpose"] == "checkpoint")
        );
    }
}
