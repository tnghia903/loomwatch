//! One agent's conversation: the loop of model calls and tool calls behind each prompt.
//!
//! A turn goes like this:
//! 1. The prompt joins the conversation.
//! 2. The model's reply streams to the [`EventSink`] as it is written.
//! 3. Every tool call it asks for is worked out, allowed or declined by [`Permissions`], run, and
//!    its result goes back to the model. The calls are asked about one at a time, in order. The
//!    reads among them run at the same time, and every other call runs on its own in its place.
//! 4. That repeats until the model replies without a tool call, the turn hits its tool-call cap,
//!    the run's spool says no more ([`Spend`]), or someone cancels it. A reply the length limit cut
//!    off is carried on instead of ending the turn. Near the cap, a tool's result says how many
//!    calls are left; at the cap, the model is asked for its answer from what it has, and no more
//!    calls run (ADR 0088).
//!
//! The conversation is append-only (see [`Message`]), and the tools offered never change, so the
//! provider's prompt cache holds for the whole session. A long output is set aside rather than put
//! in it whole, and a conversation that nears the model's context limit, or 160k tokens, is
//! replaced by a summary. One the provider refuses as too long all the same has its tool results
//! cut down to their start, their whole text set aside, and is summarised, once a turn, before
//! that ends the run.
//!
//! Each turn's message ends with today's date, worked out when the turn starts, so a session
//! parked overnight or a scheduled run is never a day out. Each model call is recorded with what
//! it was for and what it used (`usage_update`'s `_meta.loomwatch.call`).
//! [`Session::snapshot`] and [`Session::resume`] keep a parked agent as data: nothing runs while
//! it waits.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::BoxFuture;
use super::error::{AgentError, CallError};
use super::events::{self, EventSink, ToolKind, ToolStatus};
use super::permission::{Decision, PermissionRequest, Permissions};
use super::prompt::{Abilities, loomwatch_brief, project_notes, system_prompt};
use super::provider::{
    Cancel, ChatRequest, Completion, DeltaSink, Finish, Message, Parts, Picture, Provider,
    ServerTools, ToolCall, ToolSpec, Usage, WebLimits,
};
use super::skills::{SkillIndex, prompt_section};
use super::spend::{Go, Spend, Unmetered};
use super::tools::{self, Builtin, CommandSettings, Context, Output, Pictures};
use crate::documents::Kind;
use crate::you::AboutYou;

/// The context size assumed for a model whose size isn't known.
const DEFAULT_CONTEXT: u64 = 128_000;
/// Summarise once a call used this share of the context.
const COMPACT_AT: f64 = 0.8;
/// The largest context counted for [`COMPACT_AT`], however large the model's. Every call reads the
/// whole conversation again, cached or not, so one left to fill a million-token context costs
/// several times as much per call as one summarised at 160k, and models follow a very long
/// conversation less well.
const COMPACT_WINDOW_CAP: u64 = 200_000;
/// The longest reply asked for, however long the model may write: about 64,000 tokens is the most
/// a page, a lesson or a report written in one reply needs, and as long as a reply takes a model
/// many minutes.
const MAX_REPLY: u64 = 64_000;
/// The longest reply asked for when what the model may write isn't known, and the longest summary.
const DEFAULT_REPLY: u32 = 16_000;
/// How many replies in a row the length limit may cut off with the turn still going on: a cut reply
/// is carried on, and a cut tool call is sent back to be made smaller. One more ends the turn.
const MAX_CUT_OFFS: usize = 2;
/// How many replies in a row the provider may pause with nothing for the agent to run, with the
/// turn still going on: each is carried on ([`PAUSED`]). One more ends the turn.
const MAX_PAUSES: usize = 2;
/// What the agent is told when the provider paused its reply part way through the searches, page
/// reads and code it runs itself ([`Finish::Paused`]).
const PAUSED: &str = "Your reply was paused after many web searches, page reads or code runs, and \
                      the last one it began didn't run. Carry on from where it stopped, and run \
                      that step again if you still need it.";
/// What the agent is told once its turn has made as many tool calls as it may (ADR 0088). A turn
/// that stopped there with no answer spent everything it did for nothing.
pub(super) const LAST_ANSWER: &str = "You have used this turn's tool calls, and no more will \
                                      run. Write your answer now from what you have, and say \
                                      what you could not finish.";
/// What a tool call is answered with once the turn has made as many as it may.
pub(super) const NOT_RUN_AT_LIMIT: &str = "Not run: this turn reached its limit of tool calls.";
/// A tool result longer than this is set aside, and the model sees its start.
const SET_ASIDE_CHARS: usize = 24_000;
const SET_ASIDE_PREVIEW_CHARS: usize = 6_000;
/// How much of its start a tool result the model has read keeps when it is cut down to make room.
const TRIMMED_PREVIEW_CHARS: usize = 1_500;
/// What a set-aside output's note starts with, after its start.
const SET_ASIDE_MARK: &str = "\n… this output is ";
/// About how many bytes of text make a token, for the part of a request no provider has counted
/// yet (see [`Session::estimate`]). Bytes rather than characters, so accented letters and other
/// scripts, which take more tokens to a character than English, count for more.
const BYTES_PER_TOKEN: u64 = 4;
/// What one picture counts as in the estimate, in bytes of text: about 3,000 tokens. What it
/// really takes depends on its size and the model: Claude counts a token for every 750 pixels, so a
/// screenshot takes 1,000 to 3,000 and a picture at the largest size sent up to about 6,600. The
/// estimate only says when to make room, and one that comes out low is caught when the provider
/// refuses the call.
const PICTURE_SIZE: usize = 12_000;
/// How much of a tool's result the run record keeps. The model still gets all of it.
const RECORDED_OUTPUT_CHARS: usize = 4_000;
const READ_OUTPUT_DEFAULT_CHARS: usize = 20_000;
/// The most pictures one conversation holds. Past 20 in one request, Claude's API wants each
/// picture at most 2000 pixels on a side, smaller than the pictures are sent.
pub const MAX_PICTURES: usize = 20;
/// The most picture data one conversation holds, in base64. Every call sends the whole
/// conversation again, and Anthropic refuses a request over 32 MB.
pub const MAX_PICTURE_BYTES: usize = 20 * 1024 * 1024;

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

/// Tools the daemon serves itself: the Team Bus, Ask's tools, and the tools the operator connected
/// (ADR 0069).
pub trait HostTools: Send + Sync {
    fn specs(&self) -> Vec<ToolSpec>;

    /// Whether the daemon records this tool's calls itself, as the Team Bus does, so the session
    /// shouldn't record them a second time.
    fn records_own_calls(&self, _name: &str) -> bool {
        false
    }

    /// For a call the operator must allow first, what to ask: a connected tool's calls do. `None`
    /// for the daemon's own tools, which never ask.
    fn asks(&self, _name: &str) -> Option<HostAsk> {
        None
    }

    /// The tool's answer, and whether it failed.
    fn call<'a>(&'a self, name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)>;
}

