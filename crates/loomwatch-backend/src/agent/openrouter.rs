//! `OpenRouter`, the first provider: one key, every model it lists.
//!
//! One streamed `POST /chat/completions` per model call, in `OpenAI`'s chat shape with `OpenRouter`'s
//! extras:
//! - `reasoning.effort`, and `reasoning_details` passed back unchanged so a model that signs its
//!   reasoning keeps it across tool calls;
//! - `cache_control` for Anthropic models, which cache only when asked;
//! - `session_id`, so a session's calls stay on one route and keep their cache;
//! - the `openrouter:web_search` and `openrouter:web_fetch` server tools for an agent allowed the
//!   web, held to its `spend.web` limits: how much of a page is read and, when the team sets them,
//!   how many pages, searches and server-tool steps one call takes. A provider that refuses the
//!   limits gets the tools without them, so a run never fails over a limit;
//! - exact `usage.cost`, in dollars, and the web searches and page reads, in the stream's last
//!   chunk.
//!
//! Requests are retried only before anything has streamed: once text has reached the operator, a
//! retry would write it twice. That covers a busy model reported inside the stream, as `OpenRouter`
//! does once it has answered `200`, as long as it comes before the model's first word.

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{Map, Value, json};

use super::ApiKey;
use super::error::{AgentError, CallError, redact};
use super::provider::{
    Cancel, ChatRequest, Completion, DeltaSink, Finish, Message, ServerTools, ToolCall, Usage,
};
use super::sse::SseDecoder;
use crate::ai::Source;

/// Where `OpenRouter`'s API lives.
pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// Names a stand-in for `OpenRouter` on this computer, for trial copies and end-to-end checks that
/// must not spend real credit.
pub const BASE_URL_ENV: &str = "LOOMWATCH_OPENROUTER_URL";

/// Where the daemon reaches `OpenRouter`: [`DEFAULT_BASE_URL`], or the stand-in [`BASE_URL_ENV`]
/// names. Every caller (the agent, the key check, the model list) asks here, so they agree.
#[must_use]
pub fn base_url() -> String {
    choose_base(std::env::var(BASE_URL_ENV).ok().as_deref())
}

/// [`base_url`] for a given setting. Only an `http` address on this computer is taken, so a stray
/// setting can never send the key off it; anything else is reported and ignored.
fn choose_base(setting: Option<&str>) -> String {
    let Some(setting) = setting.map(str::trim).filter(|setting| !setting.is_empty()) else {
        return DEFAULT_BASE_URL.to_owned();
    };
    let setting = setting.trim_end_matches('/');
    if is_loopback_http(setting) {
        return setting.to_owned();
    }
    eprintln!(
        "warning: {BASE_URL_ENV} must be an http address on this computer (127.0.0.1, localhost \
         or [::1]); using OpenRouter itself"
    );
    DEFAULT_BASE_URL.to_owned()
}

/// Whether `url` is plain `http` to this computer, which is the one place it may skip TLS.
#[must_use]
pub fn is_loopback_http(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    })
}
/// How `OpenRouter` names `LoomWatch` on its dashboards.
pub(crate) const REFERER: &str = "https://github.com/tnghia903/loomwatch";
pub(crate) const TITLE: &str = "LoomWatch";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Silence allowed between two pieces of a stream. `OpenRouter` sends a comment every few seconds
/// while a model thinks, so this much silence means the connection is gone.
const STREAM_IDLE: Duration = Duration::from_mins(3);
/// Tries for a request refused before anything streamed: rate limits and server errors.
const ATTEMPTS: u32 = 4;
/// The longest wait between tries, whatever the server's `Retry-After` asks.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// An error body worth reading is a few hundred bytes.
const MAX_ERROR_BYTES: usize = 64 * 1024;
/// Words in a refusal that say it was the web limits, not the request, the provider could not take.
const LIMIT_FIELDS: [&str; 5] = [
    "max_tool_calls",
    "max_uses",
    "max_content_tokens",
    "server tool",
    "openrouter:web",
];

/// A connection to `OpenRouter` with the operator's key.
#[derive(Debug)]
pub struct OpenRouter {
    client: Client,
    base: String,
    key: ApiKey,
    backoff: Duration,
    /// Models whose provider refused the web limits, so they get the web tools without them for as
    /// long as the daemon runs, and don't pay for a refused call each time.
    unlimited: Mutex<HashSet<String>>,
}

impl OpenRouter {
    /// `OpenRouter` itself.
    ///
    /// # Errors
    ///
    /// When the HTTP client cannot be built.
    pub fn new(key: ApiKey) -> anyhow::Result<Self> {
        Self::with_base(key, &base_url())
    }

