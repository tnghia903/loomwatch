//! Runs an agent for the run engine: `LoomWatch`'s own agent ([`crate::agent`]), on the model its
//! team file names.
//!
//! [`AgentRun`] is what the pipeline, team mode, the Team Bus, chat and Ask hold for one agent. It
//! replaces the ACP client that used to start a third-party app, and keeps that client's calls —
//! open a session, take a turn, park, reopen, finish — so the code above it did not have to change
//! shape. Underneath, nothing is started: the agent is a [`Session`] in this process, its events go
//! to the run's [`Recorder`] as they happen, its permission requests to the operator's policy, and
//! its Team Bus calls straight to the bus.

mod bridge;
mod recorder;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use uuid::Uuid;

pub(crate) use bridge::tool_spec;
pub(crate) use recorder::{EventLog, Recorder, ReplyText, new_event_id};

use crate::agent::{
    AgentError, Demo, HostTools, NoHostTools, OFFLINE_MODEL, OpenRouter, Problem, ProblemKind,
    Provider, Session, SessionConfig, ToolSet,
};
use crate::ai::{ModelRef, Source};
use crate::archive::EventArchive;
use crate::team_bus::TeamBusConnection;
use crate::{EventKind, SessionOutcome};
use bridge::{BusTools, ChannelSink, CombinedTools, PolicyGate, Record, SpoolGate};

/// How an agent is run: its folder, the tools wired to it, its switches (ADR 0037) and who it asks
/// about anything else (ADR 0040).
#[derive(Debug, Clone)]
pub struct ProcessSpec {
    /// Kept only so team files written for an app still describe themselves; nothing is started.
    pub cmd: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// The agent's work folder.
    pub cwd: PathBuf,
    /// Tools the operator wired to this agent from an app's settings. The built-in agent can't
    /// reach them (yet), and the run says so rather than failing.
    pub tools: Vec<crate::delivery::WiredTool>,
    /// How `LoomWatch` answers this agent's permission requests. `None` declines every one, as Ask
    /// and one-turn helpers always have.
    pub permissions: Option<crate::permissions::PermissionPolicy>,
    /// Who a request the policy declines is put to: the operator of the run this agent belongs to.
    pub asker: Option<crate::permissions::PermissionAsker>,
}

/// What a session needs from the run that opens it.
pub(crate) struct TeamSessionContext<'a> {
    pub(crate) archive: &'a EventArchive,
    pub(crate) bus: Option<&'a TeamBusConnection>,
    pub(crate) event_log: Option<EventLog>,
    /// What team memory this session was supplied, already rendered and measured, archived before
    /// the opening prompt so replay can split the prompt into its sections by record.
    pub(crate) packet: Option<&'a crate::memory::ContextPacket>,
    /// What the opening prompt is made of, archived beside it for the same reason.
    pub(crate) composed: Option<&'a crate::memory::ComposedPrompt>,
    /// One more turn to take on this session before it closes, and where its answer goes: team
    /// mode's one long turn has no other boundary to checkpoint at.
    pub(crate) boundary: Option<&'a BoundaryTurn<'a>>,
}

/// An extra turn a one-shot session takes before closing, and the answer it produced.
pub(crate) struct BoundaryTurn<'a> {
    pub(crate) prompt: &'a str,
    pub(crate) answer: std::sync::Mutex<String>,
}

impl<'a> BoundaryTurn<'a> {
    pub(crate) fn new(prompt: &'a str) -> Self {
        Self {
            prompt,
            answer: std::sync::Mutex::new(String::new()),
        }
    }

    /// What the session answered, or an empty string when the turn never ran.
    pub(crate) fn answer(&self) -> String {
        self.answer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// A turn that could not finish, said in the operator's words: the key was refused, the account
/// is out of credits, no key is set. The run shows `message` as it is, and `problem` says which
/// source it was and what went wrong, for the app to offer the way out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppReportedError {
    pub(crate) message: String,
    pub(crate) problem: Option<Problem>,
}

impl AppReportedError {
    pub(crate) fn said(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            problem: None,
        }
    }

    /// The `turn_failed` note a run's record keeps for it.
    fn note(&self) -> Value {
        turn_failed(&self.message, self.problem.as_ref())
    }
}

/// A `turn_failed` note: the words, and the problem when the app can offer a way out of it.
fn turn_failed(message: &str, problem: Option<&Problem>) -> Value {
    let mut note = json!({"phase": "turn_failed", "reason": "app_error", "message": message});
    if let Some(problem) = problem {
        note["problem"] = json!(problem);
    }
    note
}

impl std::fmt::Display for AppReportedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppReportedError {}

