//! One agent's conversation: the loop of model calls and tool calls behind each prompt.
//!
//! A turn goes like this:
//! 1. The prompt joins the conversation.
//! 2. The model's reply streams to the [`EventSink`] as it is written.
//! 3. Every tool call it asks for is worked out, allowed or declined by [`Permissions`], run, and
//!    its result goes back to the model.
//! 4. That repeats until the model replies without a tool call, the turn hits its tool-call cap,
//!    or someone cancels it.
//!
//! The conversation is append-only (see [`Message`]). A long output is set aside rather than put
//! in it whole, and a conversation that nears the model's context limit is replaced by a summary.
//! [`Session::snapshot`] and [`Session::resume`] keep a parked agent as data: nothing runs while
//! it waits.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::BoxFuture;
use super::error::{AgentError, CallError};
use super::events::{self, EventSink, ToolKind, ToolStatus};
use super::permission::{Decision, PermissionRequest, Permissions};
use super::prompt::{Abilities, project_notes, system_prompt};
use super::provider::{
    Cancel, ChatRequest, Completion, DeltaSink, Finish, Message, Provider, ServerTools, ToolCall,
    ToolSpec, Usage,
};
use super::skills::index_skills;
use super::tools::{Builtin, CommandSettings, Context, Output};

/// The context size assumed for a model whose size isn't known.
const DEFAULT_CONTEXT: u64 = 128_000;
/// Summarise once a call used this share of the context.
const COMPACT_AT: f64 = 0.8;
/// A tool result longer than this is set aside, and the model sees its start.
const SET_ASIDE_CHARS: usize = 24_000;
const SET_ASIDE_PREVIEW_CHARS: usize = 6_000;
/// How much of a tool's result the run record keeps. The model still gets all of it.
const RECORDED_OUTPUT_CHARS: usize = 4_000;
const READ_OUTPUT_DEFAULT_CHARS: usize = 20_000;

/// Which of the built-in tools an agent gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)]
pub struct ToolSet {
    /// Reading, searching and changing files.
    pub files: bool,
    pub commands: bool,
    /// The provider's web search and fetch. Offered only to an agent allowed the web.
    pub web: bool,
    /// `update_plan`.
    pub plan: bool,
}

impl ToolSet {
    /// No tools of its own: an agent that only talks and uses the daemon's tools (Ask `LoomWatch`,
    /// the instruction helper).
    pub const NONE: Self = Self {
        files: false,
        commands: false,
        web: false,
        plan: false,
    };

    /// Everything, with the web as the agent's `allow.web` says.
    #[must_use]
    pub fn all(web: bool) -> Self {
        Self {
            files: true,
            commands: true,
            web,
            plan: true,
        }
    }
}

/// Tools the daemon serves itself: the Team Bus, Ask's tools.
pub trait HostTools: Send + Sync {
    fn specs(&self) -> Vec<ToolSpec>;

    /// Whether the daemon records this tool's calls itself, as the Team Bus does, so the session
    /// shouldn't record them a second time.
    fn records_own_calls(&self, _name: &str) -> bool {
        false
    }

    /// The tool's answer, and whether it failed.
    fn call<'a>(&'a self, name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)>;
}

/// No daemon tools.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoHostTools;

impl HostTools for NoHostTools {
    fn specs(&self) -> Vec<ToolSpec> {
        Vec::new()
    }

    fn call<'a>(&'a self, name: &'a str, _input: Value) -> BoxFuture<'a, (String, bool)> {
        Box::pin(async move { (format!("There's no tool called {name}."), true) })
    }
}

