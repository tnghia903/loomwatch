//! Routines: run a team on its `schedule` block and deliver the canonical reply. See
//! `docs/decisions/0010-routines-and-notion-delivery.md`.
//!
//! The scheduler is in memory. Every 30 s it rescans the teams root, recomputes fire
//! times only when a schedule changed or fired, and starts due routines through exactly
//! the path `POST /api/runs` uses ([`runs::launch`]). Fires missed while the daemon was
//! down are skipped; a routine whose previous run is still live is skipped, not queued.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::api::{ApiError, normalized_relative_path, resolve_existing_team_path};
use crate::archive::EventArchive;
use crate::config::{ScheduleConfig, TeamConfig};
use crate::notion::{PublishError, Publisher};
use crate::runs::{self, Delivery, DeliveryStatus, RunRecord, RunRegistry, RunStatus, RunTrigger};
use crate::watch_api::{ARCHIVE_DISABLED_MESSAGE, local_evidence};

/// How often the teams root is rescanned and due routines are fired.
const TICK: Duration = Duration::from_secs(30);
/// How often a delivery task looks for its run to finish.
const DELIVERY_POLL: Duration = Duration::from_millis(1000);
/// Delivery message when the duplicate-title guard skipped publishing.
pub(crate) const DUPLICATE_MESSAGE: &str = "A page with this title already exists.";

/// Why a routine cannot, or did not, fire.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Problem {
    /// The team file or its `schedule` block does not parse; cleared once it does.
    Parse(String),
    /// The last fire attempt was skipped or refused; cleared by the next successful fire.
    Fire(String),
}

impl Problem {
    fn message(&self) -> &str {
        match self {
            Self::Parse(message) | Self::Fire(message) => message,
        }
    }
}

/// One scheduled team, keyed in the map by its normalised path below the teams root.
#[derive(Debug, Clone)]
struct Entry {
    team_name: String,
    /// The validated block; `None` while the file fails to parse.
    schedule: Option<ScheduleConfig>,
    cron: String,
    timezone: Option<String>,
    prompt: String,
    enabled: bool,
    /// The effective Notion title template, when Notion delivery is configured.
    notion_title: Option<String>,
    next_at: Option<DateTime<Utc>>,
    last_run_id: Option<String>,
    last_status: Option<RunStatus>,
    last_fired_at: Option<String>,
    last_delivery: Option<Delivery>,
    problem: Option<Problem>,
}

impl Entry {
    fn new(team_name: String, schedule: Option<ScheduleConfig>, message: Option<String>) -> Self {
        let mut entry = Self {
            team_name,
            schedule: None,
            cron: String::new(),
            timezone: None,
            prompt: String::new(),
            enabled: true,
            notion_title: None,
            next_at: None,
            last_run_id: None,
            last_status: None,
            last_fired_at: None,
            last_delivery: None,
            problem: message.map(Problem::Parse),
        };
        if let Some(schedule) = schedule {
            entry.copy_fields(&schedule);
        }
        entry
    }

    /// Mirror the block's text fields (parsed or not) so the API can show them.
    fn copy_fields(&mut self, schedule: &ScheduleConfig) {
        self.cron.clone_from(&schedule.cron);
        self.timezone.clone_from(&schedule.timezone);
        self.prompt.clone_from(&schedule.prompt);
        self.enabled = schedule.enabled;
        self.notion_title = schedule.notion_title().map(str::to_owned);
    }

    /// Adopt a validated schedule: recompute the next fire only when the timing changed
    /// (or the entry had no valid schedule before), so an edit to the prompt alone does not
    /// move a pending fire.
    fn adopt(&mut self, team_name: &str, schedule: ScheduleConfig, now: DateTime<Utc>) {
        let timing_changed = self.schedule.as_ref().is_none_or(|current| {
            current.cron != schedule.cron || current.timezone != schedule.timezone
        });
        team_name.clone_into(&mut self.team_name);
        self.copy_fields(&schedule);
        if timing_changed {
            self.next_at = schedule.next_fire(now).ok().flatten();
        }
        self.schedule = Some(schedule);
        if matches!(self.problem, Some(Problem::Parse(_))) {
            self.problem = None;
        }
        if self.next_at.is_none() {
            self.problem = Some(Problem::Parse(
                "the cron expression has no future fire time".to_owned(),
            ));
        }
    }