/// Forgets a parked conversation that will not be reopened: its stop is over.
///
/// Parked conversations are kept in the database ([`crate::agent::SessionStore`]), never in
/// memory, so one waiting for an answer holds nothing while it waits.
///
/// # Errors
///
/// When the database fails.
pub(crate) async fn forget_parked(archive: &EventArchive, session_id: &str) -> Result<()> {
    archive.parked_agents().forget(session_id).await
}

/// Scripted stand-ins for a model, by the `demo/<id>` model name a test gives its team.
static DEMOS: LazyLock<Mutex<HashMap<String, Demo>>> = LazyLock::new(Mutex::default);

/// Registers `demo` and gives back the model name that runs on it, for a test's team file.
#[cfg(test)]
pub(crate) fn demo_model(demo: Demo) -> String {
    let name = format!("demo/{}", Uuid::new_v4().simple());
    DEMOS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(name.clone(), demo);
    name
}

/// The key a connection was made with, and the connection.
type KeptConnection = Option<(String, Arc<OpenRouter>)>;

/// One `OpenRouter` connection for the whole daemon, made again only when the key changes.
static OPENROUTER: LazyLock<tokio::sync::Mutex<KeptConnection>> =
    LazyLock::new(tokio::sync::Mutex::default);

/// The provider `model` runs on: its own source's, never another's.
async fn provider_for(model: &ModelRef) -> Result<Provider, AppReportedError> {
    match model.source {
        Source::OpenRouter => {}
        source @ (Source::ChatGpt | Source::Anthropic) => return Err(not_connected(source)),
    }
    let model = model.id.as_str();
    if model == OFFLINE_MODEL {
        return Ok(Provider::Demo(Demo::offline()));
    }
    if let Some(demo) = DEMOS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(model)
    {
        return Ok(Provider::Demo(demo.clone()));
    }
    let missing = || not_connected(Source::OpenRouter);
    let ai = crate::ai::installed().ok_or_else(missing)?;
    let key = ai
        .openrouter_key()
        .await
        .map_err(|error| {
            AppReportedError::said(format!(
                "LoomWatch couldn't read your OpenRouter key: {error:#}"
            ))
        })?
        .ok_or_else(missing)?;
    let mut held = OPENROUTER.lock().await;
    if let Some((kept, provider)) = held.as_ref()
        && kept == key.expose()
    {
        return Ok(Provider::OpenRouter(provider.clone()));
    }
    let provider = Arc::new(OpenRouter::new(key.clone()).map_err(|error| {
        AppReportedError::said(format!(
            "LoomWatch couldn't set up its connection to OpenRouter: {error:#}"
        ))
    })?);
    *held = Some((key.expose().to_owned(), provider.clone()));
    Ok(Provider::OpenRouter(provider))
}

/// An agent whose source has nothing connected on this computer, said with what to connect.
fn not_connected(source: Source) -> AppReportedError {
    let message = match source {
        Source::OpenRouter => {
            "Agents need an OpenRouter key to run. Add one on LoomWatch's Connections page, then \
             run the team again."
        }
        Source::ChatGpt => {
            "This agent runs on your ChatGPT plan. Sign in with ChatGPT on LoomWatch's \
             Connections page, then run the team again."
        }
        Source::Anthropic => {
            "This agent runs on your Claude API credit. Add your Claude API key on LoomWatch's \
             Connections page, then run the team again."
        }
    };
    AppReportedError {
        message: message.to_owned(),
        problem: Some(Problem::new(ProblemKind::NotConnected, source)),
    }
}

/// `model[effort]`, as team files write a model with a reasoning effort, split into its parts.
fn split_selector(selector: &str) -> (&str, Option<&str>) {
    if let Some(open) = selector.rfind('[')
        && selector.ends_with(']')
    {
        let effort = &selector[open + 1..selector.len() - 1];
        if crate::config::is_known_effort(effort) {
            return (&selector[..open], Some(effort));
        }
    }
    (selector, None)
}

/// One agent, run for the engine.
pub struct AgentRun {
    spec: ProcessSpec,
    /// Tools the daemon serves this agent besides the Team Bus, such as Ask's.
    host: Option<Arc<dyn HostTools>>,
    /// Which built-in tools it gets when no policy says.
    tools: Option<ToolSet>,
    /// Instructions after the built-in ones.
    instructions: Option<String>,
    has_run: bool,
    session: Option<Session>,
    session_id: Option<String>,
    event_log: Option<EventLog>,
    records: Option<UnboundedReceiver<Record>>,
}

impl AgentRun {
    /// An agent ready to open a session. Nothing starts until it does.
    ///
    /// # Errors
    ///
    /// Never today; kept fallible for the callers written against starting a process.
    pub fn spawn(spec: &ProcessSpec) -> Result<Self> {
        Ok(Self {
            spec: spec.clone(),
            host: None,
            tools: None,
            instructions: None,
            has_run: false,
            session: None,
            session_id: None,
            event_log: None,
            records: None,
        })
    }

