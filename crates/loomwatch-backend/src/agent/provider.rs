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
use super::openrouter::{OpenRouter, through_messages};
use crate::ai::Source;

/// One message of the conversation, in the agent's own order. It is append-only: a model that
/// signs its reasoning (Claude's "preserved thinking") refuses a history whose earlier turns were
/// edited, so nothing here is rewritten once sent. Compaction replaces the whole history instead.
/// The one exception is a tool's result, which no provider signs: a conversation too long for the
/// model has its results cut down to their start before it is summarised.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    System {
        content: String,
    },
    User {
        content: String,
        /// Pictures the operator sent with these words (ADR 0082), shown before them.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pictures: Vec<Picture>,
    },
    Assistant {
        content: String,
        /// The provider's reasoning blocks for this message, passed back exactly as received.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reasoning_details: Vec<Value>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
        /// The message in the shape its provider wrote it (Anthropic's content blocks, the
        /// Responses API's items), sent back to that provider unchanged: Claude refuses a history
        /// whose signed thinking was rewritten. Chat completions has none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native: Option<Native>,
    },
    Tool {
        tool_call_id: String,
        content: String,
        /// Pictures the tool opened for the model to look at, after its words.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pictures: Vec<Picture>,
    },
}

/// A picture in the conversation, as every provider takes one: its bytes in base64, and what kind
/// of picture they are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Picture {
    /// The file it came from, as the agent named it.
    pub name: String,
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub media_type: String,
    /// The picture's bytes in standard base64.
    pub data: String,
}

impl Picture {
    /// The picture as a `data:` address, the way the `OpenAI` APIs take one.
    #[must_use]
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.media_type, self.data)
    }
}

