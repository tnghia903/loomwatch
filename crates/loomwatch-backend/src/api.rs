//! REST surface consumed by the `LoomWatch` web UI.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header, uri::Authority};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::acp::{DiscoveredModel, ProcessSpec, discover_models};
use crate::capabilities::{
    CapabilityDetails, CapabilityInventory, detect_capabilities, detect_capability_details,
};
use crate::composer::{ComposerLayout, layout_path};
use crate::config::TeamConfig;

const TEAM_SCHEMA: &str = include_str!("../../../schemas/team.schema.yaml");

#[derive(Debug, Clone)]
struct ApiState {
    writes: Arc<Mutex<()>>,
    search_path: Option<OsString>,
    /// The `PATH` a run starts its harnesses with: the daemon's own, without the per-user
    /// folders `search_path` adds. `AcpProcess::spawn` resolves a bare `spawn.cmd` against this,
    /// so `GET /api/commands` must too — an app found only in `search_path` is listed in the
    /// Library and still fails to start.
    run_path: Option<OsString>,
    teams_root: PathBuf,
    allowed_hosts: Vec<String>,
    home_dir: Option<PathBuf>,
    /// Present only when the daemon has a database, and read by exactly one handler:
    /// `GET /api/capabilities`, to fill each memory source's kept-note count.
    ///
    /// This router deliberately does **not** depend on Postgres for anything else — reading a
    /// team's Brief is reading Markdown off disk and must work with the archive down. The
    /// inventory is the one place where a number lives in rows, and `None` there means "not
    /// counted", never "zero" (see `capabilities::MemorySourceRef::kept`).
    archive: Option<crate::archive::EventArchive>,
    host_runner: Option<crate::host_runner::ClientConfig>,
    /// The last model-discovery outcome per harness id, written by `GET
    /// /api/harnesses/{id}/models` and only read by `GET /api/harnesses` — so the list reports
    /// what a real ACP handshake last said without ever spawning one itself.
    harness_health: Arc<Mutex<HashMap<String, HealthRecord>>>,
    /// The run-control router's registry, read by exactly one handler: `DELETE /api/team` refuses
    /// while a run of the team has not finished, because that run is still reading its files.
    runs: crate::runs::RunRegistry,
}

/// How long a model-discovery outcome is reported on `GET /api/harnesses`.
///
/// The outcome is an observation, not a property of the install: an operator who signs in or
/// upgrades fixes an `error` without `LoomWatch` seeing it, and the UI stops offering a failing app
/// for new teams, so nothing else would ask it again. Past this age the harness reads as unchecked.
const HARNESS_HEALTH_TTL: Duration = Duration::from_mins(10);

/// Longest harness error kept as `healthDetail`. Vendor errors can embed whole JSON-RPC bodies;
/// the head names the problem, and the full text is still in the models endpoint's own error.
const HEALTH_DETAIL_MAX_CHARS: usize = 500;

/// One model-discovery outcome, kept against the exact process it came from.
#[derive(Debug, Clone)]
struct HealthRecord {
    executable_path: String,
    spawn: HarnessSpawn,
    checked_at: Instant,
    /// The harness's own error, or `None` when discovery succeeded.
    error: Option<String>,
}

/// How a harness is reached over ACP, when it can be reached at all.
///
/// A harness whose vendor ships no ACP surface is still worth detecting — the operator installed
/// it and wants to know `LoomWatch` saw it — but it must never be handed a spawn descriptor that
/// pretends otherwise. `None` on [`HarnessSpec::acp`] is that case, and it is why
/// [`DetectedHarness::unavailable_reason`] exists: "not found on PATH" is the wrong sentence for a
/// binary that is right there and simply does not speak the protocol.
#[derive(Debug, Clone, Copy)]
struct AcpBridge {
    /// Command that speaks ACP on stdio. Often the vendor CLI itself with a subcommand.
    command: &'static str,
    args: &'static [&'static str],
    /// Published ACP bridge to run through `npx` when no standalone bridge is installed.
    fallback_package: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
struct HarnessSpec {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    acp: Option<AcpBridge>,
}

/// Every harness `LoomWatch` knows how to look for.
///
/// This list is the whole of `LoomWatch`'s vendor knowledge, so a harness missing from it can never
/// be detected however plainly it sits on the `PATH` (TNG Part B root cause (a)). Each entry's ACP
/// invocation is verified on a real binary before it is added — a `--help` listing an `acp`
/// subcommand is not enough, because several of these CLIs ship a private JSON-RPC mode that is
/// not ACP. See `docs/ACP_SPINE.md`.
const HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude",
        name: "Claude",
        command: "claude",
        acp: Some(AcpBridge {
            command: "claude-agent-acp",
            args: &[],
            fallback_package: Some("@agentclientprotocol/claude-agent-acp"),
        }),
    },
    HarnessSpec {
        id: "codex",
        name: "Codex",
        command: "codex",
        acp: Some(AcpBridge {
            command: "codex-acp",
            args: &[],
            fallback_package: Some("@agentclientprotocol/codex-acp"),
        }),
    },
    HarnessSpec {
        id: "gemini",
        name: "Gemini",
        command: "gemini",
        acp: Some(AcpBridge {
            command: "gemini",
            args: &["--acp"],
            fallback_package: None,
        }),
    },
    HarnessSpec {
        id: "opencode",
        name: "OpenCode",
        command: "opencode",
        acp: Some(AcpBridge {
            command: "opencode",
            args: &["acp"],
            fallback_package: None,
        }),
    },
    // Hermes Agent ships its ACP adapter as a separate `hermes-acp` entry point, which
    // `docs/ACP_SPINE.md` and `examples/phase03-hermes-acp.yaml` have treated as a known harness
    // since Phase 03 — it was simply never in this table. Verified against Hermes 0.21.1:
    // `initialize` returns `protocolVersion: 1` and `agentCapabilities.loadSession: true`.
    HarnessSpec {
        id: "hermes",
        name: "Hermes",
        command: "hermes",
        acp: Some(AcpBridge {
            command: "hermes-acp",
            args: &[],
            fallback_package: None,
        }),
    },
    // OpenClaw exposes `openclaw acp`, an ACP bridge in front of its own gateway. Verified
    // against OpenClaw 2026.8.1: `protocolVersion: 1`, `agentCapabilities.loadSession: true`,
    // and `mcpCapabilities.http: false` — so the Team Bus cannot be injected into an OpenClaw
    // session and `acp.rs` archives `team_bus_unavailable` for it, exactly as it already does
    // for any harness without HTTP MCP.
    HarnessSpec {
        id: "openclaw",
        name: "OpenClaw",
        command: "openclaw",
        acp: Some(AcpBridge {
            command: "openclaw",
            args: &["acp"],
            fallback_package: None,
        }),
    },
    // `pi` is detected but has no ACP bridge. Its `--mode rpc` is pi's own protocol
    // (`@earendil-works/pi-protocol`): an ACP `initialize` frame comes back as
    // `{"type":"response","success":false,"error":"Unknown command: undefined"}`, and the bundle
    // contains no ACP method names at all. Listing it with a spawn descriptor would produce an
    // agent that cannot run, so it is reported unavailable with that reason.
    HarnessSpec {
        id: "pi",
        name: "pi",
        command: "pi",
        acp: None,
    },
];

/// Directories `LoomWatch` also searches for harnesses when the daemon's own `PATH` omits them.
///
/// Part B root cause (b): a `loomwatchd` started by launchd, a desktop launcher, or any
/// non-interactive shell inherits a `PATH` like `/usr/bin:/bin:/usr/sbin:/sbin` — none of the
/// per-user install prefixes every one of these harnesses actually uses. Detection then reports
/// nothing and the Library says "No agent harnesses found on PATH", which is true and useless.
/// These are appended *after* the inherited `PATH`, so an operator's own ordering still wins, and
/// only in [`router`]; [`router_with_path`] stays exactly as deterministic as it was for tests.
const EXTRA_HARNESS_DIRECTORIES: &[&str] = &[
    ".local/bin",
    ".opencode/bin",
    ".bun/bin",
    ".cargo/bin",
    ".npm-global/bin",
    ".volta/bin",
];

/// One supported harness detected on the daemon's `PATH`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHarness {
    pub id: String,
    pub name: String,
    pub command: String,
    pub executable_path: String,
    pub acp_available: bool,
    /// Why this harness cannot be run over ACP, in words the Library can print verbatim. Present
    /// exactly when `acp_available` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// What the last model discovery for this harness found, within [`HARNESS_HEALTH_TTL`].
    /// Absent when nothing has asked recently: being on `PATH` is not proof a harness can start
    /// (it can be signed out, or too old for its own service), and listing never spawns one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<HarnessHealth>,
    /// Why `health` is `error`, in words the UI can print verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_reason: Option<String>,
    /// The harness's own error behind `health_reason`, truncated to [`HEALTH_DETAIL_MAX_CHARS`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_detail: Option<String>,
    pub spawn: HarnessSpawn,
}

/// Outcome of the last ACP handshake `LoomWatch` made with a harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessHealth {
    Ok,
    Error,
}

/// `GET /api/harnesses`: what was found, and where it was looked for.
///
/// The searched directories are part of the answer, not debug output: "nothing was found" and
/// "nothing was looked for in the right place" are different problems with the same empty list,
/// and only the daemon knows which one happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessReport {
    pub harnesses: Vec<DetectedHarness>,
    /// The `PATH` entries scanned, in scan order, lossily encoded when not UTF-8.
    pub searched_path: Vec<String>,
    /// Ids of every harness in the catalog, so the Library can name what it looked for without
    /// keeping its own copy of the vendor list.
    pub known_ids: Vec<String>,
    /// Present when a configured host runner could not be reached or authenticated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_error: Option<String>,
}

/// Spawn descriptor the UI can copy into a new team agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessSpawn {
    pub cmd: String,
    pub args: Vec<String>,
}

/// Live model ids reported by one detected ACP harness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModels {
    pub harness_id: String,
    pub models: Vec<DiscoveredModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_thinking_effort: Option<String>,
}

/// `GET /api/commands`: whether each asked-about `spawn.cmd` would start, one entry per distinct
/// command in the order asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandReport {
    pub commands: Vec<CommandCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandCheck {
    pub cmd: String,
    pub status: CommandStatus,
    /// The executable that was found: where a run will start it for `found`, and the per-user
    /// folder the daemon's `PATH` lacks for `outside_path`. Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// What [`check_command`] concluded, without starting anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus {
    /// A run will find this executable.
    Found,
    /// Not on the daemon's `PATH` or in any per-user install folder, or an absolute path that
    /// does not exist.
    NotFound,
    /// Only in a per-user folder that `GET /api/harnesses` searches and the daemon's own `PATH`
    /// lacks — the Library lists the app, and a run still cannot start it.
    OutsidePath,
    /// An absolute path to something that is not an executable file.
    NotExecutable,
    /// A relative path such as `./bin/agent`. It resolves against the agent's working folder,
    /// which a run can swap for a prepared workspace, so it is not judged here.
    Unchecked,
}

/// Most commands one `GET /api/commands` checks. A team names a handful; this bounds the work an
/// arbitrary query string can ask for, at one `stat` per `PATH` entry each.
const MAX_COMMAND_CHECKS: usize = 64;

#[derive(Debug, Deserialize)]
struct TeamPath {
    /// The team file, relative to the teams root. `team=` is accepted as an alias so a client can
    /// use one spelling across `/api/memory` and `/api/memory/notes`, which are served by
    /// different routers.
    #[serde(alias = "team")]
    path: PathBuf,
}

/// A byte-preserving team-file representation used for both load and save.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamFile {
    pub path: PathBuf,
    pub yaml: String,
}

/// Read-only discovery data for team files available to the web UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamsDiscovery {
    /// Canonical configured root, encoded lossily only when the platform path is not UTF-8.
    pub root: String,
    /// YAML files below `root`, encoded as sorted, `/`-separated relative paths.
    pub files: Vec<String>,
    /// One summary per entry of `files`, in the same order, so a picker can show a team's name
    /// instead of its file path without opening every file itself.
    pub teams: Vec<TeamSummary>,
    /// Where the teams waiting in `.trash/` used to live, sorted. Never teams — the list does not
    /// show them — but names a new team must not take: their run history and Notebook notes are
    /// still filed under that path and id (`docs/decisions/0028-delete-a-team-to-the-trash.md`).
    pub trashed: Vec<String>,
}

/// What the team picker shows for one discovered file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSummary {
    /// The relative path, identical to the matching `files` entry.
    pub path: String,
    /// The file's `name`. Absent when the file does not parse as a team, so the picker falls
    /// back to the path rather than inventing a name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Number of `agents[]` entries, review stops included.
    pub agent_count: usize,
    /// Last modification time (RFC 3339), when the platform reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    /// Why the file cannot be opened as a team, when it cannot: `unreadable` (not YAML, or not
    /// readable at all) or `not_a_team` (YAML, but with none of a team's keys). Absent for a
    /// team, including an unfinished one, so the picker never calls a broken file "needs setup".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<&'static str>,
}

/// The two top-level keys a summary needs. Everything else in the file is ignored, so a summary
/// never fails on a field this build does not know.
struct TeamHeader {
    name: Option<String>,
    agent_count: usize,
}

/// The same line the editor draws (`TeamFileModel.parse`): a mapping with at least one of a
/// team's own keys, whose `agents`, when present, is a list.
fn read_team_header(text: &str) -> Result<TeamHeader, &'static str> {
    let value = serde_yaml::from_str::<serde_yaml::Value>(text).map_err(|_| "unreadable")?;
    let Some(mapping) = value.as_mapping() else {
        return Err("not_a_team");
    };
    let is_team = ["schemaVersion", "agents", "entrypoint"]
        .iter()
        .any(|key| mapping.contains_key(*key));
    let agents = mapping.get("agents");
    if !is_team || agents.is_some_and(|agents| !agents.is_sequence()) {
        return Err("not_a_team");
    }
    Ok(TeamHeader {
        name: mapping
            .get("name")
            .and_then(serde_yaml::Value::as_str)
            .map(str::to_owned),
        agent_count: agents
            .and_then(serde_yaml::Value::as_sequence)
            .map_or(0, Vec::len),
    })
}

fn summarize_team_file(teams_root: &Path, relative: &str) -> TeamSummary {
    let path = teams_root.join(relative);
    let header = fs::read_to_string(&path)
        .map_err(|_| "unreadable")
        .and_then(|text| read_team_header(&text));
    let problem = header.as_ref().err().copied();
    let header = header.ok();
    let modified_at = fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .map(|modified| chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339());
    TeamSummary {
        path: relative.to_owned(),
        name: header
            .as_ref()
            .and_then(|header| header.name.as_deref())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
        agent_count: header.map_or(0, |header| header.agent_count),
        modified_at,
        problem,
    }
}

/// Build the REST router using the daemon process's `PATH`.
///
/// # Errors
///
/// Returns an error when `teams_root` cannot be canonicalized.
pub fn router(teams_root: PathBuf, allowed_hosts: Vec<String>) -> io::Result<Router> {
    router_with_archive(
        teams_root,
        allowed_hosts,
        None,
        crate::runs::RunRegistry::default(),
    )
}