    /// The expanded prompt and title for a fire at `now`, unless the previous scheduled
    /// run of this team is still live.
    fn plan(
        &self,
        key: &str,
        now: DateTime<Utc>,
        is_live: impl Fn(&str) -> bool,
    ) -> Result<FirePlan, String> {
        let Some(schedule) = &self.schedule else {
            return Err(self.problem.as_ref().map_or_else(
                || "the schedule block does not parse".to_owned(),
                |problem| problem.message().to_owned(),
            ));
        };
        if let Some(run_id) = &self.last_run_id
            && is_live(run_id)
        {
            return Err(format!("previous scheduled run {run_id} is still running"));
        }
        Ok(FirePlan {
            key: key.to_owned(),
            prompt: schedule.expand(&self.prompt, &self.team_name, now),
            title: self
                .notion_title
                .as_deref()
                .map(|title| schedule.expand(title, &self.team_name, now)),
        })
    }
}

/// A due routine with its templates expanded: everything a launch needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FirePlan {
    key: String,
    prompt: String,
    /// Expanded Notion page title; `None` when the routine delivers nowhere.
    title: Option<String>,
}

/// What one tick decided: routines to launch, and routines skipped with the reason.
#[derive(Debug, Default, PartialEq, Eq)]
struct Due {
    plans: Vec<FirePlan>,
    skipped: Vec<(String, String)>,
}

/// Select every enabled entry whose fire time has passed, advance its `next_at`, and
/// expand its templates. A disabled entry's fire time is advanced without firing so a
/// later re-enable does not fire immediately. `is_live` answers whether a run id is
/// still non-terminal.
fn collect_due(
    entries: &mut BTreeMap<String, Entry>,
    now: DateTime<Utc>,
    is_live: impl Fn(&str) -> bool,
) -> Due {
    let mut due = Due::default();
    for (key, entry) in entries.iter_mut() {
        let Some(schedule) = entry.schedule.clone() else {
            continue;
        };
        let Some(next_at) = entry.next_at else {
            continue;
        };
        if next_at > now {
            continue;
        }
        entry.next_at = schedule.next_fire(now).ok().flatten();
        if !entry.enabled {
            continue;
        }
        match entry.plan(key, now, &is_live) {
            Ok(plan) => {
                due.plans.push(plan);
            }
            Err(problem) => {
                entry.problem = Some(Problem::Fire(problem.clone()));
                due.skipped.push((key.clone(), problem));
            }
        }
    }
    due
}

/// What a rescan learned about one team file.
#[derive(Debug)]
enum Scanned {
    /// Parses and has a `schedule` block.
    Scheduled {
        team_name: String,
        schedule: ScheduleConfig,
    },
    /// Has a `schedule` key but does not load; `raw` is the block as written when it is
    /// at least structurally readable.
    Broken {
        team_name: String,
        raw: Option<ScheduleConfig>,
        message: String,
    },
    /// No `schedule` key (or unreadable without one): not a routine.
    Unscheduled,
}