/// What a host tool's call asks the operator (ADR 0069).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostAsk {
    /// What the card and the run record say: "Linear: Create issue".
    pub title: String,
    /// The connected tool, as the team file names it: "Linear".
    pub server: String,
    /// The tool's own name for the call: `create_issue`.
    pub call: String,
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
    /// The folders the operator connected as knowledge. A read by a name the work folder doesn't
    /// have finds the file in one of them.
    pub knowledge: Vec<PathBuf>,
    /// An `OpenRouter` model id, such as `anthropic/claude-sonnet-5.5`.
    pub model: String,
    /// The team file's effort, if any: `low`, `medium`, `high`, `xhigh`, `max`, …
    pub effort: Option<String>,
    pub tools: ToolSet,
    /// Folders of the agent's own skills, which are always listed.
    pub skill_roots: Vec<PathBuf>,
    /// `LoomWatch`'s library of skills: listed whole while small, else by what the work calls for.
    pub skill_library: Vec<PathBuf>,
    /// What the agent is for and was asked, which picks the skills a large library lists: its
    /// role's first line and its task. `None`: its first message, whole.
    pub skill_focus: Option<String>,
    pub turned_off: Vec<String>,
    /// More instructions after the built-in ones, such as Ask `LoomWatch`'s.
    pub instructions: Option<String>,
    /// What the person told their agents about themselves (ADR 0074), in the instructions.
    pub person: Option<AboutYou>,
    /// What this agent learned from the person's feedback on its work (ADR 0078), in the
    /// instructions.
    pub lessons: Vec<String>,
    /// The longest reply one model call may write. A summary is never asked for more than
    /// [`DEFAULT_REPLY`].
    pub max_tokens: u32,
    /// The model's context size, from the model catalog.
    pub context_window: Option<u64>,
    /// The most tool calls one turn may make. Then the model is asked for its answer, with no more
    /// calls run (ADR 0088).
    pub max_tool_calls: usize,
    /// The call that brings a turn to this many tool calls has its result say how many are left,
    /// once a turn. `None`: 90% of [`Self::max_tool_calls`].
    pub warn_at_tool_calls: Option<usize>,
    /// The model can see pictures, so a picture `read_file` opens is shown to it. From the model
    /// list.
    pub sees_pictures: bool,
    /// The most pictures the conversation may hold.
    pub max_pictures: usize,
    /// The most picture data the conversation may hold, in base64 bytes.
    pub max_picture_bytes: usize,
    /// Folders besides the work folder a command may write to.
    pub writable: Vec<PathBuf>,
    /// How much web reading one model call may do.
    pub web: WebLimits,
    /// The IANA time zone the date is given in, such as the team's schedule's. `None`, or a name
    /// that isn't one: this computer's own.
    pub time_zone: Option<String>,
    /// What the turns are for, for the usage record: `work`, or what the engine opened the
    /// session for (`check`, `ask_answer`, `helper`).
    pub purpose: String,
    /// A fixed time for the date line, for tests. `None`: the clock.
    pub now: Option<chrono::DateTime<chrono::Utc>>,
}

impl SessionConfig {
    #[must_use]
    pub fn new(session_id: &str, agent_id: &str, cwd: PathBuf, model: &str) -> Self {
        Self {
            session_id: session_id.to_owned(),
            agent_id: agent_id.to_owned(),
            cwd,
            knowledge: Vec::new(),
            model: model.to_owned(),
            effort: None,
            tools: ToolSet::all(false),
            skill_roots: Vec::new(),
            skill_library: Vec::new(),
            skill_focus: None,
            turned_off: Vec::new(),
            instructions: None,
            person: None,
            lessons: Vec::new(),
            max_tokens: DEFAULT_REPLY,
            context_window: None,
            max_tool_calls: 200,
            warn_at_tool_calls: None,
            sees_pictures: false,
            max_pictures: MAX_PICTURES,
            max_picture_bytes: MAX_PICTURE_BYTES,
            writable: Vec::new(),
            web: WebLimits::default(),
            time_zone: None,
            purpose: WORK.to_owned(),
            now: None,
        }
    }
}

impl SessionConfig {
    /// Lets a reply be as long as the model may write, `most` tokens by its own list, up to
    /// [`MAX_REPLY`] and the room the context has above the point where the conversation is
    /// summarised, so the longest reply still fits beside the longest conversation sent. Set the
    /// context window first.
    ///
    /// At 16,000 a lesson written as one page was cut off part way and written again whole: two
    /// minutes and 16,000 tokens spent for nothing.
    pub fn reply_up_to(&mut self, most: u64) {
        let window = self.context_window.unwrap_or(DEFAULT_CONTEXT);
        let room = window.saturating_sub(summarise_at(window));
        let longest = room.min(MAX_REPLY).max(u64::from(DEFAULT_REPLY)).min(most);
        self.max_tokens = u32::try_from(longest).unwrap_or(DEFAULT_REPLY);
    }