    /// Serve this agent the daemon's own tools in `host` (Ask's), and only those.
    #[must_use]
    pub(crate) fn with_host_tools(mut self, host: Arc<dyn HostTools>) -> Self {
        self.host = Some(host);
        self.tools = Some(ToolSet::NONE);
        self
    }

    /// Instructions after the built-in ones, such as Ask's or a helper's.
    #[must_use]
    pub(crate) fn with_instructions(mut self, instructions: &str) -> Self {
        self.instructions = Some(instructions.to_owned());
        self
    }

    /// No tools of its own at all: a one-turn helper that only writes.
    #[must_use]
    pub(crate) fn without_tools(mut self) -> Self {
        self.tools = Some(ToolSet::NONE);
        self
    }

    /// The run's event log this agent writes to, once its session is open.
    pub(crate) fn event_log(&self) -> Option<EventLog> {
        self.event_log.clone()
    }

    /// The session id, once open. Kept across a park so [`Self::load_live`] reopens the same one.
    pub(crate) fn acp_session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Open a session, take one turn and close it.
    ///
    /// # Errors
    ///
    /// When the turn fails or the run can't be recorded.
    pub async fn run_session(
        &mut self,
        agent_id: &str,
        model: &str,
        prompt: &str,
        archive: &EventArchive,
        _exit_timeout: Duration,
    ) -> Result<SessionOutcome> {
        self.run_session_with_bus(
            agent_id,
            model,
            prompt,
            TeamSessionContext {
                archive,
                bus: None,
                event_log: None,
                packet: None,
                composed: None,
                boundary: None,
            },
        )
        .await
    }

    /// Open a session with the run's Team Bus and log, take one turn (and the boundary turn, if
    /// asked), and close it.
    pub(crate) async fn run_session_with_bus(
        &mut self,
        agent_id: &str,
        model: &str,
        prompt: &str,
        mut context: TeamSessionContext<'_>,
    ) -> Result<SessionOutcome> {
        let mut recorder = self.open_live(agent_id, model, &mut context).await?;
        let reply = self.prompt_turn(&mut recorder, prompt).await?;
        if let Some(boundary) = context.boundary {
            let answer = self
                .bookkeeping_turn(&mut recorder, boundary.prompt, "checkpoint")
                .await?;
            *boundary
                .answer
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = answer;
        }
        self.finish_live(&mut recorder, reply, &context).await
    }

