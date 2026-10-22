//! Routines: run a team on its `schedule` block and deliver the canonical reply. See
//! `docs/decisions/0010-routines-and-notion-delivery.md`.
//!
//! The scheduler is in memory. Every 30 s it rescans the teams root, recomputes fire
//! times only when a schedule changed or fired, and starts due routines through exactly
//! the path `POST /api/runs` uses ([`runs::launch`]). Fires missed while the daemon was
//! down are skipped; a routine whose previous run is still live is skipped, not queued.
//!
//! A timed fire that could not reach its AI source (`errorCode: "source_unreachable"`), as in
//! the first seconds after a computer wakes, is tried again from the start after each wait in
//! `schedule.retryAfterMinutes`, each try a retry of the one before.

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
use crate::config::DEFAULT_RUN_NOTION_TITLE;
use crate::config::{ScheduleConfig, TeamConfig};
use crate::notion::Publisher;
use crate::runs::{self, Delivery, RunRecord, RunRegistry, RunStatus, RunTrigger};
use crate::watch_api::{ARCHIVE_DISABLED_MESSAGE, local_evidence};

/// How often the teams root is rescanned and due routines are fired.
const TICK: Duration = Duration::from_secs(30);
/// How often a routine's follower looks for its run to finish and its reply to be delivered.
const DELIVERY_POLL: Duration = Duration::from_millis(1000);
/// How long a routine's follower waits for a succeeded run's delivery before it records the
/// run without one. Publishing is bounded by the Notion client's own timeouts; this only stops
/// a follower from outliving a delivery that will never come.
const DELIVERY_WAIT: Duration = Duration::from_secs(600);

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
    /// The try this routine waits to make, after its last one could not reach its AI source.
    retry: Option<Retry>,
}

/// A timed fire whose last try could not reach its AI source, waiting to be tried again.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Retry {
    /// The try that could not reach its source: the next is a retry of it.
    of: String,
    /// The words that try was given, so every try is the same job.
    prompt: String,
    /// Tries made so far, the timed fire included.
    tries: usize,
    at: DateTime<Utc>,
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
            retry: None,
        };
        if let Some(schedule) = schedule {
            entry.copy_fields(&schedule, None);
        }
        entry
    }

    /// Mirror the block's text fields (parsed or not) so the API can show them. `team_title`
    /// is the team's own `deliver` template, which a routine without `schedule.deliver` uses.
    fn copy_fields(&mut self, schedule: &ScheduleConfig, team_title: Option<&str>) {
        self.cron.clone_from(&schedule.cron);
        self.timezone.clone_from(&schedule.timezone);
        self.prompt.clone_from(&schedule.prompt);
        self.enabled = schedule.enabled;
        self.notion_title = schedule.notion_title().or(team_title).map(str::to_owned);
    }

    /// Adopt a validated schedule: recompute the next fire only when the timing changed
    /// (or the entry had no valid schedule before), so an edit to the prompt alone does not
    /// move a pending fire.
    fn adopt(
        &mut self,
        team_name: &str,
        schedule: ScheduleConfig,
        team_title: Option<&str>,
        now: DateTime<Utc>,
    ) {
        let timing_changed = self.schedule.as_ref().is_none_or(|current| {
            current.cron != schedule.cron || current.timezone != schedule.timezone
        });
        team_name.clone_into(&mut self.team_name);
        self.copy_fields(&schedule, team_title);
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
        fire: Fire,
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
            fire,
        })
    }

    /// How long to wait before trying again a run of this routine that made `tries` tries with
    /// the ones before it (`None`: one never tried again by itself), should it not reach its AI
    /// source; `None` when it would not be tried again.
    fn wait_after(&self, tries: Option<usize>) -> Option<chrono::Duration> {
        if !self.enabled {
            return None;
        }
        self.schedule.as_ref()?.retry_wait(tries?)
    }

    /// The try to wait for after `record`, a finished try that made `tries` tries with the ones
    /// before it, when it could not reach its AI source and the routine still has tries left. It
    /// is due when the run said as it ended ([`runs::RunRecord::next_try_at`]).
    fn retry_after(&self, record: &RunRecord, tries: Option<usize>) -> Option<Retry> {
        let unreachable = record.status == RunStatus::Failed
            && record.error_code.as_deref() == Some(runs::SOURCE_UNREACHABLE);
        if !unreachable {
            return None;
        }
        self.wait_after(tries)?;
        let at = DateTime::parse_from_rfc3339(record.next_try_at.as_deref()?).ok()?;
        Some(Retry {
            of: record.run_id.clone(),
            prompt: record.prompt.clone(),
            tries: tries?,
            at: at.with_timezone(&Utc),
        })
    }
}

/// What started a fire, which decides whether a try that could not reach its AI source is tried
/// again.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Fire {
    /// The routine's time came.
    Timed,
    /// Try number `tries` of a timed fire (the fire itself was the first), from the start, after
    /// the try `of` could not reach its AI source.
    Again { of: String, tries: usize },
    /// "Run now": whoever pressed it is there to try again.
    ByHand,
}

impl Fire {
    /// How many tries this one makes with the ones before it; `None` for one never tried again.
    const fn tries(&self) -> Option<usize> {
        match self {
            Self::Timed => Some(1),
            Self::Again { tries, .. } => Some(*tries),
            Self::ByHand => None,
        }
    }