/// Every `*.yaml` / `*.yml` below `teams_root` (hidden directories skipped, directory
/// symlinks not followed) with what its `schedule` block says.
fn scan(teams_root: &Path) -> Vec<(String, Scanned)> {
    let mut directories = vec![teams_root.to_path_buf()];
    let mut found = Vec::new();
    while let Some(directory) = directories.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let hidden = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with('.'));
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if hidden {
                continue;
            }
            if file_type.is_dir() {
                directories.push(path);
                continue;
            }
            let is_team = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml")
                });
            if !is_team || !path.is_file() {
                continue;
            }
            if let Some(key) = normalized_relative_path(teams_root, &path) {
                found.push((key, inspect(&path)));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

fn inspect(path: &Path) -> Scanned {
    match TeamConfig::load(path) {
        Ok(team) => match team.schedule {
            Some(schedule) => Scanned::Scheduled {
                team_name: display_name(&team.name, path),
                schedule,
            },
            None => Scanned::Unscheduled,
        },
        Err(error) => {
            let document: serde_yaml::Value = fs::read_to_string(path)
                .ok()
                .and_then(|source| serde_yaml::from_str(&source).ok())
                .unwrap_or(serde_yaml::Value::Null);
            let Some(block) = document.get("schedule") else {
                return Scanned::Unscheduled;
            };
            let name = document
                .get("name")
                .and_then(serde_yaml::Value::as_str)
                .unwrap_or_default();
            Scanned::Broken {
                team_name: display_name(name, path),
                raw: serde_yaml::from_value(block.clone()).ok(),
                message: error.root_cause().to_string(),
            }
        }
    }
}

/// The team's name, or its file stem when the file names none.
fn display_name(name: &str, path: &Path) -> String {
    if name.trim().is_empty() {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("team")
            .to_owned()
    } else {
        name.to_owned()
    }
}

/// Apply a scan to the map: scheduled files are adopted, broken ones keep or gain an
/// entry with `problem`, everything else is dropped.
fn reconcile(
    entries: &mut BTreeMap<String, Entry>,
    scanned: Vec<(String, Scanned)>,
    now: DateTime<Utc>,
) {
    let mut keep = Vec::new();
    for (key, outcome) in scanned {
        match outcome {
            Scanned::Scheduled {
                team_name,
                schedule,
            } => {
                entries
                    .entry(key.clone())
                    .or_insert_with(|| Entry::new(team_name.clone(), None, None))
                    .adopt(&team_name, schedule, now);
                keep.push(key);
            }
            Scanned::Broken {
                team_name,
                raw,
                message,
            } => {
                let entry = entries
                    .entry(key.clone())
                    .or_insert_with(|| Entry::new(team_name.clone(), None, None));
                entry.team_name = team_name;
                if let Some(raw) = &raw {
                    entry.copy_fields(raw);
                }
                entry.schedule = None;
                entry.next_at = None;
                entry.problem = Some(Problem::Parse(message));
                keep.push(key);
            }
            Scanned::Unscheduled => {}
        }
    }
    entries.retain(|key, _| keep.contains(key));
}

/// One routine as `GET /api/schedules` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSnapshot {
    pub team_path: String,
    pub team_name: String,
    pub cron: String,
    pub timezone: Option<String>,
    /// Human summary (`daily at 08:00 Asia/Singapore`), or the cron text.
    pub describe: String,
    /// The prompt template, unexpanded.
    pub prompt: String,
    pub enabled: bool,
    /// Next timed fire, RFC 3339 UTC; `null` while the block does not parse.
    pub next_at: Option<String>,
    pub last_run_id: Option<String>,
    pub last_status: Option<RunStatus>,
    pub last_fired_at: Option<String>,
    pub last_delivery: Option<Delivery>,
    pub deliver: Option<DeliverSnapshot>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeliverSnapshot {
    pub notion: NotionSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotionSnapshot {
    /// The effective title template, unexpanded.
    pub title: String,
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The routine registry plus the publisher deliveries go through.
#[derive(Clone)]
pub struct Scheduler {
    entries: Arc<RwLock<BTreeMap<String, Entry>>>,
    publisher: Arc<Publisher>,
}

/// Start the scheduler. With an archive, a background task rescans `teams_root` and
/// fires due routines every 30 s; without one nothing runs and the API answers 503.
///
/// # Errors
///
/// Returns an error if the publisher's HTTPS client cannot be initialized.
pub fn spawn(
    registry: RunRegistry,
    archive: Option<EventArchive>,
    teams_root: PathBuf,
) -> anyhow::Result<Scheduler> {
    let scheduler = Scheduler::with_publisher(Publisher::new()?);
    if let Some(archive) = archive {
        let teams_root = fs::canonicalize(&teams_root).unwrap_or(teams_root);
        let ticking = scheduler.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(TICK);
            loop {
                ticker.tick().await;
                ticking.tick(&registry, &archive, &teams_root, Utc::now());
            }
        });
    }
    Ok(scheduler)
}

impl Scheduler {
    fn with_publisher(publisher: Publisher) -> Self {
        Self {
            entries: Arc::new(RwLock::new(BTreeMap::new())),
            publisher: Arc::new(publisher),
        }
    }

    /// A scheduler with no background task whose deliveries always report "not
    /// connected" — the keychain is never read.
    #[cfg(test)]
    pub(crate) fn disconnected() -> Self {
        Self::with_publisher(Publisher::disconnected())
    }

    /// Rescan the teams root and fold the result into the map.
    fn rescan(&self, teams_root: &Path, now: DateTime<Utc>) {
        let scanned = scan(teams_root);
        let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
        reconcile(&mut entries, scanned, now);
    }

    /// One scheduler tick: rescan, then fire everything due.
    fn tick(
        &self,
        registry: &RunRegistry,
        archive: &EventArchive,
        teams_root: &Path,
        now: DateTime<Utc>,
    ) {
        self.rescan(teams_root, now);
        let due = {
            let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
            collect_due(&mut entries, now, |run_id| {
                registry
                    .get(run_id)
                    .is_some_and(|record| !record.status.is_terminal())
            })
        };
        for (key, problem) in &due.skipped {
            eprintln!("schedule: {key}: skipped: {problem}");
        }
        for plan in due.plans {
            let _outcome = self.launch(plan, registry, archive, teams_root);
        }
    }

    /// Start a planned fire through `runs::launch`, record it on the entry, and follow
    /// the run to deliver its reply.
    fn launch(
        &self,
        plan: FirePlan,
        registry: &RunRegistry,
        archive: &EventArchive,
        teams_root: &Path,
    ) -> Result<RunRecord, ApiError> {
        let result = runs::launch(
            registry,
            Some(archive.clone()),
            teams_root,
            Path::new(&plan.key),
            &plan.prompt,
            RunTrigger::Schedule,
        );
        {
            let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
            if let Some(entry) = entries.get_mut(&plan.key) {
                match &result {
                    Ok(record) => {
                        entry.last_run_id = Some(record.run_id.clone());
                        entry.last_status = Some(record.status);
                        entry.last_fired_at = Some(stamp(Utc::now()));
                        entry.last_delivery = None;
                        if matches!(entry.problem, Some(Problem::Fire(_))) {
                            entry.problem = None;
                        }
                    }
                    Err(error) => entry.problem = Some(Problem::Fire(error.message.clone())),
                }
            }
        }
        match &result {
            Ok(record) => {
                println!(
                    "schedule: fired {} as run {}{}",
                    plan.key,
                    record.run_id,
                    plan.title
                        .as_deref()
                        .map_or_else(String::new, |title| format!(
                            " (deliver to Notion as {title:?})"
                        ))
                );
                tokio::spawn(deliver_when_finished(
                    self.clone(),
                    registry.clone(),
                    plan.key,
                    record.run_id.clone(),
                    plan.title,
                ));
            }
            Err(error) => eprintln!("schedule: {}: launch refused: {}", plan.key, error.message),
        }
        result
    }

    /// Store a finished run's status and delivery on its entry, if it is still that
    /// entry's latest run.
    fn record_outcome(
        &self,
        key: &str,
        run_id: &str,
        status: RunStatus,
        delivery: Option<Delivery>,
    ) {
        let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = entries.get_mut(key)
            && entry.last_run_id.as_deref() == Some(run_id)
        {
            entry.last_status = Some(status);
            entry.last_delivery = delivery;
        }
    }

    /// Every routine, sorted by path. `lastStatus` is read live from the registry.
    #[must_use]
    pub fn snapshot(&self, registry: &RunRegistry) -> Vec<ScheduleSnapshot> {
        let entries = self.entries.read().unwrap_or_else(PoisonError::into_inner);
        entries
            .iter()
            .map(|(key, entry)| ScheduleSnapshot {
                team_path: key.clone(),
                team_name: entry.team_name.clone(),
                cron: entry.cron.clone(),
                timezone: entry.timezone.clone(),
                describe: entry
                    .schedule
                    .as_ref()
                    .map_or_else(|| entry.cron.clone(), ScheduleConfig::describe),
                prompt: entry.prompt.clone(),
                enabled: entry.enabled,
                next_at: entry.next_at.map(stamp),
                last_run_id: entry.last_run_id.clone(),
                last_status: entry
                    .last_run_id
                    .as_deref()
                    .and_then(|run_id| registry.get(run_id))
                    .map_or(entry.last_status, |record| Some(record.status)),
                last_fired_at: entry.last_fired_at.clone(),
                last_delivery: entry.last_delivery.clone(),
                deliver: entry.notion_title.clone().map(|title| DeliverSnapshot {
                    notion: NotionSnapshot { title },
                }),
                problem: entry.problem.as_ref().map(|p| p.message().to_owned()),
            })
            .collect()
    }
}

/// Wait for a scheduled run to finish, publish its reply when it succeeded and the
/// routine delivers to Notion, and record the outcome on the run and the routine.
async fn deliver_when_finished(
    scheduler: Scheduler,
    registry: RunRegistry,
    key: String,
    run_id: String,
    title: Option<String>,
) {
    let record = loop {
        match registry.get(&run_id) {
            Some(record) if record.status.is_terminal() => break record,
            Some(_) => tokio::time::sleep(DELIVERY_POLL).await,
            None => return,
        }
    };
    let reply = record
        .reply
        .as_deref()
        .filter(|reply| !reply.trim().is_empty());
    let delivery = match (record.status, title, reply) {
        (RunStatus::Succeeded, Some(title), Some(reply)) => {
            Some(publish_outcome(&scheduler.publisher, &title, reply).await)
        }
        _ => None,
    };
    if let Some(delivery) = &delivery {
        let _known = registry.set_delivery(&run_id, delivery.clone());
        if let Err(error) = registry.persist(&run_id).await {
            eprintln!("warning: could not persist run {run_id}: {error}");
        }
        println!(
            "schedule: run {run_id} delivery {}: {}{}",
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
    scheduler.record_outcome(&key, &run_id, record.status, delivery);
}

async fn publish_outcome(publisher: &Publisher, title: &str, markdown: &str) -> Delivery {
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

// ---------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------

#[derive(Clone)]
struct ScheduleState {
    scheduler: Scheduler,
    registry: RunRegistry,
    archive: Option<EventArchive>,
    teams_root: PathBuf,
}

/// `GET /api/schedules` and `POST /api/schedules/run`, loopback-only like run control.
pub fn router(
    scheduler: Scheduler,
    registry: RunRegistry,
    archive: Option<EventArchive>,
    teams_root: PathBuf,
) -> Router {
    let teams_root = fs::canonicalize(&teams_root).unwrap_or(teams_root);
    Router::new()
        .route("/api/schedules", get(list_schedules))
        .route("/api/schedules/run", post(run_now))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(ScheduleState {
            scheduler,
            registry,
            archive,
            teams_root,
        })
}

fn archive_disabled() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ARCHIVE_DISABLED_MESSAGE.to_owned(),
    )
}

async fn list_schedules(
    State(state): State<ScheduleState>,
) -> Result<Json<Vec<ScheduleSnapshot>>, ApiError> {
    if state.archive.is_none() {
        return Err(archive_disabled());
    }
    // A schedule saved a moment ago should be visible now, not after the next tick.
    state.scheduler.rescan(&state.teams_root, Utc::now());
    Ok(Json(state.scheduler.snapshot(&state.registry)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunNowRequest {
    team_path: PathBuf,
}

/// "Run the routine now": expand the templates and launch exactly like a timed fire,
/// delivery included. `enabled: false` does not stop an explicit request.
async fn run_now(
    State(state): State<ScheduleState>,
    body: Result<Json<RunNowRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid schedule run request: {}", rejection.body_text()),
        )
    })?;
    let Some(archive) = state.archive.clone() else {
        return Err(archive_disabled());
    };
    let resolved = resolve_existing_team_path(&state.teams_root, &request.team_path)?;
    let key = normalized_relative_path(&state.teams_root, &resolved).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "team path {} is not a UTF-8 path below the teams root",
                request.team_path.display()
            ),
        )
    })?;
    let now = Utc::now();
    state.scheduler.rescan(&state.teams_root, now);
    let plan = {
        let entries = state
            .scheduler
            .entries
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = entries.get(&key) else {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                format!("team {key} has no schedule block"),
            ));
        };
        entry
            .plan(&key, now, |run_id| {
                state
                    .registry
                    .get(run_id)
                    .is_some_and(|record| !record.status.is_terminal())
            })
            .map_err(|problem| {
                let status = if entry.schedule.is_none() {
                    StatusCode::UNPROCESSABLE_ENTITY
                } else {
                    StatusCode::CONFLICT
                };
                ApiError::new(status, problem)
            })?
    };
    let record = state
        .scheduler
        .launch(plan, &state.registry, &archive, &state.teams_root)?;
    Ok((StatusCode::ACCEPTED, Json(record)).into_response())
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;
    use crate::notion::NOT_CONNECTED_MESSAGE;
    use crate::runs::tests::{COMPLETING_HARNESS, SLEEPING_HARNESS, TeamsDir};

    fn utc(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .expect("valid instant")
            .with_timezone(&Utc)
    }

    fn schedule(cron: &str, prompt: &str, title: Option<&str>) -> ScheduleConfig {
        let deliver = title.map(|title| crate::config::DeliverConfig {
            notion: Some(crate::config::NotionDeliverConfig {
                title: Some(title.to_owned()),
            }),
        });
        ScheduleConfig {
            cron: cron.to_owned(),
            timezone: Some("Asia/Singapore".to_owned()),
            prompt: prompt.to_owned(),
            enabled: true,
            deliver,
        }
    }

    fn scheduled(name: &str, schedule: ScheduleConfig) -> Scanned {
        Scanned::Scheduled {
            team_name: name.to_owned(),
            schedule,
        }
    }

    /// A scheduled team whose single agent is the shell-script harness at `harness`.
    fn scheduled_team_yaml(harness: &Path, schedule_yaml: &str) -> String {
        format!(
            "schemaVersion: 1\nid: routine\nname: Routine team\nentrypoint: solo\nschedule:\n{schedule_yaml}agents:\n  - id: solo\n    name: Solo\n    role: answer directly\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
            harness.display()
        )
    }

    const DAILY: &str = "  cron: \"0 8 * * *\"\n  timezone: Asia/Singapore\n  prompt: \"{{weekday}} {{date}} digest for {{team}}\"\n  deliver:\n    notion:\n      title: \"Digest — {{date}}\"\n";

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
    fn reconcile_adopts_updates_and_drops_entries() {
        let now = utc("2026-09-11T01:00:00Z"); // 09:00 SGT: next daily 08:00 fire is the 12th
        let mut entries = BTreeMap::new();
        reconcile(
            &mut entries,
            vec![
                (
                    "a.yaml".into(),
                    scheduled("A", schedule("0 8 * * *", "p", None)),
                ),
                ("b.yaml".into(), Scanned::Unscheduled),
                (
                    "c.yaml".into(),
                    Scanned::Broken {
                        team_name: "C".into(),
                        raw: Some(schedule("99 8 * * *", "p", None)),
                        message: "schedule.cron \"99 8 * * *\" is not a valid cron expression"
                            .into(),
                    },
                ),
            ],
            now,
        );
        assert_eq!(entries.keys().collect::<Vec<_>>(), ["a.yaml", "c.yaml"]);
        assert_eq!(entries["a.yaml"].next_at, Some(utc("2026-09-12T00:00:00Z")));
        assert_eq!(entries["a.yaml"].problem, None);
        assert_eq!(entries["c.yaml"].next_at, None);
        assert_eq!(entries["c.yaml"].cron, "99 8 * * *");
        assert!(
            matches!(&entries["c.yaml"].problem, Some(Problem::Parse(m)) if m.contains("not a valid cron"))
        );

        // A prompt-only edit keeps the pending fire; a cron edit recomputes it.
        entries.get_mut("a.yaml").unwrap().last_run_id = Some("run-1".into());
        let later = utc("2026-09-11T02:00:00Z");
        reconcile(
            &mut entries,
            vec![(
                "a.yaml".into(),
                scheduled("A", schedule("0 8 * * *", "changed", Some("T"))),
            )],
            later,
        );
        assert_eq!(entries["a.yaml"].prompt, "changed");
        assert_eq!(entries["a.yaml"].notion_title.as_deref(), Some("T"));
        assert_eq!(entries["a.yaml"].next_at, Some(utc("2026-09-12T00:00:00Z")));
        assert_eq!(
            entries["a.yaml"].last_run_id.as_deref(),
            Some("run-1"),
            "history survives a rescan"
        );
        assert!(
            !entries.contains_key("c.yaml"),
            "a file that lost its schedule is dropped"
        );
        reconcile(
            &mut entries,
            vec![(
                "a.yaml".into(),
                scheduled("A", schedule("0 9 * * *", "changed", None)),
            )],
            later,
        );
        assert_eq!(entries["a.yaml"].next_at, Some(utc("2026-09-12T01:00:00Z")));
        assert_eq!(entries["a.yaml"].notion_title, None);

        // Fixing the file clears the parse problem and computes a fire time.
        reconcile(
            &mut entries,
            vec![(
                "c.yaml".into(),
                scheduled("C", schedule("0 8 * * *", "p", None)),
            )],
            later,
        );
        assert_eq!(entries["c.yaml"].problem, None);
        assert!(entries["c.yaml"].next_at.is_some());
    }

    #[test]
    fn collect_due_fires_expands_skips_overlaps_and_advances() {
        let mut entries = BTreeMap::new();
        reconcile(
            &mut entries,
            vec![
                (
                    "due.yaml".into(),
                    scheduled(
                        "Due team",
                        schedule(
                            "0 8 * * *",
                            "{{weekday}} {{date}} for {{team}}",
                            Some("T {{date}}"),
                        ),
                    ),
                ),
                (
                    "busy.yaml".into(),
                    scheduled("Busy", schedule("0 8 * * *", "p", None)),
                ),
                (
                    "later.yaml".into(),
                    scheduled("Later", schedule("0 20 * * *", "p", None)),
                ),
                (
                    "off.yaml".into(),
                    scheduled(
                        "Off",
                        ScheduleConfig {
                            enabled: false,
                            ..schedule("0 8 * * *", "p", None)
                        },
                    ),
                ),
            ],
            utc("2026-09-10T23:00:00Z"),
        );
        entries.get_mut("busy.yaml").unwrap().last_run_id = Some("live-run".into());
        let fire_time = utc("2026-09-11T00:00:00Z");
        assert!(entries.values().all(|entry| entry.next_at.is_some()));

        // Nothing is due one second early.
        let early = collect_due(&mut entries, utc("2026-09-10T23:59:59Z"), |_| false);
        assert_eq!(early, Due::default());

        let due = collect_due(&mut entries, fire_time + Duration::from_secs(5), |run_id| {
            run_id == "live-run"
        });
        assert_eq!(
            due.plans,
            [FirePlan {
                key: "due.yaml".into(),
                prompt: "Friday 2026-09-11 for Due team".into(),
                title: Some("T 2026-09-11".into()),
            }]
        );
        assert_eq!(
            due.skipped,
            [(
                "busy.yaml".to_owned(),
                "previous scheduled run live-run is still running".to_owned()
            )]
        );
        assert!(
            matches!(&entries["busy.yaml"].problem, Some(Problem::Fire(m)) if m.contains("live-run"))
        );
        // Every fired, skipped or disabled entry moved on to the next day; `later` did not.
        for key in ["due.yaml", "busy.yaml", "off.yaml"] {
            assert_eq!(
                entries[key].next_at,
                Some(utc("2026-09-12T00:00:00Z")),
                "{key}"
            );
        }
        assert_eq!(
            entries["later.yaml"].next_at,
            Some(utc("2026-09-11T12:00:00Z"))
        );

        // The next tick fires nothing again until the next fire time.
        let again = collect_due(&mut entries, fire_time + Duration::from_secs(60), |_| false);
        assert_eq!(again, Due::default());

        // Once the previous run finished, the busy team fires and its problem clears on launch.
        let tomorrow = collect_due(&mut entries, utc("2026-09-12T00:00:01Z"), |_| false);
        assert_eq!(tomorrow.plans.len(), 3, "{tomorrow:?}");
        assert!(tomorrow.skipped.is_empty());
    }

    #[test]
    fn scan_skips_hidden_directories_and_reads_broken_schedules() {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        fs::write(
            dir.0.join("routine.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        fs::write(
            dir.0.join("plain.yml"),
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n",
        )
        .unwrap();
        fs::write(
            dir.0.join("broken.yaml"),
            scheduled_team_yaml(
                &harness,
                "  cron: \"0 8 * * *\"\n  timezone: Nowhere/Land\n  prompt: go\n",
            ),
        )
        .unwrap();
        fs::write(dir.0.join("garbage.yaml"), "schedule: [\n").unwrap();
        fs::create_dir_all(dir.0.join(".hidden")).unwrap();
        fs::write(
            dir.0.join(".hidden/secret.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        fs::create_dir_all(dir.0.join("nested")).unwrap();
        fs::write(
            dir.0.join("nested/deep.YAML"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();

        let scanned = scan(&dir.0);
        let keys: Vec<&str> = scanned.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "broken.yaml",
                "garbage.yaml",
                "nested/deep.YAML",
                "plain.yml",
                "routine.yaml"
            ]
        );
        assert!(
            matches!(&scanned[0].1, Scanned::Broken { team_name, raw: Some(raw), message }
            if team_name == "Routine team" && raw.timezone.as_deref() == Some("Nowhere/Land") && message.contains("not an IANA time zone"))
        );
        assert!(
            matches!(&scanned[1].1, Scanned::Unscheduled),
            "unreadable YAML is not a routine"
        );
        assert!(matches!(&scanned[2].1, Scanned::Scheduled { .. }));
        assert!(matches!(&scanned[3].1, Scanned::Unscheduled));
        assert!(
            matches!(&scanned[4].1, Scanned::Scheduled { team_name, .. } if team_name == "Routine team")
        );

        let mut entries = BTreeMap::new();
        reconcile(&mut entries, scanned, utc("2026-09-11T01:00:00Z"));
        let scheduler = Scheduler::disconnected();
        *scheduler.entries.write().unwrap() = entries;
        let snapshot = scheduler.snapshot(&RunRegistry::default());
        assert_eq!(snapshot.len(), 3);
        let wire = serde_json::to_value(&snapshot[0]).unwrap();
        assert_eq!(wire["teamPath"], "broken.yaml");
        assert_eq!(wire["nextAt"], Value::Null);
        assert_eq!(
            wire["describe"], "0 8 * * *",
            "an unparsed schedule falls back to the cron text"
        );
        assert!(wire["problem"].as_str().unwrap().contains("Nowhere/Land"));
        let wire = serde_json::to_value(&snapshot[2]).unwrap();
        assert_eq!(wire["teamPath"], "routine.yaml");
        assert_eq!(wire["teamName"], "Routine team");
        assert_eq!(wire["describe"], "daily at 08:00 Asia/Singapore");
        assert_eq!(wire["nextAt"], "2026-09-12T00:00:00.000Z");
        assert_eq!(wire["prompt"], "{{weekday}} {{date}} digest for {{team}}");
        assert_eq!(
            wire["deliver"],
            json!({"notion": {"title": "Digest — {{date}}"}})
        );
        assert_eq!(wire["enabled"], true);
        assert_eq!(wire["lastRunId"], Value::Null);
        assert_eq!(wire["lastDelivery"], Value::Null);
        assert_eq!(wire["problem"], Value::Null);
    }

    #[tokio::test]
    async fn api_answers_503_without_an_archive_and_404_without_a_schedule() {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        fs::write(
            dir.0.join("routine.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        let app = router(
            Scheduler::disconnected(),
            RunRegistry::default(),
            None,
            dir.0.clone(),
        );
        let response = app
            .clone()
            .oneshot(get_local("/api/schedules"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json_body(response).await["error"], ARCHIVE_DISABLED_MESSAGE);
        let response = app
            .oneshot(post_json(
                "/api/schedules/run",
                &json!({"teamPath": "routine.yaml"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        let response = router(
            Scheduler::disconnected(),
            RunRegistry::default(),
            None,
            dir.0.clone(),
        )
        .oneshot(
            Request::builder()
                .uri("/api/schedules")
                .header("host", "evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn run_now_fires_the_routine_and_records_a_not_connected_delivery(pool: sqlx::PgPool) {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("harness.sh", COMPLETING_HARNESS);
        // A nested root so `../outside.yaml` names a real file that escapes it.
        let teams_root = dir.0.join("teams");
        fs::create_dir(&teams_root).unwrap();
        fs::write(
            dir.0.join("outside.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        fs::write(
            teams_root.join("routine.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        fs::write(
            teams_root.join("plain.yaml"),
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n",
        )
        .unwrap();
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(
            Scheduler::disconnected(),
            registry.clone(),
            Some(archive),
            teams_root,
        );

        let listed = json_body(
            app.clone()
                .oneshot(get_local("/api/schedules"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
        assert_eq!(listed[0]["teamPath"], "routine.yaml");

        for (path, status) in [
            ("plain.yaml", StatusCode::NOT_FOUND),
            ("missing.yaml", StatusCode::NOT_FOUND),
            ("../outside.yaml", StatusCode::FORBIDDEN),
        ] {
            let response = app
                .clone()
                .oneshot(post_json("/api/schedules/run", &json!({"teamPath": path})))
                .await
                .unwrap();
            assert_eq!(response.status(), status, "{path}");
        }
        let response = app
            .clone()
            .oneshot(post_json("/api/schedules/run", &json!({"nope": 1})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/schedules/run",
                &json!({"teamPath": "./routine.yaml"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let accepted: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        assert_eq!(accepted.trigger, RunTrigger::Schedule);
        assert_eq!(accepted.team_path, "routine.yaml");
        assert!(
            accepted.prompt.ends_with(" digest for Routine team"),
            "{}",
            accepted.prompt
        );
        assert!(
            !accepted.prompt.contains("{{"),
            "templates are expanded: {}",
            accepted.prompt
        );
        assert_eq!(accepted.delivery, None);

        let done = wait_for(&registry, &accepted.run_id, |r| r.status.is_terminal()).await;
        assert_eq!(done.status, RunStatus::Succeeded, "{done:?}");
        let delivered = wait_for(&registry, &accepted.run_id, |r| r.delivery.is_some()).await;
        let delivery = delivered.delivery.clone().unwrap();
        assert_eq!(delivery.status, DeliveryStatus::Failed);
        assert_eq!(delivery.message, NOT_CONNECTED_MESSAGE);
        assert_eq!(delivery.url, None);
        let wire = serde_json::to_value(&delivered).unwrap();
        assert_eq!(wire["trigger"], "schedule");
        assert_eq!(wire["delivery"]["target"], "notion");
        assert_eq!(wire["delivery"]["status"], "failed");
        assert_eq!(wire["delivery"]["pageId"], Value::Null);
        assert!(wire["delivery"]["deliveredAt"].is_string());

        let listed = json_body(app.oneshot(get_local("/api/schedules")).await.unwrap()).await;
        assert_eq!(listed[0]["lastRunId"], accepted.run_id);
        assert_eq!(listed[0]["lastStatus"], "succeeded");
        assert!(listed[0]["lastFiredAt"].is_string());
        assert_eq!(listed[0]["lastDelivery"]["status"], "failed");
        assert_eq!(listed[0]["lastDelivery"]["message"], NOT_CONNECTED_MESSAGE);
        assert_eq!(listed[0]["problem"], Value::Null);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn run_now_refuses_to_overlap_a_live_scheduled_run(pool: sqlx::PgPool) {
        let dir = TeamsDir::new();
        let harness = dir.write_harness("sleepy.sh", SLEEPING_HARNESS);
        fs::write(
            dir.0.join("routine.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        let archive = EventArchive::from_pool(pool);
        let registry = RunRegistry::default();
        let app = router(
            Scheduler::disconnected(),
            registry.clone(),
            Some(archive),
            dir.0.clone(),
        );

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/schedules/run",
                &json!({"teamPath": "routine.yaml"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let first: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        wait_for(&registry, &first.run_id, |r| r.status == RunStatus::Running).await;

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/schedules/run",
                &json!({"teamPath": "routine.yaml"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(response).await["error"],
            format!("previous scheduled run {} is still running", first.run_id)
        );
        let listed = json_body(
            app.clone()
                .oneshot(get_local("/api/schedules"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(listed[0]["lastRunId"], first.run_id);
        assert_eq!(listed[0]["lastStatus"], "running");

        assert!(matches!(
            registry.cancel(&first.run_id),
            runs::CancelOutcome::Cancelled(_)
        ));
        wait_for(&registry, &first.run_id, |r| r.status.is_terminal()).await;
        let response = app
            .oneshot(post_json(
                "/api/schedules/run",
                &json!({"teamPath": "routine.yaml"}),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::ACCEPTED,
            "a finished run no longer blocks"
        );
        let second: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        assert_ne!(second.run_id, first.run_id);
        let _cancelled = registry.cancel(&second.run_id);
    }
}