    /// How many tool calls a turn makes before it is told how many are left.
    fn warns_at(&self) -> usize {
        self.warn_at_tool_calls
            .unwrap_or(self.max_tool_calls * 9 / 10)
    }
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    /// The reply hit the length limit.
    MaxTokens,
    /// The turn made as many tool calls as it may. Its reply is the answer it was then asked for,
    /// if it wrote one (ADR 0088).
    MaxTurnRequests,
    /// The provider's safety filter stopped the reply.
    Refusal,
    Cancelled,
    /// The run's spool, or the agent's own guard, allows no more model calls (ADR 0068).
    SpendLimit,
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
            Self::SpendLimit => "spend_limit",
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
        let mut result = json!({
            "stopReason": self.stop_reason.as_str(),
            "usage": {
                "inputTokens": self.usage.input_tokens,
                "cachedReadTokens": self.usage.cached_read_tokens,
                "cachedWriteTokens": self.usage.cached_write_tokens,
                "outputTokens": self.usage.output_tokens,
                "totalTokens": self.usage.total_tokens(),
            },
            "_meta": {"loomwatch": {
                "costUsd": self.usage.cost_usd,
                "reasoningTokens": self.usage.reasoning_tokens,
                "webSearches": self.usage.web_searches,
                "webFetches": self.usage.web_fetches,
            }},
        });
        super::events::mark_payer(&mut result["_meta"]["loomwatch"], &self.usage);
        result
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
    spend: Arc<dyn Spend>,
    history: Vec<Message>,
    outputs: BTreeMap<String, String>,
    usage: Usage,
    last_prompt_tokens: u64,
    messages_written: u64,
    /// The part of the latest message its latest words were recorded under ([`Parts`]).
    message_part: usize,
    /// The prompt of the turn under way, which a summary keeps word for word.
    task: String,
    /// What the turn under way is for, for the usage record.
    turn: String,
    /// The skills the instructions list, kept until the first turn says what the work is.
    skills: SkillIndex,
    cancel: Arc<watch::Sender<bool>>,
    /// The pictures opened by the message whose calls are running, and their base64 bytes: they
    /// join the conversation only once all its calls are done, and count against its room before.
    unsent_pictures: (usize, usize),
    /// The tool calls the turn under way has run.
    turn_calls: ToolCalls,
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
            SkillIndex::read(
                &config.skill_roots,
                &config.skill_library,
                &config.turned_off,
            )
        } else {
            SkillIndex::default()
        };
        let focus = config.skill_focus.clone().unwrap_or_default();
        let system = instructions(&config, host.as_ref(), &skills, &focus);
        Self {
            history: vec![Message::System { content: system }],
            outputs: BTreeMap::new(),
            usage: Usage::default(),
            last_prompt_tokens: 0,
            messages_written: 0,
            message_part: 0,
            task: String::new(),
            turn: config.purpose.clone(),
            skills,
            cancel: Arc::new(watch::Sender::new(false)),
            config,
            provider,
            sink,
            permissions,
            host,
            spend: Arc::new(Unmetered),
            unsent_pictures: (0, 0),
            turn_calls: ToolCalls::default(),
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
            message_part: 0,
            task: String::new(),
            turn: config.purpose.clone(),
            skills: SkillIndex::default(),
            cancel: Arc::new(watch::Sender::new(false)),
            config,
            provider,
            sink,
            permissions,
            host,
            spend: Arc::new(Unmetered),
            unsent_pictures: (0, 0),
            turn_calls: ToolCalls::default(),
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

    /// Check every model call against `spend` (the run's spool) instead of making them freely.
    #[must_use]
    pub fn with_spend(mut self, spend: Arc<dyn Spend>) -> Self {
        self.spend = spend;
        self
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

    /// What the next turns are for, for the usage record: a handover or a checkpoint the engine
    /// asks for, or a kept-open agent's `ask_answer` or `revision`. [`Self::end_purpose`] goes back
    /// to what the session is for.
    pub fn set_purpose(&mut self, purpose: &str) {
        purpose.clone_into(&mut self.turn);
    }

    pub fn end_purpose(&mut self) {
        self.config.purpose.clone_into(&mut self.turn);
    }

    /// Runs one turn.
    ///
    /// # Errors
    ///
    /// When the provider refuses or fails ([`AgentError`]), or the run can't be recorded. A
    /// cancelled turn is not an error: it ends with [`StopReason::Cancelled`]. A conversation the
    /// provider refuses as too long is only an error the second time in a turn: the first time,
    /// room is made and it is summarised ([`Self::make_room`]).
    pub async fn prompt(&mut self, text: &str) -> Result<TurnEnd, AgentError> {
        self.prompt_showing(text, &[]).await
    }

    /// [`Self::prompt`], with pictures the operator sent shown to the model before the words
    /// (ADR 0082): when it can see pictures, and as many as the conversation has room for.
    ///
    /// # Errors
    ///
    /// As [`Self::prompt`].
    #[allow(clippy::too_many_lines)] // Every way a turn goes on or ends, in one loop.
    pub async fn prompt_showing(
        &mut self,
        text: &str,
        pictures: &[PathBuf],
    ) -> Result<TurnEnd, AgentError> {
        self.cancel.send_replace(false);
        let cancel = Cancel::new(self.cancel.subscribe());
        let pictures = self.shown(pictures).await;
        self.begin_turn(text, pictures);
        let mut turn = Usage::default();
        let mut reply = Words::default();
        // Once the turn has made as many tool calls as it may, the call that asks for its answer
        // (ADR 0088), and whether the conversation holds that request: a summary drops it.
        let mut last_answer: Option<Call> = None;
        let mut asked_for_answer = false;
        // Replies the length limit cut off in a row, and whether the last one was text to carry on.
        let mut cut_offs = 0usize;
        let mut carrying_on = false;
        // Replies in a row the provider paused with no call for the agent to run.
        let mut paused_in_a_row = 0usize;
        // Whether the provider just refused a call as too long for the model, the work's or a
        // summary's, and whether this turn has made room once already.
        let mut overflowed = false;
        let mut made_room = false;
        loop {
            if cancel.is_cancelled() {
                return Ok(ended(StopReason::Cancelled, turn, &reply));
            }
            if !self.may_call(&cancel).await {
                return Ok(ended(stopped(&cancel), turn, &reply));
            }
            if overflowed || self.needs_compacting() {
                let summarised = if overflowed {
                    self.make_room(&cancel, &mut turn).await
                } else {
                    self.compact(&cancel, &mut turn).await
                };
                overflowed = false;
                match summarised {
                    // A reply cut off before the summary isn't carried on: the summary says where
                    // the work stands, and what the model writes next is a reply of its own.
                    Ok(true) => {
                        cut_offs = 0;
                        carrying_on = false;
                        asked_for_answer = false;
                    }
                    Ok(false) => {}
                    // The summary was refused too: the newest step added more than estimated.
                    Err(CallError::Failed(AgentError::ContextTooLong)) if !made_room => {
                        made_room = true;
                        overflowed = true;
                        continue;
                    }
                    Err(CallError::Cancelled) => {
                        return Ok(ended(StopReason::Cancelled, turn, &reply));
                    }
                    Err(CallError::Failed(error)) => return Err(error),
                }
                // The summary was a call of its own, and may have used what was left.
                if !self.may_call(&cancel).await {
                    return Ok(ended(stopped(&cancel), turn, &reply));
                }
            }
            if last_answer.is_some() && !asked_for_answer {
                self.history.push(Message::User {
                    content: LAST_ANSWER.to_owned(),
                    pictures: Vec::new(),
                });
                asked_for_answer = true;
            }
            let call = match last_answer {
                Some(call) => call,
                None if cut_offs > 0 => Call::CarryOn,
                None => Call::Work,
            };
            let completion = match self.call_model(&cancel, call).await {
                Ok(completion) => completion,
                Err(CallError::Cancelled) => {
                    self.take_back_last_answer();
                    return Ok(ended(StopReason::Cancelled, turn, &reply));
                }
                // Once a turn, room is made and the call made again; a second refusal is the
                // error, whose words are then true.
                Err(CallError::Failed(AgentError::ContextTooLong)) if !made_room => {
                    made_room = true;
                    overflowed = true;
                    continue;
                }
                Err(CallError::Failed(error)) => {
                    self.take_back_last_answer();
                    return Err(error);
                }
            };
            self.count(&completion, &mut turn, call).await?;
            self.record_server_tools(&completion.server_tool_calls)
                .await?;
            let cut = completion.finish == Finish::Length;
            // A reply the provider paused part way through its own searches and code isn't done:
            // what it wrote was said on the way, and it carries on.
            let paused = completion.finish == Finish::Paused;
            let calls = completion.tool_calls.clone();
            if calls.is_empty() && !paused {
                // What it wrote before the provider's last search was said on the way to it, and
                // words follow the search whenever there is one.
                let split = completion.answer_from > 0;
                let answer = completion
                    .content
                    .get(completion.answer_from..)
                    .unwrap_or(&completion.content);
                take_reply(&mut reply.answer, answer, carrying_on && !split, cut);
            } else {
                take_reply(&mut reply.on_the_way, &completion.content, false, cut);
            }
            let wrote_nothing = completion.content.trim().is_empty();
            let finish = completion.finish;
            self.history.push(Message::Assistant {
                content: completion.content,
                reasoning_details: completion.reasoning_details,
                tool_calls: completion.tool_calls,
                native: completion.native,
            });
            cut_offs = if cut { cut_offs + 1 } else { 0 };
            paused_in_a_row = if paused && calls.is_empty() {
                paused_in_a_row + 1
            } else {
                0
            };
            carrying_on = false;
            // A turn that reached its limit says so however its answer went, so its record is
            // true about why it stopped.
            let at_limit = |reason| {
                if last_answer.is_some() {
                    StopReason::MaxTurnRequests
                } else {
                    reason
                }
            };
            if cut_offs > MAX_CUT_OFFS {
                return Ok(ended(at_limit(StopReason::MaxTokens), turn, &reply));
            }
            if calls.is_empty() {
                if cut {
                    // Carried on, so the next stage isn't handed a reply that stops mid-sentence.
                    carrying_on = !wrote_nothing;
                    self.history.push(Message::User {
                        content: carry_on(wrote_nothing).to_owned(),
                        pictures: Vec::new(),
                    });
                    continue;
                }
                // Paused part way through the provider's own searches, after "no more will run":
                // asked again, with none it may call, rather than told to carry on searching.
                if paused && let Some(asked) = last_answer {
                    if asked != Call::LastAnswer {
                        return Ok(ended(StopReason::MaxTurnRequests, turn, &reply));
                    }
                    if !wrote_nothing {
                        self.emit(events::commentary(&self.message_id())).await?;
                    }
                    self.history.push(Message::User {
                        content: LAST_ANSWER.to_owned(),
                        pictures: Vec::new(),
                    });
                    last_answer = Some(Call::BareLastAnswer);
                    continue;
                }
                if paused && paused_in_a_row <= MAX_PAUSES {
                    if !wrote_nothing {
                        self.emit(events::commentary(&self.message_id())).await?;
                    }
                    self.history.push(Message::User {
                        content: PAUSED.to_owned(),
                        pictures: Vec::new(),
                    });
                    continue;
                }
                let reason = match finish {
                    Finish::ContentFilter => StopReason::Refusal,
                    Finish::Stop | Finish::ToolCalls | Finish::Length | Finish::Paused => {
                        at_limit(StopReason::EndTurn)
                    }
                };
                return Ok(ended(reason, turn, &reply));
            }
            // What it wrote alongside its calls was said on the way, and the record says so now
            // the message is whole: its words streamed before its calls did.
            if !wrote_nothing {
                self.emit(events::commentary(&self.message_id())).await?;
            }
            self.run_calls(&calls, cut, &cancel).await?;
            // Past the limit nothing is carried on: the results say the calls didn't run, and the
            // answer is asked for again below.
            if paused && last_answer.is_none() {
                // After its calls' results, in the same message to the model.
                self.history.push(Message::User {
                    content: PAUSED.to_owned(),
                    pictures: Vec::new(),
                });
            }
            if self.turn_calls.made >= self.config.max_tool_calls {
                // The answer is asked for with the tools offered as before, so the provider reads
                // the whole conversation from its cache. A model that calls one anyway has it
                // answered unrun and is asked once more with none it may call; one that still
                // calls a tool ends the turn with what it wrote.
                last_answer = match last_answer {
                    None => Some(Call::LastAnswer),
                    Some(Call::LastAnswer) => Some(Call::BareLastAnswer),
                    Some(_) => return Ok(ended(StopReason::MaxTurnRequests, turn, &reply)),
                };
            }
        }
    }

    /// Runs the tool calls of one model message, and adds their results to the conversation in
    /// the order the model asked for them, counting them in [`Self::turn_calls`]. The result of the
    /// call that brings the turn to [`SessionConfig::warn_at_tool_calls`] says how many are left
    /// once the message's calls have run, once a turn.
    async fn run_calls(
        &mut self,
        calls: &[ToolCall],
        cut: bool,
        cancel: &Cancel,
    ) -> Result<(), AgentError> {
        // Reads are asked about one by one and then run at the same time. Any other call waits for
        // the reads before it and runs on its own, so the calls take effect in the model's order,
        // and their answers go back in that order whichever finished first.
        let mut answers: Vec<Option<Answer>> =
            std::iter::repeat_with(|| None).take(calls.len()).collect();
        let mut reads: Vec<Read> = Vec::new();
        self.unsent_pictures = (0, 0);
        // The call whose result says how many are left.
        let mut warned_at = None;
        for (place, call) in calls.iter().enumerate() {
            let read = self.read_tool(call, &reads);
            if read.is_none() {
                self.run_reads(&mut reads, &mut answers, cancel).await?;
            }
            let answer = if self.turn_calls.made >= self.config.max_tool_calls {
                (NOT_RUN_AT_LIMIT.to_owned(), Vec::new())
            } else if cancel.is_cancelled() {
                ("Not run: the turn was cancelled.".to_owned(), Vec::new())
            } else {
                self.turn_calls.made += 1;
                if !self.turn_calls.warned && self.turn_calls.made >= self.config.warns_at() {
                    self.turn_calls.warned = true;
                    warned_at = Some(place);
                }
                match read {
                    Some(tool) => match self.begin_read(tool, call, cut).await? {
                        Begun::Allowed(input) => {
                            reads.push(Read {
                                place,
                                call,
                                tool,
                                input,
                            });
                            continue;
                        }
                        Begun::Answered(answer) => (answer, Vec::new()),
                    },
                    None => self.run_tool(call, cut, cancel).await?,
                }
            };
            self.hold_unsent(&answer.1);
            answers[place] = Some(answer);
        }
        self.run_reads(&mut reads, &mut answers, cancel).await?;
        self.unsent_pictures = (0, 0);
        if let Some(Some((content, _))) = warned_at.and_then(|place| answers.get_mut(place)) {
            content.push_str(&self.calls_left());
        }
        for (call, answer) in calls.iter().zip(answers) {
            let (content, pictures) = answer.unwrap_or_default();
            self.history.push(Message::Tool {
                tool_call_id: call.id.clone(),
                content,
                pictures,
            });
        }
        Ok(())
    }

    /// The line that tells the model how many tool calls its turn has left, once it was warned and
    /// while it has any: at none left, it is asked for its answer instead.
    fn calls_left(&self) -> String {
        let left = self
            .config
            .max_tool_calls
            .saturating_sub(self.turn_calls.made);
        if !self.turn_calls.warned || left == 0 {
            return String::new();
        }
        format!(
            "\n\n{left} tool call{} left in this turn.",
            if left == 1 { "" } else { "s" }
        )
    }

    /// Takes back the request for the answer at the limit when the call made for it was cancelled
    /// or failed: left last, it would join the next turn's prompt and tell it no calls will run.
    fn take_back_last_answer(&mut self) {
        if matches!(self.history.last(), Some(Message::User { content, .. }) if content == LAST_ANSWER)
        {
            self.history.pop();
        }
    }

    /// Counts `pictures` among the ones the running message's calls opened.
    fn hold_unsent(&mut self, pictures: &[Picture]) {
        let (count, bytes) = &mut self.unsent_pictures;
        *count += pictures.len();
        *bytes += pictures
            .iter()
            .map(|picture| picture.data.len())
            .sum::<usize>();
    }

    /// The pictures the operator sent with a prompt, as the model is shown them: none when it
    /// can't see pictures, and only as many as the conversation has room for, in order. One that
    /// can't be read is left out; its path is in the prompt's words, and `read_file` says why.
    async fn shown(&self, paths: &[PathBuf]) -> Vec<Picture> {
        if paths.is_empty() || !self.config.sees_pictures {
            return Vec::new();
        }
        let (held, bytes) = self.pictures_held();
        let mut room = self.config.max_pictures.saturating_sub(held);
        let mut space = self.config.max_picture_bytes.saturating_sub(bytes);
        let mut shown = Vec::new();
        for path in paths {
            if room == 0 {
                break;
            }
            let file = path.clone();
            // Reading a picture turns and shrinks it in a helper process: off the async workers.
            let read = tokio::task::spawn_blocking(move || crate::documents::read(&file)).await;
            let Ok(Ok(crate::documents::Document::Picture(picture))) = read else {
                continue;
            };
            if picture.data.len() > space {
                continue;
            }
            room -= 1;
            space -= picture.data.len();
            shown.push(Picture {
                name: path.file_name().map_or_else(
                    || path.to_string_lossy().into_owned(),
                    |name| name.to_string_lossy().into_owned(),
                ),
                media_type: picture.media_type,
                data: picture.data,
            });
        }
        shown
    }

    /// The turn's prompt joins the conversation, dated, after any pictures it was sent with.
    fn begin_turn(&mut self, text: &str, pictures: Vec<Picture>) {
        text.clone_into(&mut self.task);
        self.turn_calls = ToolCalls::default();
        // Nothing has been sent yet, so the instructions can still list the skills this work
        // calls for: the first message says what it is.
        if self.history.len() == 1
            && self.skills.picks_by_work()
            && self.config.skill_focus.is_none()
        {
            let system = instructions(&self.config, self.host.as_ref(), &self.skills, text);
            self.history[0] = Message::System { content: system };
        }
        self.history.push(Message::User {
            content: format!("{text}\n\n{}", self.today()),
            pictures,
        });
    }

    /// The tools offered to the model. The same list on every call of the session: it leads the
    /// prompt the provider caches, so a list that changed part way would make the next call pay
    /// for the whole conversation again.
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
                // Added last, with the daemon's tools.
                Builtin::ReadToolOutput => false,
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
        // Offered from the first call, before anything is set aside, so the list never changes.
        let read_output = Builtin::ReadToolOutput.name();
        if !specs.is_empty() && !specs.iter().any(|spec| spec.name == read_output) {
            specs.push(Builtin::ReadToolOutput.spec());
        }
        specs
    }

    /// The id the model's latest words are recorded under: its latest message's, or the latest
    /// part's of it.
    fn message_id(&self) -> String {
        part_id(
            &format!("{}-{}", self.config.session_id, self.messages_written),
            self.message_part,
        )
    }

    async fn call_model(&mut self, cancel: &Cancel, call: Call) -> Result<Completion, CallError> {
        self.messages_written += 1;
        self.message_part = 0;
        let message_id = self.message_id();
        let bare = matches!(call, Call::BareSummary | Call::BareLastAnswer);
        let offered = !bare || self.provider.keeps_tools_when_off(&self.config.model);
        let tools = if offered {
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
            server_tools: if offered && self.config.tools.web {
                ServerTools {
                    web_search: true,
                    web_fetch: true,
                    limits: self.config.web,
                }
            } else {
                ServerTools::default()
            },
            max_tokens: match call {
                Call::Summary | Call::BareSummary => self.config.max_tokens.min(DEFAULT_REPLY),
                Call::Work | Call::CarryOn | Call::LastAnswer | Call::BareLastAnswer => {
                    self.config.max_tokens
                }
            },
            tools_off: bare && offered,
            session_key: &self.config.session_id,
            agent_id: &self.config.agent_id,
        };
        let deltas = Streaming {
            sink: self.sink.as_ref(),
            message_id: &message_id,
            quiet: matches!(call, Call::Summary | Call::BareSummary),
            parts: Mutex::default(),
        };
        let completion = self.provider.complete(&request, &deltas, cancel).await;
        self.message_part = deltas.parts().current();
        completion
    }

    /// Whether the next model call may be made: [`Spend`] says so, and nobody cancelled the turn
    /// while it waited for the operator.
    async fn may_call(&self, cancel: &Cancel) -> bool {
        tokio::select! {
            go = self.spend.before_call() => go == Go::Ahead && !cancel.is_cancelled(),
            () = cancel.cancelled() => false,
        }
    }

    async fn count(
        &mut self,
        completion: &Completion,
        turn: &mut Usage,
        call: Call,
    ) -> Result<(), AgentError> {
        let usage = &completion.usage;
        turn.add(usage);
        self.usage.add(usage);
        self.spend.spent(usage);
        self.last_prompt_tokens = completion
            .context_tokens
            .unwrap_or(usage.prompt_tokens() + usage.output_tokens);
        if self.provider.is_demo() && usage.total_tokens() == 0 {
            return Ok(());
        }
        let record = events::CallRecord {
            call: call.as_str(),
            turn: &self.turn,
            model: &self.config.model,
            usage,
        };
        self.emit(events::usage_update(
            self.last_prompt_tokens,
            self.config.context_window,
            self.usage.cost_usd,
            &record,
        ))
        .await
    }

    /// The line each turn's message ends with: today's date where the team works.
    fn today(&self) -> String {
        today_line(
            self.config.time_zone.as_deref(),
            self.config.now.unwrap_or_else(chrono::Utc::now),
        )
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
            let result = call
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (title, kind) = server_tool_title(name, &input, result);
            self.emit(events::tool_call(&id, &title, kind, &input, &[]))
                .await?;
            self.emit(events::tool_update(
                &id,
                ToolStatus::Completed,
                &cut(result, RECORDED_OUTPUT_CHARS),
            ))
            .await?;
        }
        Ok(())
    }

    /// Runs one tool call and gives back what goes into the conversation. `cut` says the length
    /// limit cut the model's message off, so a call with broken arguments was never finished.
    async fn run_tool(
        &mut self,
        call: &ToolCall,
        cut: bool,
        cancel: &Cancel,
    ) -> Result<(String, Vec<Picture>), AgentError> {
        let Ok(input @ Value::Object(_)) = serde_json::from_str::<Value>(&call.arguments) else {
            let said = self.broken_arguments(call, cut).await?;
            return Ok((said, Vec::new()));
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
        Ok((
            self.for_conversation(&call.id, output.text),
            output.pictures,
        ))
    }

    /// How many pictures the conversation holds now, and how much data they are in base64, with
    /// the ones the running message's calls opened.
    fn pictures_held(&self) -> (usize, usize) {
        self.history
            .iter()
            .flat_map(|message| match message {
                Message::Tool { pictures, .. } | Message::User { pictures, .. } => {
                    pictures.as_slice()
                }
                _ => &[],
            })
            .fold(self.unsent_pictures, |(count, bytes), picture| {
                (count + 1, bytes + picture.data.len())
            })
    }

    /// What the model is told about a call whose arguments aren't a JSON object, recorded as a
    /// failed call. `cut` says the length limit cut its message off before the call was finished.
    async fn broken_arguments(&self, call: &ToolCall, cut: bool) -> Result<String, AgentError> {
        // Told why, or the model makes the same call again and is cut off at the same place.
        let said = if cut {
            format!(
                "Not run: your message reached the length limit of one reply before this call to \
                 {} was complete. Make it smaller: split the work into several calls (write a long \
                 file in parts, the first with write_file and the rest with edit_file), and keep \
                 your thinking short.",
                call.name
            )
        } else {
            format!(
                "The arguments for {} weren't a JSON object. Call it again with valid arguments.",
                call.name
            )
        };
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
        Ok(said)
    }

    /// The read-only built-in `call` is for, when it can run at the same time as `reads`: any
    /// read but one of a set-aside output that a read among them has still to set aside, or one
    /// that opens a picture. A picture takes room the conversation has only so much of, so it is
    /// opened on its own, knowing what the calls before it opened.
    fn read_tool(&self, call: &ToolCall, reads: &[Read<'_>]) -> Option<Builtin> {
        let tool = Builtin::named(&call.name).filter(|tool| tool.only_reads())?;
        let input = serde_json::from_str::<Value>(&call.arguments).ok();
        let text = |key: &str| input.as_ref().and_then(|input| input.get(key)?.as_str());
        match tool {
            Builtin::ReadToolOutput => {
                let id = text("id");
                if reads.iter().any(|read| Some(read.call.id.as_str()) == id) {
                    return None;
                }
            }
            Builtin::ReadFile => {
                // Only a plain file is looked into: opening a pipe to read its start would wait
                // for whatever writes to it.
                let file = text("path").map(|path| {
                    tools::resolve_reading(&self.config.cwd, &self.config.knowledge, path)
                });
                if file.is_some_and(|file| {
                    std::fs::metadata(&file).is_ok_and(|meta| meta.is_file())
                        && Kind::of(&file) == Some(Kind::Picture)
                }) {
                    return None;
                }
            }
            _ => {}
        }
        self.offers(tool).then_some(tool)
    }

    /// A read worked out, recorded and asked about, as [`Self::run_tool`] would, but not run yet.
    async fn begin_read(
        &mut self,
        tool: Builtin,
        call: &ToolCall,
        cut: bool,
    ) -> Result<Begun, AgentError> {
        let Ok(input @ Value::Object(_)) = serde_json::from_str::<Value>(&call.arguments) else {
            return self.broken_arguments(call, cut).await.map(Begun::Answered);
        };
        Ok(match self.allow_builtin(tool, call, input).await? {
            Ok(input) => Begun::Allowed(input),
            Err(output) => Begun::Answered(self.for_conversation(&call.id, output.text)),
        })
    }

    /// Runs the allowed `reads` all at once, and puts each one's answer in its place.
    async fn run_reads(
        &mut self,
        reads: &mut Vec<Read<'_>>,
        answers: &mut [Option<Answer>],
        cancel: &Cancel,
    ) -> Result<(), AgentError> {
        if reads.is_empty() {
            return Ok(());
        }
        let outputs = futures_util::future::join_all(
            reads
                .iter()
                .map(|read| self.finish_builtin(read.tool, read.call, &read.input, cancel)),
        )
        .await;
        for (read, output) in reads.drain(..).zip(outputs) {
            let output = output?;
            let text = self.for_conversation(&read.call.id, output.text);
            self.hold_unsent(&output.pictures);
            answers[read.place] = Some((text, output.pictures));
        }
        Ok(())
    }

    fn offers(&self, tool: Builtin) -> bool {
        self.tool_specs()
            .iter()
            .any(|spec| spec.name == tool.name())
    }

    async fn run_host(&self, call: &ToolCall, input: Value) -> Result<Output, AgentError> {
        let ask = self.host.asks(&call.name);
        let recorded = !self.host.records_own_calls(&call.name);
        if recorded {
            let title = ask
                .as_ref()
                .map_or(call.name.as_str(), |ask| ask.title.as_str());
            self.emit(events::tool_call(
                &call.id,
                title,
                ToolKind::Other,
                &input,
                &[],
            ))
            .await?;
        }
        if let Some(ask) = ask {
            // A connected tool's call reaches the operator's own accounts: it asks first (ADR 0069),
            // with what it would send. The operator's change, offered for a command, isn't here.
            let request = PermissionRequest {
                session_id: self.config.session_id.clone(),
                tool_call_id: call.id.clone(),
                title: ask.title,
                kind: ToolKind::Other,
                input: json!({"server": ask.server, "tool": ask.call, "arguments": input}),
                locations: Vec::new(),
            };
            let refused = match self.permissions.request(&request).await {
                Decision::Allow | Decision::AllowEdited(_) => None,
                Decision::Deny => Some(Output::failed(
                    "The person declined this. Carry on without it, or say what you need and why.",
                )),
                Decision::Answer(answer) => Some(Output::ok(format!(
                    "The person answered instead of letting this run: {answer}"
                ))),
            };
            if let Some(output) = refused {
                if recorded {
                    let status = if output.failed {
                        ToolStatus::Failed
                    } else {
                        ToolStatus::Completed
                    };
                    self.emit(events::tool_update(&call.id, status, &output.text))
                        .await?;
                }
                return Ok(output);
            }
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
        Ok(Output {
            text,
            failed,
            pictures: Vec::new(),
        })
    }

    async fn run_builtin(
        &self,
        tool: Builtin,
        call: &ToolCall,
        input: Value,
        cancel: &Cancel,
    ) -> Result<Output, AgentError> {
        match self.allow_builtin(tool, call, input).await? {
            Ok(input) => self.finish_builtin(tool, call, &input, cancel).await,
            Err(answered) => Ok(answered),
        }
    }

    /// Works the call out, records it and asks [`Permissions`]: the arguments to run it with,
    /// which the person may have changed, or what it is answered with instead of running.
    async fn allow_builtin(
        &self,
        tool: Builtin,
        call: &ToolCall,
        mut input: Value,
    ) -> Result<Result<Value, Output>, AgentError> {
        let prepared = match tool.prepare(&input, &self.config.cwd, &self.config.knowledge) {
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
                return Ok(Err(Output::failed(said)));
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
                    if let Err(said) =
                        tool.prepare(&edited, &self.config.cwd, &self.config.knowledge)
                    {
                        let said = format!("The person's change didn't work: {said}");
                        self.emit(events::tool_update(&call.id, ToolStatus::Failed, &said))
                            .await?;
                        return Ok(Err(Output::failed(said)));
                    }
                    input = edited;
                }
                Decision::Deny => {
                    let said = "The person declined this. Carry on without it, or say what you \
                                need and why."
                        .to_owned();
                    self.emit(events::tool_update(&call.id, ToolStatus::Failed, &said))
                        .await?;
                    return Ok(Err(Output::failed(said)));
                }
                Decision::Answer(answer) => {
                    let said = format!("The person answered instead of letting this run: {answer}");
                    self.emit(events::tool_update(&call.id, ToolStatus::Completed, &said))
                        .await?;
                    return Ok(Err(Output::ok(said)));
                }
            }
        }
        Ok(Ok(input))
    }

    /// Runs an allowed call and records how it ended.
    async fn finish_builtin(
        &self,
        tool: Builtin,
        call: &ToolCall,
        input: &Value,
        cancel: &Cancel,
    ) -> Result<Output, AgentError> {
        let output = match tool {
            Builtin::UpdatePlan => self.update_plan(input).await?,
            Builtin::ReadToolOutput => self.read_output(input),
            _ => {
                let settings = CommandSettings {
                    network: self.config.tools.web,
                    writable: self.config.writable.clone(),
                };
                let context = Context {
                    cwd: &self.config.cwd,
                    connected: &self.config.knowledge,
                    cancel,
                    command: &settings,
                    pictures: {
                        let (held, bytes) = self.pictures_held();
                        Pictures {
                            seen: self.config.sees_pictures,
                            room: self.config.max_pictures.saturating_sub(held),
                            bytes: self.config.max_picture_bytes.saturating_sub(bytes),
                        }
                    },
                };
                tool.run(input, &context).await
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
        if text.chars().count() <= SET_ASIDE_CHARS {
            return text;
        }
        let note = set_aside_note(&text, id, SET_ASIDE_PREVIEW_CHARS);
        self.outputs.insert(id.to_owned(), text);
        note
    }

    fn needs_compacting(&self) -> bool {
        let window = self.config.context_window.unwrap_or(DEFAULT_CONTEXT);
        self.estimate() >= summarise_at(window) && self.history.len() > 3
    }

    /// About how many tokens the next request will take: what the provider counted for the last
    /// call, and the messages added since at [`BYTES_PER_TOKEN`]. With nothing counted yet (a
    /// resumed session, one just summarised, a provider that doesn't say), the whole conversation
    /// is estimated that way.
    ///
    /// Going by the last call alone, one step that read several long files or pages could carry the
    /// next call past the model's limit before anything was summarised. Counting bytes is rough,
    /// but it guesses only what was added since the last count, and a guess that comes out low is
    /// caught when the provider refuses the call ([`Self::make_room`]). The models' own tokenizers
    /// aren't all published, and asking the provider to count would be a call of its own.
    fn estimate(&self) -> u64 {
        let counted = if self.last_prompt_tokens == 0 {
            0
        } else {
            self.unread_from()
        };
        self.last_prompt_tokens + tokens(self.history[counted..].iter().map(size).sum())
    }

    /// Where the messages the model hasn't read yet start: after its newest message.
    fn unread_from(&self) -> usize {
        self.history
            .iter()
            .rposition(|message| matches!(message, Message::Assistant { .. }))
            .map_or(0, |index| index + 1)
    }

    /// How many tokens a request for a summary may take and leave the model room for the longest
    /// summary.
    fn request_room(&self) -> u64 {
        self.config
            .context_window
            .unwrap_or(DEFAULT_CONTEXT)
            .saturating_sub(u64::from(self.config.max_tokens.min(DEFAULT_REPLY)))
    }

    /// Cuts tool results down, each to its start with its whole text set aside for
    /// `read_tool_output`, until the conversation is estimated to take no more than `room` tokens.
    /// The newest go first, to the preview a long output gets: the model hasn't read them yet, so
    /// they were never sent. Then the ones it has read, oldest first and shorter, and last the
    /// newest as short. Nothing is cut while the conversation fits.
    ///
    /// A tool result is the one part of the conversation cut once sent: the providers send it as
    /// plain text, never signed, so the model's reasoning stays valid.
    fn make_fit(&mut self, room: u64) {
        let unread = self.unread_from();
        let results = |range: std::ops::Range<usize>| -> Vec<usize> {
            range
                .filter(|&index| matches!(self.history[index], Message::Tool { .. }))
                .collect()
        };
        let newest = results(unread..self.history.len());
        let older = results(0..unread);
        let cuts = newest
            .iter()
            .map(|&index| (index, SET_ASIDE_PREVIEW_CHARS))
            .chain(older.iter().map(|&index| (index, TRIMMED_PREVIEW_CHARS)))
            .chain(newest.iter().map(|&index| (index, TRIMMED_PREVIEW_CHARS)));
        for (index, keep) in cuts {
            if self.estimate() <= room {
                return;
            }
            let removed = self.cut_result(index, keep);
            if index < unread {
                // Part of what the last call counted.
                self.last_prompt_tokens = self.last_prompt_tokens.saturating_sub(tokens(removed));
            }
        }
    }

    /// Cuts the tool result at `index` down to its first `keep` characters and sets its whole text
    /// aside, and takes out the pictures it opened, which can be opened again. Gives back how many
    /// bytes the conversation lost, a picture counted as [`PICTURE_SIZE`].
    fn cut_result(&mut self, index: usize, keep: usize) -> usize {
        let Some(Message::Tool {
            tool_call_id,
            content,
            pictures,
        }) = self.history.get(index)
        else {
            return 0;
        };
        let names: Vec<&str> = pictures
            .iter()
            .map(|picture| picture.name.as_str())
            .collect();
        // One set aside before is cut from its whole text, which stays under its id.
        let (id, whole) = match self.set_aside_whole(tool_call_id, content) {
            Some(whole) => (tool_call_id.clone(), whole.clone()),
            None => (self.free_id(tool_call_id), content.clone()),
        };
        let cut = set_aside_note(&whole, &id, keep);
        let mut text = content.clone();
        let mut removed = 0;
        if cut.len() < content.len() {
            removed = content.len() - cut.len();
            self.outputs.insert(id, whole);
            text = cut;
        }
        if !names.is_empty() {
            let note = format!(
                "\n(Taken out to make room in the model's memory: {}. Open it again with \
                 read_file if you still need to see it.)",
                names.join(", ")
            );
            removed = (removed + names.len() * PICTURE_SIZE).saturating_sub(note.len());
            text.push_str(&note);
        }
        if removed == 0 {
            return 0;
        }
        if let Some(Message::Tool {
            content, pictures, ..
        }) = self.history.get_mut(index)
        {
            *content = text;
            pictures.clear();
        }
        removed
    }

    /// The whole text of a tool result set aside before, when `content` is what the conversation
    /// kept of it.
    fn set_aside_whole(&self, id: &str, content: &str) -> Option<&String> {
        let whole = self.outputs.get(id)?;
        let (kept, note) = content.rsplit_once(SET_ASIDE_MARK)?;
        (whole.starts_with(kept) && note.contains(&format!("read_tool_output, id {id},")))
            .then_some(whole)
    }

    /// `id`, or `id-2`, `id-3`… when another output was set aside under it already.
    fn free_id(&self, id: &str) -> String {
        let mut key = id.to_owned();
        let mut copy = 1;
        while self.outputs.contains_key(&key) {
            copy += 1;
            key = format!("{id}-{copy}");
        }
        key
    }

    /// Makes room after the provider refused a call because the conversation no longer fits the
    /// model, and summarises it. Gives back whether it was summarised.
    ///
    /// The tool results are cut down until the conversation is estimated at half of what the model
    /// has room for, or of the request just refused if that is less. The estimate didn't see this
    /// coming, so it, or the context size the catalog gave, is out by an amount nobody knows: half
    /// leaves room for both, and every cut result can still be read whole.
    async fn make_room(&mut self, cancel: &Cancel, turn: &mut Usage) -> Result<bool, CallError> {
        let room = self.request_room().min(self.estimate()) / 2;
        self.make_fit(room);
        self.compact(cancel, turn).await
    }

    /// One request for a summary, which is not part of the work whatever happens. `shorter` asks
    /// again after one the length limit cut off.
    async fn summarise(
        &mut self,
        cancel: &Cancel,
        call: Call,
        turn: &mut Usage,
        shorter: bool,
    ) -> Result<Completion, CallError> {
        self.history.push(Message::User {
            content: summary_request(shorter),
            pictures: Vec::new(),
        });
        let completion = self.call_model(cancel, call).await;
        self.history.pop();
        let completion = completion?;
        self.count(&completion, turn, call)
            .await
            .map_err(CallError::Failed)?;
        Ok(completion)
    }

    /// Replaces the conversation with a summary of it, keeping the instructions and the current
    /// task. The model writes the summary, so it keeps what matters for the work. Gives back whether
    /// the conversation was replaced.
    async fn compact(&mut self, cancel: &Cancel, turn: &mut Usage) -> Result<bool, CallError> {
        // The summary reads the whole conversation and the request for it. Most of the time they
        // fit beside the summary's reply and nothing is cut; when the newest step added more than
        // that, its results are cut down first rather than have the summary refused.
        let request = tokens(summary_request(true).len());
        self.make_fit(self.request_room().saturating_sub(request));
        let task = self.task.clone();
        // The conversation plus one more message: everything before it is read from the cache.
        let mut completion = self.summarise(cancel, Call::Summary, turn, false).await?;
        if completion.content.trim().is_empty() && self.may_call(cancel).await {
            completion = self
                .summarise(cancel, Call::BareSummary, turn, false)
                .await?;
        }
        // A summary the length limit cut off has lost its end, which is what is left to do: it is
        // asked for once more, shorter, and a second cut one is not used.
        if completion.finish == Finish::Length && self.may_call(cancel).await {
            completion = self.summarise(cancel, Call::Summary, turn, true).await?;
        }
        if completion.content.trim().is_empty() || completion.finish == Finish::Length {
            // No summary to carry on from: the conversation stays as it was.
            return Ok(false);
        }
        let Some(Message::System { content: system }) = self.history.first().cloned() else {
            return Ok(false);
        };
        // The Brief came in the opening message; a summary of a later turn would drop it.
        let brief = loomwatch_brief(&self.config.cwd)
            .filter(|_| !task.contains(crate::memory::TEAM_KNOWLEDGE_HEADING))
            .map(|brief| format!("## Standing notes from the operator\n{brief}\n\n"))
            .unwrap_or_default();
        self.history = vec![
            Message::System { content: system },
            Message::User {
                content: format!(
                    "## Where the work stands\n{}\n\n{brief}## Your current task, as you were given \
                     it\n{task}\n\nCarry on from where the summary leaves off.{}\n\n{}",
                    completion.content.trim(),
                    // A warning the summary replaced still holds.
                    self.calls_left(),
                    self.today()
                ),
                pictures: Vec::new(),
            },
        ];
        self.last_prompt_tokens = 0;
        self.emit(events::thought_chunk(
            "(The conversation was summarised to make room in the model's memory.)",
        ))
        .await
        .map_err(CallError::Failed)?;
        Ok(true)
    }
}

/// How many tokens the conversation may take in a context of `window` before it is summarised.
fn summarise_at(window: u64) -> u64 {
    let counted = window.min(COMPACT_WINDOW_CAP);
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    let line = (counted as f64 * COMPACT_AT).ceil() as u64;
    line
}

/// About how many tokens `bytes` of text make.
pub(super) fn tokens(bytes: usize) -> u64 {
    u64::try_from(bytes).unwrap_or(u64::MAX) / BYTES_PER_TOKEN
}

/// How many bytes of text a message sends: its words, and the names and arguments of the tools it
/// calls. The reasoning a provider hands back is left out: some send it again, some don't.
fn size(message: &Message) -> usize {
    match message {
        Message::System { content } => content.len(),
        Message::User { content, pictures }
        | Message::Tool {
            content, pictures, ..
        } => content.len() + pictures.len() * PICTURE_SIZE,
        Message::Assistant {
            content,
            tool_calls,
            ..
        } => {
            content.len()
                + tool_calls
                    .iter()
                    .map(|call| call.name.len() + call.arguments.len())
                    .sum::<usize>()
        }
    }
}

/// What the conversation keeps of an output set aside under `id`: its first `keep` characters,
/// and how to read the rest.
fn set_aside_note(text: &str, id: &str, keep: usize) -> String {
    let total = text.chars().count();
    let preview: String = text.chars().take(keep).collect();
    format!(
        "{preview}{SET_ASIDE_MARK}{total} characters long; the rest was set aside. Read it with \
         read_tool_output, id {id}, starting at offset {keep}."
    )
}

/// Why a turn that may not make its next call ends: it was cancelled, or the spool is used up.
fn stopped(cancel: &Cancel) -> StopReason {
    if cancel.is_cancelled() {
        StopReason::Cancelled
    } else {
        StopReason::SpendLimit
    }
}

fn ended(stop_reason: StopReason, usage: Usage, words: &Words) -> TurnEnd {
    let said = if words.answer.is_empty() {
        &words.on_the_way
    } else {
        &words.answer
    };
    TurnEnd {
        stop_reason,
        usage,
        reply: said.join("\n\n").trim_end().to_owned(),
    }
}

/// What a turn wrote, each message a paragraph. The reply is its answer: the messages that asked
/// for no tool. What it wrote alongside tool calls was said on the way ("I'll read the notes
/// first."), and is the reply only when the turn wrote nothing else.
#[derive(Default)]
struct Words {
    answer: Vec<String>,
    on_the_way: Vec<String>,
}

/// Adds a message's words to the turn's reply: a paragraph of its own, or, when `carrying_on`,
/// the rest of the paragraph the length limit cut off. A `cut` message keeps its last space, and a
/// carried-on one its first, so the two join as the model wrote them.
fn take_reply(reply: &mut Vec<String>, content: &str, carrying_on: bool, cut: bool) {
    let mut text = content;
    if !carrying_on {
        text = text.trim_start();
    }
    if !cut {
        text = text.trim_end();
    }
    if text.trim().is_empty() {
        return;
    }
    match reply.last_mut() {
        Some(last) if carrying_on => last.push_str(text),
        _ => reply.push(text.to_owned()),
    }
}

/// What the agent is told when the length limit cut its reply off.
fn carry_on(wrote_nothing: bool) -> &'static str {
    if wrote_nothing {
        "Your reply was cut off before you wrote any of it: your thinking used up the length limit \
         of one message. Think less this time, and write your reply."
    } else {
        "Your reply was cut off: it reached the length limit of one message. Carry on from exactly \
         where it stopped, without repeating anything or saying that you are carrying on."
    }
}

/// A read the model asked for, allowed and waiting to run with the reads beside it.
struct Read<'c> {
    /// Where its answer goes among its message's calls.
    place: usize,
    call: &'c ToolCall,
    tool: Builtin,
    /// The arguments it runs with, which the person may have changed.
    input: Value,
}

