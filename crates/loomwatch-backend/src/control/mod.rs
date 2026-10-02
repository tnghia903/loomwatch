//! Ask `LoomWatch` (ADR 0033): your own AI app builds and runs teams, and you keep the decisions.
//!
//! Two pieces live here. **`LoomWatch` Control** is an MCP tool server at `/api/control/mcp`: it
//! reads teams and runs, and it *proposes* — a team file, a run, a review note — but writes no team
//! file and answers no review stop. **Ask conversations** are what the Ask panel talks to: one of the
//! person's own AI apps, started over ACP outside any run, kept open across turns, archived as its
//! own session, and handed the tool server at `session/new` the way every run agent is handed the
//! Team Bus.
//!
//! Everything a tool proposes is archived into the asking conversation as a `session_meta` event,
//! so the panel renders it from the same stream as the app's own words and tool calls, and a
//! reload shows exactly what was proposed.

mod connect;
mod mcp;
#[cfg(test)]
mod tests;

pub use connect::{TOKEN_VARIABLE, bridge};

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path as RoutePath, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, mpsc};

use crate::EventKind;
use crate::acp::{AcpProcess, EventLog, ProcessSpec, TeamSessionContext};
use crate::archive::EventArchive;
use crate::delivery::{DeliveredTool, Permission, Transport};
use crate::runs::RunRegistry;
use crate::watch_api::local_evidence;

/// The MCP server name every app lists the tools under: Claude Code's `mcp__loomwatch__*`.
pub(crate) const SERVER_NAME: &str = "loomwatch";
/// Apps that can host the assistant: they speak ACP and accept an HTTP tool server, in the order
/// the default is chosen. `OpenClaw` cannot take HTTP MCP and pi does not speak ACP, so neither is
/// offered.
const ASK_APPS: [&str; 5] = ["claude", "codex", "gemini", "opencode", "hermes"];
/// A conversation nobody has written to for this long is closed; its transcript stays.
const IDLE_LIMIT: Duration = Duration::from_mins(20);
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest message the panel sends. Long enough for a pasted brief, short enough to refuse a
/// pasted file.
const MAX_MESSAGE_CHARS: usize = 8_000;
/// The `agentId` every event of a conversation is archived under.
pub(crate) const AGENT_ID: &str = "ask";
/// Where the assistant's app runs: a hidden, managed folder, never a team's own.
const ASK_WORKSPACE: &str = ".loomwatch/.ask";

/// What `main` hands the tool server.
pub struct ControlOptions {
    pub archive: Option<EventArchive>,
    /// The canonical teams root, the same one the editor and run control use.
    pub teams_root: PathBuf,
    pub registry: RunRegistry,
    /// The daemon's own listener, which the tool server is reached at.
    pub listen: SocketAddr,
    /// A command that replaces the detected apps as the assistant, from `LOOMWATCH_ASK_COMMAND`.
    /// For offline demos and tests: it never reaches a model provider unless it is one.
    pub ask_command: Option<Vec<String>>,
}

#[derive(Clone)]
pub struct Control {
    inner: Arc<Inner>,
}

struct Inner {
    archive: Option<EventArchive>,
    teams_root: PathBuf,
    registry: RunRegistry,
    /// `http://127.0.0.1:<port>`: what links in tool results and the tool server's URL start with.
    origin: String,
    /// Where apps are looked for, with the per-user folders `GET /api/harnesses` adds.
    search_path: Option<OsString>,
    ask_command: Option<Vec<String>>,
    /// Bearer token → who is calling.
    tokens: RwLock<BTreeMap<String, Caller>>,
    conversations: RwLock<BTreeMap<String, Arc<Conversation>>>,
    proposals: RwLock<BTreeMap<String, Proposal>>,
    /// The default model each app reported, kept for ten minutes so `list_apps` does not start
    /// every app on every call.
    models: Mutex<BTreeMap<String, (Instant, mcp::AppModels)>>,
    /// One lock per app while its models are being found, so a conversation's warm-up and its
    /// first `list_apps` start the app once between them.
    discovering: StdMutex<BTreeMap<String, Arc<Mutex<()>>>>,
    connections: connect::Connections,
}