    /// Open a session that stays open for more than one turn. Finish it with
    /// [`Self::finish_live`], or park it with [`Self::park_session`].
    pub(crate) async fn open_live(
        &mut self,
        agent_id: &str,
        model: &str,
        context: &mut TeamSessionContext<'_>,
    ) -> Result<Recorder> {
        if self.has_run {
            bail!("this agent has already opened a session");
        }
        self.has_run = true;
        let (model, effort) = split_selector(model);
        let model = ModelRef::parse(model);
        let session_id = Uuid::new_v4().to_string();
        let mut recorder = self.start_recorder(agent_id, &session_id, context).await?;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase": "set_config_option", "configId": "model", "value": model.selector()}),
                Some(json!({"source": "loomwatch", "phase": "set_config_option"})),
            )
            .await?;
        if let Some(effort) = effort {
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({"phase": "set_thinking_effort", "configId": "reasoning_effort", "value": effort}),
                    Some(json!({"source": "loomwatch", "phase": "set_thinking_effort"})),
                )
                .await?;
        }
        if let Some(composed) = context.composed {
            recorder.note_delivery(&composed.required_skills);
        }
        let provider = match provider_for(&model).await {
            Ok(provider) => provider,
            Err(error) => {
                recorder
                    .append(
                        EventKind::SessionMeta,
                        error.note(),
                        Some(json!({"source": "loomwatch", "phase": "turn_failed"})),
                    )
                    .await?;
                return Err(error.into());
            }
        };
        let mut config = self
            .session_config(
                &session_id,
                agent_id,
                &model.selector(),
                effort,
                context.bus,
            )
            .await;
        config.skill_focus = context.composed.map(skill_focus);
        let (sender, receiver) = unbounded_channel();
        let conversation = context.composed.is_some_and(|composed| {
            composed
                .sections
                .iter()
                .any(|section| section.kind == crate::memory::PromptSectionKind::Conversation)
        });
        let host = self.host_tools(context.bus, conversation);
        let session = Session::open(
            config,
            provider,
            Arc::new(ChannelSink(sender.clone())),
            Arc::new(PolicyGate {
                policy: self.spec.permissions.clone(),
                asker: self.spec.asker.clone(),
                records: sender.clone(),
            }),
            host,
        );
        self.session = Some(self.metered(session, sender));
        self.records = Some(receiver);
        self.session_id = Some(session_id);
        Ok(recorder)
    }

    /// Reopen a parked session, with the run's log and bus. The conversation comes out of the
    /// database, so it reopens the same whether it was parked a minute ago or by a daemon that has
    /// since restarted.
    ///
    /// # Errors
    ///
    /// When nothing is parked under `session_id` (it was already reopened or released), or the
    /// database fails.
    pub(crate) async fn load_live(
        &mut self,
        agent_id: &str,
        session_id: &str,
        context: &mut TeamSessionContext<'_>,
    ) -> Result<Recorder> {
        if self.has_run {
            bail!("this agent has already opened a session");
        }
        self.has_run = true;
        let snapshot = context
            .archive
            .parked_agents()
            .take(session_id)
            .await?
            .with_context(|| format!("{agent_id}'s parked session {session_id} is gone"))?;
        let mut recorder = self.start_recorder(agent_id, session_id, context).await?;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({
                    "phase": "session_loaded",
                    "sessionId": session_id,
                    "reason": "the operator answered; the parked session is being reopened"
                }),
                Some(json!({"source": "loomwatch", "phase": "session_loaded"})),
            )
            .await?;
        let provider = provider_for(&ModelRef::parse(&snapshot.model)).await?;
        let config = self
            .session_config(
                session_id,
                agent_id,
                &snapshot.model,
                snapshot.effort.as_deref(),
                context.bus,
            )
            .await;
        let (sender, receiver) = unbounded_channel();
        // The same tools it was opened with, or the provider's cache of the conversation is lost:
        // its opening message says whether it was handed a conversation.
        let conversation = snapshot.history.iter().any(|message| {
            matches!(message, crate::agent::Message::User { content } if crate::has_conversation(content))
        });
        let host = self.host_tools(context.bus, conversation);
        let session = Session::resume(
            snapshot,
            config,
            provider,
            Arc::new(ChannelSink(sender.clone())),
            Arc::new(PolicyGate {
                policy: self.spec.permissions.clone(),
                asker: self.spec.asker.clone(),
                records: sender.clone(),
            }),
            host,
        );
        self.session = Some(self.metered(session, sender));
        self.records = Some(receiver);
        self.session_id = Some(session_id.to_owned());
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase": "session_replayed", "sessionId": session_id, "frames": 0}),
                Some(json!({"source": "loomwatch", "phase": "session_replayed"})),
            )
            .await?;
        Ok(recorder)
    }

    /// `session`, held to its run's spool (ADR 0068) when it belongs to a run with an operator.
    /// Ask, helpers and the CLI have no run record to keep a spool on; `OpenRouter`'s own limit on
    /// the key is what holds them.
    fn metered(
        &self,
        session: Session,
        records: tokio::sync::mpsc::UnboundedSender<Record>,
    ) -> Session {
        match &self.spec.asker {
            Some(asker) => session.with_spend(Arc::new(SpoolGate {
                asker: asker.clone(),
                records,
            })),
            None => session,
        }
    }

    /// Park the session: keep its conversation in the database, under the run it belongs to, and
    /// let go of everything else.
    ///
    /// # Errors
    ///
    /// When the conversation can't be kept or the park can't be recorded.
    pub(crate) async fn park_session(
        &mut self,
        recorder: &mut Recorder,
        _exit_timeout: Duration,
    ) -> Result<()> {
        let session = self
            .session
            .as_ref()
            .context("only an open session can be parked")?;
        recorder
            .event_log
            .archive()
            .parked_agents()
            .save(
                recorder.event_log.session_id(),
                &session.config().agent_id,
                &session.snapshot(),
            )
            .await?;
        self.session = None;
        self.records = None;
        recorder
            .append(
                EventKind::Process,
                json!({"phase": "exited", "exitCode": 0, "signal": null, "message": "parked"}),
                None,
            )
            .await
    }

    /// Close the session and give back what a one-shot run gives back.
    pub(crate) async fn finish_live(
        &mut self,
        recorder: &mut Recorder,
        last_reply: String,
        context: &TeamSessionContext<'_>,
    ) -> Result<SessionOutcome> {
        let archive_session_id = recorder.event_log.session_id().to_owned();
        self.close_session();
        recorder
            .append(
                EventKind::Process,
                json!({"phase": "exited", "exitCode": 0, "signal": null, "message": ""}),
                None,
            )
            .await?;
        let event_count = context.archive.verify_session(&archive_session_id).await?;
        Ok(SessionOutcome {
            session_id: archive_session_id,
            event_count,
            exit_code: 0,
            reply: last_reply,
        })
    }

    /// End the session. Nothing more can be asked of it.
    pub(crate) fn close_session(&mut self) {
        self.session = None;
        self.records = None;
    }

    /// What the next turns are for, in their usage records, until [`Self::end_turn_for`]: a
    /// handover or checkpoint the engine asks for, or a kept-open agent's answer to a question or
    /// revision of work sent back to it.
    pub(crate) fn turn_for(&mut self, purpose: &str) {
        if let Some(session) = self.session.as_mut() {
            session.set_purpose(purpose);
        }
    }

    /// Back to what the session is for.
    pub(crate) fn end_turn_for(&mut self) {
        if let Some(session) = self.session.as_mut() {
            session.end_purpose();
        }
    }

    /// Record why a coordinator-requested turn exists. Its text and cost remain evidence, but a
    /// checkpoint or handover must never replace the agent's answer in the Output card.
    pub(crate) async fn bookkeeping_turn(
        &mut self,
        recorder: &mut Recorder,
        prompt: &str,
        purpose: &str,
    ) -> Result<String> {
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase":"turn_purpose", "purpose":purpose}),
                None,
            )
            .await?;
        let listening = recorder.interrupt.take();
        self.turn_for(purpose);
        let answer = self.prompt_turn(recorder, prompt).await;
        self.end_turn_for();
        recorder.interrupt = listening;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase":"turn_purpose", "purpose":"work"}),
                None,
            )
            .await?;
        answer
    }

    /// One turn on an open session, recorded as it happens. Returns the agent's reply.
    ///
    /// A turn the agent could not finish (a refused key, an empty account) is an
    /// [`AppReportedError`], with a `turn_failed` note in the record saying why.
    pub(crate) async fn prompt_turn(
        &mut self,
        recorder: &mut Recorder,
        prompt: &str,
    ) -> Result<String> {
        recorder.reply.clear();
        let session_id = recorder.session_id.clone();
        recorder
            .append(
                EventKind::Message,
                json!({"role": "user", "messageId": null, "content": {"type": "text", "text": prompt}}),
                Some(json!({
                    "jsonrpc": "2.0",
                    "method": "session/prompt",
                    "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]},
                })),
            )
            .await?;
        if !recorder.required_skills.is_empty() {
            let skills = std::mem::take(&mut recorder.required_skills);
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({"phase": "required_skills_supplied", "skills": skills, "method": "session/prompt"}),
                    Some(json!({"source": "loomwatch", "phase": "required_skills_supplied"})),
                )
                .await?;
        }
        let ended = self.drive(recorder, prompt).await;
        // However the turn ended, it can no longer take an answer to an `ask` it left in flight.
        if let Some(bus) = recorder.bus.clone() {
            bus.turn_ended().await;
        }
        match ended? {
            Ok(end) => {
                let result = end.as_result();
                recorder
                    .append(
                        EventKind::TurnEnd,
                        json!({"stopReason": end.stop_reason.as_str(), "usage": result["usage"]}),
                        Some(json!({"jsonrpc": "2.0", "result": result})),
                    )
                    .await?;
                recorder.note_self_report().await?;
                // The run's spool is closed: the operator finished it there, or a scheduled run had
                // nobody to ask. The whole run ends; the run registry says what it became.
                if end.stop_reason == crate::agent::StopReason::SpendLimit
                    && let Some(stopped) = self
                        .spec
                        .asker
                        .as_ref()
                        .and_then(crate::permissions::PermissionAsker::spend_stopped)
                {
                    // Its session ends here, on the record too, as a finished one would: nothing
                    // will ask it anything more.
                    self.close_session();
                    recorder
                        .append(
                            EventKind::Process,
                            json!({"phase": "exited", "exitCode": 0, "signal": null, "message": "stopped at the run's spending limit"}),
                            None,
                        )
                        .await?;
                    return Err(stopped.into());
                }
                Ok(recorder.reply.take())
            }
            Err(error) => {
                let failed = AppReportedError {
                    message: error.to_string(),
                    problem: error.problem(),
                };
                recorder.reply.clear();
                recorder
                    .append(
                        EventKind::SessionMeta,
                        failed.note(),
                        Some(json!({"source": "loomwatch", "phase": "turn_failed"})),
                    )
                    .await?;
                Err(failed.into())
            }
        }
    }

    /// Runs the turn and writes its records as they arrive. The outer error is a record that could
    /// not be written; the inner one is the agent's.
    async fn drive(
        &mut self,
        recorder: &mut Recorder,
        prompt: &str,
    ) -> Result<Result<crate::agent::TurnEnd, AgentError>> {
        let Self {
            session, records, ..
        } = self;
        let session = session.as_mut().context("this agent has no open session")?;
        let records = records.as_mut().context("this agent has no open session")?;
        let cancel = session.cancel_handle();
        let interrupt = recorder.interrupt.clone();
        let (turn_over, mut turn_ended) = tokio::sync::oneshot::channel::<()>();
        // The turn and the writing of its records run side by side, never one waiting on the
        // other: a Team Bus tool in the turn can be part way through a write on the database's one
        // writing connection while a record is being written, and a turn left unpolled until that
        // record was written held the connection for the pool's whole acquire timeout.
        let turn = async {
            let ended = session.prompt(prompt).await;
            let _ = turn_over.send(());
            Ok::<_, anyhow::Error>(ended)
        };
        let writing = async {
            let mut interrupted = false;
            loop {
                tokio::select! {
                    biased;
                    Some(record) = records.recv() => write(recorder, record).await?,
                    () = async {
                        match interrupt.as_deref() {
                            Some(stop) => stop.requested().await,
                            None => std::future::pending().await,
                        }
                    }, if !interrupted => {
                        interrupted = true;
                        cancel.cancel();
                        recorder
                            .append(
                                EventKind::SessionMeta,
                                json!({
                                    "phase": "turn_interrupted",
                                    "reason": interrupt.as_deref().map_or("operator_note", crate::runs::Interrupt::reason)
                                }),
                                Some(json!({"source": "loomwatch", "phase": "turn_interrupted"})),
                            )
                            .await?;
                    }
                    _ = &mut turn_ended => {
                        while let Ok(record) = records.try_recv() {
                            write(recorder, record).await?;
                        }
                        return Ok::<_, anyhow::Error>(());
                    }
                }
            }
        };
        let (ended, ()) = tokio::try_join!(turn, writing)?;
        Ok(ended)
    }

    /// The run's log and the recorder that writes to it, with the opening records.
    async fn start_recorder(
        &mut self,
        agent_id: &str,
        session_id: &str,
        context: &mut TeamSessionContext<'_>,
    ) -> Result<Recorder> {
        let event_log = context
            .event_log
            .take()
            .unwrap_or_else(|| EventLog::new(context.archive.clone(), session_id.to_owned()));
        self.event_log = Some(event_log.clone());
        if let Some(bus) = context.bus {
            bus.register(event_log.clone()).await;
        }
        let mut recorder = Recorder::with_log(event_log, session_id.to_owned(), agent_id);
        recorder.bus = context.bus.cloned();
        recorder
            .append(
                EventKind::Process,
                json!({"phase": "spawned", "pid": std::process::id()}),
                None,
            )
            .await?;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase": "initialize", "result": {
                    "protocolVersion": 1,
                    "agentInfo": {"name": "loomwatch", "title": "LoomWatch agent", "version": env!("CARGO_PKG_VERSION")},
                    "agentCapabilities": {"loadSession": true},
                }}),
                Some(json!({"source": "loomwatch", "phase": "initialize"})),
            )
            .await?;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase": "session_new", "result": {"sessionId": session_id}}),
                Some(json!({"source": "loomwatch", "phase": "session_new"})),
            )
            .await?;
        let unavailable: Vec<&str> = self
            .spec
            .tools
            .iter()
            .filter(|tool| !tool.connected)
            .map(|tool| tool.name.as_str())
            .collect();
        if !unavailable.is_empty() {
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "tools_unavailable",
                        "tools": unavailable,
                        "reason": "These tools aren't connected in LoomWatch; the agent runs without them."
                    }),
                    Some(json!({"source": "loomwatch", "phase": "tools_unavailable"})),
                )
                .await?;
        }
        // Before the prompt, never after: a failure between the two must leave a record of what
        // was *about* to be supplied rather than a prompt nothing explains.
        if let Some(packet) = context.packet.filter(|packet| !packet.is_empty()) {
            context
                .archive
                .store_context_packet(recorder.event_log.session_id(), packet)
                .await?;
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "context_packet",
                        "heading": crate::memory::TEAM_KNOWLEDGE_HEADING,
                        "chars": packet.used_chars,
                        "budgetChars": packet.budget_chars,
                        "sections": packet.sections,
                    }),
                    Some(json!({"source": "loomwatch", "phase": "context_packet"})),
                )
                .await?;
        }
        if let Some(composed) = context.composed {
            recorder
                .append(
                    EventKind::SessionMeta,
                    composed.meta(),
                    Some(json!({"source": "loomwatch", "phase": "prompt_sections"})),
                )
                .await?;
        }
        Ok(recorder)
    }

    async fn session_config(
        &self,
        session_id: &str,
        agent_id: &str,
        model: &str,
        effort: Option<&str>,
        bus: Option<&TeamBusConnection>,
    ) -> SessionConfig {
        let mut config = SessionConfig::new(session_id, agent_id, self.spec.cwd.clone(), model);
        config.effort = effort.map(str::to_owned);
        let web = self
            .spec
            .permissions
            .as_ref()
            .is_some_and(|policy| policy.allow().web);
        config.tools = self.tools.unwrap_or_else(|| {
            if self.spec.permissions.is_some() {
                ToolSet::all(web)
            } else {
                ToolSet::NONE
            }
        });
        config.instructions.clone_from(&self.instructions);
        if let Some(policy) = &self.spec.permissions {
            config.turned_off = policy.turned_off_skills();
            config.web = policy.web_limits();
        }
        if let Some(bus) = bus {
            config.time_zone = bus.time_zone();
            bus.purpose().clone_into(&mut config.purpose);
        }
        // Joined part by part, so Windows names them with `\` throughout, as the agent reads them.
        config.skill_roots = vec![
            self.spec.cwd.join(".agents").join("skills"),
            self.spec.cwd.join(".claude").join("skills"),
        ];
        if let Some(ai) = crate::ai::installed() {
            config.skill_library.push(ai.skills_folder());
            config.context_window = ai
                .models()
                .context_length(&ModelRef::parse(model).openrouter_equivalent())
                .await;
        }
        config
    }

    fn host_tools(
        &self,
        bus: Option<&TeamBusConnection>,
        conversation: bool,
    ) -> Arc<dyn HostTools> {
        if let Some(host) = &self.host {
            return host.clone();
        }
        let mut hosts: Vec<Arc<dyn HostTools>> = Vec::new();
        if let Some(connection) = bus {
            hosts.push(Arc::new(BusTools::new(connection.clone(), conversation)));
        }
        // The tools the operator connected and gave this agent (ADR 0069). Only a run agent, with
        // a policy to ask through, is ever offered them.
        if self.spec.permissions.is_some()
            && let Some(tools) = crate::connected_tools::installed()
        {
            let given: Vec<_> = self
                .spec
                .tools
                .iter()
                .filter(|tool| tool.connected)
                .filter_map(|tool| tools.named_now(&tool.name))
                .collect();
            if !given.is_empty() {
                hosts.push(Arc::new(crate::connected_tools::OutsideTools::new(
                    tools.clone(),
                    given,
                )));
            }
        }
        match hosts.len() {
            0 => Arc::new(NoHostTools),
            1 => hosts.remove(0),
            _ => Arc::new(CombinedTools(hosts)),
        }
    }
}