    /// The try this one tries again.
    fn retry_of(&self) -> Option<&str> {
        match self {
            Self::Again { of, .. } => Some(of),
            Self::Timed | Self::ByHand => None,
        }
    }
}

/// A due routine with its templates expanded: everything a launch needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FirePlan {
    key: String,
    prompt: String,
    /// Expanded Notion page title; `None` when the routine delivers nowhere.
    title: Option<String>,
    fire: Fire,
}

/// What one tick decided: routines to launch, and routines skipped with the reason.
#[derive(Debug, Default, PartialEq, Eq)]
struct Due {
    plans: Vec<FirePlan>,
    skipped: Vec<(String, String)>,
}

/// Select every enabled entry whose fire time has passed, advance its `next_at`, and
/// expand its templates. A disabled entry's fire time is advanced without firing so a
/// later re-enable does not fire immediately. An entry whose time has not come but whose
/// wait to try again is over is tried again, with the words its last try had. `is_live`
/// answers whether a run id is still non-terminal.
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
        let timed = entry.next_at.is_some_and(|next_at| next_at <= now);
        let planned = if timed {
            entry.next_at = schedule.next_fire(now).ok().flatten();
            if !entry.enabled {
                continue;
            }
            // Its own time wins over a try still waiting, which its launch lets go.
            entry.plan(key, now, &is_live, Fire::Timed)
        } else if entry.enabled
            && let Some(retry) = entry.retry.take_if(|retry| retry.at <= now)
        {
            let fire = Fire::Again {
                of: retry.of,
                tries: retry.tries + 1,
            };
            entry.plan(key, now, &is_live, fire).map(|plan| FirePlan {
                prompt: retry.prompt,
                ..plan
            })
        } else {
            continue;
        };
        match planned {
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

/// Why the team at `key` can't run now: an agent whose model is paid through a source not in
/// `connected` (ADR 0073), said with what to connect. `None` when every agent can run, or the file
/// can't be read here (the run itself then says why).
fn unconnected_source(
    teams_root: &Path,
    key: &str,
    connected: &[crate::ai::Source],
) -> Option<String> {
    let text = fs::read_to_string(teams_root.join(key)).ok()?;
    let team = TeamConfig::parse(&text).ok()?;
    team.agents
        .iter()
        .filter(|agent| agent.kind != crate::config::AgentKind::Operator)
        .find_map(|agent| {
            let model = crate::ai::ModelRef::parse(&agent.model);
            let offline = model.id == crate::agent::OFFLINE_MODEL || model.id.starts_with("demo/");
            if offline || connected.contains(&model.source) {
                return None;
            }
            let name = if agent.name.trim().is_empty() {
                agent.id.as_str()
            } else {
                agent.name.trim()
            };
            Some(format!(
                "{name} runs on {}, which isn't connected on this computer. Connect it on \
                 LoomWatch's Connections page, and the routine runs at its next time.",
                model.source.said()
            ))
        })
}

/// What a rescan learned about one team file.
#[derive(Debug)]
enum Scanned {
    /// Parses and has a `schedule` block.
    Scheduled {
        team_name: String,
        schedule: ScheduleConfig,
        /// The team's own `deliver` title template, for a routine without `schedule.deliver`.
        team_title: Option<String>,
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

/// Every team file below `teams_root` with what its `schedule` block says.
fn scan(teams_root: &Path) -> Vec<(String, Scanned)> {
    team_files(teams_root)
        .into_iter()
        .map(|(key, path)| {
            let scanned = inspect(&path);
            (key, scanned)
        })
        .collect()
}

/// Every `*.yaml` / `*.yml` below `teams_root` (hidden directories and a team's own
/// `<team>.brief/` and `<team>.files/` skipped, directory symlinks not followed), keyed by its
/// normalised path below the root and sorted by it. The scheduler and the approvals record
/// (`crate::approvals`) read the same set.
pub(crate) fn team_files(teams_root: &Path) -> Vec<(String, PathBuf)> {
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
                if !crate::api::is_team_sidecar_folder(&path) {
                    directories.push(path);
                }
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
                found.push((key, path));
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
                team_title: team
                    .deliver
                    .as_ref()
                    .and_then(|deliver| deliver.notion_title(DEFAULT_RUN_NOTION_TITLE))
                    .map(str::to_owned),
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
/// entry with `problem`, everything else is dropped. Returns the tries that no longer get
/// tried again, because their routine was paused, broke or went.
fn reconcile(
    entries: &mut BTreeMap<String, Entry>,
    scanned: Vec<(String, Scanned)>,
    now: DateTime<Utc>,
) -> Vec<String> {
    let mut keep = Vec::new();
    for (key, outcome) in scanned {
        match outcome {
            Scanned::Scheduled {
                team_name,
                schedule,
                team_title,
            } => {
                entries
                    .entry(key.clone())
                    .or_insert_with(|| Entry::new(team_name.clone(), None, None))
                    .adopt(&team_name, schedule, team_title.as_deref(), now);
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
                    entry.copy_fields(raw, None);
                }
                entry.schedule = None;
                entry.next_at = None;
                entry.problem = Some(Problem::Parse(message));
                keep.push(key);
            }
            Scanned::Unscheduled => {}
        }
    }
    let mut dropped = Vec::new();
    entries.retain(|key, entry| {
        let kept = keep.contains(key);
        if (!kept || !entry.enabled || entry.schedule.is_none())
            && let Some(retry) = entry.retry.take()
        {
            dropped.push(retry.of);
        }
        kept
    });
    dropped
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
    /// When the routine tries its last run again, after it could not reach its AI source; RFC
    /// 3339 UTC. Tried within a tick (30 s) of it.
    pub next_try_at: Option<String>,
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

/// The routine registry plus the publisher deliveries go through. The publisher is installed on
/// the run registry, which publishes every run's reply (ADR 0038); the scheduler only follows a
/// routine's run to report the outcome on the routine.
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
    // Every run delivers through the registry (ADR 0038), so the one publisher lives there.
    registry.set_publisher(scheduler.publisher.clone());
    if let Some(archive) = archive {
        let teams_root = crate::platform::canonicalize(&teams_root).unwrap_or(teams_root);
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

    /// Rescan the teams root and fold the result into the map. A try that no longer gets tried
    /// again stops saying when it would be.
    fn rescan(&self, registry: &RunRegistry, teams_root: &Path, now: DateTime<Utc>) {
        let scanned = scan(teams_root);
        let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
        for run_id in reconcile(&mut entries, scanned, now) {
            let _known = registry.set_next_try(&run_id, None);
        }
    }

    /// One scheduler tick: rescan, then fire everything due.
    fn tick(
        &self,
        registry: &RunRegistry,
        archive: &EventArchive,
        teams_root: &Path,
        now: DateTime<Utc>,
    ) {
        self.rescan(registry, teams_root, now);
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

    /// Start a planned fire, and say on the try it tries again, if any, that the wait is over.
    fn launch(
        &self,
        plan: FirePlan,
        registry: &RunRegistry,
        archive: &EventArchive,
        teams_root: &Path,
    ) -> Result<RunRecord, ApiError> {
        let tried_again = plan.fire.retry_of().map(str::to_owned);
        let result = self.start(plan, registry, archive, teams_root);
        if let Some(run_id) = tried_again {
            let _known = registry.set_next_try(&run_id, None);
        }
        result
    }

    /// Start a planned fire through `runs::launch`, record it on the entry, and follow
    /// the run to deliver its reply.
    fn start(
        &self,
        plan: FirePlan,
        registry: &RunRegistry,
        archive: &EventArchive,
        teams_root: &Path,
    ) -> Result<RunRecord, ApiError> {
        // A run whose agent's source isn't connected would only fail: the routine says why
        // instead, and tries again at its next time.
        if let Some(problem) = crate::ai::installed()
            .and_then(|ai| unconnected_source(teams_root, &plan.key, &ai.connected_sources()))
        {
            let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
            if let Some(entry) = entries.get_mut(&plan.key) {
                entry.problem = Some(Problem::Fire(problem.clone()));
            }
            eprintln!("schedule: {}: not started: {problem}", plan.key);
            return Err(ApiError::new(StatusCode::CONFLICT, problem));
        }
        let again_after = self
            .entries
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&plan.key)
            .and_then(|entry| entry.wait_after(plan.fire.tries()));
        let result = runs::launch(
            registry,
            Some(archive.clone()),
            teams_root,
            Path::new(&plan.key),
            &plan.prompt,
            RunTrigger::Schedule,
            runs::Tries {
                retry_of: plan.fire.retry_of(),
                again_after,
            },
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
                        // A new run, whatever started it, is the routine's run now: an earlier
                        // try waiting to be tried again no longer is.
                        if let Some(retry) = entry.retry.take() {
                            let _known = registry.set_next_try(&retry.of, None);
                        }
                    }
                    Err(error) => entry.problem = Some(Problem::Fire(error.message.clone())),
                }
            }
        }
        match &result {
            Ok(record) => {
                println!(
                    "schedule: fired {} as run {}{}{}",
                    plan.key,
                    record.run_id,
                    match &plan.fire {
                        Fire::Again { of, tries } => format!(" (try {tries}, again after {of})"),
                        Fire::Timed | Fire::ByHand => String::new(),
                    },
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
                    plan.fire.tries(),
                ));
            }
            Err(error) => eprintln!("schedule: {}: launch refused: {}", plan.key, error.message),
        }
        result
    }

    /// Store a finished run's status and delivery on its entry, if it is still that
    /// entry's latest run, and when it could not reach its AI source and has tries left, when it
    /// is tried again: on the routine and on the run. `tries` is how many tries the run made with
    /// the ones before it; `None` for one never tried again by itself.
    fn record_outcome(
        &self,
        registry: &RunRegistry,
        key: &str,
        record: &RunRecord,
        tries: Option<usize>,
    ) {
        let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = entries.get_mut(key) else {
            return;
        };
        if entry.last_run_id.as_deref() != Some(record.run_id.as_str()) {
            return;
        }
        entry.last_status = Some(record.status);
        entry.last_delivery.clone_from(&record.delivery);
        entry.retry = entry.retry_after(record, tries);
        if entry.retry.is_none() && record.next_try_at.is_some() {
            // Paused while it ran, say: the routine won't try it again after all.
            let _known = registry.set_next_try(&record.run_id, None);
        }
        if let Some(retry) = &entry.retry {
            println!(
                "schedule: {key}: run {} couldn't reach its AI source; trying again at {} (try {})",
                retry.of,
                stamp(retry.at),
                retry.tries + 1
            );
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
                // Live too: the run's delivery lands on the run first, and the follower that
                // copies it here polls.
                last_delivery: entry
                    .last_run_id
                    .as_deref()
                    .and_then(|run_id| registry.get(run_id))
                    .and_then(|record| record.delivery)
                    .or_else(|| entry.last_delivery.clone()),
                deliver: entry.notion_title.clone().map(|title| DeliverSnapshot {
                    notion: NotionSnapshot { title },
                }),
                problem: entry.problem.as_ref().map(|p| p.message().to_owned()),
                next_try_at: entry.retry.as_ref().map(|retry| stamp(retry.at)),
            })
            .collect()
    }
}

