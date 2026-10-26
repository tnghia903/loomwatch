//! Ask `LoomWatch` (ADR 0033): an assistant that builds and runs teams, while you keep the decisions.
//!
//! Two pieces live here. **`LoomWatch` Control** is a set of tools: they read teams and runs, and
//! they *propose* — a team file, a run, a review note — but write no team file and answer no review
//! stop. **Ask conversations** are what the Ask panel talks to: `LoomWatch`'s own agent on the
//! operator's `OpenRouter` key, outside any run, kept open across turns, archived as its own session,
//! and given the Control tools and nothing else: no files, no commands, no web.
//!
//! Everything a tool proposes is archived into the asking conversation as a `session_meta` event,
//! so the panel renders it from the same stream as the assistant's own words and tool calls, and a
//! reload shows exactly what was proposed.

mod instructions;
mod mcp;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::Duration;

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
use crate::archive::EventArchive;
use crate::engine::{AgentRun, EventLog, ProcessSpec, TeamSessionContext};
use crate::runs::RunRegistry;
use crate::watch_api::local_evidence;

/// A conversation nobody has written to for this long is closed; its transcript stays.
const IDLE_LIMIT: Duration = Duration::from_mins(20);
/// The longest message the panel sends. Long enough for a pasted brief, short enough to refuse a
/// pasted file.
const MAX_MESSAGE_CHARS: usize = 8_000;
/// The `agentId` every event of a conversation is archived under.
pub(crate) const AGENT_ID: &str = "ask";
/// Where the assistant works: a hidden, managed folder, never a team's own. It is given no file
/// tools, so nothing is written there; it is only somewhere to stand.
const ASK_WORKSPACE: &str = ".loomwatch/.ask";
/// What the assistant shows as in the panel.
const ASSISTANT_NAME: &str = "Ask LoomWatch";

/// What `main` hands Ask.
pub struct ControlOptions {
    pub archive: Option<EventArchive>,
    /// The canonical teams root, the same one the editor and run control use.
    pub teams_root: PathBuf,
    /// `LoomWatch`'s own skills folder (`capabilities::skills_folder`), which `list_skills` lists
    /// with the project's, as the Library and runs do.
    pub skills_folder: Option<PathBuf>,
    pub registry: RunRegistry,
    /// The daemon's own listener: links to runs in tool results start with it.
    pub listen: SocketAddr,
    /// A model that replaces the person's choice for every conversation, from
    /// `LOOMWATCH_ASK_MODEL`: `fake/offline` for an offline demo.
    pub ask_model: Option<String>,
}

#[derive(Clone)]
pub struct Control {
    inner: Arc<Inner>,
}

struct Inner {
    archive: Option<EventArchive>,
    teams_root: PathBuf,
    skills_folder: Option<PathBuf>,
    registry: RunRegistry,
    /// `http://127.0.0.1:<port>`: what links in tool results start with.
    origin: String,
    ask_model: Option<String>,
    conversations: RwLock<BTreeMap<String, Arc<Conversation>>>,
    proposals: RwLock<BTreeMap<String, Proposal>>,
}

/// Who a tool call is from: an Ask conversation, by id.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Caller {
    Conversation(String),
}

/// One Ask conversation: a live session of the assistant, and the archive session it writes to.
struct Conversation {
    id: String,
    app: AskApp,
    /// The one writer for this archive session. The assistant's events and the tools' proposals
    /// both go through it, because a second writer would collide on the sequence numbers.
    event_log: EventLog,
    turns: Mutex<Option<mpsc::Sender<Turn>>>,
    status: StdMutex<ConversationStatus>,
}

/// What the panel shows the assistant as, and the model it runs on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskApp {
    id: String,
    name: String,
    /// The model this conversation runs on: the person's choice, or the default.
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
        let listen = if options.listen.ip().is_unspecified() {
            SocketAddr::from(([127, 0, 0, 1], options.listen.port()))
        } else {
            options.listen
        };
        Self {
            inner: Arc::new(Inner {
                archive: options.archive,
                teams_root: options.teams_root,
                skills_folder: options.skills_folder,
                registry: options.registry,
                origin: format!("http://{listen}"),
                ask_model: options
                    .ask_model
                    .map(|model| model.trim().to_owned())
                    .filter(|model| !model.is_empty()),
                conversations: RwLock::default(),
                proposals: RwLock::default(),
            }),
        }
    }

    /// The Ask panel's endpoints. Loopback and same-origin only, like run control.
    pub fn router(&self) -> Router {
        Router::new()
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
            .route("/api/ask/instructions", post(instructions::rewrite))
            .route("/api/ask/proposals/{id}", get(get_proposal))
            .route("/api/ask/proposals/{id}/outcome", post(proposal_outcome))
            .route_layer(middleware::from_fn(local_evidence))
            .with_state(self.clone())
    }

    fn run_url(&self, team_path: &str, run_id: &str) -> String {
        run_address(&self.inner.origin, team_path, run_id)
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
        let Caller::Conversation(id) = caller;
        let Some(log) = self
            .conversation(id)
            .await
            .map(|item| item.event_log.clone())
        else {
            return;
        };
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

    /// The model a conversation runs on: the offline override, the person's choice, or the default.
    fn model_for(&self, chosen: Option<String>) -> String {
        self.inner
            .ask_model
            .clone()
            .or(chosen)
            .unwrap_or_else(|| tier_model("strong"))
    }
}

