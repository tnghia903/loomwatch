//! The conversation as the agent keeps it, and the one call every provider answers: take the
//! conversation so far, stream the model's next message.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;

use super::BoxFuture;
use super::anthropic::Anthropic;
use super::chatgpt::ChatGptPlan;
use super::demo::Demo;
use super::error::CallError;
use super::openrouter::OpenRouter;
use crate::ai::Source;

/// One message of the conversation, in the agent's own order. It is append-only: a model that
/// signs its reasoning (Claude's "preserved thinking") refuses a history whose earlier turns were
/// edited, so nothing here is rewritten once sent. Compaction replaces the whole history instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: String,
        /// The provider's reasoning blocks for this message, passed back exactly as received.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reasoning_details: Vec<Value>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
        /// The message as a provider other than `OpenRouter` wrote it, sent back to that provider
        /// unchanged: Claude refuses a history whose signed thinking was rewritten.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native: Option<Native>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

/// A message in the shape one provider writes it: Anthropic's content blocks or the Responses API's
/// output items. Only that provider reads it back; any other ignores it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Native {
    pub source: Source,
    pub items: Vec<Value>,
}

/// A tool the model asked to call. `arguments` is the JSON text the model wrote, kept as text so
/// it goes back to the provider byte for byte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// A tool offered to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// A JSON Schema for the arguments.
    pub parameters: Value,
}

/// Tools the provider runs itself, so the agent never sees their requests. They are offered only
/// to an agent allowed the web, because nothing can ask the operator about them one by one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ServerTools {
    pub web_search: bool,
    pub web_fetch: bool,
    /// How much of the web one call may read.
    pub limits: WebLimits,
}

/// How much web reading one model call may do (a team file's `spend.web`). Every page read stays
/// in the conversation, and every later call reads the conversation again, so a page costs far
/// more than once. Only the page length is held by default: how many pages and searches a call
/// may make is left to `OpenRouter` (30 steps) until a quality benchmark shows a lower figure
/// keeps the work as good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebLimits {
    /// How much of one page is read, in tokens. A longer page is cut.
    pub page_tokens: u32,
    /// Pages one call may read. `None`: `OpenRouter`'s own limit.
    pub pages: Option<u32>,
    /// Searches one call may run. `None`: `OpenRouter`'s own limit.
    pub searches: Option<u32>,
    /// Searches and page reads together in one call. `None`: `OpenRouter`'s own limit.
    pub steps: Option<u32>,
}

impl ServerTools {
    /// Whether any is offered.
    #[must_use]
    pub const fn any(self) -> bool {
        self.web_search || self.web_fetch
    }
}

impl WebLimits {
    /// About 12,000 words: a long article, a documentation page or most reports whole; a book-length
    /// page cut.
    pub const PAGE_TOKENS: u32 = 16_000;

    /// About how many words of a page are read: a token is about three quarters of a word.
    #[must_use]
    pub fn page_words(self) -> u32 {
        let words = self.page_tokens / 4 * 3;
        // Rounded to a figure a person would say.
        if words >= 1_000 {
            (words + 500) / 1_000 * 1_000
        } else {
            (words + 50) / 100 * 100
        }
    }
}

impl Default for WebLimits {
    fn default() -> Self {
        Self {
            page_tokens: Self::PAGE_TOKENS,
            pages: None,
            searches: None,
            steps: None,
        }
    }
}

/// Everything one model call needs.
#[derive(Debug, Clone, Copy)]
pub struct ChatRequest<'a> {
    pub model: &'a str,
    /// `low`, `medium`, `high`, `xhigh`, `max`, `minimal` or `none`; `None` leaves it to the model.
    pub effort: Option<&'a str>,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
    pub server_tools: ServerTools,
    pub max_tokens: u32,
    /// The tools are offered only so the conversation stays as it was: the model must not call
    /// one. A summary on a provider that signs its reasoning asks this rather than offering none,
    /// which would change what came before and undo the signatures and the prompt cache.
    pub tools_off: bool,
    /// Groups the calls of one session, so the provider keeps routing them to the same place and
    /// its prompt cache keeps working.
    pub session_key: &'a str,
    /// Which agent is asking. Only the offline demo reads it.
    pub agent_id: &'a str,
}

/// Why the model stopped writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    Stop,
    ToolCalls,
    /// It reached the reply length limit mid-message.
    Length,
    /// The provider's safety filter stopped it.
    ContentFilter,
}

/// What one model call cost, in tokens and in dollars. `input_tokens` counts only the prompt
/// tokens not served from the cache, the way the run archive has always counted them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub cached_read_tokens: u64,
    pub cached_write_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cost_usd: f64,
    /// Web searches and page reads the provider ran for the call. Zero for a provider that says
    /// nothing of them and a session parked before they were counted.
    #[serde(default)]
    pub web_searches: u64,
    #[serde(default)]
    pub web_fetches: u64,
    /// Who paid, when it was not `OpenRouter`. A `ChatGPT` plan's calls cost the plan's allowance,
    /// not dollars, so their `cost_usd` is zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paid_by: Option<Source>,
    /// `cost_usd` was worked out from list prices rather than reported by the provider.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cost_estimated: bool,
}