    /// Another address speaking `OpenRouter`'s API: `https`, or `http` on this computer for tests.
    ///
    /// # Errors
    ///
    /// When `base` is neither, or the HTTP client cannot be built.
    pub fn with_base(key: ApiKey, base: &str) -> anyhow::Result<Self> {
        let base = base.trim_end_matches('/').to_owned();
        let local = is_loopback_http(&base);
        anyhow::ensure!(
            base.starts_with("https://") || local,
            "an OpenRouter address must be https"
        );
        let client = Client::builder()
            .user_agent(concat!("LoomWatch/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!local)
            .build()?;
        Ok(Self {
            client,
            base,
            key,
            backoff: Duration::from_secs(1),
            unlimited: Mutex::default(),
        })
    }

    /// The same connection waiting `backoff` between tries, so tests don't wait seconds.
    #[cfg(test)]
    pub(crate) fn with_backoff(mut self, backoff: Duration) -> Self {
        self.backoff = backoff;
        self
    }

    pub(crate) async fn complete(
        &self,
        request: &ChatRequest<'_>,
        deltas: &dyn DeltaSink,
        cancel: &Cancel,
    ) -> Result<Completion, CallError> {
        let mut limited = request.server_tools.any() && !self.refuses_limits(request.model);
        let mut body = body(request, limited);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let sent = self
                .client
                .post(format!("{}/chat/completions", self.base))
                .bearer_auth(self.key.expose())
                .header("HTTP-Referer", REFERER)
                .header("X-OpenRouter-Title", TITLE)
                .json(&body)
                .send();
            let response = tokio::select! {
                response = sent => response,
                () = cancel.cancelled() => return Err(CallError::Cancelled),
            };
            let response = match response {
                Ok(response) => response,
                Err(error) if attempt < ATTEMPTS && (error.is_connect() || error.is_timeout()) => {
                    self.wait(attempt, None, cancel).await?;
                    continue;
                }
                Err(error) => {
                    return Err(
                        AgentError::Network(Source::OpenRouter, network_error(&error)).into(),
                    );
                }
            };
            let status = response.status();
            if status.is_success() {
                match read_stream(response, request.model, deltas, cancel).await? {
                    Streamed::Whole(completion) => return Ok(completion),
                    Streamed::Refused { status, said } => {
                        if limited && refused_the_limits(status, &said) {
                            self.forget_limits(request.model);
                            limited = false;
                            body = self::body(request, false);
                            continue;
                        }
                        if attempt < ATTEMPTS && retryable(status) {
                            self.wait(attempt, None, cancel).await?;
                            continue;
                        }
                        return Err(status_error(status, &said, request.model).into());
                    }
                }
            }
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            if attempt < ATTEMPTS && retryable(status) {
                self.wait(attempt, retry_after, cancel).await?;
                continue;
            }
            let said = read_error_body(response).await;
            if limited && refused_the_limits(status, &said) {
                self.forget_limits(request.model);
                limited = false;
                body = self::body(request, false);
                continue;
            }
            return Err(status_error(status, &said, request.model).into());
        }
    }

    fn refuses_limits(&self, model: &str) -> bool {
        self.unlimited
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(model)
    }

    fn forget_limits(&self, model: &str) {
        eprintln!(
            "warning: {model}'s provider refused the web limits; it reads the web without them"
        );
        self.unlimited
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(model.to_owned());
    }

    async fn wait(
        &self,
        attempt: u32,
        retry_after: Option<Duration>,
        cancel: &Cancel,
    ) -> Result<(), CallError> {
        let doubled = self.backoff * 2u32.saturating_pow(attempt - 1);
        let wait = retry_after.unwrap_or(doubled).min(MAX_BACKOFF);
        tokio::select! {
            () = tokio::time::sleep(wait) => Ok(()),
            () = cancel.cancelled() => Err(CallError::Cancelled),
        }
    }
}

fn retryable(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

/// Whether a refusal was the provider saying it can't take the web limits: a bad request that
/// names one of them.
fn refused_the_limits(status: StatusCode, said: &str) -> bool {
    let lower = said.to_lowercase();
    matches!(
        status,
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
    ) && LIMIT_FIELDS.iter().any(|field| lower.contains(field))
}

/// The request body. `limited` holds the web tools to the request's limits.
fn body(request: &ChatRequest<'_>, limited: bool) -> Value {
    let mut tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            })
        })
        .collect();
    let ServerTools {
        web_search,
        web_fetch,
        limits,
    } = request.server_tools;
    // A page longer than the limit is cut rather than filling the conversation. A figure the team
    // leaves out is left to `OpenRouter`.
    let server_tool = |kind: &str, parameters: Map<String, Value>| {
        if limited && !parameters.is_empty() {
            json!({"type": kind, "parameters": parameters})
        } else {
            json!({"type": kind})
        }
    };
    let uses = |count: Option<u32>| {
        count
            .map(|count| Map::from_iter([("max_uses".to_owned(), json!(count))]))
            .unwrap_or_default()
    };
    if web_search {
        tools.push(server_tool("openrouter:web_search", uses(limits.searches)));
    }
    if web_fetch {
        let mut parameters = uses(limits.pages);
        parameters.insert("max_content_tokens".into(), json!(limits.page_tokens));
        tools.push(server_tool("openrouter:web_fetch", parameters));
    }
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert(
        "messages".into(),
        Value::Array(wire_messages(request.messages)),
    );
    body.insert("stream".into(), json!(true));
    body.insert("max_completion_tokens".into(), json!(request.max_tokens));
    body.insert("session_id".into(), json!(request.session_key));
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
        body.insert("parallel_tool_calls".into(), json!(true));
    }
    // The steps one call's server tools may take together, when the team sets it: `max_uses`
    // binds only some search engines, and this binds them all.
    if let Some(steps) = limits
        .steps
        .filter(|_| limited && (web_search || web_fetch))
    {
        body.insert("max_tool_calls".into(), json!(steps));
    }
    // `OpenRouter` has no `ultra`, so it goes as its highest, `max`.
    if let Some(effort) = request.effort {
        let effort = if effort == "ultra" { "max" } else { effort };
        body.insert("reasoning".into(), json!({"effort": effort}));
    }
    // Anthropic's models cache a prompt only when asked; the others cache on their own.
    if request.model.starts_with("anthropic/") {
        body.insert("cache_control".into(), json!({"type": "ephemeral"}));
    }
    Value::Object(body)
}