/// Wait for a scheduled run to finish and, when the run publishes its reply (it succeeded and
/// was launched with a delivery title), for that delivery; then record the outcome on the
/// routine, which tries the run again when it could not reach its AI source. The run registry
/// does the publishing, exactly as for a run started by hand.
async fn deliver_when_finished(
    scheduler: Scheduler,
    registry: RunRegistry,
    key: String,
    run_id: String,
    tries: Option<usize>,
) {
    let mut finished_at: Option<tokio::time::Instant> = None;
    let record = loop {
        match registry.get(&run_id) {
            Some(record) if record.status.is_terminal() => {
                let finished = *finished_at.get_or_insert_with(tokio::time::Instant::now);
                let awaiting_delivery = record.status == RunStatus::Succeeded
                    && record.deliver_title.is_some()
                    && record.delivery.is_none();
                if !awaiting_delivery || finished.elapsed() >= DELIVERY_WAIT {
                    break record;
                }
                tokio::time::sleep(DELIVERY_POLL).await;
            }
            Some(_) => tokio::time::sleep(DELIVERY_POLL).await,
            None => return,
        }
    };
    scheduler.record_outcome(&registry, &key, &record, tries);
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
    let teams_root = crate::platform::canonicalize(&teams_root).unwrap_or(teams_root);
    // Already done by `spawn` in the daemon; a router built on its own (tests) still needs it.
    registry.set_publisher(scheduler.publisher.clone());
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
    state
        .scheduler
        .rescan(&state.registry, &state.teams_root, Utc::now());
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
    state
        .scheduler
        .rescan(&state.registry, &state.teams_root, now);
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
            .plan(
                &key,
                now,
                |run_id| {
                    state
                        .registry
                        .get(run_id)
                        .is_some_and(|record| !record.status.is_terminal())
                },
                Fire::ByHand,
            )
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
    use crate::runs::DeliveryStatus;
    use crate::runs::tests::{TeamsDir, completing, sleeping};

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
            retry_after_minutes: crate::config::DEFAULT_RETRY_AFTER_MINUTES.to_vec(),
        }
    }

    fn scheduled(name: &str, schedule: ScheduleConfig) -> Scanned {
        Scanned::Scheduled {
            team_name: name.to_owned(),
            schedule,
            team_title: None,
        }
    }

    /// A scheduled team whose single agent runs on `model`.
    fn scheduled_team_yaml(model: &str, schedule_yaml: &str) -> String {
        format!(
            "schemaVersion: 1\nid: routine\nname: Routine team\nentrypoint: solo\nschedule:\n{schedule_yaml}agents:\n  - id: solo\n    name: Solo\n    role: answer directly\n    model: {model}\n"
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
                fire: Fire::Timed,
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

    /// A routine's team file added to another team as knowledge, or kept in its Brief, is a copy:
    /// scanned, the routine would fire twice. A folder that only happens to end in `.files` has no
    /// team file beside it and is still scanned.
    #[test]
    fn scan_leaves_out_the_folders_a_team_keeps_beside_it() {
        let dir = TeamsDir::new();
        let harness = completing();
        let routine = scheduled_team_yaml(&harness, DAILY);
        fs::write(dir.0.join("routine.yaml"), &routine).unwrap();
        let added = crate::chosen_knowledge::store_file(
            &dir.0.join("routine.yaml"),
            "copy.yaml",
            routine.as_bytes(),
        )
        .unwrap();
        assert_eq!(added.path, "routine.files/copy.yaml");
        // An upper-case extension is a team too, and its folders are its own.
        fs::create_dir_all(dir.0.join("nested/deep.brief")).unwrap();
        fs::write(dir.0.join("nested/deep.YAML"), &routine).unwrap();
        fs::write(dir.0.join("nested/deep.brief/copy.yaml"), &routine).unwrap();
        fs::create_dir_all(dir.0.join("archive.files")).unwrap();
        fs::write(dir.0.join("archive.files/old.yaml"), &routine).unwrap();

        let scanned = scan(&dir.0);
        let keys: Vec<&str> = scanned.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(
            keys,
            ["archive.files/old.yaml", "nested/deep.YAML", "routine.yaml"]
        );
    }

    #[test]
    fn scan_skips_hidden_directories_and_reads_broken_schedules() {
        let dir = TeamsDir::new();
        let harness = completing();
        fs::write(
            dir.0.join("routine.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        fs::write(
            dir.0.join("plain.yml"),
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
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
        let harness = completing();
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

    #[tokio::test]
    async fn run_now_fires_the_routine_and_records_a_not_connected_delivery() {
        let pool = crate::db::Db::temp().await;
        let dir = TeamsDir::new();
        let harness = completing();
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
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: x\n      cwd: .\n    model: m\n",
        )
        .unwrap();
        let archive = EventArchive::new(pool);
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

    #[tokio::test]
    async fn run_now_refuses_to_overlap_a_live_scheduled_run() {
        let pool = crate::db::Db::temp().await;
        let dir = TeamsDir::new();
        let (harness, _thinking) = sleeping();
        fs::write(
            dir.0.join("routine.yaml"),
            scheduled_team_yaml(&harness, DAILY),
        )
        .unwrap();
        let archive = EventArchive::new(pool);
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

    /// A routine whose agent runs on a source that isn't connected says so, rather than starting
    /// a run that would only fail; an offline demo needs nothing connected.
    #[test]
    fn a_routine_names_the_source_its_agent_needs() {
        let root =
            std::env::temp_dir().join(format!("loomwatch-schedule-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("team.yaml"),
            "schemaVersion: 1\nentrypoint: w\nagents:\n  - id: w\n    name: Writer\n    model: chatgpt:gpt-6.1-sol\n  - id: d\n    name: Demo\n    model: fake/offline\n",
        )
        .unwrap();
        let said =
            unconnected_source(&root, "team.yaml", &[crate::ai::Source::OpenRouter]).unwrap();
        assert!(
            said.starts_with("Writer runs on your ChatGPT plan"),
            "{said}"
        );
        assert!(unconnected_source(&root, "team.yaml", &[crate::ai::Source::ChatGpt]).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    /// What a stand-in source says when it can't be reached, as `ChatGPT`'s sign-in did the
    /// morning the network was not back yet.
    fn unreachable() -> crate::agent::AgentError {
        crate::agent::AgentError::Network(
            crate::ai::Source::ChatGpt,
            "couldn't renew the sign-in with ChatGPT".to_owned(),
        )
    }

    /// A routine's agent whose first `times` requests can't reach its source, and that answers
    /// "the brief" after.
    fn waking(times: usize) -> String {
        crate::engine::demo_model(crate::agent::Demo::failing_first(
            times,
            unreachable,
            |_| Some(crate::agent::Completion::text("the brief")),
        ))
    }

    /// A finished scheduled run of a one-agent team, as the follower sees it: `next_try_at` is when
    /// its end said it is tried again.
    fn finished(
        run_id: &str,
        status: RunStatus,
        code: Option<&str>,
        next_try_at: Option<&str>,
    ) -> RunRecord {
        let team = TeamConfig::parse(&scheduled_team_yaml(crate::agent::OFFLINE_MODEL, DAILY))
            .expect("a valid routine");
        let mut record = RunRecord::queued(
            "brief.yaml".to_owned(),
            "the words the first try had".to_owned(),
            &team,
            RunTrigger::Schedule,
        )
        .expect("a record");
        run_id.clone_into(&mut record.run_id);
        record.status = status;
        record.error_code = code.map(str::to_owned);
        record.next_try_at = next_try_at.map(str::to_owned);
        record
    }

    /// A routine waiting to make the try after `try-1`, due at `due_at`: the entries, and the try.
    fn waiting_for_a_try(due_at: &str) -> (BTreeMap<String, Entry>, ScheduleConfig, Retry) {
        let mut entries = BTreeMap::new();
        let waits = ScheduleConfig {
            retry_after_minutes: vec![1, 5],
            ..schedule("0 8 * * *", "{{date}} brief", None)
        };
        reconcile(
            &mut entries,
            vec![("brief.yaml".into(), scheduled("Brief", waits.clone()))],
            utc("2026-09-10T23:00:00Z"),
        );
        let waiting = Retry {
            of: "try-1".into(),
            prompt: "the words the first try had".into(),
            tries: 1,
            at: utc(due_at),
        };
        (entries, waits, waiting)
    }

    /// Only a timed fire, or a try of one, that could not reach its AI source is tried again, after
    /// each wait in turn and then no more, at the time its run said as it ended.
    #[test]
    fn a_try_that_could_not_reach_its_source_is_tried_again_after_each_wait() {
        let due_at = "2026-09-11T00:04:20.000Z";
        let (mut entries, _, waiting) = waiting_for_a_try(due_at);
        let entry = entries.get_mut("brief.yaml").unwrap();

        // What each run is told at launch: how long its routine waits to try it again.
        assert_eq!(
            entry.wait_after(Some(1)),
            Some(chrono::Duration::minutes(1))
        );
        assert_eq!(
            entry.wait_after(Some(2)),
            Some(chrono::Duration::minutes(5)),
            "the second wait is the second entry"
        );
        assert_eq!(
            entry.wait_after(Some(3)),
            None,
            "two waits, three tries, then no more"
        );
        assert_eq!(
            entry.wait_after(None),
            None,
            "\"Run now\" is never tried again by itself"
        );

        // The routine waits for the try its run said, as it ended, would come.
        let unreachable = finished(
            "try-1",
            RunStatus::Failed,
            Some(runs::SOURCE_UNREACHABLE),
            Some(due_at),
        );
        assert_eq!(entry.retry_after(&unreachable, Some(1)), Some(waiting));
        assert_eq!(
            entry.retry_after(&unreachable, Some(3)),
            None,
            "no tries left"
        );
        assert_eq!(entry.retry_after(&unreachable, None), None, "by hand");
        for (status, code) in [
            (RunStatus::Failed, Some(APP_ERROR_CODE)),
            (RunStatus::Failed, None),
            (RunStatus::Succeeded, None),
            (RunStatus::Cancelled, None),
        ] {
            assert_eq!(
                entry.retry_after(&finished("try-1", status, code, Some(due_at)), Some(1)),
                None,
                "{status:?} {code:?}"
            );
        }
        entry.enabled = false;
        assert_eq!(
            entry.wait_after(Some(1)),
            None,
            "a paused routine tries nothing"
        );
        assert_eq!(entry.retry_after(&unreachable, Some(1)), None);
    }

    /// When its wait is over a try runs with the words it had. The routine's own time wins over a
    /// try still waiting, and pausing the routine lets the try go.
    #[test]
    fn a_waiting_try_runs_with_its_words_unless_its_routine_comes_first() {
        let due_at = "2026-09-11T00:04:20.000Z";
        let (mut entries, waits, waiting) = waiting_for_a_try(due_at);
        let entry = entries.get_mut("brief.yaml").unwrap();

        // Waiting: nothing is due a second early; once due, the try runs with the words it had, as
        // a retry of the try before it, and is no longer waiting.
        entry.next_at = Some(utc("2026-09-12T00:00:00Z"));
        entry.retry = Some(waiting.clone());
        let early = collect_due(&mut entries, utc("2026-09-11T00:04:19Z"), |_| false);
        assert_eq!(early, Due::default());
        let due = collect_due(&mut entries, utc(due_at), |_| false);
        assert_eq!(
            due.plans,
            [FirePlan {
                key: "brief.yaml".into(),
                prompt: "the words the first try had".into(),
                title: None,
                fire: Fire::Again {
                    of: "try-1".into(),
                    tries: 2,
                },
            }]
        );
        assert_eq!(entries["brief.yaml"].retry, None);
        assert_eq!(
            entries["brief.yaml"].next_at,
            Some(utc("2026-09-12T00:00:00Z")),
            "a try does not move the routine's own time"
        );

        // The routine's own time comes before the wait is over: it fires as itself.
        let entry = entries.get_mut("brief.yaml").unwrap();
        entry.retry = Some(Retry {
            at: utc("2026-09-12T00:00:30Z"),
            ..waiting.clone()
        });
        let due = collect_due(&mut entries, utc("2026-09-12T00:00:05Z"), |_| false);
        assert_eq!(due.plans.len(), 1, "{due:?}");
        assert_eq!(due.plans[0].fire, Fire::Timed);
        assert_eq!(due.plans[0].prompt, "2026-09-12 brief");

        // Paused, the routine lets its waiting try go, and says which one.
        entries.get_mut("brief.yaml").unwrap().retry = Some(waiting);
        let paused = ScheduleConfig {
            enabled: false,
            ..waits
        };
        let dropped = reconcile(
            &mut entries,
            vec![("brief.yaml".into(), scheduled("Brief", paused))],
            utc("2026-09-11T00:03:30Z"),
        );
        assert_eq!(dropped, ["try-1"]);
        assert_eq!(entries["brief.yaml"].retry, None);
        let due = collect_due(&mut entries, utc("2026-09-11T00:10:00Z"), |_| false);
        assert_eq!(due, Due::default());
    }

    /// A routine paused while its run was going won't try that run again, though the run said as it
    /// ended that it would be: the routine takes that back, on the run too.
    #[test]
    fn a_routine_paused_while_its_run_went_takes_back_the_next_try() {
        let scheduler = Scheduler::disconnected();
        let registry = RunRegistry::default();
        let mut entries = BTreeMap::new();
        reconcile(
            &mut entries,
            vec![(
                "brief.yaml".into(),
                scheduled(
                    "Brief",
                    ScheduleConfig {
                        enabled: false,
                        ..schedule("0 8 * * *", "brief", None)
                    },
                ),
            )],
            utc("2026-09-11T00:00:00Z"),
        );
        entries.get_mut("brief.yaml").unwrap().last_run_id = Some("try-1".into());
        *scheduler.entries.write().unwrap() = entries;
        let ended = finished(
            "try-1",
            RunStatus::Failed,
            Some(runs::SOURCE_UNREACHABLE),
            Some("2026-09-11T00:04:20.000Z"),
        );
        registry.insert(ended.clone());

        scheduler.record_outcome(&registry, "brief.yaml", &ended, Some(1));
        assert_eq!(registry.get("try-1").unwrap().next_try_at, None);
        assert_eq!(scheduler.entries.read().unwrap()["brief.yaml"].retry, None);
        assert_eq!(scheduler.snapshot(&registry)[0].next_try_at, None);
    }

    /// Waits until the routine's follower has recorded `run_id`'s end on the routine.
    async fn followed(scheduler: &Scheduler, key: &str, run_id: &str) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                {
                    let entries = scheduler.entries.read().unwrap();
                    let entry = &entries[key];
                    if entry.last_run_id.as_deref() == Some(run_id)
                        && entry.last_status.is_some_and(RunStatus::is_terminal)
                    {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("the routine recorded how its run ended in time");
    }

    /// Fires the routine at `key` as if its time had just come, and gives back the run it started.
    /// Every routine's own time is then put out of the way of the tries, whatever the time of day
    /// the test runs at.
    fn fire(
        scheduler: &Scheduler,
        registry: &RunRegistry,
        archive: &EventArchive,
        root: &Path,
        key: &str,
    ) -> RunRecord {
        let now = Utc::now();
        let later = utc("2099-01-01T00:00:00Z");
        scheduler.rescan(registry, root, now);
        for (routine, entry) in scheduler.entries.write().unwrap().iter_mut() {
            entry.next_at = Some(if routine == key {
                now - chrono::Duration::seconds(1)
            } else {
                later
            });
        }
        scheduler.tick(registry, archive, root, now);
        let mut entries = scheduler.entries.write().unwrap();
        let entry = entries.get_mut(key).unwrap();
        entry.next_at = Some(later);
        registry
            .get(entry.last_run_id.as_deref().expect("the routine fired"))
            .expect("its run is registered")
    }

    /// The morning the network was not back yet: the routine's run could not reach its AI source,
    /// so the routine said when it would try again, on itself and on the run; tried again then,
    /// from the start with the same words, as a retry of that run; waited longer the second time;
    /// and the third try answered and stopped the waiting.
    #[tokio::test]
    async fn a_routine_tries_again_after_its_run_could_not_reach_its_source() {
        let pool = crate::db::Db::temp().await;
        let dir = TeamsDir::new();
        let model = waking(2);
        fs::write(
            dir.0.join("brief.yaml"),
            scheduled_team_yaml(
                &model,
                "  cron: \"0 8 * * 1-5\"\n  prompt: \"{{weekday}} brief for {{team}}\"\n  retryAfterMinutes: [1, 5]\n",
            ),
        )
        .unwrap();
        let archive = EventArchive::new(pool);
        let registry = RunRegistry::default();
        let scheduler = Scheduler::disconnected();
        let root = dir.0.clone();
        let key = "brief.yaml";

        let mut tries = vec![fire(&scheduler, &registry, &archive, &root, key)];
        assert_eq!(tries[0].retry_of_run_id, None);
        for (wait, try_number) in [(60, 2), (300, 3)] {
            let failed = tries.last().unwrap().clone();
            // The moment it reads as stopped, it also says when it is tried again: no reader
            // ever sees a stop to act on.
            let ended = wait_for(&registry, &failed.run_id, |r| r.status.is_terminal()).await;
            assert!(ended.next_try_at.is_some(), "said as it ended: {ended:?}");
            followed(&scheduler, key, &failed.run_id).await;
            let failed = registry.get(&failed.run_id).unwrap();
            assert_eq!(failed.status, RunStatus::Failed, "{failed:?}");
            assert_eq!(failed.error_code.as_deref(), Some(runs::SOURCE_UNREACHABLE));
            let at = failed
                .next_try_at
                .clone()
                .expect("the run says when it is tried again");
            let listed = scheduler.snapshot(&registry);
            assert_eq!(listed[0].next_try_at.as_deref(), Some(at.as_str()));
            assert_eq!(listed[0].last_status, Some(RunStatus::Failed));
            assert_eq!(listed[0].problem, None, "a try to come is not a problem");
            let waited = utc(&at) - utc(failed.finished_at.as_deref().unwrap());
            assert_eq!(
                waited.num_seconds(),
                wait,
                "try {try_number} waits {wait} s, not {waited}"
            );

            // Nothing a second early; at its time, the next try.
            scheduler.tick(
                &registry,
                &archive,
                &root,
                utc(&at) - chrono::Duration::seconds(1),
            );
            assert_eq!(
                scheduler.snapshot(&registry)[0].last_run_id.as_deref(),
                Some(failed.run_id.as_str())
            );
            scheduler.tick(&registry, &archive, &root, utc(&at));
            let next = registry
                .get(
                    scheduler.snapshot(&registry)[0]
                        .last_run_id
                        .as_deref()
                        .unwrap(),
                )
                .unwrap();
            assert_ne!(next.run_id, failed.run_id, "try {try_number} is a new run");
            assert_eq!(
                next.retry_of_run_id.as_deref(),
                Some(failed.run_id.as_str())
            );
            assert_eq!(next.trigger, RunTrigger::Schedule);
            assert_eq!(next.prompt, tries[0].prompt, "every try is the same job");
            assert_eq!(
                registry.get(&failed.run_id).unwrap().next_try_at,
                None,
                "tried again: no longer waiting"
            );
            tries.push(next);
        }

        let last = tries.last().unwrap();
        followed(&scheduler, key, &last.run_id).await;
        let answered = registry.get(&last.run_id).unwrap();
        assert_eq!(answered.status, RunStatus::Succeeded, "{answered:?}");
        assert_eq!(answered.reply.as_deref(), Some("the brief"));
        assert_eq!(answered.next_try_at, None);
        let listed = scheduler.snapshot(&registry);
        assert_eq!(listed[0].next_try_at, None);
        assert_eq!(listed[0].last_status, Some(RunStatus::Succeeded));
        let wire = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(wire["nextTryAt"], Value::Null);
    }

    /// "Run now" keeps what it always did: a run that could not reach its source is the person's to
    /// try again. A timed run refused for its key is not tried again either, and a routine paused
    /// while its run waits lets the wait go, on the run too.
    #[tokio::test]
    async fn only_a_timed_run_that_could_not_reach_its_source_is_tried_again() {
        let pool = crate::db::Db::temp().await;
        let dir = TeamsDir::new();
        let refused = crate::engine::demo_model(crate::agent::Demo::failing_first(
            1,
            || crate::agent::AgentError::KeyRefused(crate::ai::Source::OpenRouter),
            |_| Some(crate::agent::Completion::text("the brief")),
        ));
        let routine = |model: &str, enabled: bool| {
            scheduled_team_yaml(
                model,
                &format!("  cron: \"0 8 * * *\"\n  prompt: brief\n  enabled: {enabled}\n"),
            )
        };
        fs::write(dir.0.join("byhand.yaml"), routine(&waking(1), true)).unwrap();
        fs::write(dir.0.join("refused.yaml"), routine(&refused, true)).unwrap();
        fs::write(dir.0.join("paused.yaml"), routine(&waking(1), true)).unwrap();
        let archive = EventArchive::new(pool);
        let registry = RunRegistry::default();
        let scheduler = Scheduler::disconnected();
        let root = dir.0.clone();
        let app = router(
            scheduler.clone(),
            registry.clone(),
            Some(archive.clone()),
            root.clone(),
        );

        let response = app
            .oneshot(post_json(
                "/api/schedules/run",
                &json!({"teamPath": "byhand.yaml"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let by_hand: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        followed(&scheduler, "byhand.yaml", &by_hand.run_id).await;
        let by_hand = registry.get(&by_hand.run_id).unwrap();
        assert_eq!(
            by_hand.error_code.as_deref(),
            Some(runs::SOURCE_UNREACHABLE)
        );
        assert_eq!(by_hand.next_try_at, None);

        let refused = fire(&scheduler, &registry, &archive, &root, "refused.yaml");
        followed(&scheduler, "refused.yaml", &refused.run_id).await;
        let refused = registry.get(&refused.run_id).unwrap();
        assert_eq!(refused.error_code.as_deref(), Some(APP_ERROR_CODE));
        assert_eq!(refused.next_try_at, None);

        let waiting = fire(&scheduler, &registry, &archive, &root, "paused.yaml");
        followed(&scheduler, "paused.yaml", &waiting.run_id).await;
        assert!(registry.get(&waiting.run_id).unwrap().next_try_at.is_some());
        fs::write(dir.0.join("paused.yaml"), routine(&waking(0), false)).unwrap();
        scheduler.rescan(&registry, &root, Utc::now());
        assert_eq!(registry.get(&waiting.run_id).unwrap().next_try_at, None);

        let listed = scheduler.snapshot(&registry);
        assert_eq!(listed.len(), 3);
        assert!(
            listed.iter().all(|routine| routine.next_try_at.is_none()),
            "{listed:?}"
        );
        assert!(
            scheduler
                .entries
                .read()
                .unwrap()
                .values()
                .all(|entry| entry.retry.is_none())
        );
    }

    /// "Run now" while a try waits starts the routine afresh: the waiting try goes, on the routine and
    /// on the run it would have tried again. (The routine's own time does the same, through the same
    /// launch.)
    #[tokio::test]
    async fn run_now_lets_a_waiting_try_go() {
        let pool = crate::db::Db::temp().await;
        let dir = TeamsDir::new();
        fs::write(
            dir.0.join("brief.yaml"),
            scheduled_team_yaml(&waking(1), "  cron: \"0 8 * * *\"\n  prompt: brief\n"),
        )
        .unwrap();
        let archive = EventArchive::new(pool);
        let registry = RunRegistry::default();
        let scheduler = Scheduler::disconnected();
        let root = dir.0.clone();
        let waiting = fire(&scheduler, &registry, &archive, &root, "brief.yaml");
        followed(&scheduler, "brief.yaml", &waiting.run_id).await;
        assert!(registry.get(&waiting.run_id).unwrap().next_try_at.is_some());
        assert!(scheduler.snapshot(&registry)[0].next_try_at.is_some());

        let response = router(scheduler.clone(), registry.clone(), Some(archive), root)
            .oneshot(post_json(
                "/api/schedules/run",
                &json!({"teamPath": "brief.yaml"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let by_hand: RunRecord = serde_json::from_value(json_body(response).await).unwrap();
        assert_eq!(by_hand.retry_of_run_id, None, "a run of its own, not a try");
        assert_eq!(registry.get(&waiting.run_id).unwrap().next_try_at, None);
        assert_eq!(scheduler.entries.read().unwrap()["brief.yaml"].retry, None);
        assert_eq!(scheduler.snapshot(&registry)[0].next_try_at, None);
        wait_for(&registry, &by_hand.run_id, |r| r.status.is_terminal()).await;
    }

    /// What a run whose source answered "no" is recorded with.
    const APP_ERROR_CODE: &str = "app_error";
}