/// What a call puts in the conversation: its text, and the pictures it opened.
type Answer = (String, Vec<Picture>);

/// Where a read stands once it was asked about.
enum Begun {
    /// Allowed, with the arguments to run it with.
    Allowed(Value),
    /// Answered without running: declined, answered by the person, or not a call it could make.
    Answered(String),
}

/// What a model call is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Call {
    /// The agent's work, streamed to the operator as it is written.
    Work,
    /// The work again after the length limit cut a reply off: the rest of the reply, or a tool
    /// call made smaller.
    CarryOn,
    /// A summary the agent writes for itself, with the same tools offered as for the work, so the
    /// provider reads the whole conversation from its cache.
    Summary,
    /// The same summary with no tools, for a model that called one instead of writing it.
    BareSummary,
    /// The answer once the turn has made as many tool calls as it may (ADR 0088), streamed as the
    /// work is, with the same tools offered so the provider reads the conversation from its
    /// cache. None of them runs.
    LastAnswer,
    /// The same answer with no tool the model may call, for a model that called one instead.
    BareLastAnswer,
}

impl Call {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Work => WORK,
            Self::CarryOn => "carry_on",
            Self::Summary => "summary",
            Self::BareSummary => "bare_summary",
            Self::LastAnswer => "last_answer",
            Self::BareLastAnswer => "bare_last_answer",
        }
    }
}