/// The model `tier` runs on, paid by a connected plan that offers it, else `OpenRouter` (ADR 0073,
/// `ModelTiers::model_on`); `OpenRouter`'s when nothing says.
pub(crate) fn tier_model(tier: &str) -> String {
    use crate::ai::{ModelRef, Source};
    let Some(ai) = crate::ai::installed() else {
        return crate::ai::MODEL_TIERS.model_on(tier, &[], &|_| true);
    };
    let claude = ai.claude_status();
    let plan = ai.chatgpt_status();
    // A plan whose list isn't known yet is taken to offer its maker's models.
    let offers = |model: &ModelRef| match model.source {
        Source::Anthropic => {
            claude.models.is_empty() || claude.models.iter().any(|known| known.id == model.id)
        }
        Source::ChatGpt => {
            plan.models.is_empty() || plan.models.iter().any(|known| known.slug == model.id)
        }
        Source::OpenRouter => true,
    };
    crate::ai::MODEL_TIERS.model_on(tier, &ai.connected_sources(), &offers)
}

/// Where a run opens in the app: its team's page on that run, or, for a run of an agent's own chat
/// (`.jobs/.bench/<id>.yaml`), that agent's chat in My agents with the run's Details beside it, as
/// the app's own links (`historyRunUrl` in ui/src/lib/runs/history.ts) open it.
fn run_address(origin: &str, team_path: &str, run_id: &str) -> String {
    match crate::jobs::chat_of(team_path) {
        Some(agent) => format!(
            "{origin}/agents/{}?view=chat&run={}",
            encode_query(agent),
            encode_query(run_id)
        ),
        None => format!(
            "{origin}/?path={}&run={}",
            encode_query(team_path),
            encode_query(run_id)
        ),
    }
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartConversation {
    /// An `OpenRouter` model id; empty or absent uses the default model.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    ask_before_run: Option<bool>,
}

/// The longest model id the panel may name. Real ids are a few dozen characters; this only keeps a
/// pasted paragraph out of a request to the provider.
const MAX_MODEL_CHARS: usize = 200;

/// The chosen model, trimmed, or `None` for the default. A model that can't be an id is refused
/// here rather than sent to the provider.
fn chosen_model(model: Option<&str>) -> Result<Option<String>, String> {
    let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) else {
        return Ok(None);
    };
    if model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control) {
        return Err("That isn't a model id. Choose a model from the list.".to_owned());
    }
    Ok(Some(model.to_owned()))
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
        Ok(model) => control.model_for(model),
        Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
    };
    let workspace = match prepare_workspace(&control.inner.teams_root) {
        Ok(path) => path,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
    };
    let id = format!("ask-{}", uuid::Uuid::new_v4());
    let conversation = Arc::new(Conversation {
        id: id.clone(),
        app: AskApp {
            id: "loomwatch".to_owned(),
            name: ASSISTANT_NAME.to_owned(),
            model: Some(model),
        },
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
    let spec = ask_spec(workspace);
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
    (
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "app": "loomwatch",
            "appName": ASSISTANT_NAME,
            "model": model,
            "state": "starting",
        })),
    )
        .into_response()
}

/// How the assistant runs: in the managed folder, with no permissions to ask for anything. Its
/// only tools are the Control tools ([`mcp::ControlTools`]).
pub(crate) fn ask_spec(workspace: PathBuf) -> ProcessSpec {
    ProcessSpec {
        cmd: String::new(),
        args: Vec::new(),
        env: BTreeMap::new(),
        cwd: workspace,
        tools: Vec::new(),
        permissions: None,
        asker: None,
        lessons: Vec::new(),
        pictures: Vec::new(),
    }
}

/// The assistant's working folder: hidden, managed, and never a team's.
pub(crate) fn prepare_workspace(teams_root: &Path) -> Result<PathBuf, String> {
    let workspace = teams_root.join(ASK_WORKSPACE);
    std::fs::create_dir_all(&workspace)
        .map_err(|error| format!("could not prepare the Ask folder: {error}"))?;
    Ok(workspace)
}

/// One conversation's life: open the session, take turns until it goes quiet or is ended, close it.
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
        bus: None,
        event_log: Some(conversation.event_log.clone()),
        packet: None,
        composed: None,
        boundary: None,
    };
    let tools = Arc::new(mcp::ControlTools::new(control.clone(), caller.clone()));
    let mut process = match AgentRun::spawn(&spec) {
        Ok(process) => process.with_host_tools(tools),
        Err(failure) => {
            fail(
                &control,
                &conversation,
                &format!("Ask couldn't start: {failure}"),
            )
            .await;
            return;
        }
    };
    let model = conversation.app.model.as_deref().unwrap_or_default();
    let mut recorder = match process.open_live(AGENT_ID, model, &mut context).await {
        Ok(recorder) => recorder,
        Err(failure) => {
            // Already in the person's words: no key, a refused key, no credits.
            fail(
                &control,
                &conversation,
                &first_line(&format!("{failure:#}")),
            )
            .await;
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
                fail(
                    &control,
                    &conversation,
                    &first_line(&format!("{failure:#}")),
                )
                .await;
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
    *conversation.turns.lock().await = None;
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
    let caller = Caller::Conversation(proposal.source.clone());
    control
        .record(
            &caller,
            "ask_proposal_outcome",
            json!({"proposalId": id, "file": proposal.file, "outcome": outcome.outcome}),
        )
        .await;
    StatusCode::NO_CONTENT.into_response()
}