/// Who a tool call is from.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Caller {
    /// An Ask conversation, by id.
    Conversation(String),
    /// An app the person connected from Settings, by app id.
    Connection(String),
}

/// One Ask conversation: a live session of one app, and the archive session it writes to.
struct Conversation {
    id: String,
    app: AskApp,
    token: String,
    /// The one writer for this archive session. The app's frames and the tool server's proposals
    /// both go through it, because a second writer would collide on the sequence numbers.
    event_log: EventLog,
    turns: Mutex<Option<mpsc::Sender<Turn>>>,
    status: StdMutex<ConversationStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskApp {
    id: String,
    name: String,
    /// The model the person chose for this conversation; `None` is the app's own default.
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ConversationState {
    Starting,
    Ready,
    Working,
    Ended,
    Failed,
}

#[derive(Debug, Clone)]
struct ConversationStatus {
    state: ConversationState,
    error: Option<String>,
    ask_before_run: bool,
    /// The run this conversation started last, so `get_run` without an id means "that one".
    last_run: Option<String>,
    run_requests: BTreeMap<String, RunRequest>,
}

#[derive(Debug, Clone)]
struct RunRequest {
    file: String,
    request: String,
}

/// What the person is looking at, sent with every message so the app needs no tool to find out.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskContext {
    /// `home`, `build` or `run`.
    #[serde(default)]
    view: Option<String>,
    #[serde(default)]
    team_path: Option<String>,
    #[serde(default)]
    run_id: Option<String>,
}

struct Turn {
    text: String,
    context: AskContext,
}

/// A team file the tool server was asked to propose. Never written by the tool server: the panel
/// applies it with the editor's own save, against [`Self::base_revision`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Proposal {
    id: String,
    /// The conversation id, or `connection:<app>`.
    source: String,
    file: String,
    name: String,
    is_new: bool,
    yaml: String,
    /// The file's revision when the proposal was made; `None` for a new file.
    base_revision: Option<String>,
    summary: String,
    created_at: String,
}

impl Control {
    #[must_use]
    pub fn new(options: ControlOptions) -> Self {
        let runtime_home = std::env::var_os("HOME").map(PathBuf::from);
        let search_path =
            crate::api::augment_search_path(std::env::var_os("PATH"), runtime_home.as_deref());
        Self::with_search_path(options, search_path)
    }

    /// [`Self::new`] with an explicit place to look for apps, so tests never find the real ones.
    #[must_use]
    pub fn with_search_path(options: ControlOptions, search_path: Option<OsString>) -> Self {
        let listen = if options.listen.ip().is_unspecified() {
            SocketAddr::from(([127, 0, 0, 1], options.listen.port()))
        } else {
            options.listen
        };
        let connections = connect::Connections::load(&options.teams_root);
        let control = Self {
            inner: Arc::new(Inner {
                archive: options.archive,
                teams_root: options.teams_root,
                registry: options.registry,
                origin: format!("http://{listen}"),
                search_path,
                ask_command: options.ask_command.filter(|command| !command.is_empty()),
                tokens: RwLock::default(),
                conversations: RwLock::default(),
                proposals: RwLock::default(),
                models: Mutex::default(),
                discovering: StdMutex::default(),
                connections,
            }),
        };
        control.restore_connection_tokens();
        control
    }