/// The tool calls a turn has run, and whether a result has said how many are left.
#[derive(Default)]
struct ToolCalls {
    made: usize,
    warned: bool,
}

/// What a turn is for when nothing says otherwise.
pub const WORK: &str = "work";

/// The instructions a session starts with, listing the skills `work` calls for.
fn instructions(
    config: &SessionConfig,
    host: &dyn HostTools,
    skills: &SkillIndex,
    work: &str,
) -> String {
    let abilities = Abilities {
        files: config.tools.files,
        commands: config.tools.commands,
        web: config.tools.web.then(|| config.web.page_words()),
        plan: config.tools.plan,
        ask_user: host.specs().iter().any(|tool| tool.name == "ask_user"),
    };
    let notes = if config.tools.files {
        project_notes(&config.cwd)
    } else {
        None
    };
    system_prompt(
        &config.cwd,
        abilities,
        config.person.as_ref(),
        &config.lessons,
        &prompt_section(skills, work),
        notes.as_deref(),
        config.instructions.as_deref(),
    )
}

/// What the agent is asked for a summary of its conversation.
fn summary_request(shorter: bool) -> String {
    let mut request = String::from(
        "Your conversation is getting too long to work with. Write a summary of it for yourself to \
         carry on from: what the task is, what you have done and found, what you decided and why, \
         and what is left to do. Keep, exactly as they are: the address (URL) and date of every \
         source you have used or will cite, every figure, name and quote you will need, the file \
         names you worked on, and the id of any set-aside output you may read again. Be complete \
         but brief. Don't call any tools: reply with the summary only.",
    );
    if shorter {
        request.push_str(
            " Your last summary was cut off by the length limit of one reply: make this one \
             shorter, and think less before you write it.",
        );
    }
    request
}