/// The conversation as chat messages. A `tool` message carries text only, so the pictures a turn's
/// tools opened follow its tool results in one user message, each after the name of its file.
fn wire_messages(history: &[Message]) -> Vec<Value> {
    let mut messages = Vec::with_capacity(history.len());
    let mut pictures: Vec<Value> = Vec::new();
    for (index, message) in history.iter().enumerate() {
        messages.push(wire_message(message));
        if let Message::Tool {
            pictures: opened, ..
        } = message
        {
            for picture in opened {
                pictures.push(
                    json!({"type": "text", "text": format!("The picture {} shows:", picture.name)}),
                );
                pictures
                    .push(json!({"type": "image_url", "image_url": {"url": picture.data_url()}}));
            }
        }
        let results_end = !matches!(history.get(index + 1), Some(Message::Tool { .. }));
        if results_end && !pictures.is_empty() {
            messages.push(json!({"role": "user", "content": std::mem::take(&mut pictures)}));
        }
    }
    messages
}

fn wire_message(message: &Message) -> Value {
    match message {
        Message::System { content } => json!({"role": "system", "content": content}),
        Message::User { content } => json!({"role": "user", "content": content}),
        Message::Assistant {
            content,
            reasoning_details,
            tool_calls,
            ..
        } => {
            let mut wire = Map::new();
            wire.insert("role".into(), json!("assistant"));
            wire.insert(
                "content".into(),
                if content.is_empty() && !tool_calls.is_empty() {
                    Value::Null
                } else {
                    json!(content)
                },
            );
            if !tool_calls.is_empty() {
                wire.insert(
                    "tool_calls".into(),
                    tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {"name": call.name, "arguments": call.arguments},
                            })
                        })
                        .collect(),
                );
            }
            if !reasoning_details.is_empty() {
                wire.insert(
                    "reasoning_details".into(),
                    Value::Array(reasoning_details.clone()),
                );
            }
            Value::Object(wire)
        }
        Message::Tool {
            tool_call_id,
            content,
            ..
        } => json!({"role": "tool", "tool_call_id": tool_call_id, "content": content}),
    }
}

/// The message a stream assembles, piece by piece.
#[derive(Default)]
struct Assembled {
    content: String,
    reasoning_details: Vec<Value>,
    calls: Vec<PartialCall>,
    finish: Option<Finish>,
    usage: Usage,
    /// Whether anything has reached the operator yet.
    streamed: bool,
    /// An error the stream reported before the model wrote anything.
    refused: Option<(StatusCode, String)>,
}

impl Assembled {
    /// Whether the model has written anything at all: text, reasoning or part of a tool call.
    fn begun(&self) -> bool {
        self.streamed || !self.calls.is_empty() || !self.reasoning_details.is_empty()
    }
}

/// How a stream that `OpenRouter` accepted ended.
enum Streamed {
    Whole(Completion),
    /// It reported an error before the model wrote anything, so trying again repeats nothing.
    Refused {
        status: StatusCode,
        said: String,
    },
}

#[derive(Default)]
struct PartialCall {
    index: u64,
    id: String,
    name: String,
    arguments: String,
}

async fn read_stream(
    mut response: reqwest::Response,
    model: &str,
    deltas: &dyn DeltaSink,
    cancel: &Cancel,
) -> Result<Streamed, CallError> {
    let mut decoder = SseDecoder::default();
    let mut message = Assembled::default();
    loop {
        let chunk = tokio::select! {
            chunk = tokio::time::timeout(STREAM_IDLE, response.chunk()) => chunk,
            () = cancel.cancelled() => return Err(CallError::Cancelled),
        };
        let chunk = match chunk {
            Err(_) => return Err(AgentError::Stalled(Source::OpenRouter).into()),
            Ok(Err(error)) => {
                return Err(AgentError::Network(Source::OpenRouter, network_error(&error)).into());
            }
            Ok(Ok(None)) => break,
            Ok(Ok(Some(bytes))) => bytes,
        };
        for event in decoder.push(&chunk) {
            if event.trim() == "[DONE]" {
                return Ok(Streamed::Whole(finish(message)));
            }
            take_event(&event, &mut message, model, deltas).await?;
            if let Some((status, said)) = message.refused.take() {
                return Ok(Streamed::Refused { status, said });
            }
        }
    }
    if let Some(event) = decoder.finish()
        && event.trim() != "[DONE]"
    {
        take_event(&event, &mut message, model, deltas).await?;
        if let Some((status, said)) = message.refused.take() {
            return Ok(Streamed::Refused { status, said });
        }
    }
    if message.finish.is_none() && message.content.is_empty() && message.calls.is_empty() {
        return Err(AgentError::Stalled(Source::OpenRouter).into());
    }
    Ok(Streamed::Whole(finish(message)))
}