/// Build the REST router with the archive the capability inventory needs to count kept notes,
/// and the run registry `DELETE /api/team` checks for a team's unfinished runs.
///
/// The daemon uses this with the same registry it hands the run-control router; every other caller
/// (and every test) keeps [`router`], which passes no archive and reports `kept: null` — the honest
/// absence rather than a zero it could not have counted — and an empty registry.
///
/// # Errors
///
/// Returns an error when `teams_root` cannot be canonicalized.
pub fn router_with_archive(
    teams_root: PathBuf,
    allowed_hosts: Vec<String>,
    archive: Option<crate::archive::EventArchive>,
    runs: crate::runs::RunRegistry,
) -> io::Result<Router> {
    // The inherited `PATH` alone is not enough: see `EXTRA_HARNESS_DIRECTORIES`.
    // Executables come from the runtime home, not the independently configured read-only
    // capability import. Finding a host binary in an import would not make it runnable here.
    let runtime_home = std::env::var_os("HOME").map(PathBuf::from);
    let run_path = std::env::var_os("PATH");
    let search_path = augment_search_path(run_path.clone(), runtime_home.as_deref());
    router_with(
        teams_root,
        allowed_hosts,
        SearchPaths {
            detection: search_path,
            run: run_path,
        },
        archive,
        crate::host_runner::configured_client(),
        runs,
    )
}

/// Build the REST router with an explicit executable search path.
///
/// Keeping the search path in router state makes harness discovery deterministic in tests
/// and avoids mutating the process environment.
///
/// # Errors
///
/// Returns an error when `teams_root` cannot be canonicalized.
pub fn router_with_path(
    teams_root: PathBuf,
    allowed_hosts: Vec<String>,
    search_path: Option<OsString>,
) -> io::Result<Router> {
    let paths = SearchPaths {
        run: search_path.clone(),
        detection: search_path,
    };
    router_with(
        teams_root,
        allowed_hosts,
        paths,
        None,
        None,
        crate::runs::RunRegistry::default(),
    )
}

/// Where executables are looked for: [`ApiState::search_path`] and [`ApiState::run_path`].
struct SearchPaths {
    detection: Option<OsString>,
    run: Option<OsString>,
}

fn router_with(
    teams_root: PathBuf,
    allowed_hosts: Vec<String>,
    paths: SearchPaths,
    archive: Option<crate::archive::EventArchive>,
    host_runner: Option<crate::host_runner::ClientConfig>,
    runs: crate::runs::RunRegistry,
) -> io::Result<Router> {
    let state = ApiState {
        writes: Arc::default(),
        search_path: paths.detection,
        run_path: paths.run,
        teams_root: fs::canonicalize(teams_root)?,
        allowed_hosts: allowed_hosts
            .into_iter()
            .map(|host| normalize_hostname(&host))
            .filter(|host| !host.is_empty())
            .collect(),
        home_dir: crate::capabilities::configured_home(),
        archive,
        host_runner,
        harness_health: Arc::default(),
        runs,
    };
    Ok(Router::new()
        .route("/api/harnesses", get(get_harnesses))
        .route("/api/harnesses/{id}/models", get(get_harness_models))
        .route("/api/commands", get(get_commands))
        .route("/api/capabilities", get(get_capabilities))
        .route("/api/capabilities/{id}", get(get_capability_details))
        .route("/api/teams", get(get_teams))
        .route("/api/team", get(get_team).put(put_team).delete(delete_team))
        .route("/api/instructions", get(get_instructions))
        .route("/api/team/layout", get(get_layout).put(put_layout))
        .route("/api/memory", get(get_memory))
        .route("/api/memory/file", axum::routing::put(put_memory_file))
        .route("/api/config/schema", get(get_config_schema))
        .route("/api/files/stat", get(get_file_stat))
        .route("/api/files/open", axum::routing::post(post_file_open))
        .route("/api/jobs", get(get_jobs))
        .route(
            "/api/jobs/{id}",
            axum::routing::put(put_job).delete(delete_job),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            enforce_allowed_host,
        ))
        .with_state(state))
}

async fn enforce_allowed_host(
    State(state): State<ApiState>,
    request: Request,
    next: Next,
) -> Response {
    let allowed = request
        .uri()
        .authority()
        .cloned()
        .or_else(|| {
            request
                .headers()
                .get(header::HOST)
                .and_then(|host| host.to_str().ok())
                .and_then(|host| host.parse::<Authority>().ok())
        })
        .map(|authority| normalize_hostname(authority.host()))
        .is_some_and(|host| state.allowed_hosts.iter().any(|allowed| allowed == &host));

    if !allowed {
        return ApiError::new(StatusCode::FORBIDDEN, "host is not allowed".to_owned())
            .into_response();
    }
    next.run(request).await
}

fn normalize_hostname(host: &str) -> String {
    let host = host.trim().trim_end_matches('.');
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
        .to_ascii_lowercase()
}

async fn harness_report(state: &ApiState) -> HarnessReport {
    let mut report = HarnessReport {
        harnesses: detect_harnesses(state.search_path.as_deref()),
        searched_path: searched_directories(state.search_path.as_deref()),
        known_ids: known_harness_ids(),
        runner_error: None,
    };
    if let Some(config) = &state.host_runner {
        match crate::host_runner::list_harnesses(config).await {
            Ok(remote) => report = crate::host_runner::merge_reports(report, remote),
            Err(error) => {
                report.runner_error = Some(format!("Host harness runner unavailable: {error:#}"));
            }
        }
    }
    let health = state
        .harness_health
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    apply_harness_health(&mut report.harnesses, &health, Instant::now());
    report
}

/// Annotate `harnesses` with the discovery outcomes in `records` that still describe them.
///
/// An outcome applies only to the same executable and spawn descriptor it was observed on — a
/// reinstall elsewhere, or an ACP bridge appearing in place of the `npx` fallback, is a different
/// process whose health nobody has seen — and only until [`HARNESS_HEALTH_TTL`] has passed.
fn apply_harness_health(
    harnesses: &mut [DetectedHarness],
    records: &HashMap<String, HealthRecord>,
    now: Instant,
) {
    for harness in harnesses.iter_mut().filter(|harness| harness.acp_available) {
        let Some(record) = records.get(&harness.id) else {
            continue;
        };
        if record.executable_path != harness.executable_path
            || record.spawn != harness.spawn
            || now.saturating_duration_since(record.checked_at) >= HARNESS_HEALTH_TTL
        {
            continue;
        }
        match &record.error {
            None => harness.health = Some(HarnessHealth::Ok),
            Some(detail) => {
                // Discovery is initialize + session/new against the harness's own account, so a
                // failure there is, in practice, sign-in or a CLI its service no longer accepts.
                // The exact message rides along in `health_detail`.
                harness.health = Some(HarnessHealth::Error);
                harness.health_reason = Some(format!(
                    "{}: sign-in or version problem — run \"{}\" in Terminal to fix",
                    harness.name, harness.command
                ));
                harness.health_detail = Some(detail.clone());
            }
        }
    }
}

fn health_detail(error: &anyhow::Error) -> String {
    let detail = format!("{error:#}");
    match detail.char_indices().nth(HEALTH_DETAIL_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &detail[..cut]),
        None => detail,
    }
}

async fn get_harnesses(State(state): State<ApiState>) -> Json<HarnessReport> {
    Json(harness_report(&state).await)
}

async fn get_harness_models(
    State(state): State<ApiState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<HarnessModels>, ApiError> {
    let harness = harness_report(&state)
        .await
        .harnesses
        .into_iter()
        .find(|harness| harness.id == id)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("unknown harness {id:?}")))?;
    if !harness.acp_available {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!("{} does not have an available ACP adapter", harness.name),
        ));
    }

    // Resolve against the same PATH snapshot used for detection. This also keeps the endpoint
    // deterministic in tests instead of silently consulting a different process environment.
    let cmd = state
        .search_path
        .as_deref()
        .and_then(|search_path| find_executable(search_path, &harness.spawn.cmd))
        .map_or_else(
            || harness.spawn.cmd.clone(),
            |path| path.to_string_lossy().into_owned(),
        );
    let spec = ProcessSpec {
        cmd,
        args: harness.spawn.args.clone(),
        env: std::collections::BTreeMap::new(),
        cwd: state.teams_root.clone(),
        tools: Vec::new(),
    };
    let discovered = discover_models(&spec).await;
    state
        .harness_health
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            harness.id.clone(),
            HealthRecord {
                executable_path: harness.executable_path.clone(),
                spawn: harness.spawn.clone(),
                checked_at: Instant::now(),
                error: discovered.as_ref().err().map(health_detail),
            },
        );
    let catalog = discovered.map_err(|error| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("failed to load models from {}: {error:#}", harness.name),
        )
    })?;
    Ok(Json(HarnessModels {
        harness_id: harness.id,
        models: catalog.models,
        current_model_id: catalog.current_model_id,
        current_thinking_effort: catalog.current_thinking_effort,
    }))
}

/// `GET /api/commands?cmd=…&cmd=…` — whether each `spawn.cmd` would start, before a run tries.
///
/// The team file is not read: Build asks about the document it is editing, which a run saves
/// first, so a check of the file on disk would trail every unsaved change of app. Nothing is ever
/// executed — a command is looked up exactly as `AcpProcess::spawn` will look it up, and that is
/// all.
async fn get_commands(
    State(state): State<ApiState>,
    Query(query): Query<Vec<(String, String)>>,
) -> Result<Json<CommandReport>, ApiError> {
    let mut commands: Vec<String> = Vec::new();
    for (key, cmd) in query {
        if key != "cmd" || cmd.is_empty() || commands.contains(&cmd) {
            continue;
        }
        if commands.len() == MAX_COMMAND_CHECKS {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("at most {MAX_COMMAND_CHECKS} commands are checked at once"),
            ));
        }
        commands.push(cmd);
    }
    Ok(Json(CommandReport {
        commands: commands
            .iter()
            .map(|cmd| check_command(cmd, state.run_path.as_deref(), state.search_path.as_deref()))
            .collect(),
    }))
}

/// Harness report for the machine running this process, including user install prefixes.
/// The host runner uses this exact detector, so its inventory and spawn allowlist cannot drift.
#[must_use]
pub fn system_harness_report() -> HarnessReport {
    let runtime_home = std::env::var_os("HOME").map(PathBuf::from);
    let search_path = augment_search_path(std::env::var_os("PATH"), runtime_home.as_deref());
    HarnessReport {
        harnesses: detect_harnesses(search_path.as_deref()),
        searched_path: searched_directories(search_path.as_deref()),
        known_ids: known_harness_ids(),
        runner_error: None,
    }
}

async fn get_capabilities(State(state): State<ApiState>) -> Json<CapabilityInventory> {
    let mut inventory = detect_capabilities(state.home_dir.as_deref(), &state.teams_root);
    // `detect_capabilities` is a filesystem scan and cannot count rows, so every live team's
    // memory source comes back with `kept: None`. Where the daemon has a database, fill it in
    // here — in one statement for every team at once — and leave it absent where it does not,
    // because "not counted" and "zero kept notes" are different answers.
    if let Some(archive) = &state.archive {
        let teams: Vec<String> = inventory
            .sources
            .iter()
            .filter_map(|source| source.memory.as_ref()?.team.clone())
            .collect();
        match archive.notebook().kept_counts(&teams).await {
            Ok(counts) => {
                for source in &mut inventory.sources {
                    if let Some(memory) = source.memory.as_mut()
                        && let Some(team) = memory.team.as_deref()
                    {
                        memory.kept = Some(counts.get(team).copied().unwrap_or(0));
                    }
                }
            }
            Err(error) => eprintln!("warning: could not count kept notes: {}", error.message),
        }
    }
    Json(inventory)
}

async fn get_capability_details(
    State(state): State<ApiState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<CapabilityDetails>, ApiError> {
    detect_capability_details(state.home_dir.as_deref(), &state.teams_root, &id)
        .map(Json)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("unknown capability {id:?}")))
}

/// One instruction file as it is on disk **now**, with the fingerprint of what was read.
///
/// Deliberately not called a receipt: it reports the current bytes, and says nothing about which
/// run they belong to. The caller holds the fingerprint its run recorded and decides whether the
/// two agree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstructionFile {
    path: String,
    sha256: String,
    chars: usize,
    content: String,
}

/// `GET /api/instructions?path=` — read back instructions a run prepared for an agent.
///
/// A run archives the *fingerprint* of the instructions it put in an agent's opening prompt, not
/// their bytes, so reading them means reading the prepared copy the run wrote into the agent's
/// workspace under the teams root. That copy can have changed, or be gone, since the run — which
/// is why this returns the hash of what it actually read and leaves the verdict to the caller.
///
/// Scoped by `resolve_existing_team_path`, so a path outside the teams root is refused rather
/// than turning the daemon into a general file reader.
/// What a file an agent produced is (`crate::files`): the team output shows it as a card.
async fn get_file_stat(
    State(state): State<ApiState>,
    Query(query): Query<TeamPath>,
) -> Result<Json<crate::files::FileFacts>, ApiError> {
    crate::files::stat(&state.teams_root, &query.path).map(Json)
}

/// Open a produced file with its default app, or show it in its folder. JSON only: a page on
/// another site cannot send this without a preflight the daemon never answers.
async fn post_file_open(
    State(state): State<ApiState>,
    Json(request): Json<crate::files::OpenRequest>,
) -> Result<StatusCode, ApiError> {
    crate::files::open(&state.teams_root, &request).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The jobs the operator saved (`crate::jobs`, ADR 0030), and the files in the jobs folder that
/// are not valid jobs.
async fn get_jobs(State(state): State<ApiState>) -> Result<Json<crate::jobs::JobList>, ApiError> {
    let teams_root = state.teams_root.clone();
    tokio::task::spawn_blocking(move || crate::jobs::list_jobs(&teams_root))
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(job_error)
}

/// Save a job. `If-None-Match: *` saves only when no job has this id, so the UI can ask before
/// replacing one; without it an existing job is replaced.
async fn put_job(
    State(state): State<ApiState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(spec): Json<crate::jobs::JobSpec>,
) -> Result<Json<crate::jobs::SavedJob>, ApiError> {
    let create_only = headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|value| value.as_bytes() == b"*");
    let _write = state.writes.lock().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "job write lock unavailable".into(),
        )
    })?;
    crate::jobs::save_job(&state.teams_root, &id, spec, create_only)
        .map(Json)
        .map_err(job_error)
}

/// Remove a saved job: its file moves to `.jobs/.removed/`. No team changes.
async fn delete_job(
    State(state): State<ApiState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let _write = state.writes.lock().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "job write lock unavailable".into(),
        )
    })?;
    let moved = crate::jobs::remove_job(&state.teams_root, &id).map_err(job_error)?;
    Ok(Json(json!({ "id": id, "movedTo": moved })))
}

fn job_error(error: crate::jobs::JobError) -> ApiError {
    use crate::jobs::JobError;
    match error {
        JobError::Invalid(message) => ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, message),
        JobError::Exists(name) => ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            format!("You already have a job called “{name}”."),
        ),
        JobError::NotFound(id) => ApiError::new(
            StatusCode::NOT_FOUND,
            format!("There is no saved job “{id}”."),
        ),
        JobError::Io(message) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("The jobs folder could not be used: {message}"),
        ),
    }
}