    /// The tool server and the Ask panel's endpoints. Loopback and same-origin only, like run
    /// control; the tool server additionally takes a bearer token.
    pub fn router(&self) -> Router {
        Router::new()
            .route("/api/control/mcp", post(mcp::post))
            .route("/api/ask/apps", get(apps))
            .route("/api/ask/conversations", post(start_conversation))
            .route(
                "/api/ask/conversations/{id}",
                get(conversation_status).delete(end_conversation),
            )
            .route("/api/ask/conversations/{id}/messages", post(send_message))
            .route(
                "/api/ask/conversations/{id}/settings",
                post(update_settings),
            )
            .route(
                "/api/ask/conversations/{id}/run-requests/{request}",
                post(decide_run_request),
            )
            .route("/api/ask/inbox", get(inbox))
            .route("/api/ask/proposals/{id}", get(get_proposal))
            .route("/api/ask/proposals/{id}/outcome", post(proposal_outcome))
            .route("/api/ask/connections", get(connect::list))
            .route(
                "/api/ask/connections/{app}",
                post(connect::connect).delete(connect::disconnect),
            )
            .route_layer(middleware::from_fn(local_evidence))
            .with_state(self.clone())
    }

    fn mcp_url(&self) -> String {
        format!("{}/api/control/mcp", self.inner.origin)
    }

    fn run_url(&self, team_path: &str, run_id: &str) -> String {
        format!(
            "{}/?path={}&run={}",
            self.inner.origin,
            encode_query(team_path),
            encode_query(run_id)
        )
    }

    async fn caller(&self, token: &str) -> Option<Caller> {
        self.inner.tokens.read().await.get(token).cloned()
    }

    async fn conversation(&self, id: &str) -> Option<Arc<Conversation>> {
        self.inner.conversations.read().await.get(id).cloned()
    }

    /// Archive a `LoomWatch`-authored event into a conversation, under the conversation's one
    /// writer. Failures are logged rather than returned: a proposal the panel cannot show is a
    /// worse outcome than a missing line in the transcript, and the tool result still says it.
    async fn record(&self, caller: &Caller, phase: &str, mut payload: Value) {
        if let Some(object) = payload.as_object_mut() {
            object.insert("phase".to_owned(), json!(phase));
        }
        let log = match caller {
            Caller::Conversation(id) => self
                .conversation(id)
                .await
                .map(|item| item.event_log.clone()),
            Caller::Connection(app) => {
                self.inner.connections.remember(app, &payload);
                self.inner.connections.event_log(app, self.archive())
            }
        };
        let Some(log) = log else { return };
        if let Err(error) = log
            .append(
                AGENT_ID,
                EventKind::SessionMeta,
                payload,
                Some(json!({"source": "loomwatch", "phase": phase})),
            )
            .await
        {
            eprintln!("warning: could not record {phase} for Ask: {error:#}");
        }
    }

    fn archive(&self) -> Option<&EventArchive> {
        self.inner.archive.as_ref()
    }

    fn restore_connection_tokens(&self) {
        let tokens = self.inner.connections.tokens();
        let inner = Arc::clone(&self.inner);
        // The listener is not serving yet, so nothing can race this write.
        if let Ok(mut map) = inner.tokens.try_write() {
            for (app, token) in tokens {
                map.insert(token, Caller::Connection(app));
            }
        }
    }
}