/// How a session is set up.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub session_id: String,
    pub agent_id: String,
    /// The work folder. File paths are relative to it, and commands run in it.
    pub cwd: PathBuf,
    /// An `OpenRouter` model id, such as `anthropic/claude-sonnet-5.5`.
    pub model: String,
    /// The team file's effort, if any: `low`, `medium`, `high`, `xhigh`, `max`, …
    pub effort: Option<String>,
    pub tools: ToolSet,
    /// Folders of skills to list, the agent's own first.
    pub skill_roots: Vec<PathBuf>,
    pub turned_off: Vec<String>,
    /// More instructions after the built-in ones, such as Ask `LoomWatch`'s.
    pub instructions: Option<String>,
    /// The longest reply one model call may write.
    pub max_tokens: u32,
    /// The model's context size, from the model catalog.
    pub context_window: Option<u64>,
    /// The most tool calls one turn may make before it stops.
    pub max_tool_calls: usize,
    /// Folders besides the work folder a command may write to.
    pub writable: Vec<PathBuf>,
}

impl SessionConfig {
    #[must_use]
    pub fn new(session_id: &str, agent_id: &str, cwd: PathBuf, model: &str) -> Self {
        Self {
            session_id: session_id.to_owned(),
            agent_id: agent_id.to_owned(),
            cwd,
            model: model.to_owned(),
            effort: None,
            tools: ToolSet::all(false),
            skill_roots: Vec::new(),
            turned_off: Vec::new(),
            instructions: None,
            max_tokens: 16_000,
            context_window: None,
            max_tool_calls: 200,
            writable: Vec::new(),
        }
    }
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    /// The reply hit the length limit.
    MaxTokens,
    /// The turn made as many tool calls as it may.
    MaxTurnRequests,
    /// The provider's safety filter stopped the reply.
    Refusal,
    Cancelled,
}

impl StopReason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EndTurn => "end_turn",
            Self::MaxTokens => "max_tokens",
            Self::MaxTurnRequests => "max_turn_requests",
            Self::Refusal => "refusal",
            Self::Cancelled => "cancelled",
        }
    }
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnEnd {
    pub stop_reason: StopReason,
    /// What this turn cost.
    pub usage: Usage,
    /// The agent's reply in this turn: each message it wrote, a paragraph apart.
    pub reply: String,
}

impl TurnEnd {
    /// The turn's end as the run archive records one: `stopReason` and `usage`, with the cost in
    /// `_meta`.
    #[must_use]
    pub fn as_result(&self) -> Value {
        json!({
            "stopReason": self.stop_reason.as_str(),
            "usage": {
                "inputTokens": self.usage.input_tokens,
                "cachedReadTokens": self.usage.cached_read_tokens,
                "cachedWriteTokens": self.usage.cached_write_tokens,
                "outputTokens": self.usage.output_tokens,
                "totalTokens": self.usage.total_tokens(),
            },
            "_meta": {"loomwatch": {"costUsd": self.usage.cost_usd, "reasoningTokens": self.usage.reasoning_tokens}},
        })
    }
}

/// A parked session, as data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session_id: String,
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    pub history: Vec<Message>,
    #[serde(default)]
    pub outputs: BTreeMap<String, String>,
    #[serde(default)]
    pub usage: Usage,
    #[serde(default)]
    pub messages_written: u64,
}

/// Cancels the turn a session is running, from anywhere.
#[derive(Debug, Clone)]
pub struct CancelHandle(Arc<watch::Sender<bool>>);

impl CancelHandle {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
}

/// One built-in agent's conversation.
pub struct Session {
    config: SessionConfig,
    provider: Provider,
    sink: Arc<dyn EventSink>,
    permissions: Arc<dyn Permissions>,
    host: Arc<dyn HostTools>,
    history: Vec<Message>,
    outputs: BTreeMap<String, String>,
    usage: Usage,
    last_prompt_tokens: u64,
    messages_written: u64,
    cancel: Arc<watch::Sender<bool>>,
}