/// What picks the skills a large library lists for an agent: what it is for (its role's first line)
/// and what it was asked (its task), not everything it was handed with them.
fn skill_focus(composed: &crate::memory::ComposedPrompt) -> String {
    use crate::memory::PromptSectionKind;
    composed
        .sections
        .iter()
        .filter_map(|section| match section.kind {
            PromptSectionKind::Role => Some(crate::orientation::role_summary(&section.text)),
            PromptSectionKind::Task => Some(section.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn write(recorder: &mut Recorder, record: Record) -> Result<()> {
    match record {
        Record::Update(update) => {
            let frame = json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"sessionId": recorder.session_id, "update": update},
            });
            recorder.record_frame(&frame).await
        }
        Record::Meta(payload) => {
            let phase = payload.get("phase").cloned().unwrap_or(Value::Null);
            recorder
                .append(
                    EventKind::SessionMeta,
                    payload,
                    Some(json!({"source": "loomwatch", "phase": phase})),
                )
                .await
        }
        Record::Permission { request, response } => {
            recorder.record_frame(&request).await?;
            recorder.record_frame(&response).await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    /// The skills a large library lists follow the agent's role and task, not the material it was
    /// handed: a long handover or Brief would match skills the work isn't about.
    #[test]
    fn the_skill_focus_is_the_roles_first_line_and_the_task() {
        let team = crate::config::TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: writer\nagents:\n  - id: writer\n    model: m\n    role: |\n      You write the brief.\n      How to work:\n      - Note every meeting.\n",
        )
        .expect("team");
        let agent = &team.agents[0];
        let mut task = crate::NodeTask::goal("Prepare the slides.");
        task.stage_results = Some("Minutes of the budget meeting and its action items.".to_owned());
        let composed =
            crate::compose_prompt(agent, &crate::memory::ContextPacket::default(), &task);
        assert_eq!(
            skill_focus(&composed),
            "You write the brief.\nPrepare the slides."
        );
    }
    use crate::test_support::{stand_in, turn};

    /// A folder for one test's database, removed when the test ends.
    struct Folder(PathBuf);

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn spec(cwd: &Path) -> ProcessSpec {
        ProcessSpec {
            cmd: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: cwd.to_owned(),
            tools: Vec::new(),
            permissions: None,
            asker: None,
        }
    }

    fn context(archive: &EventArchive, event_log: Option<EventLog>) -> TeamSessionContext<'_> {
        TeamSessionContext {
            archive,
            bus: None,
            event_log,
            packet: None,
            composed: None,
            boundary: None,
        }
    }

    /// **A parked agent comes back from the database alone, and carries on.**
    ///
    /// Parked under one daemon and reopened under the next: a second connection to the same file,
    /// a new agent, and nothing carried over in memory. Its next turn panics unless it is taken in
    /// the conversation that holds the first, which a fresh session would not.
    #[tokio::test]
    async fn a_parked_agent_carries_on_after_the_daemon_restarts() -> Result<()> {
        let folder = Folder(
            std::env::temp_dir().join(format!("loomwatch-parked-{}", Uuid::new_v4().simple())),
        );
        std::fs::create_dir_all(&folder.0)?;
        let path = folder.0.join("loomwatch.db");
        let (model, demo) = stand_in(vec![
            turn(&["Find the budget"], "the budget is 40"),
            turn(&["Now halve it"], "then it is 20").remembering(&["the budget is 40"]),
        ]);
        let run_id = Uuid::new_v4().to_string();

        let session_id = {
            let archive = EventArchive::open(&path).await?;
            let log = EventLog::new(archive.clone(), run_id.clone());
            let mut agent = AgentRun::spawn(&spec(&folder.0))?;
            let mut recorder = agent
                .open_live("a", &model, &mut context(&archive, Some(log)))
                .await?;
            assert_eq!(
                agent.prompt_turn(&mut recorder, "Find the budget").await?,
                "the budget is 40"
            );
            agent.park_session(&mut recorder, Duration::ZERO).await?;
            archive.flush().await;
            agent
                .acp_session_id()
                .context("a parked agent keeps its session id")?
                .to_owned()
            // The agent, its log and the database close here, as they do when the daemon stops.
        };

        let archive = EventArchive::open(&path).await?;
        let parked = archive.parked_agents();
        let kept = parked
            .load(&session_id)
            .await?
            .context("the parked agent is in the database")?;
        assert_eq!(kept.model, model);

        let mut agent = AgentRun::spawn(&spec(&folder.0))?;
        // The run that parked it is gone with the daemon, so this reopen writes to a log of its
        // own: a second log over the run's session would restart its numbering.
        let mut recorder = agent
            .load_live("a", &session_id, &mut context(&archive, None))
            .await?;
        assert!(
            parked.load(&session_id).await?.is_none(),
            "a reopened agent is no longer parked"
        );
        assert_eq!(
            agent.prompt_turn(&mut recorder, "Now halve it").await?,
            "then it is 20"
        );
        let asked = demo.requests();
        assert_eq!(asked.len(), 2, "{asked:?}");
        assert!(
            asked[1].messages.starts_with(&asked[0].messages),
            "the second turn is asked in the conversation of the first"
        );

        let mut again = AgentRun::spawn(&spec(&folder.0))?;
        let refused = again
            .load_live("a", &session_id, &mut context(&archive, None))
            .await
            .err()
            .context("an agent can be reopened only once")?;
        assert!(refused.to_string().contains("is gone"), "{refused:#}");
        Ok(())
    }

    /// Forgetting a parked agent removes it from the database, and only it.
    #[tokio::test]
    async fn forgetting_a_parked_agent_removes_its_row() -> Result<()> {
        let archive = EventArchive::new(crate::db::Db::temp().await);
        let (model, _demo) = stand_in(vec![turn(&[], "one"), turn(&[], "two")]);
        let run_id = Uuid::new_v4().to_string();
        let log = EventLog::new(archive.clone(), run_id.clone());
        let mut parked = Vec::new();
        for agent_id in ["a", "b"] {
            let mut agent = AgentRun::spawn(&spec(&std::env::temp_dir()))?;
            let mut recorder = agent
                .open_live(agent_id, &model, &mut context(&archive, Some(log.clone())))
                .await?;
            agent.prompt_turn(&mut recorder, "go").await?;
            agent.park_session(&mut recorder, Duration::ZERO).await?;
            parked.push(agent.acp_session_id().context("parked")?.to_owned());
        }

        forget_parked(&archive, &parked[0]).await?;
        assert!(archive.parked_agents().load(&parked[0]).await?.is_none());
        assert!(archive.parked_agents().load(&parked[1]).await?.is_some());
        archive.parked_agents().forget_run(&run_id).await?;
        assert!(archive.parked_agents().load(&parked[1]).await?.is_none());
        Ok(())
    }
}
