//! Loopback-only run control: start a team from the browser, watch it through the exact
//! archive stream, and stop it. See `docs/decisions/0008-run-control-api.md`.
//!
//! A run's `runId` is minted here, before any harness exists, and doubles as the archive
//! `sessionId` every event of the run lands under — so a client can open
//! `/api/session/stream?session=<runId>` the moment `POST /api/runs` returns. The registry
//! is in-memory and lives as long as the daemon; it is not the immutable run record of
//! `RUN_PROVENANCE_CONTRACT.md`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};
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
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::api::{ApiError, normalized_relative_path, resolve_existing_team_path};
use crate::archive::EventArchive;
use crate::config::TeamConfig;
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
const IDEMPOTENCY_CONFLICT: &str = "idempotency_conflict";

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
    /// Set after a routine run finishes and its reply has been delivered (or not);
    /// always `null` for manual runs.
    #[serde(default)]
    pub delivery: Option<Delivery>,
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
        let (mode, responder) = if team.edges.is_empty() {
            ("team", team.entrypoint.clone())
        } else {
            let order = team.pipeline_order()?;
            let last = order
                .last()
                .cloned()
                .unwrap_or_else(|| team.entrypoint.clone());
            ("pipeline", last)
        };
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

/// In-memory registry of every run started through the API since the daemon booted.
#[derive(Clone, Default)]
pub struct RunRegistry {
    inner: Arc<RwLock<RegistryInner>>,
}

impl RunRegistry {
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
        entry.record.status = RunStatus::Cancelled;
        entry.record.finished_at = Some(now());
        CancelOutcome::Cancelled(entry.record.clone())
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
            entry.handle = None;
        }
        true
    }
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
        .route("/api/runs/{id}/cancel", post(cancel_run))
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
    );
    match outcome {
        Ok(StartRunOutcome::Accepted(record)) => {
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
        Err(LaunchError::Api(error)) => Err(error),
    }
}

fn launch_manual(
    registry: &RunRegistry,
    archive: Option<EventArchive>,
    teams_root: &Path,
    request: &StartRunRequest,
) -> Result<StartRunOutcome, LaunchError> {
    let expected_revision = request.expected_revision.as_deref();
    let start_key = request.start_key.as_deref();
    let fingerprint = start_key
        .map(|_| start_fingerprint(&request.team_path, &request.prompt, expected_revision));
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

    let prepared = prepare_run(
        archive,
        teams_root,
        Path::new(&request.team_path),
        &request.prompt,
        RunTrigger::Manual,
        expected_revision,
    )?;
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
    let prepared = prepare_run(archive, teams_root, team_path, prompt, trigger, None)
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
    prompt: String,
}

fn prepare_run(
    archive: Option<EventArchive>,
    teams_root: &Path,
    team_path: &Path,
    prompt: &str,
    trigger: RunTrigger,
    expected_revision: Option<&str>,
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
    let Some(archive) = archive else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ARCHIVE_DISABLED_MESSAGE.to_owned(),
        )
        .into());
    };
    let record = RunRecord::queued(relative, prompt.to_owned(), &team, trigger)
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}")))?;
    Ok(PreparedRun {
        record,
        archive,
        resolved,
        prompt: prompt.to_owned(),
    })
}

fn spawn_prepared(registry: &RunRegistry, prepared: PreparedRun, run_id: &str) {
    let handle = tokio::spawn(execute(
        registry.clone(),
        prepared.archive,
        prepared.resolved,
        prepared.prompt,
        run_id.to_owned(),
    ));
    registry.attach(run_id, handle);
}

fn team_revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
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
async fn execute(
    registry: RunRegistry,
    archive: EventArchive,
    team_path: PathBuf,
    prompt: String,
    run_id: String,
) {
    if !registry.mark_starting(&run_id) {
        // Cancelled between insertion and the first poll: never start a process for it.
        return;
    }
    let run = crate::run_team_session_with_session_id(
        &team_path,
        archive.clone(),
        &prompt,
        EXIT_TIMEOUT,
        run_id.clone(),
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
) -> Result<Json<RunRecord>, ApiError> {
    state.registry.get(&run_id).map(Json).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("run {run_id} does not exist"),
        )
    })
}

async fn cancel_run(
    State(state): State<RunsState>,
    RoutePath(run_id): RoutePath<String>,
) -> Response {
    match state.registry.cancel(&run_id) {
        CancelOutcome::Cancelled(record) => (StatusCode::OK, Json(record)).into_response(),
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

        fn write_team(&self, name: &str, harness: &Path) -> PathBuf {
            let yaml = format!(
                "schemaVersion: 1\nid: fake\nname: Fake harness team\nentrypoint: solo\nagents:\n  - id: solo\n    name: Solo\n    role: answer directly\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
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

    #[test]
    fn registry_transitions_are_monotonic_and_terminal_states_never_change() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n  - id: b\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\nedges:\n  - {from: a, to: b, layer: configured, kind: sequence, ts: \"2026-09-10T00:00:00Z\"}\n",
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
    fn start_keys_collapse_duplicates_and_bind_to_the_exact_request_fingerprint() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n",
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
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n",
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
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n",
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
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n",
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
}