impl Usage {
    pub fn add(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.cached_read_tokens += other.cached_read_tokens;
        self.cached_write_tokens += other.cached_write_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
        self.cost_usd += other.cost_usd;
        self.web_searches += other.web_searches;
        self.web_fetches += other.web_fetches;
        self.paid_by = self.paid_by.or(other.paid_by);
        self.cost_estimated |= other.cost_estimated;
    }

    /// Every prompt token, cached or not: how full the model's context was for this call.
    #[must_use]
    pub fn prompt_tokens(&self) -> u64 {
        self.input_tokens + self.cached_read_tokens + self.cached_write_tokens
    }

    #[must_use]
    pub fn total_tokens(&self) -> u64 {
        self.prompt_tokens() + self.output_tokens
    }
}

/// A finished model message.
#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    pub content: String,
    pub reasoning_details: Vec<Value>,
    pub tool_calls: Vec<ToolCall>,
    pub finish: Finish,
    pub usage: Usage,
    /// Searches and fetches the provider ran on the model's behalf, for the record.
    pub server_tool_calls: Vec<Value>,
    /// The message as the provider wrote it, when it is not `OpenRouter`: see [`Native`].
    pub native: Option<Native>,
}

impl Completion {
    /// A plain reply with no tools, for the demo and tests.
    #[must_use]
    pub fn text(content: &str) -> Self {
        Self {
            content: content.to_owned(),
            reasoning_details: Vec::new(),
            tool_calls: Vec::new(),
            finish: Finish::Stop,
            usage: Usage::default(),
            server_tool_calls: Vec::new(),
            native: None,
        }
    }

    /// A reply that calls tools, for tests.
    #[must_use]
    pub fn calls(content: &str, calls: Vec<ToolCall>) -> Self {
        Self {
            finish: Finish::ToolCalls,
            tool_calls: calls,
            ..Self::text(content)
        }
    }
}

/// Where a provider sends the text as it streams in, so the operator watches it being written.
pub(crate) trait DeltaSink: Send + Sync {
    fn text<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>>;
    fn reasoning<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>>;
}

/// The model providers `LoomWatch` can run an agent on.
#[derive(Debug, Clone)]
pub enum Provider {
    OpenRouter(Arc<OpenRouter>),
    /// The person's own Claude API key (ADR 0073).
    Anthropic(Arc<Anthropic>),
    /// The person's `ChatGPT` plan, through the sign-in with `ChatGPT` (ADR 0073).
    ChatGpt(Arc<ChatGptPlan>),
    Demo(Demo),
}

impl Provider {
    /// Stream the model's next message.
    pub(crate) async fn complete(
        &self,
        request: &ChatRequest<'_>,
        deltas: &dyn DeltaSink,
        cancel: &Cancel,
    ) -> Result<Completion, CallError> {
        match self {
            Self::OpenRouter(provider) => provider.complete(request, deltas, cancel).await,
            // Boxed: a provider's call is a large future, and Windows builds count it larger still.
            Self::Anthropic(provider) => Box::pin(provider.complete(request, deltas, cancel)).await,
            Self::ChatGpt(provider) => Box::pin(provider.complete(request, deltas, cancel)).await,
            // A stopped turn stops the demo too, as it stops a stream.
            Self::Demo(demo) => tokio::select! {
                completion = demo.complete(request, deltas) => completion,
                () = cancel.cancelled() => Err(CallError::Cancelled),
            },
        }
    }

    /// Whether this is the offline demo, which never calls a model and never costs anything.
    #[must_use]
    pub fn is_demo(&self) -> bool {
        matches!(self, Self::Demo(_))
    }

    /// Whether a summary keeps the session's tools, asking the model not to call them
    /// ([`ChatRequest::tools_off`]), rather than going without: true where the conversation is signed
    /// and must not change under it.
    #[must_use]
    pub fn keeps_tools_for_summaries(&self) -> bool {
        !matches!(self, Self::OpenRouter(_) | Self::Demo(_))
    }
}

/// The cancelling side of a turn: [`CancelHandle`](super::CancelHandle) flips it, the turn
/// watches it.
#[derive(Debug, Clone)]
pub(crate) struct Cancel(watch::Receiver<bool>);

impl Cancel {
    pub(crate) fn new(receiver: watch::Receiver<bool>) -> Self {
        Self(receiver)
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    /// Resolves once the turn is cancelled. Never resolves for a turn nobody cancels.
    pub(crate) async fn cancelled(&self) {
        let mut receiver = self.0.clone();
        // An error means the handle is gone, so nothing can cancel any more: wait forever.
        if receiver.wait_for(|cancelled| *cancelled).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}