async fn take_event(
    event: &str,
    message: &mut Assembled,
    model: &str,
    deltas: &dyn DeltaSink,
) -> Result<(), CallError> {
    let Ok(chunk) = serde_json::from_str::<Value>(event) else {
        // A line that isn't JSON is noise between events, not the model's answer.
        return Ok(());
    };
    if let Some(error) = chunk.get("error") {
        let code = error.get("code").and_then(Value::as_u64).unwrap_or(0);
        let said = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the stream ended with an error");
        let status = u16::try_from(code)
            .ok()
            .and_then(|code| StatusCode::from_u16(code).ok())
            .unwrap_or(StatusCode::BAD_GATEWAY);
        if !message.begun() {
            message.refused = Some((status, said.to_owned()));
            return Ok(());
        }
        return Err(status_error(status, said, model).into());
    }
    if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
        message.usage = read_usage(usage);
    }
    let Some(choice) = chunk.pointer("/choices/0") else {
        return Ok(());
    };
    if let Some(delta) = choice.get("delta") {
        if let Some(text) = delta.get("content").and_then(Value::as_str)
            && !text.is_empty()
        {
            message.content.push_str(text);
            message.streamed = true;
            deltas.text(text).await?;
        }
        if let Some(text) = delta.get("reasoning").and_then(Value::as_str)
            && !text.is_empty()
        {
            message.streamed = true;
            deltas.reasoning(text).await?;
        }
        if let Some(details) = delta.get("reasoning_details").and_then(Value::as_array) {
            for detail in details {
                merge_reasoning(&mut message.reasoning_details, detail);
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                merge_call(&mut message.calls, call);
            }
        }
    }
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        message.finish = Some(match reason {
            "tool_calls" => Finish::ToolCalls,
            "length" => Finish::Length,
            "content_filter" => Finish::ContentFilter,
            "error" => {
                return Err(AgentError::Provider(
                    Source::OpenRouter,
                    "the model stopped with an error partway through its reply".to_owned(),
                )
                .into());
            }
            _ => Finish::Stop,
        });
    }
    Ok(())
}

/// Adds one streamed reasoning piece. Pieces of one block share an `index` and a `type`: their
/// text joins up, and whatever else they carry (a signature, an id) is the block's final word.
fn merge_reasoning(details: &mut Vec<Value>, piece: &Value) {
    let index = piece.get("index");
    let kind = piece.get("type");
    let existing = index.and_then(|index| {
        details
            .iter_mut()
            .find(|detail| detail.get("index") == Some(index) && detail.get("type") == kind)
    });
    let (Some(existing), Some(piece)) = (existing, piece.as_object()) else {
        details.push(piece.clone());
        return;
    };
    let Some(existing) = existing.as_object_mut() else {
        return;
    };
    for (key, value) in piece {
        match (key.as_str(), existing.get_mut(key), value) {
            ("text" | "summary" | "data", Some(Value::String(held)), Value::String(more)) => {
                held.push_str(more);
            }
            _ => {
                existing.insert(key.clone(), value.clone());
            }
        }
    }
}

/// Adds one streamed tool-call piece. The first piece of a call carries its id and name; later
/// ones carry more of its arguments under the same `index`.
fn merge_call(calls: &mut Vec<PartialCall>, piece: &Value) {
    let index = piece
        .get("index")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| u64::try_from(calls.len()).unwrap_or(u64::MAX));
    let id = piece.get("id").and_then(Value::as_str);
    let name = piece.pointer("/function/name").and_then(Value::as_str);
    let arguments = piece.pointer("/function/arguments").and_then(Value::as_str);
    let position = calls
        .iter()
        .position(|call| call.index == index)
        .unwrap_or_else(|| {
            calls.push(PartialCall {
                index,
                ..PartialCall::default()
            });
            calls.len() - 1
        });
    let call = &mut calls[position];
    if let Some(id) = id.filter(|id| !id.is_empty()) {
        id.clone_into(&mut call.id);
    }
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        if call.name.is_empty() {
            name.clone_into(&mut call.name);
        } else if id.is_none() {
            call.name.push_str(name);
        }
    }
    if let Some(arguments) = arguments {
        call.arguments.push_str(arguments);
    }
}