/// `text` without the date line a turn's message ends with: the prompt as it was given.
pub(crate) fn without_date(text: &str) -> &str {
    match text.rsplit_once(DATE_LINE) {
        Some((prompt, line)) if !line.contains('\n') => prompt,
        _ => text,
    }
}

/// How the date line starts, a paragraph of its own at the end of a turn's message.
const DATE_LINE: &str = "\n\nToday is ";

/// "Today is Sunday 18 October 2026 (Asia/Singapore)." in `time_zone`, or in this computer's own
/// zone, named by its offset from UTC, when there is none or it isn't one.
pub(super) fn today_line(time_zone: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> String {
    const DATE: &str = "%A %-d %B %Y";
    if let Some((zone, name)) = time_zone
        .map(str::trim)
        .and_then(|name| Some((name.parse::<chrono_tz::Tz>().ok()?, name)))
    {
        return format!(
            "Today is {} ({name}).",
            now.with_timezone(&zone).format(DATE)
        );
    }
    let local = now.with_timezone(&chrono::Local);
    format!(
        "Today is {} (UTC{}).",
        local.format(DATE),
        local.format("%:z")
    )
}

/// The provider's name for a team file's effort. `default` leaves it to the model. Each provider
/// moves an effort it doesn't take to the nearest one it does, so `ultra` reaches the `ChatGPT`
/// plan's models that take it, and `OpenRouter` and Claude get `max`.
fn provider_effort(effort: Option<&str>) -> Option<&'static str> {
    match effort?.trim().to_ascii_lowercase().as_str() {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        "ultra" => Some("ultra"),
        _ => None,
    }
}