/// A message in the shape one provider writes it: Anthropic's content blocks (from Anthropic, or
/// from `OpenRouter`'s `/messages`) or the Responses API's output items. Only the source that wrote
/// it reads it back; any other ignores it.
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
    /// `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `minimal` or `none`; `None` leaves it to
    /// the model. Each provider moves one its model doesn't take to the nearest it does.
    pub effort: Option<&'a str>,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
    pub server_tools: ServerTools,
    pub max_tokens: u32,
    /// The tools are offered only so the conversation stays as it was: the model must not call
    /// one. A summary, or the answer at a turn's tool-call limit, on a provider that signs its
    /// reasoning asks this rather than offering none,
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
    /// The provider paused it part way through the searches, page reads and code it runs itself,
    /// more times than one call carries on; the step it had begun last was taken out unrun.
    Paused,
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
    /// Where the message's last part begins in `content` ([`Parts`]): what comes before it was
    /// said on the way to a search the provider ran. Zero when nothing was.
    pub answer_from: usize,
    /// The message as the provider wrote it, when it is not `OpenRouter`: see [`Native`].
    pub native: Option<Native>,
    /// How full the model's context was after the message, when `usage` adds up more than one
    /// request (a paused reply carried on): the last request's prompt and what it wrote. `None`
    /// when `usage` says it.
    pub context_tokens: Option<u64>,
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
            answer_from: 0,
            native: None,
            context_tokens: None,
        }
    }

    /// A reply whose provider ran a search between each of `parts`, for the demo and tests.
    #[must_use]
    pub fn searched(parts: &[&str]) -> Self {
        let mut written = Written::default();
        for (place, part) in parts.iter().enumerate() {
            if place > 0 {
                written.tool();
            }
            written.text(part);
        }
        Self {
            answer_from: written.answer_from,
            ..Self::text(&written.content)
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

/// Where a call nobody watches being written streams to: nowhere ([`Provider::once`]).
struct Quiet;

impl DeltaSink for Quiet {
    fn text<'a>(&'a self, _text: &'a str) -> BoxFuture<'a, Result<(), CallError>> {
        Box::pin(async { Ok(()) })
    }

    fn reasoning<'a>(&'a self, _text: &'a str) -> BoxFuture<'a, Result<(), CallError>> {
        Box::pin(async { Ok(()) })
    }

    fn server_tool(&self) {}
}

/// Where a provider sends the text as it streams in, so the operator watches it being written.
pub(crate) trait DeltaSink: Send + Sync {
    fn text<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>>;
    fn reasoning<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<(), CallError>>;
    /// The provider began a tool it runs itself (a web search, a page read): what the model
    /// writes next comes after its result ([`Parts`]).
    fn server_tool(&self);
}

/// Where the tools a provider runs itself split one model message. A model that searches the web
/// part way through a message writes on either side of the search ("Let me check the prices.",
/// then the answer), and the provider sends both as one message. The words after a search are a
/// part of their own, and the words before it were said on the way to it, as words written
/// alongside a tool call are. A search with nothing said before it, or nothing after, splits
/// nothing.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Parts {
    /// Which part the latest words belong to, from 0.
    current: usize,
    /// The message has said something.
    said: bool,
    /// The provider began a tool since the latest words.
    after_tool: bool,
}

impl Parts {
    pub(crate) fn tool(&mut self) {
        self.after_tool = true;
    }

    /// Takes the model's next `piece` of words, and says whether it begins a new part.
    pub(crate) fn begins(&mut self, piece: &str) -> bool {
        if piece.trim().is_empty() {
            return false;
        }
        let begins = self.said && self.after_tool;
        self.said = true;
        self.after_tool = false;
        self.current += usize::from(begins);
        begins
    }

    pub(crate) const fn current(self) -> usize {
        self.current
    }
}

/// One model message's words as a provider puts them together, its [`Parts`] a paragraph apart.
#[derive(Debug, Default)]
pub(crate) struct Written {
    pub(crate) content: String,
    /// Where the last part begins in `content`.
    pub(crate) answer_from: usize,
    parts: Parts,
}

impl Written {
    pub(crate) fn text(&mut self, piece: &str) {
        if self.parts.begins(piece) {
            let have = trailing_newlines(&self.content) + leading_newlines(piece);
            for _ in have..2 {
                self.content.push('\n');
            }
            self.answer_from = self.content.len();
        }
        self.content.push_str(piece);
    }

    pub(crate) fn tool(&mut self) {
        self.parts.tool();
    }
}

fn trailing_newlines(text: &str) -> usize {
    text.bytes().rev().take_while(|byte| *byte == b'\n').count()
}

fn leading_newlines(text: &str) -> usize {
    text.bytes().take_while(|byte| *byte == b'\n').count()
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

    /// One question, with no tools and no conversation before it: `system` says the job, `user`
    /// carries what it is about. The reply's words and what the call used, or why there were none,
    /// in words.
    pub(crate) async fn once(
        &self,
        model: &str,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> Result<Completion, String> {
        let messages = [
            Message::System {
                content: system.to_owned(),
            },
            Message::User {
                content: user.to_owned(),
                pictures: Vec::new(),
            },
        ];
        let key = format!("once-{}", uuid::Uuid::new_v4().simple());
        let request = ChatRequest {
            model,
            effort: Some("low"),
            messages: &messages,
            tools: &[],
            server_tools: ServerTools::default(),
            max_tokens,
            tools_off: false,
            session_key: &key,
            agent_id: "",
        };
        // Nobody stops it: it ends with the reply, or fails.
        let (_stop, never) = watch::channel(false);
        match self.complete(&request, &Quiet, &Cancel::new(never)).await {
            Ok(completion) => Ok(completion),
            Err(CallError::Cancelled) => Err("it was stopped".to_owned()),
            Err(CallError::Failed(error)) => Err(error.to_string()),
        }
    }

    /// Whether this is the offline demo, which never calls a model and never costs anything.
    #[must_use]
    pub fn is_demo(&self) -> bool {
        matches!(self, Self::Demo(_))
    }

    /// Whether a call that must not use a tool (a summary, or the answer at a turn's tool-call
    /// limit) keeps the session's tools, asking the model not to call them
    /// ([`ChatRequest::tools_off`]), rather than going without: true where the conversation is signed
    /// and must not change under it, as it is for a Claude on `OpenRouter`'s `/messages`.
    #[must_use]
    pub fn keeps_tools_when_off(&self, model: &str) -> bool {
        match self {
            Self::OpenRouter(_) => through_messages(model),
            Self::Demo(_) => false,
            Self::Anthropic(_) | Self::ChatGpt(_) => true,
        }
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

#[cfg(test)]
mod tests {
    use super::{Parts, Written};

    /// The words after a search the provider ran are a paragraph of their own and where the
    /// answer begins. Blank words don't begin a part, and a search with nothing said before it
    /// splits nothing.
    #[test]
    fn a_search_splits_a_message_only_between_words() {
        let mut written = Written::default();
        written.text("Let me check.");
        written.tool();
        written.text("\n");
        written.tool();
        written.text("Basic costs 139,000 VND.");
        assert_eq!(written.content, "Let me check.\n\nBasic costs 139,000 VND.");
        assert_eq!(
            &written.content[written.answer_from..],
            "Basic costs 139,000 VND."
        );

        let mut written = Written::default();
        written.tool();
        written.text("Basic costs 139,000 VND.");
        written.tool();
        assert_eq!(written.content, "Basic costs 139,000 VND.");
        assert_eq!(written.answer_from, 0);

        let mut parts = Parts::default();
        assert!(!parts.begins("Let me check."));
        parts.tool();
        assert!(!parts.begins("  \n"));
        assert!(parts.begins("Basic"));
        assert!(!parts.begins(" costs"));
        assert_eq!(parts.current(), 1);
    }
}