fn finish(message: Assembled) -> Completion {
    let tool_calls: Vec<ToolCall> = message
        .calls
        .into_iter()
        .enumerate()
        .filter(|(_, call)| !call.name.is_empty())
        .map(|(position, call)| ToolCall {
            id: if call.id.is_empty() {
                format!("call_{position}")
            } else {
                call.id
            },
            name: call.name,
            arguments: if call.arguments.trim().is_empty() {
                "{}".to_owned()
            } else {
                call.arguments
            },
        })
        .collect();
    let server_tool_calls: Vec<Value> = message
        .reasoning_details
        .iter()
        .filter(|detail| {
            detail.get("type").and_then(Value::as_str) == Some("reasoning.server_tool_call")
        })
        .cloned()
        .collect();
    let finish = match message.finish {
        Some(finish) => finish,
        None if !tool_calls.is_empty() => Finish::ToolCalls,
        None => Finish::Stop,
    };
    // What the provider ran, counted from the calls themselves when its usage doesn't say.
    let mut usage = message.usage;
    let ran = |kind: &str| -> u64 {
        let count = server_tool_calls
            .iter()
            .filter(|call| {
                call.get("tool_name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.ends_with(kind))
            })
            .count();
        u64::try_from(count).unwrap_or(u64::MAX)
    };
    usage.web_searches = usage.web_searches.max(ran("web_search"));
    usage.web_fetches = usage.web_fetches.max(ran("web_fetch"));
    Completion {
        content: message.content,
        reasoning_details: message.reasoning_details,
        tool_calls,
        finish,
        usage,
        server_tool_calls,
        native: None,
    }
}

fn read_usage(usage: &Value) -> Usage {
    let number = |pointer: &str| usage.pointer(pointer).and_then(Value::as_u64).unwrap_or(0);
    let prompt = number("/prompt_tokens");
    let cached_read = number("/prompt_tokens_details/cached_tokens");
    let cached_write = number("/prompt_tokens_details/cache_write_tokens");
    let web = read_web_use(usage);
    Usage {
        input_tokens: prompt.saturating_sub(cached_read + cached_write),
        cached_read_tokens: cached_read,
        cached_write_tokens: cached_write,
        output_tokens: number("/completion_tokens"),
        reasoning_tokens: number("/completion_tokens_details/reasoning_tokens"),
        cost_usd: usage.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
        web_searches: web.searches,
        web_fetches: web.fetches,
        ..Usage::default()
    }
}

/// Searches and page reads, from the counts a usage carries.
struct WebUse {
    searches: u64,
    fetches: u64,
}

/// The usage's web counts. Chat Completions sends them as `server_tool_use_details`; the
/// feature guides and the Anthropic-shaped endpoints call them `server_tool_use`. Where both come
/// they count the same calls, so each figure is the larger of the two, never their sum.
/// - `web_search_requests`: every search, whether the provider ran it (Anthropic's own) or
///   `OpenRouter` did.
/// - `web_fetch_requests`: the pages Anthropic's own fetch read, when `OpenRouter` passes the
///   count on.
/// - `tool_calls_executed`: the server-tool calls `OpenRouter` ran itself, its searches among
///   them, and the only count a page it fetched gets. The web tools are the only server tools
///   `LoomWatch` offers, so what is left after the searches was a page read. That is exact when
///   `OpenRouter` ran the searches too, and a floor when the provider searched on its own.
fn read_web_use(usage: &Value) -> WebUse {
    let largest = |field: &str| {
        ["server_tool_use", "server_tool_use_details"]
            .iter()
            .filter_map(|counts| usage.get(counts)?.get(field)?.as_u64())
            .max()
            .unwrap_or(0)
    };
    let searches = largest("web_search_requests");
    WebUse {
        searches,
        fetches: largest("web_fetch_requests")
            .max(largest("tool_calls_executed").saturating_sub(searches)),
    }
}

async fn read_error_body(mut response: reqwest::Response) -> String {
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_ERROR_BYTES {
            break;
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| text.trim().chars().take(300).collect())
}

/// What a refused request means for the operator.
fn status_error(status: StatusCode, said: &str, model: &str) -> AgentError {
    let said = redact(said);
    let lower = said.to_lowercase();
    match status {
        StatusCode::UNAUTHORIZED => AgentError::KeyRefused(Source::OpenRouter),
        StatusCode::PAYMENT_REQUIRED => AgentError::OutOfCredits(Source::OpenRouter),
        StatusCode::TOO_MANY_REQUESTS => AgentError::RateLimited(Source::OpenRouter),
        StatusCode::NOT_FOUND => AgentError::ModelUnavailable(Source::OpenRouter, model.to_owned()),
        StatusCode::FORBIDDEN if lower.contains("key") => {
            AgentError::KeyRefused(Source::OpenRouter)
        }
        _ if lower.contains("context length")
            || lower.contains("context window")
            || lower.contains("maximum context")
            || lower.contains("too many tokens") =>
        {
            AgentError::ContextTooLong
        }
        _ if (lower.contains("model")
            && ["not found", "invalid", "not a valid", "does not exist"]
                .iter()
                .any(|phrase| lower.contains(phrase))
            && !lower.contains("tool"))
            || lower.contains("no endpoints found") =>
        {
            AgentError::ModelUnavailable(Source::OpenRouter, model.to_owned())
        }
        _ if said.is_empty() => {
            AgentError::Provider(Source::OpenRouter, format!("HTTP {}", status.as_u16()))
        }
        _ => AgentError::Provider(Source::OpenRouter, said),
    }
}

/// A network failure in plain words. `reqwest`'s own message can name the address, which is
/// `OpenRouter`'s and fine to show, but never the key, which only travels in a header.
fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the connection timed out".to_owned()
    } else if error.is_connect() {
        "the connection failed; check this computer's internet connection".to_owned()
    } else {
        redact(&error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::provider::ToolSpec;

    /// A `tool` message carries text only, so the pictures a turn's tools opened follow its tool
    /// results in one user message, each after the name of its file.
    #[test]
    fn pictures_follow_the_turns_tool_results_in_a_user_message() {
        let history = [
            Message::Tool {
                tool_call_id: "call_1".into(),
                content: "shot.png: a picture, 40×20 pixels.".into(),
                pictures: vec![crate::agent::provider::Picture {
                    name: "shot.png".into(),
                    media_type: "image/png".into(),
                    data: "iVBORw0K".into(),
                }],
            },
            Message::Tool {
                tool_call_id: "call_2".into(),
                content: "B".into(),
                pictures: Vec::new(),
            },
            Message::Assistant {
                content: "Seen.".into(),
                reasoning_details: Vec::new(),
                tool_calls: Vec::new(),
                native: None,
            },
        ];
        let wire = wire_messages(&history);
        assert_eq!(
            wire,
            [
                json!({"role": "tool", "tool_call_id": "call_1", "content": "shot.png: a picture, 40×20 pixels."}),
                json!({"role": "tool", "tool_call_id": "call_2", "content": "B"}),
                json!({"role": "user", "content": [
                    {"type": "text", "text": "The picture shot.png shows:"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0K"}},
                ]}),
                json!({"role": "assistant", "content": "Seen."}),
            ]
        );
        let without = wire_messages(&history[1..]);
        assert_eq!(without.len(), 2, "no pictures, no extra message");
    }

    /// A stand-in on this computer is taken, with or without a trailing slash; anything that would
    /// send the key elsewhere, even dressed up as local, falls back to `OpenRouter` itself.
    #[test]
    fn only_a_stand_in_on_this_computer_replaces_openrouter() {
        assert_eq!(choose_base(None), DEFAULT_BASE_URL);
        assert_eq!(choose_base(Some("  ")), DEFAULT_BASE_URL);
        assert_eq!(
            choose_base(Some("http://127.0.0.1:4100/api/v1/")),
            "http://127.0.0.1:4100/api/v1"
        );
        assert_eq!(
            choose_base(Some("http://localhost:4100/api/v1")),
            "http://localhost:4100/api/v1"
        );
        for refused in [
            "https://openrouter.example.com/api/v1",
            "http://example.com/api/v1",
            "http://localhost.example.com/api/v1",
            "http://127.0.0.1.example.com/api/v1",
            "http://user@example.com:80/127.0.0.1",
            "file:///etc/hosts",
            "not a url",
        ] {
            assert_eq!(choose_base(Some(refused)), DEFAULT_BASE_URL, "{refused}");
        }
    }

    fn request<'a>(
        messages: &'a [Message],
        tools: &'a [ToolSpec],
        model: &'a str,
    ) -> ChatRequest<'a> {
        ChatRequest {
            model,
            effort: Some("medium"),
            messages,
            tools,
            server_tools: ServerTools {
                web_search: true,
                web_fetch: false,
                limits: crate::agent::WebLimits::default(),
            },
            max_tokens: 8192,
            tools_off: false,
            session_key: "s-1",
            agent_id: "writer",
        }
    }

    #[test]
    fn the_body_carries_tools_reasoning_and_anthropic_caching() {
        let messages = [
            Message::System {
                content: "Be brief.".into(),
            },
            Message::Assistant {
                content: String::new(),
                reasoning_details: vec![
                    json!({"type": "reasoning.text", "text": "hm", "signature": "sig"}),
                ],
                tool_calls: vec![ToolCall {
                    id: "call_1".into(),
                    name: "read_file".into(),
                    arguments: "{\"path\":\"a.md\"}".into(),
                }],
                native: None,
            },
            Message::Tool {
                tool_call_id: "call_1".into(),
                content: "hello".into(),
                pictures: Vec::new(),
            },
        ];
        let tools = [ToolSpec {
            name: "read_file".into(),
            description: "Read a file.".into(),
            parameters: json!({"type": "object"}),
        }];
        let body = body(
            &request(&messages, &tools, "anthropic/claude-haiku-5.5"),
            true,
        );
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning"], json!({"effort": "medium"}));
        assert_eq!(body["cache_control"], json!({"type": "ephemeral"}));
        assert_eq!(body["session_id"], "s-1");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
        // By default only a page's length is held; how many searches is left to OpenRouter.
        assert_eq!(body["tools"][1], json!({"type": "openrouter:web_search"}));
        assert!(body.get("max_tool_calls").is_none());
        assert_eq!(body["messages"][1]["content"], Value::Null);
        assert_eq!(
            body["messages"][1]["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"a.md\"}"
        );
        assert_eq!(
            body["messages"][1]["reasoning_details"][0]["signature"],
            "sig"
        );
        assert_eq!(
            body["messages"][2],
            json!({"role": "tool", "tool_call_id": "call_1", "content": "hello"})
        );

        let other = body_for_model("openai/gpt-5.5");
        assert!(other.get("cache_control").is_none());
    }

    fn body_for_model(model: &str) -> Value {
        body(&request(&[], &[], model), true)
    }

    /// `OpenRouter` has no `ultra`, so an agent set to it thinks at `max`; the rest go as set.
    #[test]
    fn ultra_goes_to_openrouter_as_max() {
        let at = |effort| {
            let request = ChatRequest {
                effort: Some(effort),
                ..request(&[], &[], "openai/gpt-6.1-sol")
            };
            body(&request, true)["reasoning"].clone()
        };
        assert_eq!(at("ultra"), json!({"effort": "max"}));
        assert_eq!(at("xhigh"), json!({"effort": "xhigh"}));
    }

    /// Every model `OpenRouter` routes to gets the same limits, as the team file sets them; a model
    /// without the web gets none; and a provider that refused them gets the bare tools.
    #[test]
    fn web_limits_go_to_every_model_that_reads_the_web() {
        let limits = crate::agent::WebLimits {
            page_tokens: 12_000,
            pages: Some(4),
            searches: Some(2),
            steps: Some(6),
        };
        for model in [
            "anthropic/claude-opus-5.5",
            "openai/gpt-6.1-sol",
            "google/gemini-4-argon",
            "deepseek/deepseek-v4-pro",
            "nvidia/nemotron-3-ultra-550b-a55b:free",
        ] {
            let both = ChatRequest {
                server_tools: ServerTools {
                    web_search: true,
                    web_fetch: true,
                    limits,
                },
                ..request(&[], &[], model)
            };
            let sent = body(&both, true);
            assert_eq!(
                sent["tools"],
                json!([
                    {"type": "openrouter:web_search", "parameters": {"max_uses": 2}},
                    {"type": "openrouter:web_fetch", "parameters": {"max_uses": 4, "max_content_tokens": 12_000}},
                ]),
                "{model}"
            );
            assert_eq!(sent["max_tool_calls"], 6, "{model}");
            let bare = body(&both, false);
            assert_eq!(
                bare["tools"],
                json!([{"type": "openrouter:web_search"}, {"type": "openrouter:web_fetch"}]),
                "{model}"
            );
            assert!(bare.get("max_tool_calls").is_none(), "{model}");
            // The default holds only the page length, and leaves the counts to OpenRouter.
            let default = ChatRequest {
                server_tools: ServerTools {
                    web_search: true,
                    web_fetch: true,
                    limits: crate::agent::WebLimits::default(),
                },
                ..request(&[], &[], model)
            };
            let sent = body(&default, true);
            assert_eq!(
                sent["tools"],
                json!([
                    {"type": "openrouter:web_search"},
                    {"type": "openrouter:web_fetch", "parameters": {"max_content_tokens": 16_000}},
                ]),
                "{model}"
            );
            assert!(sent.get("max_tool_calls").is_none(), "{model}");
            let offline = ChatRequest {
                server_tools: ServerTools::default(),
                ..request(&[], &[], model)
            };
            let sent = body(&offline, true);
            assert!(sent.get("tools").is_none() && sent.get("max_tool_calls").is_none());
        }
    }

    #[test]
    fn a_refusal_of_the_limits_is_told_from_any_other() {
        for said in [
            "Invalid parameter: max_tool_calls is not supported for this model",
            "tools[1].parameters.max_content_tokens: unknown field",
            "This provider does not support server tools",
            "openrouter:web_fetch is not available with this provider",
        ] {
            assert!(refused_the_limits(StatusCode::BAD_REQUEST, said), "{said}");
        }
        assert!(!refused_the_limits(
            StatusCode::BAD_REQUEST,
            "This endpoint's maximum context length is 200000 tokens"
        ));
        assert!(!refused_the_limits(
            StatusCode::TOO_MANY_REQUESTS,
            "max_tool_calls: slow down"
        ));
    }

    /// The usage says what the provider ran; without it, the recorded calls do.
    #[test]
    fn web_searches_and_reads_are_counted_per_call() {
        let usage = read_usage(&json!({
            "prompt_tokens": 10,
            "server_tool_use": {"web_search_requests": 2, "web_fetch_requests": 3},
        }));
        assert_eq!((usage.web_searches, usage.web_fetches), (2, 3));
        // The usage of a Chat Completions stream, as `OpenRouter` sends it when a model searched
        // with its own engine (here Anthropic's): the searches, nothing else.
        let usage = read_usage(&json!({
            "prompt_tokens": 24_310,
            "server_tool_use_details": {"web_search_requests": 3},
        }));
        assert_eq!((usage.web_searches, usage.web_fetches), (3, 0));
        // Anthropic's own count of the pages it read, under either name.
        let usage = read_usage(&json!({
            "server_tool_use_details": {"web_search_requests": 1, "web_fetch_requests": 2},
        }));
        assert_eq!((usage.web_searches, usage.web_fetches), (1, 2));
        let silent = Assembled {
            reasoning_details: vec![
                json!({"type": "reasoning.server_tool_call", "tool_name": "openrouter:web_fetch"}),
                json!({"type": "reasoning.server_tool_call", "tool_name": "openrouter:web_fetch"}),
                json!({"type": "reasoning.server_tool_call", "tool_name": "openrouter:web_search"}),
                json!({"type": "reasoning.text", "text": "hm"}),
            ],
            ..Assembled::default()
        };
        let counted = finish(silent).usage;
        assert_eq!((counted.web_searches, counted.web_fetches), (1, 2));
        assert_eq!(
            read_usage(&json!({})).web_fetches,
            0,
            "a provider that says nothing"
        );
    }

    /// The same calls counted under both names, or in the usage and in the recorded calls, are
    /// counted once.
    #[test]
    fn web_use_reported_twice_is_counted_once() {
        let usage = read_usage(&json!({
            "server_tool_use": {"web_search_requests": 2, "web_fetch_requests": 1},
            "server_tool_use_details": {"web_search_requests": 2},
        }));
        assert_eq!((usage.web_searches, usage.web_fetches), (2, 1));
        let usage = read_usage(&json!({
            "server_tool_use": {"web_search_requests": 1},
            "server_tool_use_details": {"web_search_requests": 3},
        }));
        assert_eq!(usage.web_searches, 3, "the fuller of the two");
        // A page counted as read and as one of the calls `OpenRouter` ran is one page.
        let usage = read_usage(&json!({
            "server_tool_use": {"tool_calls_requested": 2, "tool_calls_executed": 2,
                                "web_fetch_requests": 2, "web_search_requests": 0},
        }));
        assert_eq!(usage.web_fetches, 2);
        let recorded =
            |tool: &str| json!({"type": "reasoning.server_tool_call", "tool_name": tool});
        let both = Assembled {
            usage: read_usage(&json!({
                "server_tool_use_details": {"tool_calls_requested": 3, "tool_calls_executed": 3,
                                            "web_search_requests": 2},
            })),
            reasoning_details: vec![
                recorded("openrouter:web_search"),
                recorded("openrouter:web_search"),
                recorded("openrouter:web_fetch"),
            ],
            ..Assembled::default()
        };
        let counted = finish(both).usage;
        assert_eq!((counted.web_searches, counted.web_fetches), (2, 1));
    }

    /// A page `OpenRouter` fetched itself has no count of its own: it is one of the server-tool
    /// calls it ran, and the searches are the others.
    #[test]
    fn pages_openrouter_read_are_the_calls_it_ran_that_were_not_searches() {
        let usage = read_usage(&json!({
            "server_tool_use_details": {"tool_calls_requested": 5, "tool_calls_executed": 5,
                                        "web_search_requests": 2},
        }));
        assert_eq!((usage.web_searches, usage.web_fetches), (2, 3));
        let usage = read_usage(&json!({
            "server_tool_use_details": {"tool_calls_requested": 2, "tool_calls_executed": 2},
        }));
        assert_eq!(
            (usage.web_searches, usage.web_fetches),
            (0, 2),
            "pages only"
        );
        // A fetch refused past its limit was asked for, but no page was read.
        let usage = read_usage(&json!({
            "server_tool_use_details": {"tool_calls_requested": 4, "tool_calls_executed": 3,
                                        "web_search_requests": 1},
        }));
        assert_eq!(usage.web_fetches, 2);
        // Searches the provider ran on its own are not among `OpenRouter`'s calls. What is left is
        // then a floor on the pages, and never below none.
        let usage = read_usage(&json!({
            "server_tool_use_details": {"web_search_requests": 4, "tool_calls_executed": 1},
        }));
        assert_eq!((usage.web_searches, usage.web_fetches), (4, 0));
    }

    #[test]
    fn streamed_tool_calls_and_reasoning_are_joined_up() {
        let mut calls = Vec::new();
        merge_call(
            &mut calls,
            &json!({"index": 0, "id": "call_a", "function": {"name": "write_file", "arguments": ""}}),
        );
        merge_call(
            &mut calls,
            &json!({"index": 0, "function": {"arguments": "{\"path\":"}}),
        );
        merge_call(
            &mut calls,
            &json!({"index": 1, "id": "call_b", "function": {"name": "list_files", "arguments": "{}"}}),
        );
        merge_call(
            &mut calls,
            &json!({"index": 0, "function": {"arguments": "\"a\"}"}}),
        );
        assert_eq!(calls[0].arguments, "{\"path\":\"a\"}");
        assert_eq!(calls[1].name, "list_files");

        let mut details = Vec::new();
        merge_reasoning(
            &mut details,
            &json!({"type": "reasoning.text", "index": 0, "text": "Think"}),
        );
        merge_reasoning(
            &mut details,
            &json!({"type": "reasoning.text", "index": 0, "text": "ing."}),
        );
        merge_reasoning(
            &mut details,
            &json!({"type": "reasoning.text", "index": 0, "signature": "s1"}),
        );
        assert_eq!(
            details,
            [json!({"type": "reasoning.text", "index": 0, "text": "Thinking.", "signature": "s1"})]
        );
    }

    #[test]
    fn usage_counts_uncached_input_and_the_exact_cost() {
        let usage = read_usage(&json!({
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "prompt_tokens_details": {"cached_tokens": 800, "cache_write_tokens": 100},
            "completion_tokens_details": {"reasoning_tokens": 20},
            "cost": 0.0123,
        }));
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.cached_read_tokens, 800);
        assert_eq!(usage.cached_write_tokens, 100);
        assert_eq!(usage.prompt_tokens(), 1000);
        assert_eq!(usage.reasoning_tokens, 20);
        assert!((usage.cost_usd - 0.0123).abs() < f64::EPSILON);
    }

    #[test]
    fn refusals_read_in_plain_words() {
        let model = "anthropic/claude-opus-5.5";
        assert!(matches!(
            status_error(StatusCode::UNAUTHORIZED, "No auth", model),
            AgentError::KeyRefused(Source::OpenRouter)
        ));
        assert!(matches!(
            status_error(StatusCode::PAYMENT_REQUIRED, "Insufficient credits", model),
            AgentError::OutOfCredits(Source::OpenRouter)
        ));
        assert!(matches!(
            status_error(
                StatusCode::BAD_REQUEST,
                "This endpoint's maximum context length is 200000 tokens",
                model
            ),
            AgentError::ContextTooLong
        ));
        assert!(matches!(
            status_error(
                StatusCode::BAD_REQUEST,
                "x/y is not a valid model ID",
                model
            ),
            AgentError::ModelUnavailable(Source::OpenRouter, _)
        ));
        let AgentError::Provider(Source::OpenRouter, said) = status_error(
            StatusCode::BAD_REQUEST,
            "bad key sk-or-v1-abcdefabcdefabcdef",
            model,
        ) else {
            panic!("expected a provider error");
        };
        assert!(!said.contains("abcdefabcdef"));
    }
}