impl Session {
    /// A new session, starting with the built-in instructions.
    #[must_use]
    pub fn open(
        config: SessionConfig,
        provider: Provider,
        sink: Arc<dyn EventSink>,
        permissions: Arc<dyn Permissions>,
        host: Arc<dyn HostTools>,
    ) -> Self {
        let skills = if config.tools.files {
            index_skills(&config.skill_roots, &config.turned_off)
        } else {
            Vec::new()
        };
        let abilities = Abilities {
            files: config.tools.files,
            commands: config.tools.commands,
            web: config.tools.web,
            plan: config.tools.plan,
            ask_user: host.specs().iter().any(|tool| tool.name == "ask_user"),
        };
        let notes = if config.tools.files {
            project_notes(&config.cwd)
        } else {
            None
        };
        let system = system_prompt(
            &config.cwd,
            abilities,
            &skills,
            notes.as_deref(),
            config.instructions.as_deref(),
        );
        Self {
            history: vec![Message::System { content: system }],
            outputs: BTreeMap::new(),
            usage: Usage::default(),
            last_prompt_tokens: 0,
            messages_written: 0,
            cancel: Arc::new(watch::Sender::new(false)),
            config,
            provider,
            sink,
            permissions,
            host,
        }
    }

    /// A parked session, picked up where it stopped.
    #[must_use]
    pub fn resume(
        snapshot: Snapshot,
        mut config: SessionConfig,
        provider: Provider,
        sink: Arc<dyn EventSink>,
        permissions: Arc<dyn Permissions>,
        host: Arc<dyn HostTools>,
    ) -> Self {
        // The model and effort it was opened with stay: a resumed session is the same session.
        config.model = snapshot.model;
        config.effort = snapshot.effort;
        Self {
            history: snapshot.history,
            outputs: snapshot.outputs,
            usage: snapshot.usage,
            last_prompt_tokens: 0,
            messages_written: snapshot.messages_written,
            cancel: Arc::new(watch::Sender::new(false)),
            config,
            provider,
            sink,
            permissions,
            host,
        }
    }