/// What a call the provider ran on its own side is called in the run record, and its kind.
///
/// Claude's newer web tools write and run code to search and read, so a call can be code, or a
/// search or page read that code started. One started by code can come with no input, and the page
/// it read is then known only from its result ("Read <address>"). Code is said as code, never as a
/// search: it ran on the provider's computer, not this one, so it is not a command either.
fn server_tool_title(name: &str, input: &Value, result: &str) -> (String, ToolKind) {
    let text = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    if name.contains("code_execution") || text("code").is_some() {
        let line = text("code")
            .or_else(|| text("command"))
            .and_then(|code| code.lines().map(str::trim).find(|line| !line.is_empty()))
            .map(|line| {
                let short: String = line.chars().take(80).collect();
                if short.len() < line.len() {
                    format!("{short}…")
                } else {
                    short
                }
            });
        return match line {
            Some(line) => (format!("Run code: {line}"), ToolKind::Other),
            None => ("Run code".to_owned(), ToolKind::Other),
        };
    }
    if name.ends_with("web_fetch") {
        let read = result
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("Read "))
            .map(str::trim);
        return match text("url").or(read) {
            Some(url) => (format!("Read {url}"), ToolKind::Fetch),
            None => ("Read a page".to_owned(), ToolKind::Fetch),
        };
    }
    match text("query") {
        Some(query) => (format!("Search the web: {query}"), ToolKind::Fetch),
        None => ("Search the web".to_owned(), ToolKind::Fetch),
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

/// The id the `part`th part of the message `message_id` is recorded under ([`Parts`]). The first
/// part's is the message's own.
fn part_id(message_id: &str, part: usize) -> String {
    if part == 0 {
        message_id.to_owned()
    } else {
        format!("{message_id}.{part}")
    }
}

/// Streams a reply's text and reasoning to the sink as they arrive.
struct Streaming<'a> {
    sink: &'a dyn EventSink,
    message_id: &'a str,
    /// A summary the agent writes for itself isn't shown.
    quiet: bool,
    /// Where the provider's own searches split the message: each part is recorded as a message
    /// of its own.
    parts: Mutex<Parts>,
}