async fn get_instructions(
    State(state): State<ApiState>,
    Query(query): Query<TeamPath>,
) -> Result<Json<InstructionFile>, ApiError> {
    let resolved = resolve_existing_team_path(&state.teams_root, &query.path)?;
    let bytes = fs::read(&resolved).map_err(|error| {
        let status = if error.kind() == io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        ApiError::new(
            status,
            format!("failed to read {}: {error}", query.path.display()),
        )
    })?;
    // Instruction bundles are capped at 128 KiB when they are prepared; this is the same bound,
    // so a file that grew past it after the run is refused rather than streamed into a browser.
    if bytes.len() > 128 * 1024 {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "{} is {} bytes; instruction files are read back up to 128 KiB",
                query.path.display(),
                bytes.len()
            ),
        ));
    }
    // The fingerprint a run records is over the decoded text, so a file that is no longer UTF-8
    // cannot be compared to it and is reported as unreadable rather than lossily decoded.
    let text = String::from_utf8(bytes).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("{} is not UTF-8: {error}", query.path.display()),
        )
    })?;
    Ok(Json(InstructionFile {
        path: query.path.to_string_lossy().into_owned(),
        sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
        chars: text.chars().count(),
        content: text,
    }))
}

async fn get_teams(State(state): State<ApiState>) -> Result<Json<TeamsDiscovery>, ApiError> {
    // Directory walking and reading every team file is blocking I/O; keep it off the runtime's
    // worker threads so a large teams folder never stalls the run streams.
    let teams_root = state.teams_root.clone();
    let scanned = tokio::task::spawn_blocking(move || {
        discover_team_files(&teams_root).map(|files| {
            let teams = files
                .iter()
                .map(|file| summarize_team_file(&teams_root, file))
                .collect::<Vec<_>>();
            (files, teams, trashed_team_paths(&teams_root))
        })
    })
    .await
    .map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to discover team files: {error}"),
        )
    })?;
    let (files, teams, trashed) = scanned.map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to discover team files: {error}"),
        )
    })?;
    Ok(Json(TeamsDiscovery {
        root: state.teams_root.to_string_lossy().into_owned(),
        files,
        teams,
        trashed,
    }))
}

/// Folders a team never lives in: hidden ones (including the daemon's own `.loomwatch` managed
/// workspaces, which can hold whole repositories) and package caches. Skipping them keeps the
/// picker free of stray YAML and the scan fast as workspaces grow.
fn is_skipped_team_directory(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| name.starts_with('.') || name == "node_modules")
}

fn discover_team_files(teams_root: &Path) -> io::Result<Vec<String>> {
    let mut directories = vec![teams_root.to_path_buf()];
    let mut files = Vec::new();

    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let path = entry.path();

            // Directory symlinks are deliberately not followed. This both avoids cycles and
            // makes it impossible for traversal to leave the configured tree while scanning.
            if file_type.is_dir() {
                if !is_skipped_team_directory(&entry.file_name()) {
                    directories.push(path);
                }
                continue;
            }
            if !(file_type.is_file() || file_type.is_symlink()) || !is_team_file(&path) {
                continue;
            }

            // A file symlink is useful when it still resolves inside the teams root. Broken
            // links and links to files outside the root are not discoverable.
            let Ok(resolved) = fs::canonicalize(&path) else {
                continue;
            };
            if !resolved.starts_with(teams_root) || !resolved.is_file() {
                continue;
            }
            if let Some(relative) = normalized_relative_path(teams_root, &path) {
                files.push(relative);
            }
        }
    }

    files.sort_unstable();
    files.dedup();
    Ok(files)
}

fn is_team_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("yaml") || extension.eq_ignore_ascii_case("yml")
        })
}

/// Render `path` (which must already be canonical and below `teams_root`) as the sorted,
/// `/`-separated relative form the discovery listing uses. `None` when it is not strictly
/// below the root or contains non-UTF-8 components.
pub(crate) fn normalized_relative_path(teams_root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(teams_root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_str()?),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

async fn get_team(
    State(state): State<ApiState>,
    Query(query): Query<TeamPath>,
) -> Result<Response, ApiError> {
    let resolved_path = resolve_existing_team_path(&state.teams_root, &query.path)?;
    let yaml = fs::read_to_string(&resolved_path).map_err(|error| {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        ApiError::new(
            status,
            format!("failed to read team file {}: {error}", query.path.display()),
        )
    })?;
    Ok(team_response(&TeamFile {
        path: query.path,
        yaml,
    }))
}

async fn put_team(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(team_file): Json<TeamFile>,
) -> Result<Response, ApiError> {
    TeamConfig::parse(&team_file.yaml)
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))?;
    // Serialize the precondition check and replacement across all API clients.
    let _write = state.writes.lock().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "team write lock unavailable".into(),
        )
    })?;
    let resolved_path = resolve_writable_team_path(&state.teams_root, &team_file.path)?;
    let create = check_precondition(&headers, &resolved_path)?;
    atomic_write(&resolved_path, team_file.yaml.as_bytes(), create).map_err(|error| {
        ApiError::new(
            if error.kind() == io::ErrorKind::AlreadyExists {
                StatusCode::PRECONDITION_FAILED
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            format!(
                "failed to write team file {}: {error}",
                team_file.path.display()
            ),
        )
    })?;
    Ok(team_response(&team_file))
}

/// Where `DELETE /api/team` puts a team: a hidden folder under the teams root, so the team list,
/// the scheduler and the memory index stop seeing the team while every byte of it stays where the
/// operator can get it back. See `docs/decisions/0028-delete-a-team-to-the-trash.md`.
pub(crate) const TRASH_DIR: &str = ".trash";

/// The note inside each trashed team's folder: a [`DeletedTeam`], saying where it came from.
const TRASH_MANIFEST: &str = "deleted.json";

/// What `DELETE /api/team` moved, and where. Also written into the trash folder as its manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedTeam {
    /// The team file as the team list named it, relative to the teams root. Moving the `moved`
    /// files back into this path's folder restores the team, history and notes included.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The folder the team now lives in, relative to the teams root.
    pub trash: String,
    /// File names inside `trash`: the team's own `<team>.brief` folder and `<team>.layout.json`
    /// sidecar when it had them, then the YAML.
    pub moved: Vec<String>,
    /// RFC 3339.
    pub deleted_at: String,
}

/// Move a team out of the team list and into `<teams root>/.trash/`.
///
/// Confined exactly like `PUT /api/team`: the path resolves, symlinks first, to a file strictly
/// below the teams root. Run history and Notebook notes are kept, filed under the team's path and
/// id as they were, so restoring the files restores the team whole.
///
/// Refused (409) while a run of the team has not finished, which is still reading its files, and
/// while another team's `memory.inherits` names it, which would stop that team from running.
async fn delete_team(
    State(state): State<ApiState>,
    Query(query): Query<TeamPath>,
) -> Result<Json<DeletedTeam>, ApiError> {
    let refuse = |message: String| ApiError::new(StatusCode::CONFLICT, message);
    // The same lock every team write takes, so no save can recreate a sidecar mid-move.
    let _write = state.writes.lock().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "team write lock unavailable".into(),
        )
    })?;
    let team = resolve_existing_team_path(&state.teams_root, &query.path)?;
    // A link's sidecars sit beside its target, which may be listed as a team of its own; moving
    // either half would leave the other dangling.
    let requested = rooted_candidate(&state.teams_root, &query.path);
    if fs::symlink_metadata(&requested).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(refuse(format!(
            "{} is a link to another file, so LoomWatch can't move it whole. Remove the link in \
             your teams folder instead.",
            query.path.display()
        )));
    }
    let relative = listed_team_path(&state.teams_root, &team).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("{} is not in your teams list.", query.path.display()),
        )
    })?;
    if state.runs.live_run_for(&relative).is_some() {
        return Err(refuse(
            "This team is running right now. Stop the run or wait for it to finish, then delete \
             the team."
                .to_owned(),
        ));
    }
    let dependents = teams_inheriting(&state.teams_root, &team, &relative).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to check which teams read this one's memory: {error}"),
        )
    })?;
    if !dependents.is_empty() {
        let (verb, whose) = if dependents.len() == 1 {
            ("reads", "that team's")
        } else {
            ("read", "their")
        };
        return Err(refuse(format!(
            "{} {verb} this team's memory. Remove it from {whose} memory settings first, then \
             delete this team.",
            dependents.join(", "),
        )));
    }
    let name = summarize_team_file(&state.teams_root, &relative).name;
    let deleted = move_team_to_trash(
        &state.teams_root,
        &team,
        &relative,
        name,
        chrono::Utc::now(),
    )
    .map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "couldn't move {} to {TRASH_DIR}; nothing was moved: {error}",
                query.path.display()
            ),
        )
    })?;
    Ok(Json(deleted))
}

/// `team` (canonical) as `GET /api/teams` lists it, or `None` when the list never would: not a
/// `.yaml`/`.yml` file, or inside a hidden folder — the trash itself, `.loomwatch` workspaces —
/// or a package cache. A team already in the trash cannot be deleted again.
fn listed_team_path(teams_root: &Path, team: &Path) -> Option<String> {
    if !team.is_file() || !is_team_file(team) {
        return None;
    }
    let relative = normalized_relative_path(teams_root, team)?;
    let folders = relative.rsplit_once('/').map_or("", |(folders, _)| folders);
    let hidden = folders
        .split('/')
        .any(|folder| is_skipped_team_directory(std::ffi::OsStr::new(folder)));
    (!hidden).then_some(relative)
}

/// Names of the listed teams, other than `relative` itself, whose enabled `memory.inherits` names
/// this team's id — the same id the memory index files it under (its `id`, else its file stem).
fn teams_inheriting(teams_root: &Path, team: &Path, relative: &str) -> io::Result<Vec<String>> {
    let Some(config) = fs::read_to_string(team)
        .ok()
        .and_then(|source| TeamConfig::parse(&source).ok())
    else {
        // A file that does not load is not in the memory index, so nothing can inherit it.
        return Ok(Vec::new());
    };
    let id = if config.id.is_empty() {
        team.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        config.id
    };
    Ok(discover_team_files(teams_root)?
        .into_iter()
        .filter(|file| file != relative)
        .filter(|file| {
            fs::read_to_string(teams_root.join(file))
                .ok()
                .and_then(|source| TeamConfig::parse(&source).ok())
                .and_then(|other| other.memory)
                .is_some_and(|memory| {
                    memory.enabled
                        && memory
                            .inherits
                            .iter()
                            .any(|entry| entry.team.as_deref() == Some(id.as_str()))
                })
        })
        .map(|file| {
            let summary = summarize_team_file(teams_root, &file);
            summary.name.unwrap_or(summary.path)
        })
        .collect())
}

/// Move the team's own `<team>.brief/` folder, its `<team>.layout.json` sidecar and its YAML into
/// a new folder under `.trash/`, the YAML last.
///
/// A rename never copies, so nothing is lost if this stops part-way, and a failure puts back what
/// already moved: the team leaves the list only once its YAML has gone, which is the last step.
/// The manifest is written first, so a folder found half-filled after a crash still says whose
/// files it holds.
fn move_team_to_trash(
    teams_root: &Path,
    team: &Path,
    relative: &str,
    name: Option<String>,
    now: chrono::DateTime<chrono::Utc>,
) -> io::Result<DeletedTeam> {
    let trash_root = teams_root.join(TRASH_DIR);
    match fs::symlink_metadata(&trash_root) {
        // `symlink_metadata` reports a link as not a directory, so a `.trash` link that leads
        // out of the teams root is refused rather than followed.
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(io::Error::other(format!(
                "{TRASH_DIR} in the teams folder is not a folder"
            )));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(&trash_root)?,
        Err(error) => return Err(error),
    }

    // `trip.yaml` and `trip.yml` side by side share `trip.brief/` and `trip.layout.json`; those
    // stay for the team that remains.
    let shares_sidecars = ["yaml", "yml"]
        .iter()
        .map(|extension| team.with_extension(extension))
        .any(|sibling| sibling != team && sibling.is_file());
    let mut sources = Vec::new();
    if !shares_sidecars {
        sources.extend(
            [team.with_extension("brief"), layout_path(team)]
                .into_iter()
                .filter(|sidecar| fs::symlink_metadata(sidecar).is_ok()),
        );
    }
    sources.push(team.to_path_buf());

    let stem = team.file_stem().map_or_else(
        || "team".to_owned(),
        |stem| stem.to_string_lossy().into_owned(),
    );
    let base = format!("{}-{stem}", now.format("%Y-%m-%dT%H%M%SZ"));
    let (folder_name, folder) = (1..=100)
        .map(|attempt| {
            if attempt == 1 {
                base.clone()
            } else {
                format!("{base}-{attempt}")
            }
        })
        .find_map(|candidate| {
            let folder = trash_root.join(&candidate);
            match fs::create_dir(&folder) {
                Ok(()) => Some(Ok((candidate, folder))),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error)),
            }
        })
        .unwrap_or_else(|| Err(io::Error::other("no free folder name in the trash")))?;

    let deleted = DeletedTeam {
        path: relative.to_owned(),
        name,
        trash: format!("{TRASH_DIR}/{folder_name}"),
        moved: sources
            .iter()
            .filter_map(|source| source.file_name())
            .map(|file| file.to_string_lossy().into_owned())
            .collect(),
        deleted_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    };
    let abandon = |moved: &[(PathBuf, PathBuf)]| {
        for (source, target) in moved.iter().rev() {
            let _ = fs::rename(target, source);
        }
        let _ = fs::remove_file(folder.join(TRASH_MANIFEST));
        let _ = fs::remove_dir(&folder);
    };
    let manifest = serde_json::to_vec_pretty(&deleted).map_err(io::Error::other)?;
    if let Err(error) = fs::write(folder.join(TRASH_MANIFEST), manifest) {
        abandon(&[]);
        return Err(error);
    }
    let mut moved = Vec::new();
    for source in sources {
        let Some(file_name) = source.file_name() else {
            continue;
        };
        let target = folder.join(file_name);
        if let Err(error) = fs::rename(&source, &target) {
            abandon(&moved);
            return Err(error);
        }
        moved.push((source, target));
    }
    Ok(deleted)
}