    /// The session as data, for parking.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            session_id: self.config.session_id.clone(),
            model: self.config.model.clone(),
            effort: self.config.effort.clone(),
            history: self.history.clone(),
            outputs: self.outputs.clone(),
            usage: self.usage,
            messages_written: self.messages_written,
        }
    }

    #[must_use]
    pub fn cancel_handle(&self) -> CancelHandle {
        CancelHandle(self.cancel.clone())
    }

    /// What the whole session has cost so far.
    #[must_use]
    pub fn usage(&self) -> Usage {
        self.usage
    }

    #[must_use]
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    /// Runs one turn.
    ///
    /// # Errors
    ///
    /// When the provider refuses or fails ([`AgentError`]), or the run can't be recorded. A
    /// cancelled turn is not an error: it ends with [`StopReason::Cancelled`].
    pub async fn prompt(&mut self, text: &str) -> Result<TurnEnd, AgentError> {
        self.cancel.send_replace(false);
        let cancel = Cancel::new(self.cancel.subscribe());
        self.history.push(Message::User {
            content: text.to_owned(),
        });
        let mut turn = Usage::default();
        let mut reply: Vec<String> = Vec::new();
        let mut calls_made = 0usize;
        loop {
            if cancel.is_cancelled() {
                return Ok(ended(StopReason::Cancelled, turn, &reply));
            }
            if self.needs_compacting() {
                match self.compact(&cancel, &mut turn).await {
                    Ok(()) => {}
                    Err(CallError::Cancelled) => {
                        return Ok(ended(StopReason::Cancelled, turn, &reply));
                    }
                    Err(CallError::Failed(error)) => return Err(error),
                }
            }
            let completion = match self.call_model(&cancel, true).await {
                Ok(completion) => completion,
                Err(CallError::Cancelled) => {
                    return Ok(ended(StopReason::Cancelled, turn, &reply));
                }
                Err(CallError::Failed(error)) => return Err(error),
            };
            self.count(&completion.usage, &mut turn).await?;
            self.record_server_tools(&completion.server_tool_calls)
                .await?;
            if !completion.content.trim().is_empty() {
                reply.push(completion.content.trim().to_owned());
            }
            let calls = completion.tool_calls.clone();
            let finish = completion.finish;
            self.history.push(Message::Assistant {
                content: completion.content,
                reasoning_details: completion.reasoning_details,
                tool_calls: completion.tool_calls,
            });
            if calls.is_empty() {
                let reason = match finish {
                    Finish::Length => StopReason::MaxTokens,
                    Finish::ContentFilter => StopReason::Refusal,
                    Finish::Stop | Finish::ToolCalls => StopReason::EndTurn,
                };
                return Ok(ended(reason, turn, &reply));
            }
            for call in &calls {
                let content = if calls_made >= self.config.max_tool_calls {
                    "Not run: this turn reached its limit of tool calls.".to_owned()
                } else if cancel.is_cancelled() {
                    "Not run: the turn was cancelled.".to_owned()
                } else {
                    calls_made += 1;
                    self.run_tool(call, &cancel).await?
                };
                self.history.push(Message::Tool {
                    tool_call_id: call.id.clone(),
                    content,
                });
            }
            if calls_made >= self.config.max_tool_calls {
                return Ok(ended(StopReason::MaxTurnRequests, turn, &reply));
            }
        }
    }

    /// The tools offered to the model this turn.
    fn tool_specs(&self) -> Vec<ToolSpec> {
        let set = self.config.tools;
        let mut specs: Vec<ToolSpec> = Builtin::ALL
            .into_iter()
            .filter(|tool| match tool {
                Builtin::ListFiles
                | Builtin::ReadFile
                | Builtin::SearchFiles
                | Builtin::WriteFile
                | Builtin::EditFile => set.files,
                Builtin::RunCommand => set.commands,
                Builtin::UpdatePlan => set.plan,
                // Offered once there is something set aside to read.
                Builtin::ReadToolOutput => !self.outputs.is_empty(),
            })
            .map(Builtin::spec)
            .collect();
        let builtin: Vec<String> = specs.iter().map(|spec| spec.name.clone()).collect();
        specs.extend(
            self.host
                .specs()
                .into_iter()
                .filter(|spec| !builtin.contains(&spec.name)),
        );
        specs
    }

    async fn call_model(&mut self, cancel: &Cancel, stream: bool) -> Result<Completion, CallError> {
        self.messages_written += 1;
        let message_id = format!("{}-{}", self.config.session_id, self.messages_written);
        let tools = if stream {
            self.tool_specs()
        } else {
            Vec::new()
        };
        let effort = provider_effort(self.config.effort.as_deref());
        let request = ChatRequest {
            model: &self.config.model,
            effort,
            messages: &self.history,
            tools: &tools,
            server_tools: if stream && self.config.tools.web {
                ServerTools {
                    web_search: true,
                    web_fetch: true,
                }
            } else {
                ServerTools::default()
            },
            max_tokens: self.config.max_tokens,
            session_key: &self.config.session_id,
            agent_id: &self.config.agent_id,
        };
        let deltas = Streaming {
            sink: self.sink.as_ref(),
            message_id: &message_id,
            quiet: !stream,
        };
        self.provider.complete(&request, &deltas, cancel).await
    }

    async fn count(&mut self, usage: &Usage, turn: &mut Usage) -> Result<(), AgentError> {
        turn.add(usage);
        self.usage.add(usage);
        self.last_prompt_tokens = usage.prompt_tokens() + usage.output_tokens;
        if self.provider.is_demo() && usage.total_tokens() == 0 {
            return Ok(());
        }
        self.emit(events::usage_update(
            self.last_prompt_tokens,
            self.config.context_window,
            self.usage.cost_usd,
        ))
        .await
    }

    async fn emit(&self, update: Value) -> Result<(), AgentError> {
        self.sink.update(update).await.map_err(AgentError::Record)
    }

    /// The searches and fetches the provider ran, recorded as finished tool calls.
    async fn record_server_tools(&self, calls: &[Value]) -> Result<(), AgentError> {
        for (index, call) in calls.iter().enumerate() {
            let name = call
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("openrouter:web_search");
            let id = call
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map_or_else(
                    || format!("server-{}-{index}", self.messages_written),
                    str::to_owned,
                );
            let input: Value = call
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or_else(|| json!({}));
            let (title, kind) = if name.ends_with("web_fetch") {
                let url = input.get("url").and_then(Value::as_str).unwrap_or("a page");
                (format!("Read {url}"), ToolKind::Fetch)
            } else {
                let query = input
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("the web");
                (format!("Search the web: {query}"), ToolKind::Fetch)
            };
            self.emit(events::tool_call(&id, &title, kind, &input, &[]))
                .await?;
            let result = call
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default();
            self.emit(events::tool_update(
                &id,
                ToolStatus::Completed,
                &cut(result, RECORDED_OUTPUT_CHARS),
            ))
            .await?;
        }
        Ok(())
    }

    /// Runs one tool call and gives back what goes into the conversation.
    async fn run_tool(&mut self, call: &ToolCall, cancel: &Cancel) -> Result<String, AgentError> {
        let Ok(input @ Value::Object(_)) = serde_json::from_str::<Value>(&call.arguments) else {
            let said = format!(
                "The arguments for {} weren't a JSON object. Call it again with valid arguments.",
                call.name
            );
            self.emit(events::tool_call(
                &call.id,
                &call.name,
                ToolKind::Other,
                &json!({}),
                &[],
            ))
            .await?;
            self.emit(events::tool_update(&call.id, ToolStatus::Failed, &said))
                .await?;
            return Ok(said);
        };
        let output = match Builtin::named(&call.name).filter(|tool| self.offers(*tool)) {
            Some(tool) => self.run_builtin(tool, call, input, cancel).await?,
            None if self.host.specs().iter().any(|spec| spec.name == call.name) => {
                self.run_host(call, input).await?
            }
            None => {
                let said = Output::failed(format!("There's no tool called {}.", call.name));
                self.emit(events::tool_call(
                    &call.id,
                    &call.name,
                    ToolKind::Other,
                    &input,
                    &[],
                ))
                .await?;
                self.emit(events::tool_update(
                    &call.id,
                    ToolStatus::Failed,
                    &said.text,
                ))
                .await?;
                said
            }
        };
        Ok(self.for_conversation(&call.id, output.text))
    }

    fn offers(&self, tool: Builtin) -> bool {
        self.tool_specs()
            .iter()
            .any(|spec| spec.name == tool.name())
    }

    async fn run_host(&self, call: &ToolCall, input: Value) -> Result<Output, AgentError> {
        let recorded = !self.host.records_own_calls(&call.name);
        if recorded {
            self.emit(events::tool_call(
                &call.id,
                &call.name,
                ToolKind::Other,
                &input,
                &[],
            ))
            .await?;
        }
        let (text, failed) = self.host.call(&call.name, input).await;
        if recorded {
            let status = if failed {
                ToolStatus::Failed
            } else {
                ToolStatus::Completed
            };
            self.emit(events::tool_update(
                &call.id,
                status,
                &cut(&text, RECORDED_OUTPUT_CHARS),
            ))
            .await?;
        }
        Ok(Output { text, failed })
    }

    async fn run_builtin(
        &mut self,
        tool: Builtin,
        call: &ToolCall,
        mut input: Value,
        cancel: &Cancel,
    ) -> Result<Output, AgentError> {
        let prepared = match tool.prepare(&input, &self.config.cwd) {
            Ok(prepared) => prepared,
            Err(said) => {
                self.emit(events::tool_call(
                    &call.id,
                    &call.name,
                    ToolKind::Other,
                    &input,
                    &[],
                ))
                .await?;
                self.emit(events::tool_update(&call.id, ToolStatus::Failed, &said))
                    .await?;
                return Ok(Output::failed(said));
            }
        };
        self.emit(events::tool_call(
            &call.id,
            &prepared.title,
            prepared.kind,
            &input,
            &prepared.locations,
        ))
        .await?;
        if prepared.needs_permission {
            let request = PermissionRequest {
                session_id: self.config.session_id.clone(),
                tool_call_id: call.id.clone(),
                title: prepared.title.clone(),
                kind: prepared.kind,
                input: input.clone(),
                locations: prepared.locations.clone(),
            };
            match self.permissions.request(&request).await {
                Decision::Allow => {}
                Decision::AllowEdited(edited) => {
                    if let Err(said) = tool.prepare(&edited, &self.config.cwd) {
                        let said = format!("The person's change didn't work: {said}");
                        self.emit(events::tool_update(&call.id, ToolStatus::Failed, &said))
                            .await?;
                        return Ok(Output::failed(said));
                    }
                    input = edited;
                }
                Decision::Deny => {
                    let said = "The person declined this. Carry on without it, or say what you \
                                need and why."
                        .to_owned();
                    self.emit(events::tool_update(&call.id, ToolStatus::Failed, &said))
                        .await?;
                    return Ok(Output::failed(said));
                }
                Decision::Answer(answer) => {
                    let said = format!("The person answered instead of letting this run: {answer}");
                    self.emit(events::tool_update(&call.id, ToolStatus::Completed, &said))
                        .await?;
                    return Ok(Output::ok(said));
                }
            }
        }
        let output = match tool {
            Builtin::UpdatePlan => self.update_plan(&input).await?,
            Builtin::ReadToolOutput => self.read_output(&input),
            _ => {
                let settings = CommandSettings {
                    network: self.config.tools.web,
                    writable: self.config.writable.clone(),
                };
                let context = Context {
                    cwd: &self.config.cwd,
                    cancel,
                    command: &settings,
                };
                tool.run(&input, &context).await
            }
        };
        let status = if output.failed {
            ToolStatus::Failed
        } else {
            ToolStatus::Completed
        };
        self.emit(events::tool_update(
            &call.id,
            status,
            &cut(&output.text, RECORDED_OUTPUT_CHARS),
        ))
        .await?;
        Ok(output)
    }

    async fn update_plan(&self, input: &Value) -> Result<Output, AgentError> {
        let Some(steps) = input.get("steps").and_then(Value::as_array) else {
            return Ok(Output::failed("`steps` must be a list."));
        };
        let entries: Vec<(String, String)> = steps
            .iter()
            .filter_map(|step| {
                let text = step.get("step").and_then(Value::as_str)?.trim();
                let status = step
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| matches!(*status, "pending" | "in_progress" | "completed"))
                    .unwrap_or("pending");
                (!text.is_empty()).then(|| (text.to_owned(), status.to_owned()))
            })
            .collect();
        self.emit(events::plan(&entries)).await?;
        let done = entries
            .iter()
            .filter(|(_, status)| status == "completed")
            .count();
        Ok(Output::ok(format!(
            "Plan updated: {done} of {} steps done.",
            entries.len()
        )))
    }

    fn read_output(&self, input: &Value) -> Output {
        let Some(id) = input.get("id").and_then(Value::as_str) else {
            return Output::failed("`id` is required.");
        };
        let Some(text) = self.outputs.get(id) else {
            return Output::failed(format!("No set-aside output has the id {id}."));
        };
        let number = |key: &str| {
            input
                .get(key)
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
        };
        let offset = number("offset").unwrap_or(0);
        let limit = number("limit").unwrap_or(READ_OUTPUT_DEFAULT_CHARS).max(1);
        let total = text.chars().count();
        let part: String = text.chars().skip(offset).take(limit).collect();
        let end = (offset + limit).min(total);
        if end < total {
            Output::ok(format!(
                "{part}\n… characters {offset}–{end} of {total}. Read on with offset {end}."
            ))
        } else {
            Output::ok(part)
        }
    }

    /// What goes into the conversation for a tool's result: all of it, or its start and an id to
    /// read the rest by.
    fn for_conversation(&mut self, id: &str, text: String) -> String {
        let total = text.chars().count();
        if total <= SET_ASIDE_CHARS {
            return text;
        }
        let preview: String = text.chars().take(SET_ASIDE_PREVIEW_CHARS).collect();
        self.outputs.insert(id.to_owned(), text);
        format!(
            "{preview}\n… this output is {total} characters long; the rest was set aside. Read it \
             with read_tool_output, id {id}, starting at offset {SET_ASIDE_PREVIEW_CHARS}."
        )
    }

    fn needs_compacting(&self) -> bool {
        let window = self.config.context_window.unwrap_or(DEFAULT_CONTEXT);
        #[allow(clippy::cast_precision_loss)]
        let used = self.last_prompt_tokens as f64 / window as f64;
        used >= COMPACT_AT && self.history.len() > 3
    }

    /// Replaces the conversation with a summary of it, keeping the instructions and the current
    /// task. The model writes the summary, so it keeps what matters for the work.
    async fn compact(&mut self, cancel: &Cancel, turn: &mut Usage) -> Result<(), CallError> {
        let task = self
            .history
            .iter()
            .rev()
            .find_map(|message| match message {
                Message::User { content } => Some(content.clone()),
                _ => None,
            })
            .unwrap_or_default();
        self.history.push(Message::User {
            content: "Your conversation is nearly too long for your memory. Write a summary of it \
                      for yourself to carry on from: what the task is, what you have done and \
                      found (with file names and sources), what you decided and why, and what is \
                      left to do. Be complete but brief. Reply with the summary only."
                .to_owned(),
        });
        let completion = self.call_model(cancel, false).await;
        // Whatever happens, the request for a summary is not part of the work.
        self.history.pop();
        let completion = completion?;
        self.count(&completion.usage, turn)
            .await
            .map_err(CallError::Failed)?;
        let Some(Message::System { content: system }) = self.history.first().cloned() else {
            return Ok(());
        };
        self.history = vec![
            Message::System { content: system },
            Message::User {
                content: format!(
                    "## Where the work stands\n{}\n\n## Your current task, as you were given it\n\
                     {task}\n\nCarry on from where the summary leaves off.",
                    completion.content.trim()
                ),
            },
        ];
        self.last_prompt_tokens = 0;
        self.emit(events::thought_chunk(
            "(The conversation was summarised to make room in the model's memory.)",
        ))
        .await
        .map_err(CallError::Failed)
    }
}