/// A random bearer token: two v4 UUIDs, 244 random bits.
fn new_token() -> String {
    format!(
        "lw_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({"error": message.into()}))).into_response()
}

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The apps found here that can host the assistant, in the order the default is chosen.
fn ask_apps(control: &Control) -> Vec<crate::api::DetectedHarness> {
    if let Some(command) = &control.inner.ask_command {
        return vec![crate::api::DetectedHarness {
            id: "custom".to_owned(),
            name: "Offline assistant".to_owned(),
            command: command[0].clone(),
            executable_path: command[0].clone(),
            acp_available: true,
            unavailable_reason: None,
            health: None,
            health_reason: None,
            health_detail: None,
            spawn: crate::api::HarnessSpawn {
                cmd: command[0].clone(),
                args: command[1..].to_vec(),
            },
        }];
    }
    let detected = crate::api::detect_harnesses(control.inner.search_path.as_deref());
    ASK_APPS
        .iter()
        .filter_map(|id| detected.iter().find(|app| app.id == *id).cloned())
        .collect()
}

async fn apps(State(control): State<Control>) -> Json<Value> {
    let apps = ask_apps(&control);
    let default = apps
        .iter()
        .find(|app| app.acp_available)
        .map(|app| app.id.clone());
    Json(json!({
        "apps": apps.iter().map(|app| json!({
            "id": app.id,
            "name": app.name,
            "available": app.acp_available,
            "reason": app.unavailable_reason,
        })).collect::<Vec<_>>(),
        "defaultApp": default,
    }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartConversation {
    #[serde(default)]
    app: Option<String>,
    /// A model id from the app's own list; empty or absent uses the app's default.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    ask_before_run: Option<bool>,
}

/// The longest model id the panel may name. Real ids are a few dozen characters; this only keeps a
/// pasted paragraph out of the app's `session/set_model`.
const MAX_MODEL_CHARS: usize = 200;

/// The chosen model, trimmed, or `None` for the app's default. A model that can't be an id is
/// refused here rather than handed to the app.
fn chosen_model(model: Option<&str>) -> Result<Option<String>, String> {
    let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) else {
        return Ok(None);
    };
    if model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control) {
        return Err(
            "That isn't a model this app lists. Choose one from the list, or its default."
                .to_owned(),
        );
    }
    Ok(Some(model.to_owned()))
}

/// The app the person asked for, or the first one here that can run Ask; why not, in plain words.
fn chosen_app<'a>(
    apps: &'a [crate::api::DetectedHarness],
    requested: Option<&str>,
) -> Result<&'a crate::api::DetectedHarness, String> {
    let chosen = match requested {
        Some(id) => Some(apps.iter().find(|app| app.id == id).ok_or_else(|| {
            format!("{id} isn't an AI app Ask can use on this computer. Choose another app.")
        })?),
        None => apps.iter().find(|app| app.acp_available),
    };
    let Some(app) = chosen else {
        return Err(
            "No AI app that can run Ask was found on this computer. Install and sign in to Claude \
             Code, Codex, Gemini CLI or OpenCode, then start LoomWatch again from a terminal where \
             it works."
                .to_owned(),
        );
    };
    if !app.acp_available {
        return Err(format!(
            "{} can't run Ask here: {}",
            app.name,
            app.unavailable_reason.clone().unwrap_or_default()
        ));
    }
    Ok(app)
}

async fn start_conversation(
    State(control): State<Control>,
    body: Option<Json<StartConversation>>,
) -> Response {
    let request = body.map(|Json(body)| body).unwrap_or_default();
    let Some(archive) = control.inner.archive.clone() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            crate::watch_api::ARCHIVE_DISABLED_MESSAGE,
        );
    };
    let model = match chosen_model(request.model.as_deref()) {
        Ok(model) => model,
        Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
    };
    let apps = ask_apps(&control);
    let app = match chosen_app(&apps, request.app.as_deref()) {
        Ok(app) => app,
        Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
    };
    let workspace = match prepare_workspace(&control.inner.teams_root) {
        Ok(path) => path,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
    };
    let id = format!("ask-{}", uuid::Uuid::new_v4());
    let token = new_token();
    let conversation = Arc::new(Conversation {
        id: id.clone(),
        app: AskApp {
            id: app.id.clone(),
            name: app.name.clone(),
            model,
        },
        token: token.clone(),
        event_log: EventLog::new(archive, id.clone()),
        turns: Mutex::new(None),
        status: StdMutex::new(ConversationStatus {
            state: ConversationState::Starting,
            error: None,
            ask_before_run: request.ask_before_run.unwrap_or(true),
            last_run: None,
            run_requests: BTreeMap::new(),
        }),
    });
    let spec = assistant_spec(&control, app, workspace, &token);
    control
        .inner
        .tokens
        .write()
        .await
        .insert(token, Caller::Conversation(id.clone()));
    control
        .inner
        .conversations
        .write()
        .await
        .insert(id.clone(), Arc::clone(&conversation));
    let (sender, receiver) = mpsc::channel(4);
    *conversation.turns.lock().await = Some(sender);
    control
        .record(
            &Caller::Conversation(id.clone()),
            "ask_status",
            json!({"state": "starting", "app": conversation.app}),
        )
        .await;
    let model = conversation.app.model.clone();
    tokio::spawn(converse(control.clone(), conversation, spec, receiver));
    // Most first requests are "make me a team", which needs every app's models; finding them
    // starts each app, so it begins now rather than when the assistant first asks.
    let warm = control.clone();
    tokio::spawn(async move { mcp::warm_models(&warm).await });
    (
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "app": app.id,
            "appName": app.name,
            "model": model,
            "state": "starting",
        })),
    )
        .into_response()
}