/// The original paths of the teams in the trash, read from each folder's manifest. A folder with
/// no readable manifest still holds its files; it just cannot say whose they were.
fn trashed_team_paths(teams_root: &Path) -> Vec<String> {
    let trash_root = teams_root.join(TRASH_DIR);
    if !fs::symlink_metadata(&trash_root).is_ok_and(|metadata| metadata.is_dir()) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(trash_root) else {
        return Vec::new();
    };
    let mut paths: Vec<String> = entries
        .flatten()
        .filter_map(|entry| fs::read(entry.path().join(TRASH_MANIFEST)).ok())
        .filter_map(|bytes| serde_json::from_slice::<DeletedTeam>(&bytes).ok())
        .map(|deleted| deleted.path)
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutWrite {
    path: PathBuf,
    layout: ComposerLayout,
}

/// The planned-capability sidecar for one team. Absent is not an error: a team that has never had
/// a capability placed on it simply has an empty layout.
/// The team's Brief as the Memory panel reads it: what is pinned, who it applies to, and how much
/// of the packet budget it uses.
///
/// Read-only. Writing a Brief *entry* is two changes — a Markdown file and a line in the team
/// YAML — and the UI already owns byte-preserving YAML editing through `useTeamDocument`, so this
/// surface writes only the Markdown (`PUT /api/memory/file`) and the document hook writes the
/// YAML. Splitting it the other way would give the daemon a second, competing YAML writer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryView {
    /// `false` when the team has no `memory:` block, or it is disabled. Every count is then zero.
    pub enabled: bool,
    pub entries: Vec<MemoryEntryView>,
    /// `memory.packet.maxChars`.
    pub budget_chars: u32,
    /// Characters the whole-team entries use, which is what the chip and the panel subtitle
    /// report. A scoped entry is excluded because it is not supplied to every agent.
    pub used_chars: usize,
    pub deliver_as: String,
    /// Brief entries this team reads from the teams it inherits, in `inherits:` order.
    ///
    /// A separate list from [`Self::entries`], not a flag on each row, because the panel treats
    /// them differently in every respect: they are dashed and read-only, they offer "Open there"
    /// and "Exclude" instead of Edit and Remove, and `PUT /api/memory/file` would refuse to write
    /// one anyway — it is bounded to this team's own directory.
    pub inherited: Vec<MemoryEntryView>,
    /// Team ids whose kept notes are in this team's scope.
    pub inherited_teams: Vec<String>,
    /// Whether agents on this team get the four memory tools.
    pub notebook_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryView {
    /// Relative to the team file, exactly as the team file spells it.
    pub path: String,
    pub title: String,
    pub body: String,
    pub chars: usize,
    pub sha256: String,
    /// Agent ids this entry is supplied to; absent means the whole team.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applies_to: Option<Vec<String>>,
    /// The team this entry belongs to, when this team only inherited it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

async fn get_memory(
    State(state): State<ApiState>,
    Query(query): Query<TeamPath>,
) -> Result<Json<MemoryView>, ApiError> {
    let resolved = resolve_existing_team_path(&state.teams_root, &query.path)?;
    let team = TeamConfig::load(&resolved).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "failed to read team file {}: {error:#}",
                query.path.display()
            ),
        )
    })?;
    // A Brief file that cannot be read is the operator's problem to fix and would refuse a run,
    // so the panel must say so rather than showing a short list that looks complete.
    let roots = crate::memory::MemoryRoots::for_team(&resolved, Some(&state.teams_root));
    let memory = crate::memory::TeamMemory::load(&roots, &resolved, team.memory.as_ref())
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.message))?;
    let view = |entry: &crate::memory::BriefEntry| MemoryEntryView {
        path: entry.path.clone(),
        title: entry.title.clone(),
        body: entry.body.clone(),
        chars: entry.body.chars().count(),
        sha256: entry.sha256.clone(),
        applies_to: entry.applies_to.clone(),
        origin: entry.origin.clone(),
    };
    let entries: Vec<MemoryEntryView> = memory.brief.iter().map(view).collect();
    let inherited: Vec<MemoryEntryView> = memory.inherited.iter().map(view).collect();
    let used_chars = entries
        .iter()
        .filter(|entry| entry.applies_to.is_none())
        .map(|entry| entry.chars)
        .sum();
    Ok(Json(MemoryView {
        enabled: team.memory.as_ref().is_some_and(|memory| memory.enabled),
        entries,
        budget_chars: memory.packet_max_chars,
        used_chars,
        deliver_as: match memory.deliver_as {
            crate::config::DeliverAs::NativeFile => "native-file".to_owned(),
            crate::config::DeliverAs::PacketOnly => "packet-only".to_owned(),
        },
        inherited,
        inherited_teams: memory.inherited_teams.clone(),
        notebook_enabled: memory.notebook_enabled,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileWrite {
    /// The team file, relative to the teams root.
    pub path: PathBuf,
    /// The Brief file, relative to the team file's own directory.
    pub file: PathBuf,
    pub body: String,
}

/// Write one Brief Markdown file beside the team YAML.
///
/// The teams-root boundary is enforced the same way every other write here is: the resolved path
/// must lie under the canonical root, symlinks resolved first. In addition the file must land
/// under the *team file's own directory* — a Brief belongs to one team, and a panel that could
/// write into a sibling team's directory would make ownership unanswerable.
async fn put_memory_file(
    State(state): State<ApiState>,
    Json(write): Json<MemoryFileWrite>,
) -> Result<Json<MemoryEntryView>, ApiError> {
    let bad = |message: String| ApiError::new(StatusCode::BAD_REQUEST, message);
    if write.body.trim().is_empty() {
        return Err(bad("a Brief file must not be empty.".to_owned()));
    }
    let spelled = write.file.to_string_lossy().into_owned();
    if write.file.is_absolute()
        || write
            .file
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(bad(format!(
            "the Brief path {spelled} must be a relative path with no `..` segments."
        )));
    }
    if write.file.extension().and_then(|value| value.to_str()) != Some("md") {
        return Err(bad(format!(
            "the Brief file {spelled} must be Markdown (.md)."
        )));
    }
    let _guard = state.writes.lock().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "team write lock unavailable".into(),
        )
    })?;
    let team = resolve_existing_team_path(&state.teams_root, &write.path)?;
    let team_dir = team
        .parent()
        .ok_or_else(|| bad(format!("team path {} has no parent", write.path.display())))?
        .to_path_buf();
    let target = team_dir.join(&write.file);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create {}: {error}", parent.display()),
            )
        })?;
        // Re-check after creating: a pre-existing symlinked directory on the way down would
        // otherwise place the file outside the team.
        let resolved_parent = fs::canonicalize(parent).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to resolve {}: {error}", parent.display()),
            )
        })?;
        if !resolved_parent.starts_with(&team_dir)
            || !resolved_parent.starts_with(&state.teams_root)
        {
            return Err(bad(format!(
                "the Brief path {spelled} resolves outside the team's own directory."
            )));
        }
    }
    atomic_write(&target, write.body.as_bytes(), false).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to write {}: {error}", target.display()),
        )
    })?;
    let digest = format!("{:x}", Sha256::digest(write.body.as_bytes()));
    Ok(Json(MemoryEntryView {
        title: crate::memory::title_for(&write.body, &write.file),
        path: spelled,
        chars: write.body.chars().count(),
        body: write.body,
        sha256: digest,
        applies_to: None,
        origin: None,
    }))
}

async fn get_layout(
    State(state): State<ApiState>,
    Query(query): Query<TeamPath>,
) -> Result<Json<ComposerLayout>, ApiError> {
    let team = resolve_existing_team_path(&state.teams_root, &query.path)?;
    let sidecar = layout_path(&team);
    let bytes = match fs::read(&sidecar) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Json(ComposerLayout::default()));
        }
        Err(error) => {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read {}: {error}", sidecar.display()),
            ));
        }
    };
    // A sidecar we cannot parse must not take the canvas down with it: report it so the UI can
    // say the wiring could not be read, rather than silently pretending there was none.
    let mut layout: ComposerLayout = serde_json::from_slice(&bytes).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "{} is not a layout this daemon understands: {error}",
                sidecar.display()
            ),
        )
    })?;
    layout
        .validate()
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))?;
    // Version 1 is read, not refused: version 2 only added fields, so an older sidecar is already
    // a valid newer one with two of them absent. It is stamped forward here so the client never
    // sees a version it would then have to know how to migrate.
    layout.migrate();
    Ok(Json(layout))
}

/// Writes `<team>.layout.json`. The sidecar name is derived here, never sent by the client, and
/// the team file it belongs to must already exist.
async fn put_layout(
    State(state): State<ApiState>,
    Json(write): Json<LayoutWrite>,
) -> Result<Json<ComposerLayout>, ApiError> {
    write
        .layout
        .validate()
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))?;
    let _guard = state.writes.lock().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "team write lock unavailable".into(),
        )
    })?;
    let team = resolve_existing_team_path(&state.teams_root, &write.path)?;
    let sidecar = layout_path(&team);
    let body = serde_json::to_vec_pretty(&write.layout)
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    atomic_write(&sidecar, &body, false).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to write {}: {error}", sidecar.display()),
        )
    })?;
    Ok(Json(write.layout))
}

fn revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn team_response(team: &TeamFile) -> Response {
    let revision = revision(team.yaml.as_bytes());
    (
        [
            (header::ETAG, format!("\"{revision}\"")),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        Json(json!({
            "path": team.path, "yaml": team.yaml, "revision": revision,
        })),
    )
        .into_response()
}

fn check_precondition(headers: &HeaderMap, path: &Path) -> Result<bool, ApiError> {
    let matches = headers.get(header::IF_MATCH);
    let absent = headers.get(header::IF_NONE_MATCH);
    if matches.is_none() && absent.is_none() {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "Save requires If-Match with the loaded revision, or If-None-Match: * to create."
                .into(),
        ));
    }
    if matches.is_some() && absent.is_some() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Use only one save precondition.".into(),
        ));
    }
    let current = match fs::read(path) {
        Ok(bytes) => Some(revision(&bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            ));
        }
    };
    let valid = if let Some(value) = matches {
        current
            .as_ref()
            .is_some_and(|revision| value.to_str().ok() == Some(format!("\"{revision}\"").as_str()))
    } else {
        absent.and_then(|value| value.to_str().ok()) == Some("*") && current.is_none()
    };
    if !valid {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            "The team file changed or the destination already exists. Reload before saving.".into(),
        ));
    }
    Ok(absent.is_some())
}

/// Resolve a requested team path to a canonical file strictly below the canonical
/// `teams_root`, following symlinks first so an escape cannot hide behind a link. Shared
/// by `GET /api/team` and `POST /api/runs` so both surfaces enforce the same boundary.
pub(crate) fn resolve_existing_team_path(
    teams_root: &Path,
    requested: &Path,
) -> Result<PathBuf, ApiError> {
    let candidate = rooted_candidate(teams_root, requested);
    let resolved = fs::canonicalize(&candidate).map_err(|error| {
        let status = if error.kind() == io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        ApiError::new(
            status,
            format!(
                "failed to resolve team file {}: {error}",
                requested.display()
            ),
        )
    })?;
    ensure_under_teams_root(teams_root, requested, resolved)
}

fn resolve_writable_team_path(teams_root: &Path, requested: &Path) -> Result<PathBuf, ApiError> {
    let candidate = rooted_candidate(teams_root, requested);
    match fs::symlink_metadata(&candidate) {
        Ok(_) => {
            let resolved = fs::canonicalize(&candidate).map_err(|error| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "failed to resolve team file {}: {error}",
                        requested.display()
                    ),
                )
            })?;
            ensure_under_teams_root(teams_root, requested, resolved)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let file_name = candidate.file_name().ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!("team path {} has no file name", requested.display()),
                )
            })?;
            let parent = candidate.parent().ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!("team path {} has no parent", requested.display()),
                )
            })?;
            let resolved_parent = fs::canonicalize(parent).map_err(|error| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "failed to resolve parent of team file {}: {error}",
                        requested.display()
                    ),
                )
            })?;
            ensure_under_teams_root(teams_root, requested, resolved_parent.join(file_name))
        }
        Err(error) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "failed to inspect team file {}: {error}",
                requested.display()
            ),
        )),
    }
}

fn rooted_candidate(teams_root: &Path, requested: &Path) -> PathBuf {
    if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        teams_root.join(requested)
    }
}

fn ensure_under_teams_root(
    teams_root: &Path,
    requested: &Path,
    resolved: PathBuf,
) -> Result<PathBuf, ApiError> {
    if resolved.starts_with(teams_root) && resolved != teams_root {
        Ok(resolved)
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!(
                "team path {} resolves outside the configured teams root",
                requested.display()
            ),
        ))
    }
}

/// Replace `path` without ever exposing a partially written team file.
///
/// The temporary file lives beside the destination so the final rename stays on one
/// filesystem and is atomic. Syncing it before the rename also prevents a successful
/// response from referring to bytes that are still only in userspace buffers.
fn atomic_write(path: &Path, contents: &[u8], create: bool) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "team file path has no file name",
        )
    })?;
    let temporary_path = parent.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));

    let result = (|| {
        let mut temporary_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        if let Ok(metadata) = fs::metadata(path) {
            temporary_file.set_permissions(metadata.permissions())?;
        }
        temporary_file.write_all(contents)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        if create {
            // Unlike rename, hard_link cannot overwrite a concurrently created destination.
            fs::hard_link(&temporary_path, path)?;
            fs::remove_file(&temporary_path)
        } else {
            fs::rename(&temporary_path, path)
        }
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

async fn get_config_schema() -> Result<Json<Value>, ApiError> {
    let schema = serde_yaml::from_str(TEAM_SCHEMA).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("embedded team schema is invalid: {error}"),
        )
    })?;
    Ok(Json(schema))
}

/// Scan a `PATH` value for every harness in [`HARNESSES`].
#[must_use]
pub fn detect_harnesses(search_path: Option<&std::ffi::OsStr>) -> Vec<DetectedHarness> {
    let Some(search_path) = search_path else {
        return Vec::new();
    };
    HARNESSES
        .iter()
        .filter_map(|spec| {
            find_executable(search_path, spec.command)
                .map(|path| detected(search_path, *spec, &path))
        })
        .collect()
}

/// Every id in the catalog, so the UI need not keep a second copy of the vendor list.
#[must_use]
pub fn known_harness_ids() -> Vec<String> {
    HARNESSES
        .iter()
        .map(|spec| spec.id.to_owned())
        .collect::<Vec<_>>()
}

fn detected(
    search_path: &std::ffi::OsStr,
    spec: HarnessSpec,
    executable: &Path,
) -> DetectedHarness {
    let found = |command: &str, args: &[&str], acp_available, unavailable_reason| DetectedHarness {
        id: spec.id.to_owned(),
        name: spec.name.to_owned(),
        command: spec.command.to_owned(),
        executable_path: executable.to_string_lossy().into_owned(),
        acp_available,
        unavailable_reason,
        health: None,
        health_reason: None,
        health_detail: None,
        spawn: HarnessSpawn {
            cmd: command.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        },
    };
    let Some(bridge) = spec.acp else {
        return found(
            spec.command,
            &[],
            false,
            Some(format!(
                "{} is installed but ships no ACP bridge, so LoomWatch cannot drive it. \
                 Reach its models through `opencode acp` instead.",
                spec.command
            )),
        );
    };
    if find_executable(search_path, bridge.command).is_some() {
        return found(bridge.command, bridge.args, true, None);
    }
    let npx_available = find_executable(search_path, "npx").is_some();
    match bridge.fallback_package {
        Some(package) if npx_available => found("npx", &["-y", package], true, None),
        Some(package) => found(
            bridge.command,
            bridge.args,
            false,
            Some(format!(
                "neither {} nor npx (for the {package} bridge) is on the searched PATH.",
                bridge.command
            )),
        ),
        None => found(
            bridge.command,
            bridge.args,
            false,
            Some(format!("{} is not on the searched PATH.", bridge.command)),
        ),
    }
}