fn ended(stop_reason: StopReason, usage: Usage, reply: &[String]) -> TurnEnd {
    TurnEnd {
        stop_reason,
        usage,
        reply: reply.join("\n\n"),
    }
}

/// The provider's name for a team file's effort. `default` leaves it to the model, and the
/// efforts `OpenRouter` doesn't know are mapped to the nearest one it does.
fn provider_effort(effort: Option<&str>) -> Option<&'static str> {
    match effort?.trim().to_ascii_lowercase().as_str() {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" | "ultra" => Some("max"),
        _ => None,
    }
}

/// `text` cut to `limit` characters for the run record.
fn cut(text: &str, limit: usize) -> String {
    let total = text.chars().count();
    if total <= limit {
        return text.to_owned();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}\n… ({} more characters)", total - limit)
}

/// Streams a reply's text and reasoning to the sink as they arrive.
struct Streaming<'a> {
    sink: &'a dyn EventSink,
    message_id: &'a str,
    /// A summary the agent writes for itself isn't shown.
    quiet: bool,
}

impl DeltaSink for Streaming<'_> {
    fn text<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>> {
        Box::pin(async move {
            if self.quiet {
                return Ok(());
            }
            self.sink
                .update(events::message_chunk(text, self.message_id))
                .await
                .map_err(|error| CallError::Failed(AgentError::Record(error)))
        })
    }

    fn reasoning<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>> {
        Box::pin(async move {
            if self.quiet {
                return Ok(());
            }
            self.sink
                .update(events::thought_chunk(text))
                .await
                .map_err(|error| CallError::Failed(AgentError::Record(error)))
        })
    }
}