impl Streaming<'_> {
    fn parts(&self) -> Parts {
        *self.parts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn emit(&self, update: Value) -> Result<(), CallError> {
        self.sink
            .update(update)
            .await
            .map_err(|error| CallError::Failed(AgentError::Record(error)))
    }
}

impl DeltaSink for Streaming<'_> {
    fn text<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>> {
        Box::pin(async move {
            if self.quiet {
                return Ok(());
            }
            let (begun, part) = {
                let mut parts = self.parts.lock().unwrap_or_else(PoisonError::into_inner);
                (parts.begins(text), parts.current())
            };
            // The words before a search were said on the way to it, and the record says so before
            // the words after it begin.
            if begun {
                self.emit(events::commentary(&part_id(self.message_id, part - 1)))
                    .await?;
            }
            self.emit(events::message_chunk(text, &part_id(self.message_id, part)))
                .await
        })
    }

    fn server_tool(&self) {
        self.parts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .tool();
    }

    fn reasoning<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>> {
        Box::pin(async move {
            if self.quiet {
                return Ok(());
            }
            self.emit(events::thought_chunk(text)).await
        })
    }
}

#[cfg(test)]
mod effort_tests {
    use super::provider_effort;

    /// `ultra` goes on to the provider, which knows whether its model takes it: the `ChatGPT` plan's
    /// biggest models do. `default` and a word no provider knows leave it to the model.
    #[test]
    fn every_effort_reaches_the_provider_as_set() {
        for effort in [
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ] {
            assert_eq!(provider_effort(Some(effort)), Some(effort));
        }
        assert_eq!(provider_effort(Some(" Ultra ")), Some("ultra"));
        assert_eq!(provider_effort(Some("default")), None);
        assert_eq!(provider_effort(Some("turbo")), None);
        assert_eq!(provider_effort(None), None);
    }
}