/// The `PATH` entries a scan would walk, in order.
#[must_use]
pub fn searched_directories(search_path: Option<&std::ffi::OsStr>) -> Vec<String> {
    search_path
        .map(|search_path| {
            std::env::split_paths(search_path)
                .map(|directory| directory.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Append the per-user install prefixes to an inherited `PATH`, skipping duplicates.
///
/// See [`EXTRA_HARNESS_DIRECTORIES`] for why. Returns `None` only when there is nothing at all to
/// search, which cannot happen while `HOME` is set.
fn augment_search_path(inherited: Option<OsString>, home: Option<&Path>) -> Option<OsString> {
    let mut directories: Vec<PathBuf> = inherited
        .as_deref()
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    if let Some(home) = home {
        for extra in EXTRA_HARNESS_DIRECTORIES {
            let candidate = home.join(extra);
            if !directories.contains(&candidate) {
                directories.push(candidate);
            }
        }
    }
    if directories.is_empty() {
        return inherited;
    }
    std::env::join_paths(directories).ok().or(inherited)
}

/// Judge one `spawn.cmd` the way a run will resolve it, without running it.
///
/// A bare name is looked up on `run_path`, the `PATH` a run inherits. `detection_path` only
/// explains a miss: an app that `GET /api/harnesses` finds in a per-user folder can be listed in
/// the Library and still not start, and "not installed" would be the wrong thing to say about it.
fn check_command(
    cmd: &str,
    run_path: Option<&std::ffi::OsStr>,
    detection_path: Option<&std::ffi::OsStr>,
) -> CommandCheck {
    let command = Path::new(cmd);
    let (status, path) = if command.is_absolute() {
        if is_executable(command) {
            (CommandStatus::Found, Some(command.to_path_buf()))
        } else if fs::metadata(command).is_ok() {
            (CommandStatus::NotExecutable, None)
        } else {
            (CommandStatus::NotFound, None)
        }
    } else if command.components().count() > 1 {
        (CommandStatus::Unchecked, None)
    } else if let Some(found) = run_path.and_then(|run_path| find_executable(run_path, cmd)) {
        (CommandStatus::Found, Some(found))
    } else if let Some(found) =
        detection_path.and_then(|detection_path| find_executable(detection_path, cmd))
    {
        (CommandStatus::OutsidePath, Some(found))
    } else {
        (CommandStatus::NotFound, None)
    };
    CommandCheck {
        cmd: cmd.to_owned(),
        status,
        path: path.map(|path| path.to_string_lossy().into_owned()),
    }
}

fn find_executable(search_path: &std::ffi::OsStr, command: &str) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .flat_map(|directory| executable_candidates(&directory, command))
        .find(|candidate| is_executable(candidate))
}

#[cfg(not(windows))]
fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    vec![directory.join(command)]
}

#[cfg(windows)]
fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    let extensions =
        std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
    extensions
        .to_string_lossy()
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(|extension| directory.join(format!("{command}{extension}")))
        .collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// A JSON `{ "error": message }` response with an explicit status.
#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    pub(crate) message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: String) -> Self {
        Self { status, message }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;

    const VALID_TEAM: &str = "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n";

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("loomwatch-api-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create temporary directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove temporary directory");
        }
    }

    fn create_executable(directory: &Path, name: &str) {
        create_executable_with_contents(directory, name, "#!/bin/sh\n");
    }

    fn create_executable_with_contents(directory: &Path, name: &str, contents: &str) {
        let path = directory.join(name);
        let mut file = fs::File::create(&path).expect("create executable");
        file.write_all(contents.as_bytes())
            .expect("write executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                .expect("set executable bit");
        }
    }

    fn test_router(teams_root: &Path) -> Router {
        test_router_with_path(teams_root, None)
    }

    fn test_router_with_path(teams_root: &Path, search_path: Option<OsString>) -> Router {
        router_with_path(
            teams_root.to_path_buf(),
            vec!["localhost".to_owned()],
            search_path,
        )
        .expect("build API router")
    }

    async fn response_json(response: Response) -> Value {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes();
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    /// The fingerprint a run records is `sha256(text)` with `chars` counted over characters, not
    /// bytes (`workspace::prepare`). Reading instructions back is only proof if this handler
    /// reproduces both exactly, so the test pins a body whose two counts differ.
    #[tokio::test]
    async fn instructions_endpoint_reproduces_the_fingerprint_a_run_records() {
        let root = TempDirectory::new();
        let nested = root.0.join(".loomwatch").join("team").join("agent");
        fs::create_dir_all(&nested).expect("create workspace");
        // Two characters, three bytes: a byte count would disagree with the recorded `chars`.
        let body = "design brief — é\n";
        fs::write(nested.join("SKILL.md"), body).expect("write skill");

        let response = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .uri("/api/instructions?path=.loomwatch/team/agent/SKILL.md")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["content"], body);
        assert_eq!(json["chars"], body.chars().count());
        assert_ne!(
            body.chars().count(),
            body.len(),
            "the fixture must distinguish characters from bytes"
        );
        assert_eq!(
            json["sha256"],
            format!("{:x}", Sha256::digest(body.as_bytes()))
        );
    }

    /// The path arrives from the client, so the teams root is the boundary: this endpoint reads
    /// instructions a run prepared, never an arbitrary file.
    #[tokio::test]
    async fn instructions_endpoint_refuses_a_path_outside_the_teams_root() {
        let root = TempDirectory::new();
        let outside = TempDirectory::new();
        fs::write(outside.0.join("secret.md"), "not yours").expect("write outside");

        for uri in [
            "/api/instructions?path=../secret.md".to_owned(),
            format!(
                "/api/instructions?path={}",
                outside.0.join("secret.md").display()
            ),
        ] {
            let response = test_router(&root.0)
                .oneshot(
                    Request::builder()
                        .uri(&uri)
                        .header(header::HOST, "localhost")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert!(
                response.status().is_client_error(),
                "{uri} should be refused, got {}",
                response.status()
            );
            let json = response_json(response).await;
            assert!(
                !json.to_string().contains("not yours"),
                "{uri} leaked the file it refused"
            );
        }
    }

    /// The team output turns a produced file into a card: the route answers inside the teams root
    /// and refuses the same path shape everywhere else.
    #[tokio::test]
    async fn file_stat_describes_a_produced_file_and_refuses_outside_paths() {
        let root = TempDirectory::new();
        let workspace = root.0.join(".loomwatch").join("team").join("writer");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::write(workspace.join("report.docx"), b"PK").expect("write report");
        let canonical = fs::canonicalize(&root.0).expect("canonical root");
        let report = canonical.join(".loomwatch/team/writer/report.docx");

        let response = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/stat?path={}", report.display()))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["name"], "report.docx");
        assert_eq!(json["kind"], "document");
        assert_eq!(json["exists"], true);
        assert_eq!(json["openable"], true);

        let response = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .uri("/api/files/stat?path=/etc/hosts")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    /// Opening launches an app, so it must not be reachable from a plain cross-site form post: only
    /// a JSON body is accepted, and a browser will not send one cross-origin without a preflight.
    #[tokio::test]
    async fn file_open_accepts_json_only() {
        let root = TempDirectory::new();
        let response = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/files/open")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "text/plain")
                    .body(Body::from(r#"{"path":"x.docx"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    /// A saved job round-trips through the API: created once, refused a second create so the UI
    /// can ask before replacing it, listed, removed, and kept out of the team list throughout.
    // One test on purpose: each step reads the state the previous one left on disk.
    #[allow(clippy::too_many_lines)]
    #[tokio::test]
    async fn jobs_are_saved_listed_and_removed_without_becoming_teams() {
        let root = TempDirectory::new();
        let job = r#"{"name":"Release notes","does":"Drafts release notes","instructions":"Write the notes.","apps":["codex"],"skills":["release-style"]}"#;
        let put = |create_only: bool| {
            let mut request = Request::builder()
                .method("PUT")
                .uri("/api/jobs/release-notes")
                .header(header::HOST, "localhost")
                .header(header::CONTENT_TYPE, "application/json");
            if create_only {
                request = request.header(header::IF_NONE_MATCH, "*");
            }
            request.body(Body::from(job)).expect("request")
        };
        let get = |uri: &str| {
            Request::builder()
                .uri(uri)
                .header(header::HOST, "localhost")
                .body(Body::empty())
                .expect("request")
        };

        let response = test_router(&root.0)
            .oneshot(put(true))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let response = test_router(&root.0)
            .oneshot(put(true))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
        let response = test_router(&root.0)
            .oneshot(put(false))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);

        let list = response_json(
            test_router(&root.0)
                .oneshot(get("/api/jobs"))
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(list["jobs"][0]["id"], "release-notes");
        assert_eq!(list["jobs"][0]["skills"][0], "release-style");
        let teams = response_json(
            test_router(&root.0)
                .oneshot(get("/api/teams"))
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(teams["files"], json!([]), "a job is never listed as a team");

        let response = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/jobs/release-notes")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"name":"X","instructions":""}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let delete = || {
            Request::builder()
                .method("DELETE")
                .uri("/api/jobs/release-notes")
                .header(header::HOST, "localhost")
                .body(Body::empty())
                .expect("request")
        };
        let response = test_router(&root.0)
            .oneshot(delete())
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let response = test_router(&root.0)
            .oneshot(delete())
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let list = response_json(
            test_router(&root.0)
                .oneshot(get("/api/jobs"))
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(list["jobs"], json!([]));

        let response = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .uri("/api/jobs")
                    .header(header::HOST, "evil.example")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "jobs sit behind the host check"
        );
    }

    #[tokio::test]
    async fn instructions_endpoint_reports_a_file_the_run_no_longer_has() {
        let root = TempDirectory::new();
        let response = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .uri("/api/instructions?path=.loomwatch/gone/SKILL.md")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn harness_endpoint_scans_path_in_catalog_order() {
        let first = TempDirectory::new();
        let second = TempDirectory::new();
        create_executable(&first.0, "opencode");
        create_executable(&second.0, "claude");
        fs::write(first.0.join("codex"), b"not executable").expect("write non-executable");
        let search_path = std::env::join_paths([&first.0, &second.0]).expect("join search path");

        let response = test_router_with_path(&first.0, Some(search_path))
            .oneshot(
                Request::builder()
                    .uri("/api/harnesses")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            json!({
                "harnesses": [
                    {
                        "id": "claude",
                        "name": "Claude",
                        "command": "claude",
                        "executablePath": second.0.join("claude").to_string_lossy(),
                        "acpAvailable": false,
                        "unavailableReason": "neither claude-agent-acp nor npx (for the @agentclientprotocol/claude-agent-acp bridge) is on the searched PATH.",
                        "spawn": {"cmd": "claude-agent-acp", "args": []}
                    },
                    {
                        "id": "opencode",
                        "name": "OpenCode",
                        "command": "opencode",
                        "executablePath": first.0.join("opencode").to_string_lossy(),
                        "acpAvailable": true,
                        "spawn": {"cmd": "opencode", "args": ["acp"]}
                    }
                ],
                "searchedPath": [
                    first.0.to_string_lossy(),
                    second.0.to_string_lossy(),
                ],
                "knownIds": ["claude", "codex", "gemini", "opencode", "hermes", "openclaw", "pi"],
            })
        );
    }

    /// Part B root cause (a): the catalog was a closed list of four, so three harnesses sitting in
    /// the same directory as `claude` could never be reported. This pins the three that were
    /// missing, including the one that is deliberately reported as unrunnable.
    #[tokio::test]
    async fn harness_endpoint_detects_hermes_openclaw_and_pi() {
        let directory = TempDirectory::new();
        create_executable(&directory.0, "hermes");
        create_executable(&directory.0, "hermes-acp");
        create_executable(&directory.0, "openclaw");
        create_executable(&directory.0, "pi");
        let search_path = std::env::join_paths([&directory.0]).expect("join search path");

        let harnesses = detect_harnesses(Some(search_path.as_os_str()));
        let by_id = |id: &str| {
            harnesses
                .iter()
                .find(|harness| harness.id == id)
                .unwrap_or_else(|| panic!("{id} was not detected"))
                .clone()
        };

        let hermes = by_id("hermes");
        assert!(hermes.acp_available);
        assert_eq!(hermes.spawn.cmd, "hermes-acp");
        assert_eq!(hermes.spawn.args, Vec::<String>::new());

        let openclaw = by_id("openclaw");
        assert!(openclaw.acp_available);
        assert_eq!(openclaw.spawn.cmd, "openclaw");
        assert_eq!(openclaw.spawn.args, ["acp"]);

        // `pi` has no ACP bridge at all, so it must be reported with that reason rather than the
        // Library's old guess that its command was missing from the PATH.
        let pi = by_id("pi");
        assert!(!pi.acp_available);
        let reason = pi.unavailable_reason.expect("pi has an unavailable reason");
        assert!(reason.contains("no ACP bridge"), "{reason}");
        assert!(!reason.contains("PATH"), "{reason}");
    }

    /// `hermes` on its own is not enough: without `hermes-acp` there is nothing to spawn, and the
    /// reason must name the adapter rather than the vendor CLI that *is* present.
    #[tokio::test]
    async fn hermes_without_its_adapter_is_reported_unavailable() {
        let directory = TempDirectory::new();
        create_executable(&directory.0, "hermes");
        create_executable(&directory.0, "npx");
        let search_path = std::env::join_paths([&directory.0]).expect("join search path");

        let harnesses = detect_harnesses(Some(search_path.as_os_str()));
        let hermes = harnesses
            .iter()
            .find(|harness| harness.id == "hermes")
            .expect("hermes detected");
        assert!(!hermes.acp_available);
        assert_eq!(
            hermes.unavailable_reason.as_deref(),
            Some("hermes-acp is not on the searched PATH.")
        );
    }

    /// A team shared from another machine names an app this one does not have. Build asks before
    /// the run does, so each command must come back judged the way `AcpProcess::spawn` would
    /// resolve it — and asking must never start one. `npx` is how the Claude and Codex bridges
    /// run without a standalone install, so it is checked like any other name on the `PATH`.
    #[tokio::test]
    async fn command_check_judges_each_spawn_command_without_running_it() {
        let root = TempDirectory::new();
        let bin = root.0.join("bin");
        fs::create_dir(&bin).expect("create bin");
        let ran = root.0.join("ran");
        create_executable_with_contents(
            &bin,
            "npx",
            &format!("#!/bin/sh\ntouch '{}'\n", ran.display()),
        );
        let installed = bin.join("npx");
        let not_a_program = root.0.join("notes.txt");
        fs::write(&not_a_program, "not a program").expect("write a plain file");
        let gone = root.0.join("gone/agent");
        let search_path = std::env::join_paths([&bin]).expect("join search path");
        let router = test_router_with_path(&root.0, Some(search_path));

        let query = [
            "npx",
            "acme-agent-cli",
            "npx",
            "",
            &installed.to_string_lossy(),
            &not_a_program.to_string_lossy(),
            &gone.to_string_lossy(),
            "./bin/agent",
        ]
        .iter()
        .map(|cmd| {
            // Temporary folders can hold `+` or spaces, which a query would otherwise decode.
            let encoded: String = cmd
                .bytes()
                .map(|byte| match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' => {
                        char::from(byte).to_string()
                    }
                    _ => format!("%{byte:02X}"),
                })
                .collect();
            format!("cmd={encoded}")
        })
        .collect::<Vec<_>>()
        .join("&");
        let (status, report) = get_json(&router, &format!("/api/commands?{query}")).await;

        assert_eq!(status, StatusCode::OK, "{report}");
        assert_eq!(
            report,
            json!({
                "commands": [
                    {"cmd": "npx", "status": "found", "path": installed.to_string_lossy()},
                    {"cmd": "acme-agent-cli", "status": "not_found"},
                    {"cmd": installed.to_string_lossy(), "status": "found", "path": installed.to_string_lossy()},
                    {"cmd": not_a_program.to_string_lossy(), "status": "not_executable"},
                    {"cmd": gone.to_string_lossy(), "status": "not_found"},
                    {"cmd": "./bin/agent", "status": "unchecked"},
                ]
            })
        );
        // The counterfactual: the same script, run, leaves the marker. Checking left none.
        assert!(!ran.exists(), "checking a command must never execute it");
        assert!(
            std::process::Command::new(&installed)
                .status()
                .expect("run the fixture")
                .success()
        );
        assert!(ran.exists(), "the fixture must be able to prove it ran");
    }

    /// Under launchd the daemon's own `PATH` is `/usr/bin:/bin:…`. The Library still lists an app
    /// in `~/.opencode/bin` (detection searches there), but a run cannot start it — so the check
    /// says "outside the PATH", with where it is, rather than "not installed".
    #[tokio::test]
    async fn a_command_only_in_a_per_user_folder_is_outside_the_run_path() {
        let system = TempDirectory::new();
        let per_user = TempDirectory::new();
        create_executable(&per_user.0, "opencode");
        let run_path = std::env::join_paths([&system.0]).expect("run path");
        let detection_path =
            std::env::join_paths([&system.0, &per_user.0]).expect("detection path");
        // The production split, built directly: `router_with_path` gives both the same value.
        let router = router_with(
            system.0.clone(),
            vec!["localhost".to_owned()],
            SearchPaths {
                detection: Some(detection_path.clone()),
                run: Some(run_path),
            },
            None,
            None,
            crate::runs::RunRegistry::default(),
        )
        .expect("build API router");

        let (status, report) = get_json(&router, "/api/commands?cmd=opencode").await;
        assert_eq!(status, StatusCode::OK, "{report}");
        assert_eq!(
            report,
            json!({"commands": [{
                "cmd": "opencode",
                "status": "outside_path",
                "path": per_user.0.join("opencode").to_string_lossy(),
            }]})
        );

        // Once the daemon's own PATH has the folder, a run finds it there.
        let found = check_command(
            "opencode",
            Some(detection_path.as_os_str()),
            Some(detection_path.as_os_str()),
        );
        assert_eq!(found.status, CommandStatus::Found);
    }

    #[tokio::test]
    async fn command_check_refuses_an_unbounded_question() {
        let root = TempDirectory::new();
        let query = (0..=MAX_COMMAND_CHECKS)
            .map(|index| format!("cmd=app-{index}"))
            .collect::<Vec<_>>()
            .join("&");
        let (status, body) =
            get_json(&test_router(&root.0), &format!("/api/commands?{query}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    /// Part B root cause (b): a daemon launched without the per-user prefixes on its `PATH` finds
    /// nothing. The production router appends them; the inherited order still comes first.
    #[test]
    fn augmenting_the_search_path_adds_the_per_user_prefixes_after_the_inherited_ones() {
        let home = Path::new("/home/tester");
        let augmented = augment_search_path(Some(OsString::from("/usr/bin:/bin")), Some(home))
            .expect("augmented path");
        let directories = searched_directories(Some(augmented.as_os_str()));

        assert_eq!(directories[0], "/usr/bin");
        assert_eq!(directories[1], "/bin");
        assert!(
            directories.contains(&"/home/tester/.local/bin".to_owned()),
            "{directories:?}"
        );
        assert!(
            directories.contains(&"/home/tester/.opencode/bin".to_owned()),
            "{directories:?}"
        );
    }

    /// An operator who already put `~/.local/bin` on the `PATH` must not see it twice, and their
    /// ordering must survive.
    #[test]
    fn augmenting_the_search_path_does_not_duplicate_a_directory_already_present() {
        let home = Path::new("/home/tester");
        let augmented = augment_search_path(
            Some(OsString::from("/home/tester/.local/bin:/usr/bin")),
            Some(home),
        )
        .expect("augmented path");
        let directories = searched_directories(Some(augmented.as_os_str()));

        assert_eq!(directories[0], "/home/tester/.local/bin");
        assert_eq!(
            directories
                .iter()
                .filter(|entry| entry.as_str() == "/home/tester/.local/bin")
                .count(),
            1,
            "{directories:?}"
        );
    }

    #[tokio::test]
    async fn harness_endpoint_uses_npx_bridge_for_claude_and_codex_when_needed() {
        let directory = TempDirectory::new();
        create_executable(&directory.0, "claude");
        create_executable(&directory.0, "codex");
        create_executable(&directory.0, "npx");
        let search_path = std::env::join_paths([&directory.0]).expect("join search path");

        let harnesses = detect_harnesses(Some(search_path.as_os_str()));

        assert_eq!(harnesses.len(), 2);
        assert_eq!(harnesses[0].id, "claude");
        assert!(harnesses[0].acp_available);
        assert_eq!(harnesses[0].spawn.cmd, "npx");
        assert_eq!(
            harnesses[0].spawn.args,
            ["-y", "@agentclientprotocol/claude-agent-acp"]
        );
        assert_eq!(harnesses[1].id, "codex");
        assert!(harnesses[1].acp_available);
        assert_eq!(harnesses[1].spawn.cmd, "npx");
        assert_eq!(
            harnesses[1].spawn.args,
            ["-y", "@agentclientprotocol/codex-acp"]
        );
    }

    #[tokio::test]
    async fn harness_models_endpoint_uses_the_live_acp_catalog() {
        let directory = TempDirectory::new();
        create_executable_with_contents(
            &directory.0,
            "opencode",
            r#"#!/bin/sh
set -eu
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"catalog","configOptions":[{"id":"model","type":"select","options":[{"name":"Fast","value":"provider/fast"},{"name":"Reasoning","value":"provider/reasoning"}]}]}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'
"#,
        );
        let search_path = std::env::join_paths([&directory.0]).expect("join search path");

        let response = test_router_with_path(&directory.0, Some(search_path))
            .oneshot(
                Request::builder()
                    .uri("/api/harnesses/opencode/models")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            json!({
                "harnessId": "opencode",
                "models": [
                    {"id": "provider/fast", "name": "Fast", "thinkingEfforts": []},
                    {"id": "provider/reasoning", "name": "Reasoning", "thinkingEfforts": []}
                ]
            })
        );
    }

    /// The fake `gemini` from the field report: it initializes, then refuses `session/new` the way
    /// Gemini Code Assist refuses a client it no longer supports. Every launch is counted, so a
    /// test can prove the list itself never starts it.
    const REFUSING_GEMINI: &str = r#"#!/bin/sh
set -eu
printf 'launch\n' >> "$0.launches"
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"This client is no longer supported for Gemini Code Assist for individuals."}}'
"#;

    const ANSWERING_OPENCODE: &str = r#"#!/bin/sh
set -eu
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"catalog","configOptions":[{"id":"model","type":"select","options":[{"name":"Fast","value":"provider/fast"}]}]}}'
IFS= read -r _
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'
"#;

    async fn get_json(router: &Router, uri: &str) -> (StatusCode, Value) {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        (response.status(), response_json(response).await)
    }

    fn listed<'a>(report: &'a Value, id: &str) -> &'a Value {
        report["harnesses"]
            .as_array()
            .expect("harness list")
            .iter()
            .find(|harness| harness["id"] == id)
            .unwrap_or_else(|| panic!("{id} listed"))
    }

    /// Field report: `gemini` was on PATH, so the list said it was available and the UI offered
    /// it as ready, while every model lookup failed. The list now carries what discovery last
    /// saw — and only that: listing must not spawn anything to find out.
    #[tokio::test]
    async fn harness_list_reports_the_last_discovery_outcome_without_spawning() {
        let directory = TempDirectory::new();
        create_executable_with_contents(&directory.0, "gemini", REFUSING_GEMINI);
        create_executable_with_contents(&directory.0, "opencode", ANSWERING_OPENCODE);
        let search_path = std::env::join_paths([&directory.0]).expect("join search path");
        let router = test_router_with_path(&directory.0, Some(search_path));
        let launches = || {
            fs::read_to_string(directory.0.join("gemini.launches"))
                .map_or(0, |text| text.lines().count())
        };

        // Nothing has asked yet, so nothing is claimed either way.
        let (status, before) = get_json(&router, "/api/harnesses").await;
        assert_eq!(status, StatusCode::OK);
        for id in ["gemini", "opencode"] {
            let harness = listed(&before, id);
            assert_eq!(harness["acpAvailable"], true);
            assert!(harness.get("health").is_none(), "{id}: {harness}");
            assert!(harness.get("healthReason").is_none(), "{id}: {harness}");
        }
        assert_eq!(launches(), 0, "listing harnesses spawned one");

        let (status, refused) = get_json(&router, "/api/harnesses/gemini/models").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(
            refused["error"]
                .as_str()
                .is_some_and(|error| error.contains("no longer supported")),
            "{refused}"
        );
        let (status, _) = get_json(&router, "/api/harnesses/opencode/models").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(launches(), 1);

        let (_, after) = get_json(&router, "/api/harnesses").await;
        let gemini = listed(&after, "gemini");
        assert_eq!(
            gemini["acpAvailable"], true,
            "health never rewrites acpAvailable"
        );
        assert_eq!(gemini["health"], "error");
        assert_eq!(
            gemini["healthReason"],
            "Gemini: sign-in or version problem — run \"gemini\" in Terminal to fix"
        );
        let detail = gemini["healthDetail"].as_str().expect("health detail");
        assert!(
            detail.contains("ACP session/new failed during model discovery"),
            "{detail}"
        );
        assert!(detail.contains("no longer supported"), "{detail}");
        let opencode = listed(&after, "opencode");
        assert_eq!(opencode["health"], "ok");
        assert!(opencode.get("healthReason").is_none(), "{opencode}");
        assert!(opencode.get("healthDetail").is_none(), "{opencode}");
        assert_eq!(launches(), 1, "listing harnesses spawned one");
    }

    #[test]
    fn harness_health_expires_and_never_outlives_the_process_it_was_seen_on() {
        let harness = DetectedHarness {
            id: "gemini".to_owned(),
            name: "Gemini".to_owned(),
            command: "gemini".to_owned(),
            executable_path: "/opt/bin/gemini".to_owned(),
            acp_available: true,
            unavailable_reason: None,
            health: None,
            health_reason: None,
            health_detail: None,
            spawn: HarnessSpawn {
                cmd: "gemini".to_owned(),
                args: vec!["--acp".to_owned()],
            },
        };
        let checked_at = Instant::now();
        let records = HashMap::from([(
            "gemini".to_owned(),
            HealthRecord {
                executable_path: harness.executable_path.clone(),
                spawn: harness.spawn.clone(),
                checked_at,
                error: Some("ACP session/new failed during model discovery".to_owned()),
            },
        )]);
        let health_at = |harness: &DetectedHarness, now: Instant| {
            let mut harnesses = [harness.clone()];
            apply_harness_health(&mut harnesses, &records, now);
            harnesses[0].health
        };

        let fresh = checked_at + HARNESS_HEALTH_TTL.saturating_sub(Duration::from_secs(1));
        assert_eq!(health_at(&harness, fresh), Some(HarnessHealth::Error));
        // Past the TTL the operator may well have signed in; the harness reads as unchecked.
        assert_eq!(health_at(&harness, checked_at + HARNESS_HEALTH_TTL), None);

        let reinstalled = DetectedHarness {
            executable_path: "/usr/local/bin/gemini".to_owned(),
            ..harness.clone()
        };
        assert_eq!(health_at(&reinstalled, fresh), None);
        let other_bridge = DetectedHarness {
            spawn: HarnessSpawn {
                cmd: "npx".to_owned(),
                args: vec!["-y".to_owned(), "gemini-acp".to_owned()],
            },
            ..harness.clone()
        };
        assert_eq!(health_at(&other_bridge, fresh), None);
        let no_bridge = DetectedHarness {
            acp_available: false,
            ..harness.clone()
        };
        assert_eq!(health_at(&no_bridge, fresh), None);
    }

    #[test]
    fn health_detail_keeps_the_head_of_a_long_harness_error() {
        let long = anyhow::anyhow!("é".repeat(HEALTH_DETAIL_MAX_CHARS + 10))
            .context("ACP session/new failed during model discovery");
        let detail = health_detail(&long);
        assert_eq!(detail.chars().count(), HEALTH_DETAIL_MAX_CHARS + 1);
        assert!(detail.starts_with("ACP session/new failed during model discovery: é"));
        assert!(detail.ends_with('…'));
        assert_eq!(
            health_detail(&anyhow::anyhow!("short")),
            "short",
            "a short error is kept whole"
        );
    }

    const MEMORY_TEAM: &str = "schemaVersion: 1\nentrypoint: a\nmemory:\n  brief:\n    - path: brief/constraints.md\n    - path: brief/tone.md\n      appliesTo:\n        - b\nagents:\n  - id: a\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n  - id: b\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n";

    #[tokio::test]
    async fn memory_endpoint_reports_the_brief_with_its_scope_and_budget() {
        let directory = TempDirectory::new();
        fs::create_dir_all(directory.0.join("brief")).expect("brief dir");
        fs::write(directory.0.join("demo.yaml"), MEMORY_TEAM).expect("team");
        fs::write(
            directory.0.join("brief/constraints.md"),
            "# House constraints\nNever touch main.\n",
        )
        .expect("constraints");
        fs::write(
            directory.0.join("brief/tone.md"),
            "# Audience and tone\nBe terse.\n",
        )
        .expect("tone");

        let body = response_json(
            test_router(&directory.0)
                .oneshot(
                    Request::builder()
                        .uri("/api/memory?path=demo.yaml")
                        .header(header::HOST, "localhost")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response"),
        )
        .await;

        assert_eq!(body["enabled"], true);
        assert_eq!(body["budgetChars"], 8000);
        assert_eq!(body["deliverAs"], "native-file");
        assert_eq!(body["entries"][0]["title"], "House constraints");
        assert_eq!(body["entries"][0]["path"], "brief/constraints.md");
        assert!(body["entries"][0]["appliesTo"].is_null());
        assert_eq!(body["entries"][1]["title"], "Audience and tone");
        assert_eq!(body["entries"][1]["appliesTo"][0], "b");
        // The chip's number: only what every agent is supplied. A scoped entry is not.
        assert_eq!(
            body["usedChars"].as_u64(),
            Some("# House constraints\nNever touch main.\n".chars().count() as u64)
        );
    }

    /// A team with no `memory:` block reports an honest nothing rather than 404 — the panel is
    /// reachable before an operator has written anything, and its empty state is part of the
    /// design.
    #[tokio::test]
    async fn memory_endpoint_reports_nothing_for_a_team_without_a_block() {
        let directory = TempDirectory::new();
        fs::write(directory.0.join("demo.yaml"), VALID_TEAM).expect("team");

        let body = response_json(
            test_router(&directory.0)
                .oneshot(
                    Request::builder()
                        .uri("/api/memory?path=demo.yaml")
                        .header(header::HOST, "localhost")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(body["enabled"], false);
        assert_eq!(body["entries"], json!([]));
        assert_eq!(body["usedChars"], 0);
    }

    /// A Brief file the team names but that is not on disk would refuse the run, so the panel has
    /// to say so instead of showing a list that looks complete.
    #[tokio::test]
    async fn memory_endpoint_reports_an_unreadable_brief_rather_than_omitting_it() {
        let directory = TempDirectory::new();
        fs::write(directory.0.join("demo.yaml"), MEMORY_TEAM).expect("team");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/memory?path=demo.yaml")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = response_json(response).await;
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|error| error.contains("brief/constraints.md")),
            "{body}"
        );
    }

    #[tokio::test]
    async fn writing_a_brief_file_lands_beside_the_team_and_returns_its_row() {
        let directory = TempDirectory::new();
        fs::write(directory.0.join("demo.yaml"), VALID_TEAM).expect("team");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/memory/file")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "path": "demo.yaml",
                            "file": "brief/house-rules.md",
                            "body": "# House rules\nNever touch main.\n"
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["title"], "House rules");
        assert_eq!(body["path"], "brief/house-rules.md");
        assert_eq!(
            fs::read_to_string(directory.0.join("brief/house-rules.md")).expect("written"),
            "# House rules\nNever touch main.\n"
        );
    }

    /// The panel writes into the team's own directory and nowhere else. A traversal, an absolute
    /// path and a non-Markdown name are each refused before anything is created.
    #[tokio::test]
    async fn writing_a_brief_file_refuses_to_escape_the_team_directory() {
        let directory = TempDirectory::new();
        fs::create_dir_all(directory.0.join("teams")).expect("teams");
        fs::write(directory.0.join("teams/demo.yaml"), VALID_TEAM).expect("team");

        for file in ["../escaped.md", "/etc/escaped.md", "brief/notes.txt"] {
            let response = test_router_with_path(&directory.0.join("teams"), None)
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri("/api/memory/file")
                        .header(header::HOST, "localhost")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            json!({"path": "demo.yaml", "file": file, "body": "# X\nbody\n"})
                                .to_string(),
                        ))
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{file}");
        }
        assert!(!directory.0.join("escaped.md").exists());
        assert!(!directory.0.join("teams/brief/notes.txt").exists());
    }

    /// The sidecar keeps planned capability wiring out of `team.schema.yaml` (composer §8.2):
    /// the team file the daemon runs stays byte-identical when only the canvas changes.
    #[tokio::test]
    async fn layout_round_trips_beside_the_team_file_without_touching_it() {
        let directory = TempDirectory::new();
        let team = directory.0.join("demo.yaml");
        fs::write(&team, VALID_TEAM).expect("write team");

        let empty = response_json(
            test_router(&directory.0)
                .oneshot(
                    Request::builder()
                        .uri("/api/team/layout?path=demo.yaml")
                        .header(header::HOST, "localhost")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(
            empty,
            json!({ "version": 2, "nodes": [], "edges": [], "agents": {} })
        );

        // A version-**1** sidecar written by an earlier build: it goes in as version 1 and comes
        // back stamped forward, with its content intact and the two version-2 fields empty. That
        // is the migration path, exercised through the endpoint an operator's canvas uses.
        let version_one = json!({
            "version": 1,
            "nodes": [{ "id": "skill:notebooklm", "kind": "skill", "name": "notebooklm", "source": "Claude Code", "position": { "x": 320.0, "y": 240.0 } }],
            "edges": [{ "from": "a", "to": "skill:notebooklm" }],
        });
        let layout = json!({
            "version": 2,
            "nodes": [
                { "id": "skill:notebooklm", "kind": "skill", "name": "notebooklm", "source": "Claude Code", "position": { "x": 320.0, "y": 240.0 } },
                { "id": "knowledge:research-team-memory", "kind": "knowledge", "name": "Research team memory", "source": "LoomWatch", "position": { "x": 320.0, "y": 420.0 }, "memory": { "team": "research-team" } },
            ],
            "edges": [{ "from": "a", "to": "skill:notebooklm" }],
            "agents": { "a": { "x": 0.0, "y": 0.0 } },
        });
        let written = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team/layout")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "path": "demo.yaml", "layout": layout }).to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(written.status(), StatusCode::OK);

        assert_eq!(
            fs::read_to_string(&team).expect("team unchanged"),
            VALID_TEAM
        );
        assert!(directory.0.join("demo.layout.json").is_file());

        let read_back = response_json(
            test_router(&directory.0)
                .oneshot(
                    Request::builder()
                        .uri("/api/team/layout?path=demo.yaml")
                        .header(header::HOST, "localhost")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(read_back, layout);

        // The version-1 file reads back as version 2 with nothing lost.
        fs::write(
            directory.0.join("demo.layout.json"),
            version_one.to_string(),
        )
        .expect("write a version-1 sidecar");
        let upgraded = response_json(
            test_router(&directory.0)
                .oneshot(
                    Request::builder()
                        .uri("/api/team/layout?path=demo.yaml")
                        .header(header::HOST, "localhost")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response"),
        )
        .await;
        assert_eq!(
            upgraded,
            json!({
                "version": 2,
                "nodes": [{ "id": "skill:notebooklm", "kind": "skill", "name": "notebooklm", "source": "Claude Code", "position": { "x": 320.0, "y": 240.0 } }],
                "edges": [{ "from": "a", "to": "skill:notebooklm" }],
                "agents": {},
            })
        );
    }

    #[tokio::test]
    async fn layout_write_refuses_an_edge_to_a_capability_that_is_not_there() {
        let directory = TempDirectory::new();
        fs::write(directory.0.join("demo.yaml"), VALID_TEAM).expect("write team");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team/layout")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "path": "demo.yaml",
                            "layout": { "version": 1, "nodes": [], "edges": [{ "from": "a", "to": "skill:ghost" }] },
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!directory.0.join("demo.layout.json").exists());
    }

    /// The client never names the file it writes, so `..` in the team path cannot place a
    /// sidecar outside the teams root.
    #[tokio::test]
    async fn layout_cannot_be_written_outside_the_teams_root() {
        let directory = TempDirectory::new();
        let root = directory.0.join("teams");
        fs::create_dir(&root).expect("create teams root");
        fs::write(root.join("demo.yaml"), VALID_TEAM).expect("write team");
        fs::write(directory.0.join("outside.yaml"), VALID_TEAM).expect("write outside team");

        let response = test_router(&root)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team/layout")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "path": "../outside.yaml", "layout": { "version": 1, "nodes": [], "edges": [] } })
                            .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!directory.0.join("outside.layout.json").exists());
    }

    #[tokio::test]
    async fn schema_endpoint_returns_the_embedded_schema_as_json() {
        let directory = TempDirectory::new();
        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/config/schema")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let schema = response_json(response).await;
        assert_eq!(
            schema["$id"],
            "https://loomwatch.dev/schemas/team.schema.yaml"
        );
        assert_eq!(schema["properties"]["schemaVersion"]["const"], 1);
    }

    /// Validate a team document against the embedded schema, returning its error texts.
    fn schema_errors(document: &Value) -> Vec<String> {
        let schema: Value = serde_yaml::from_str(TEAM_SCHEMA).expect("parse embedded schema");
        let validator = jsonschema::draft202012::new(&schema).expect("compile schema");
        validator
            .iter_errors(document)
            .map(|error| error.to_string())
            .collect()
    }

    fn scheduled_document(schedule: &Value) -> Value {
        json!({
            "schemaVersion": 1,
            "id": "daily-news",
            "name": "Daily news",
            "entrypoint": "a",
            "schedule": schedule,
            "agents": [{
                "id": "a", "name": "A", "role": "collect", "model": "m",
                "spawn": {"cmd": "acp", "args": [], "env": {}, "cwd": "."}
            }],
            "edges": []
        })
    }

    #[test]
    fn team_schema_accepts_a_full_schedule_block() {
        let document = scheduled_document(&json!({
            "cron": "0 8 * * *",
            "timezone": "Asia/Singapore",
            "prompt": "Prepare the {{date}} digest.",
            "enabled": true,
            "deliver": {"notion": {"title": "News — {{date}}"}}
        }));
        assert_eq!(schema_errors(&document), Vec::<String>::new());

        let minimal = scheduled_document(&json!({"cron": "@daily", "prompt": "go"}));
        assert_eq!(schema_errors(&minimal), Vec::<String>::new());

        let mut without = scheduled_document(&Value::Null);
        without.as_object_mut().unwrap().remove("schedule");
        assert_eq!(schema_errors(&without), Vec::<String>::new());
    }

    #[test]
    fn team_schema_rejects_malformed_schedule_blocks() {
        for (schedule, expected) in [
            (json!({"prompt": "go"}), "cron"),
            (json!({"cron": "0 8 * * *"}), "prompt"),
            (json!({"cron": "0 8 * * *", "prompt": ""}), "shorter than 1"),
            (
                json!({"cron": "0 8 * * *", "prompt": "go", "enabled": "yes"}),
                "not of type",
            ),
            (
                json!({"cron": "0 8 * * *", "prompt": "go", "every": "day"}),
                "Additional properties",
            ),
            (
                json!({"cron": "0 8 * * *", "prompt": "go", "deliver": {"slack": {}}}),
                "Additional properties",
            ),
            (
                json!({"cron": "0 8 * * *", "prompt": "go", "deliver": {"notion": {"page": "x"}}}),
                "Additional properties",
            ),
        ] {
            let errors = schema_errors(&scheduled_document(&schedule));
            assert!(
                errors.iter().any(|error| error.contains(expected)),
                "{schedule}: expected an error mentioning {expected:?}, got {errors:?}"
            );
        }
    }

    #[tokio::test]
    async fn teams_endpoint_returns_root_and_sorted_relative_yaml_paths() {
        let directory = TempDirectory::new();
        let nested = directory.0.join("nested");
        fs::create_dir(&nested).expect("create nested directory");
        fs::write(directory.0.join("z.yaml"), VALID_TEAM).expect("write root team");
        fs::write(nested.join("b.yml"), VALID_TEAM).expect("write nested team");
        fs::write(nested.join("a.YAML"), VALID_TEAM).expect("write uppercase team");
        fs::write(directory.0.join("notes.txt"), "not a team").expect("write non-team file");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/teams")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(
            body["root"],
            json!(
                fs::canonicalize(&directory.0)
                    .expect("canonical teams root")
                    .to_string_lossy()
            )
        );
        assert_eq!(
            body["files"],
            json!(["nested/a.YAML", "nested/b.yml", "z.yaml"])
        );
        let summaries = body["teams"].as_array().expect("team summaries");
        assert_eq!(
            summaries
                .iter()
                .map(|team| team["path"].as_str().expect("summary path"))
                .collect::<Vec<_>>(),
            ["nested/a.YAML", "nested/b.yml", "z.yaml"]
        );
        assert!(summaries.iter().all(|team| team["agentCount"] == json!(1)));
        assert!(summaries.iter().all(|team| team["modifiedAt"].is_string()));
    }

    #[tokio::test]
    async fn teams_endpoint_names_each_team_and_skips_hidden_and_package_folders() {
        let directory = TempDirectory::new();
        fs::write(
            directory.0.join("named.yaml"),
            format!("name: '  Research desk  '\n{VALID_TEAM}"),
        )
        .expect("write named team");
        fs::write(directory.0.join("broken.yaml"), "agents: [unclosed").expect("write broken");
        fs::write(directory.0.join("notes.yaml"), "shopping:\n  - milk\n").expect("write notes");
        fs::write(
            directory.0.join("started.yaml"),
            "schemaVersion: 1\nname: Draft\n",
        )
        .expect("write unfinished team");
        for skipped in [".loomwatch/workspace", "node_modules/pkg"] {
            let folder = directory.0.join(skipped);
            fs::create_dir_all(&folder).expect("create skipped folder");
            fs::write(folder.join("stray.yaml"), VALID_TEAM).expect("write stray yaml");
        }

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/teams")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(
            body["files"],
            json!(["broken.yaml", "named.yaml", "notes.yaml", "started.yaml"])
        );
        // A file that does not parse is still listed, by path, with no invented name, and says
        // why it cannot be opened rather than passing for an unfinished team.
        assert_eq!(body["teams"][0]["path"], json!("broken.yaml"));
        assert!(body["teams"][0].get("name").is_none());
        assert_eq!(body["teams"][0]["agentCount"], json!(0));
        assert_eq!(body["teams"][0]["problem"], json!("unreadable"));
        assert_eq!(body["teams"][1]["name"], json!("Research desk"));
        assert_eq!(body["teams"][1]["agentCount"], json!(1));
        assert!(body["teams"][1].get("problem").is_none());
        assert_eq!(body["teams"][2]["problem"], json!("not_a_team"));
        // An unfinished team is still a team: no problem, zero agents.
        assert_eq!(body["teams"][3]["name"], json!("Draft"));
        assert!(body["teams"][3].get("problem").is_none());
    }

    #[tokio::test]
    async fn teams_endpoint_returns_an_empty_list_for_an_empty_root() {
        let directory = TempDirectory::new();
        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/teams")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["files"], json!([]));
    }

    #[tokio::test]
    async fn teams_endpoint_reports_a_scan_failure_after_router_construction() {
        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        let unavailable_root = directory.0.join("teams-unavailable");
        fs::create_dir(&teams_root).expect("create teams root");
        let router = test_router(&teams_root);
        fs::rename(&teams_root, &unavailable_root).expect("make teams root unavailable");

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/teams")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            response_json(response).await["error"]
                .as_str()
                .is_some_and(|error| error.starts_with("failed to discover team files:"))
        );
    }

    #[test]
    fn teams_router_rejects_a_missing_root() {
        let directory = TempDirectory::new();
        let missing = directory.0.join("missing");
        let error = router_with_path(missing, vec!["localhost".to_owned()], None)
            .expect_err("missing teams root should fail router construction");

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn teams_discovery_rejects_lexical_escape_paths() {
        let root = Path::new("/teams");
        assert_eq!(
            normalized_relative_path(root, Path::new("/teams/nested/team.yaml")),
            Some("nested/team.yaml".to_owned())
        );
        assert_eq!(
            normalized_relative_path(root, Path::new("/teams/../outside.yaml")),
            None
        );
        assert_eq!(
            normalized_relative_path(root, Path::new("/outside.yaml")),
            None
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn teams_endpoint_excludes_symlink_escapes_and_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        let outside_directory = directory.0.join("outside");
        fs::create_dir(&teams_root).expect("create teams root");
        fs::create_dir(&outside_directory).expect("create outside directory");
        let inside_file = teams_root.join("inside.yaml");
        let outside_file = outside_directory.join("outside.yaml");
        fs::write(&inside_file, VALID_TEAM).expect("write inside team");
        fs::write(&outside_file, VALID_TEAM).expect("write outside team");
        symlink(&inside_file, teams_root.join("inside-link.yaml"))
            .expect("create confined file symlink");
        symlink(&outside_file, teams_root.join("outside-link.yaml"))
            .expect("create escaping file symlink");
        symlink(&outside_directory, teams_root.join("outside-directory"))
            .expect("create escaping directory symlink");

        let response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .uri("/api/teams")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await["files"],
            json!(["inside-link.yaml", "inside.yaml"])
        );
    }

    #[tokio::test]
    async fn team_endpoint_loads_yaml_without_reformatting() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team file.yaml");
        fs::write(&path, VALID_TEAM).expect("write team file");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", path.to_str().expect("UTF-8 path"))
            .finish();

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["yaml"], VALID_TEAM);
    }

    #[tokio::test]
    async fn team_endpoint_atomically_replaces_valid_yaml_byte_for_byte() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team.yaml");
        fs::write(&path, "old contents\n").expect("write original file");
        let body = serde_json::to_vec(&TeamFile {
            path: path.clone(),
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(
                        header::IF_MATCH,
                        format!("\"{}\"", revision(b"old contents\n")),
                    )
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fs::read_to_string(&path).expect("read saved file"),
            VALID_TEAM
        );
        let entries = fs::read_dir(&directory.0)
            .expect("read team directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect team directory");
        assert_eq!(entries.len(), 1, "temporary file should be renamed away");
        assert_eq!(entries[0].path(), path);
        assert_eq!(response_json(response).await["yaml"], VALID_TEAM);
    }

    async fn save_request(router: Router, condition: Option<(&str, &str)>, yaml: &str) -> Response {
        let mut request = Request::builder()
            .method("PUT")
            .uri("/api/team")
            .header(header::HOST, "localhost")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some((name, value)) = condition {
            request = request.header(name, value);
        }
        router
            .oneshot(
                request
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "path": "team.yaml", "yaml": yaml
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn conditional_saves_reject_stale_and_missing_revisions_without_writing() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team.yaml");
        fs::write(&path, VALID_TEAM).unwrap();
        let router = test_router(&directory.0);
        let original = format!("\"{}\"", revision(VALID_TEAM.as_bytes()));
        let changed = format!("{VALID_TEAM}\n# first editor\n");
        assert_eq!(
            save_request(router.clone(), None, &changed).await.status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        let response = save_request(router.clone(), Some(("if-match", &original)), &changed).await;
        assert_eq!(response.status(), StatusCode::OK);
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_owned();
        let body = response_json(response).await;
        assert_eq!(etag, format!("\"{}\"", body["revision"].as_str().unwrap()));
        assert_eq!(body["revision"], revision(changed.as_bytes()));
        assert_eq!(
            save_request(router.clone(), Some(("if-match", &original)), VALID_TEAM)
                .await
                .status(),
            StatusCode::PRECONDITION_FAILED
        );
        assert_eq!(
            save_request(router, Some(("if-none-match", "*")), VALID_TEAM)
                .await
                .status(),
            StatusCode::PRECONDITION_FAILED
        );
        assert_eq!(fs::read_to_string(path).unwrap(), changed);
    }

    #[tokio::test]
    async fn concurrent_creates_and_updates_have_only_one_winner() {
        let directory = TempDirectory::new();
        let router = test_router(&directory.0);
        let (first, second) = tokio::join!(
            save_request(router.clone(), Some(("if-none-match", "*")), VALID_TEAM),
            save_request(router.clone(), Some(("if-none-match", "*")), VALID_TEAM)
        );
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::PRECONDITION_FAILED);
        let original = format!("\"{}\"", revision(VALID_TEAM.as_bytes()));
        let changed = format!("{VALID_TEAM}\n# changed\n");
        let (first, second) = tokio::join!(
            save_request(router.clone(), Some(("if-match", &original)), &changed),
            save_request(router, Some(("if-match", &original)), VALID_TEAM)
        );
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::PRECONDITION_FAILED);
        assert_eq!(
            fs::read_to_string(directory.0.join("team.yaml")).unwrap(),
            changed
        );
    }

    #[test]
    fn revision_is_sha256_over_exact_bytes() {
        assert_eq!(
            revision(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(revision(b"abc"), revision(b"abc\n"));
    }

    #[tokio::test]
    async fn team_endpoint_rejects_parent_traversal_outside_root() {
        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside_path = directory.0.join("outside.yaml");
        fs::write(&outside_path, "do not replace").expect("write outside file");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", "../outside.yaml")
            .finish();
        let get_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(get_response.status(), StatusCode::FORBIDDEN);

        let body = serde_json::to_vec(&TeamFile {
            path: PathBuf::from("../outside.yaml"),
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");

        let response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            fs::read_to_string(outside_path).expect("read outside file"),
            "do not replace"
        );
    }

    #[tokio::test]
    async fn team_endpoint_rejects_absolute_path_outside_root() {
        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside_path = directory.0.join("outside.yaml");
        fs::write(&outside_path, VALID_TEAM).expect("write outside file");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", outside_path.to_str().expect("UTF-8 path"))
            .finish();

        let response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let body = serde_json::to_vec(&TeamFile {
            path: outside_path.clone(),
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");
        let put_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(put_response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            fs::read_to_string(outside_path).expect("read outside file"),
            VALID_TEAM
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn team_endpoint_rejects_symlink_escape_after_resolution() {
        use std::os::unix::fs::symlink;

        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside_path = directory.0.join("outside.yaml");
        fs::write(&outside_path, "do not replace").expect("write outside file");
        let link_path = teams_root.join("team.yaml");
        symlink(&outside_path, &link_path).expect("create symlink");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", link_path.to_str().expect("UTF-8 path"))
            .finish();

        let get_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(get_response.status(), StatusCode::FORBIDDEN);

        let body = serde_json::to_vec(&TeamFile {
            path: link_path,
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");
        let put_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(put_response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            fs::read_to_string(outside_path).expect("read outside file"),
            "do not replace"
        );
    }

    #[tokio::test]
    async fn api_rejects_a_host_outside_the_allowlist() {
        let directory = TempDirectory::new();
        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/config/schema")
                    .header(header::HOST, "rebound.example:3000")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn invalid_save_does_not_replace_the_existing_file() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team.yaml");
        fs::write(&path, VALID_TEAM).expect("write original team");
        let body = serde_json::to_vec(&TeamFile {
            path: path.clone(),
            yaml: "schemaVersion: 2\n".to_owned(),
        })
        .expect("serialize request");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            fs::read_to_string(path).expect("read original file"),
            VALID_TEAM
        );
        assert!(
            response_json(response).await["error"]
                .as_str()
                .is_some_and(|error| error.contains("invalid team YAML"))
        );
    }

    // ───────────────────────────────────────────────────────────────────────────────────────────
    // Deleting a team
    // ───────────────────────────────────────────────────────────────────────────────────────────

    const TRIP_TEAM: &str = "schemaVersion: 1\nid: trip\nname: Trip planner\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n";

    fn router_with_runs(teams_root: &Path, runs: crate::runs::RunRegistry) -> Router {
        router_with(
            teams_root.to_path_buf(),
            vec!["localhost".to_owned()],
            SearchPaths {
                detection: None,
                run: None,
            },
            None,
            None,
            runs,
        )
        .expect("build API router")
    }

    async fn delete_request(router: Router, path: &str) -> Response {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", path)
            .finish();
        router
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response")
    }

    async fn error_text(response: Response) -> String {
        response_json(response).await["error"]
            .as_str()
            .expect("error message")
            .to_owned()
    }

    /// A team on disk is its YAML, its layout sidecar and its own Brief folder. Deleting it moves
    /// all three out of the list together, erases nothing, and leaves every other team alone.
    #[tokio::test]
    async fn delete_moves_the_team_with_its_layout_and_brief_into_the_trash() {
        let root = TempDirectory::new();
        fs::write(root.0.join("trip.yaml"), TRIP_TEAM).expect("write team");
        fs::write(root.0.join("trip.layout.json"), "{}").expect("write layout");
        fs::create_dir(root.0.join("trip.brief")).expect("create Brief folder");
        fs::write(root.0.join("trip.brief/style.md"), "# Style\n").expect("write Brief");
        fs::write(root.0.join("other.yaml"), VALID_TEAM).expect("write other team");
        fs::write(root.0.join("other.layout.json"), "{}").expect("write other layout");

        let response = delete_request(test_router(&root.0), "trip.yaml").await;
        assert_eq!(response.status(), StatusCode::OK);
        let deleted: DeletedTeam =
            serde_json::from_value(response_json(response).await).expect("deleted team");
        assert_eq!(deleted.path, "trip.yaml");
        assert_eq!(deleted.name.as_deref(), Some("Trip planner"));
        assert_eq!(
            deleted.moved,
            ["trip.brief", "trip.layout.json", "trip.yaml"]
        );
        assert!(
            deleted.trash.starts_with(".trash/") && deleted.trash.ends_with("-trip"),
            "{}",
            deleted.trash
        );

        let folder = root.0.join(&deleted.trash);
        assert_eq!(
            fs::read_to_string(folder.join("trip.yaml")).expect("trashed team"),
            TRIP_TEAM
        );
        assert_eq!(
            fs::read_to_string(folder.join("trip.brief/style.md")).expect("trashed Brief"),
            "# Style\n"
        );
        assert!(folder.join("trip.layout.json").is_file());
        let manifest: DeletedTeam =
            serde_json::from_slice(&fs::read(folder.join(TRASH_MANIFEST)).expect("read manifest"))
                .expect("manifest JSON");
        assert_eq!(manifest, deleted);
        for gone in ["trip.yaml", "trip.layout.json", "trip.brief"] {
            assert!(
                fs::symlink_metadata(root.0.join(gone)).is_err(),
                "{gone} is still beside the teams"
            );
        }
        assert!(root.0.join("other.yaml").is_file());
        assert!(root.0.join("other.layout.json").is_file());

        // The list forgets the team, but remembers its name is taken.
        let listing = test_router(&root.0)
            .oneshot(
                Request::builder()
                    .uri("/api/teams")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = response_json(listing).await;
        assert_eq!(body["files"], json!(["other.yaml"]));
        assert_eq!(body["trashed"], json!(["trip.yaml"]));
    }

    #[tokio::test]
    async fn delete_is_confined_to_the_teams_the_list_shows() {
        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside = directory.0.join("outside.yaml");
        fs::write(&outside, VALID_TEAM).expect("write outside file");

        // Out of the root, lexically, absolutely, or as the root itself.
        for path in [
            "../outside.yaml",
            outside.to_str().expect("UTF-8 path"),
            ".",
        ] {
            let response = delete_request(test_router(&teams_root), path).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
        assert_eq!(
            fs::read_to_string(&outside).expect("read outside file"),
            VALID_TEAM
        );

        // Inside the root, but never a team in the list: missing, not YAML, already in the trash,
        // or part of a managed workspace.
        let kept = [
            "notes.md",
            ".trash/2026-10-01T090000Z-old/old.yaml",
            ".loomwatch/trip/a/agent.yaml",
        ];
        for file in kept {
            let path = teams_root.join(file);
            fs::create_dir_all(path.parent().expect("parent")).expect("create folder");
            fs::write(&path, VALID_TEAM).expect("write file");
        }
        for path in kept.iter().copied().chain(["missing.yaml"]) {
            let response = delete_request(test_router(&teams_root), path).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        for file in kept {
            assert!(teams_root.join(file).is_file(), "{file} was moved");
        }
        // Only the trashed team that was already there: no refusal created a folder.
        assert_eq!(
            fs::read_dir(teams_root.join(TRASH_DIR))
                .expect("trash")
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_never_follows_a_link_out_of_the_root_or_moves_half_of_one() {
        use std::os::unix::fs::symlink;

        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside = directory.0.join("outside.yaml");
        fs::write(&outside, VALID_TEAM).expect("write outside file");
        symlink(&outside, teams_root.join("escape.yaml")).expect("link out");
        fs::write(teams_root.join("real.yaml"), VALID_TEAM).expect("write team");
        symlink(teams_root.join("real.yaml"), teams_root.join("alias.yaml")).expect("link in");

        let escape = delete_request(test_router(&teams_root), "escape.yaml").await;
        assert_eq!(escape.status(), StatusCode::FORBIDDEN);
        assert!(outside.is_file());
        assert!(fs::symlink_metadata(teams_root.join("escape.yaml")).is_ok());

        let alias = delete_request(test_router(&teams_root), "alias.yaml").await;
        assert_eq!(alias.status(), StatusCode::CONFLICT);
        assert!(error_text(alias).await.contains("is a link"));
        assert!(fs::symlink_metadata(teams_root.join("alias.yaml")).is_ok());
        assert!(teams_root.join("real.yaml").is_file());

        // A `.trash` that is itself a link out of the root is never written through.
        let elsewhere = directory.0.join("elsewhere");
        fs::create_dir(&elsewhere).expect("create elsewhere");
        symlink(&elsewhere, teams_root.join(TRASH_DIR)).expect("link the trash out");
        let response = delete_request(test_router(&teams_root), "real.yaml").await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(teams_root.join("real.yaml").is_file());
        assert_eq!(fs::read_dir(&elsewhere).expect("elsewhere").count(), 0);
    }

    /// A run reads its team's files as it goes, and a waiting run is still running.
    #[tokio::test]
    async fn delete_waits_until_no_run_of_the_team_is_unfinished() {
        let root = TempDirectory::new();
        fs::write(root.0.join("trip.yaml"), TRIP_TEAM).expect("write team");
        fs::write(root.0.join("other.yaml"), VALID_TEAM).expect("write other team");
        let team = TeamConfig::parse(TRIP_TEAM).expect("team parses");
        let runs = crate::runs::RunRegistry::default();
        let queued = |path: &str| {
            crate::runs::RunRecord::queued(
                path.to_owned(),
                "Plan a week in Kyoto".to_owned(),
                &team,
                crate::runs::RunTrigger::Manual,
            )
            .expect("run record")
        };
        let mut finished = queued("trip.yaml");
        finished.status = crate::runs::RunStatus::Succeeded;
        runs.insert(finished);
        let live = queued("trip.yaml");
        runs.insert(live.clone());
        runs.insert(queued("other.yaml"));

        // Refused however the path is spelled.
        let absolute = root.0.join("trip.yaml");
        for path in ["trip.yaml", absolute.to_str().expect("UTF-8 path")] {
            let refused = delete_request(router_with_runs(&root.0, runs.clone()), path).await;
            assert_eq!(refused.status(), StatusCode::CONFLICT, "{path}");
            assert!(error_text(refused).await.contains("running right now"));
            assert!(root.0.join("trip.yaml").is_file());
        }

        assert!(matches!(
            runs.cancel(&live.run_id),
            crate::runs::CancelOutcome::Cancelled(_)
        ));
        let response = delete_request(router_with_runs(&root.0, runs), "trip.yaml").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!root.0.join("trip.yaml").exists());
    }

    /// Inheritance is by id, and the memory index does not look in the trash, so deleting a team
    /// another one inherits from would stop that team from running.
    #[tokio::test]
    async fn delete_refuses_a_team_whose_memory_another_team_inherits() {
        let root = TempDirectory::new();
        fs::write(root.0.join("trip.yaml"), TRIP_TEAM).expect("write team");
        let borrower = "schemaVersion: 1\nid: japan\nname: Japan trip\nentrypoint: a\nmemory:\n  inherits:\n    - team: trip\nagents:\n  - id: a\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n";
        fs::write(root.0.join("japan.yaml"), borrower).expect("write borrower");

        let refused = delete_request(test_router(&root.0), "trip.yaml").await;
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        assert!(
            error_text(refused)
                .await
                .starts_with("Japan trip reads this team's memory.")
        );
        assert!(root.0.join("trip.yaml").is_file());

        // A memory block that is switched off reads nothing.
        fs::write(
            root.0.join("japan.yaml"),
            borrower.replace("memory:\n", "memory:\n  enabled: false\n"),
        )
        .expect("switch the borrower's memory off");
        let response = delete_request(test_router(&root.0), "trip.yaml").await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    /// `trip.yaml` and `trip.yml` resolve to the same `trip.layout.json` and `trip.brief/`, so
    /// deleting one leaves them for the other.
    #[tokio::test]
    async fn delete_leaves_sidecars_a_same_named_team_still_uses() {
        let root = TempDirectory::new();
        fs::write(root.0.join("trip.yaml"), TRIP_TEAM).expect("write team");
        fs::write(root.0.join("trip.yml"), VALID_TEAM).expect("write sibling");
        fs::write(root.0.join("trip.layout.json"), "{}").expect("write layout");
        fs::create_dir(root.0.join("trip.brief")).expect("create Brief folder");

        let response = delete_request(test_router(&root.0), "trip.yaml").await;
        assert_eq!(response.status(), StatusCode::OK);
        let deleted: DeletedTeam =
            serde_json::from_value(response_json(response).await).expect("deleted team");
        assert_eq!(deleted.moved, ["trip.yaml"]);
        assert!(root.0.join("trip.yml").is_file());
        assert!(root.0.join("trip.layout.json").is_file());
        assert!(root.0.join("trip.brief").is_dir());
    }

    #[test]
    fn two_deletions_in_one_second_get_a_folder_each() {
        let directory = TempDirectory::new();
        let root = fs::canonicalize(&directory.0).expect("canonical root");
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-01T09:00:00Z")
            .expect("timestamp")
            .with_timezone(&chrono::Utc);
        let folders = (0..2)
            .map(|_| {
                fs::write(root.join("trip.yaml"), TRIP_TEAM).expect("write team");
                move_team_to_trash(&root, &root.join("trip.yaml"), "trip.yaml", None, now)
                    .expect("move to trash")
                    .trash
            })
            .collect::<Vec<_>>();
        assert_eq!(
            folders,
            [
                ".trash/2026-10-01T090000Z-trip",
                ".trash/2026-10-01T090000Z-trip-2"
            ]
        );
        assert_eq!(trashed_team_paths(&root), ["trip.yaml"]);
    }
}