/// How the assistant's app is started: the detected command, resolved to a path so it starts with
/// the daemon's own `PATH`, in the managed folder, carrying the tool server as its one wired tool.
fn assistant_spec(
    control: &Control,
    app: &crate::api::DetectedHarness,
    workspace: PathBuf,
    token: &str,
) -> ProcessSpec {
    let command = control
        .inner
        .search_path
        .as_deref()
        .and_then(|path| crate::api::find_executable(path, &app.spawn.cmd))
        .map_or_else(
            || app.spawn.cmd.clone(),
            |path| path.to_string_lossy().into_owned(),
        );
    ProcessSpec {
        cmd: command,
        args: app.spawn.args.clone(),
        env: BTreeMap::new(),
        cwd: workspace,
        tools: vec![control_tool(&control.mcp_url(), token)],
    }
}

/// The assistant's working folder: hidden, managed, and never a team's. Its Claude settings allow
/// exactly the `LoomWatch` tools and deny shell, file edits and the web, because Claude's ACP adapter
/// runs tools without asking (ADR 0033).
fn prepare_workspace(teams_root: &Path) -> Result<PathBuf, String> {
    let workspace = teams_root.join(ASK_WORKSPACE);
    let settings = workspace.join(".claude");
    std::fs::create_dir_all(&settings)
        .map_err(|error| format!("could not prepare the Ask folder: {error}"))?;
    let rules = json!({
        "permissions": {
            "allow": [format!("mcp__{SERVER_NAME}")],
            "deny": ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]
        }
    });
    let text = serde_json::to_string_pretty(&rules).unwrap_or_default();
    std::fs::write(settings.join("settings.json"), text)
        .map_err(|error| format!("could not prepare the Ask folder: {error}"))?;
    Ok(workspace)
}

/// The tool server, as the one wired tool an Ask session carries.
fn control_tool(url: &str, token: &str) -> DeliveredTool {
    DeliveredTool {
        name: "LoomWatch Control".to_owned(),
        server: SERVER_NAME.to_owned(),
        provider: "LoomWatch".to_owned(),
        config_path: String::new(),
        transport: Transport::Http,
        env_names: Vec::new(),
        header_names: vec!["Authorization".to_owned()],
        permission: Permission::Granted,
        server_definition: json!({
            "type": "http",
            "name": SERVER_NAME,
            "url": url,
            "headers": [{"name": "Authorization", "value": format!("Bearer {token}")}]
        }),
    }
}

