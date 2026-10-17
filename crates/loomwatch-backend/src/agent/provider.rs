//! The conversation as the agent keeps it, and the one call every provider answers: take the
//! conversation so far, stream the model's next message.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;

use super::BoxFuture;
use super::demo::Demo;
use super::error::CallError;
use super::openrouter::OpenRouter;

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
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
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
}

impl Usage {
    pub fn add(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.cached_read_tokens += other.cached_read_tokens;
        self.cached_write_tokens += other.cached_write_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
        self.cost_usd += other.cost_usd;
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
            Self::Demo(demo) => demo.complete(request, deltas).await,
        }
    }

    /// Whether this is the offline demo, which never calls a model and never costs anything.
    #[must_use]
    pub fn is_demo(&self) -> bool {
        matches!(self, Self::Demo(_))
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