/// One conversation's life: start the app, take turns until it goes quiet or is ended, close it.
async fn converse(
    control: Control,
    conversation: Arc<Conversation>,
    spec: ProcessSpec,
    mut turns: mpsc::Receiver<Turn>,
) {
    let caller = Caller::Conversation(conversation.id.clone());
    let Some(archive) = control.inner.archive.clone() else {
        return;
    };
    let mut context = TeamSessionContext {
        archive: &archive,
        exit_timeout: EXIT_TIMEOUT,
        bus: None,
        event_log: Some(conversation.event_log.clone()),
        packet: None,
        composed: None,
        boundary: None,
    };
    let process = match AcpProcess::spawn(&spec) {
        Ok(process) => process.approving_tools_of(SERVER_NAME),
        Err(failure) => {
            let message = format!(
                "{} could not start: {failure}. Check that it works in a terminal, then try again.",
                conversation.app.name
            );
            fail(&control, &conversation, &message).await;
            return;
        }
    };
    let mut process = process;
    let model = conversation.app.model.as_deref().unwrap_or_default();
    let mut recorder = match process.open_live(AGENT_ID, model, &mut context).await {
        Ok(recorder) => recorder,
        Err(failure) => {
            let reason = first_line(&format!("{failure:#}"));
            // A model the app turned down is the person's choice to change, so say so.
            let message = if reason.contains("rejected configured model") {
                format!(
                    "{} wouldn't use {model}: {reason}. Choose another model, or its default.",
                    conversation.app.name
                )
            } else {
                format!(
                    "{} started but did not answer LoomWatch: {reason}",
                    conversation.app.name
                )
            };
            fail(&control, &conversation, &message).await;
            return;
        }
    };
    // A message sent while the app was starting is already queued and the conversation already
    // says it is working; only a conversation still starting becomes ready here.
    if lock(&conversation.status).state == ConversationState::Starting {
        set_state(&control, &conversation, ConversationState::Ready).await;
    }
    let mut first = true;
    loop {
        let Ok(Some(turn)) = tokio::time::timeout(IDLE_LIMIT, turns.recv()).await else {
            break;
        };
        let prompt = compose_prompt(&control, &turn, first);
        first = false;
        control
            .record(
                &caller,
                "ask_message",
                json!({"text": turn.text, "context": turn.context}),
            )
            .await;
        match process.prompt_turn(&mut recorder, &prompt).await {
            Ok(_) => set_state(&control, &conversation, ConversationState::Ready).await,
            Err(failure) => {
                let message = format!(
                    "{} stopped answering: {}",
                    conversation.app.name,
                    first_line(&format!("{failure:#}"))
                );
                fail(&control, &conversation, &message).await;
                break;
            }
        }
    }
    let _ = process
        .finish_live(&mut recorder, String::new(), &context)
        .await;
    if lock(&conversation.status).state != ConversationState::Failed {
        set_state(&control, &conversation, ConversationState::Ended).await;
    }
    forget_token(&control, &conversation).await;
}

fn first_line(text: &str) -> String {
    text.lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

async fn set_state(control: &Control, conversation: &Conversation, state: ConversationState) {
    {
        let mut status = lock(&conversation.status);
        if status.state == state {
            return;
        }
        status.state = state;
    }
    control
        .record(
            &Caller::Conversation(conversation.id.clone()),
            "ask_status",
            json!({"state": state, "app": conversation.app}),
        )
        .await;
}

async fn fail(control: &Control, conversation: &Conversation, message: &str) {
    {
        let mut status = lock(&conversation.status);
        status.state = ConversationState::Failed;
        status.error = Some(message.to_owned());
    }
    control
        .record(
            &Caller::Conversation(conversation.id.clone()),
            "ask_status",
            json!({"state": "failed", "app": conversation.app, "error": message}),
        )
        .await;
    forget_token(control, conversation).await;
}

async fn forget_token(control: &Control, conversation: &Conversation) {
    control
        .inner
        .tokens
        .write()
        .await
        .remove(&conversation.token);
    *conversation.turns.lock().await = None;
}

/// What the app is told. The first turn carries the instructions; every turn says where the person
/// is, so the app never has to ask a tool for it.
fn compose_prompt(control: &Control, turn: &Turn, first: bool) -> String {
    let mut prompt = String::new();
    if first {
        prompt.push_str(mcp::INSTRUCTIONS);
        prompt.push_str("\n\n");
    }
    prompt.push_str("## Where the person is\n");
    prompt.push_str(&describe_context(control, &turn.context));
    prompt.push_str("\n\n## The person's message\n");
    prompt.push_str(turn.text.trim());
    prompt
}

fn describe_context(control: &Control, context: &AskContext) -> String {
    let team = context.team_path.as_deref().map(|path| {
        let name = crate::api::summarize_team_file(&control.inner.teams_root, path)
            .name
            .unwrap_or_else(|| path.to_owned());
        format!("the team \"{name}\" (file `{path}`)")
    });
    let run = context.run_id.as_deref().and_then(|id| {
        control.inner.registry.get(id).map(|record| {
            let waiting = record
                .waiting_on
                .as_ref()
                .and_then(|waiting| waiting.get("name").and_then(Value::as_str))
                .map(|name| format!(", waiting for the person at \"{name}\""))
                .unwrap_or_default();
            format!(
                "run `{id}`, which is {}{waiting}",
                serde_json::to_value(record.status)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default()
            )
        })
    });
    match (context.view.as_deref(), team, run) {
        (Some("run"), Some(team), Some(run)) => format!("Watching {run} of {team}."),
        (Some("run"), Some(team), None) => format!("On the Run view of {team}."),
        (_, Some(team), _) => format!("Building {team} on the canvas."),
        _ => "On Home, with no team open.".to_owned(),
    }
}

async fn conversation_status(
    State(control): State<Control>,
    RoutePath(id): RoutePath<String>,
) -> Response {
    let Some(conversation) = control.conversation(&id).await else {
        return error(StatusCode::NOT_FOUND, "This conversation has ended.");
    };
    let status = lock(&conversation.status).clone();
    Json(json!({
        "id": conversation.id,
        "app": conversation.app.id,
        "appName": conversation.app.name,
        "model": conversation.app.model,
        "state": status.state,
        "error": status.error,
        "askBeforeRun": status.ask_before_run,
        "lastRun": status.last_run,
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    text: String,
    #[serde(default)]
    context: AskContext,
}

async fn send_message(
    State(control): State<Control>,
    RoutePath(id): RoutePath<String>,
    body: Result<Json<Message>, JsonRejection>,
) -> Response {
    let Ok(Json(message)) = body else {
        return error(StatusCode::BAD_REQUEST, "Send {text, context}.");
    };
    let text = message.text.trim();
    if text.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Write a message first.");
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("Keep a message under {MAX_MESSAGE_CHARS} characters."),
        );
    }
    let Some(conversation) = control.conversation(&id).await else {
        return error(StatusCode::NOT_FOUND, "This conversation has ended.");
    };
    {
        let mut status = lock(&conversation.status);
        match status.state {
            ConversationState::Working => {
                return error(
                    StatusCode::CONFLICT,
                    format!("{} is still answering.", conversation.app.name),
                );
            }
            ConversationState::Ended | ConversationState::Failed => {
                return error(
                    StatusCode::GONE,
                    "This conversation has ended. Start a new one.",
                );
            }
            ConversationState::Starting | ConversationState::Ready => {
                status.state = ConversationState::Working;
            }
        }
    }
    let sender = conversation.turns.lock().await.clone();
    let delivered = match sender {
        Some(sender) => sender
            .send(Turn {
                text: text.to_owned(),
                context: message.context,
            })
            .await
            .is_ok(),
        None => false,
    };
    if !delivered {
        lock(&conversation.status).state = ConversationState::Ended;
        return error(
            StatusCode::GONE,
            "This conversation has ended. Start a new one.",
        );
    }
    control
        .record(
            &Caller::Conversation(id.clone()),
            "ask_status",
            json!({"state": "working", "app": conversation.app}),
        )
        .await;
    (StatusCode::ACCEPTED, Json(json!({"state": "working"}))).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    ask_before_run: bool,
}

async fn update_settings(
    State(control): State<Control>,
    RoutePath(id): RoutePath<String>,
    body: Result<Json<Settings>, JsonRejection>,
) -> Response {
    let Ok(Json(settings)) = body else {
        return error(StatusCode::BAD_REQUEST, "Send {askBeforeRun}.");
    };
    let Some(conversation) = control.conversation(&id).await else {
        return error(StatusCode::NOT_FOUND, "This conversation has ended.");
    };
    lock(&conversation.status).ask_before_run = settings.ask_before_run;
    Json(json!({"askBeforeRun": settings.ask_before_run})).into_response()
}

async fn end_conversation(
    State(control): State<Control>,
    RoutePath(id): RoutePath<String>,
) -> Response {
    let Some(conversation) = control.conversation(&id).await else {
        return StatusCode::NO_CONTENT.into_response();
    };
    // Dropping the sender ends the conversation's loop after any turn in progress.
    *conversation.turns.lock().await = None;
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunDecision {
    /// `started` (the panel started it with `POST /api/runs`) or `declined`.
    decision: String,
    #[serde(default)]
    run_id: Option<String>,
}

/// The person's answer to a run the app asked to start. The panel starts the run itself, with the
/// editor's own pinned revision; this only records the outcome so the transcript and the app know.
async fn decide_run_request(
    State(control): State<Control>,
    RoutePath((id, request_id)): RoutePath<(String, String)>,
    body: Result<Json<RunDecision>, JsonRejection>,
) -> Response {
    let Ok(Json(decision)) = body else {
        return error(StatusCode::BAD_REQUEST, "Send {decision, runId?}.");
    };
    let Some(conversation) = control.conversation(&id).await else {
        return error(StatusCode::NOT_FOUND, "This conversation has ended.");
    };
    let request = lock(&conversation.status).run_requests.remove(&request_id);
    let Some(request) = request else {
        return error(
            StatusCode::NOT_FOUND,
            "That run request was already answered.",
        );
    };
    let caller = Caller::Conversation(id);
    match (decision.decision.as_str(), decision.run_id) {
        ("started", Some(run_id)) => {
            lock(&conversation.status).last_run = Some(run_id.clone());
            control
                .record(
                    &caller,
                    "ask_run_started",
                    json!({"requestId": request_id, "runId": run_id, "file": request.file,
                           "request": request.request}),
                )
                .await;
        }
        ("declined", _) => {
            control
                .record(
                    &caller,
                    "ask_run_declined",
                    json!({"requestId": request_id, "file": request.file}),
                )
                .await;
        }
        _ => {
            lock(&conversation.status)
                .run_requests
                .insert(request_id, request);
            return error(
                StatusCode::BAD_REQUEST,
                "decision must be started (with runId) or declined.",
            );
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// What connected apps proposed or started recently, newest last, for the Ask panel to show.
async fn inbox(State(control): State<Control>) -> Json<Value> {
    Json(json!({"items": control.inner.connections.inbox()}))
}

async fn get_proposal(
    State(control): State<Control>,
    RoutePath(id): RoutePath<String>,
) -> Response {
    match control.inner.proposals.read().await.get(&id) {
        Some(proposal) => Json(proposal).into_response(),
        None => error(
            StatusCode::NOT_FOUND,
            "This proposal is no longer available. Ask again to get a new one.",
        ),
    }
}

#[derive(Debug, Deserialize)]
struct Outcome {
    /// `applied`, `discarded` or `undone`.
    outcome: String,
}

/// What the person did with a proposal, recorded so the transcript says it and the app's next
/// `read_team` is not a surprise.
async fn proposal_outcome(
    State(control): State<Control>,
    RoutePath(id): RoutePath<String>,
    body: Result<Json<Outcome>, JsonRejection>,
) -> Response {
    let Ok(Json(outcome)) = body else {
        return error(StatusCode::BAD_REQUEST, "Send {outcome}.");
    };
    if !matches!(outcome.outcome.as_str(), "applied" | "discarded" | "undone") {
        return error(
            StatusCode::BAD_REQUEST,
            "outcome must be applied, discarded or undone.",
        );
    }
    let Some(proposal) = control.inner.proposals.read().await.get(&id).cloned() else {
        return error(
            StatusCode::NOT_FOUND,
            "This proposal is no longer available.",
        );
    };
    let caller = proposal.source.strip_prefix("connection:").map_or_else(
        || Caller::Conversation(proposal.source.clone()),
        |app| Caller::Connection(app.to_owned()),
    );
    control
        .record(
            &caller,
            "ask_proposal_outcome",
            json!({"proposalId": id, "file": proposal.file, "outcome": outcome.outcome}),
        )
        .await;
    StatusCode::NO_CONTENT.into_response()
}
