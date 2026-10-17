//! `OpenRouter`, the first provider: one key, every model it lists.
//!
//! One streamed `POST /chat/completions` per model call, in `OpenAI`'s chat shape with `OpenRouter`'s
//! extras:
//! - `reasoning.effort`, and `reasoning_details` passed back unchanged so a model that signs its
//!   reasoning keeps it across tool calls;
//! - `cache_control` for Anthropic models, which cache only when asked;
//! - `session_id`, so a session's calls stay on one route and keep their cache;
//! - the `openrouter:web_search` and `openrouter:web_fetch` server tools for an agent allowed the
//!   web;
//! - exact `usage.cost`, in dollars, in the stream's last chunk.
//!
//! Requests are retried only before anything has streamed: once text has reached the operator, a
//! retry would write it twice.

use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{Map, Value, json};

use super::ApiKey;
use super::error::{AgentError, CallError, redact};
use super::provider::{
    Cancel, ChatRequest, Completion, DeltaSink, Finish, Message, ServerTools, ToolCall, Usage,
};
use super::sse::SseDecoder;

/// Where `OpenRouter`'s API lives.
pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
/// How `OpenRouter` names `LoomWatch` on its dashboards.
const REFERER: &str = "https://github.com/tnghia903/loomwatch";
const TITLE: &str = "LoomWatch";
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

/// A connection to `OpenRouter` with the operator's key.
#[derive(Debug)]
pub struct OpenRouter {
    client: Client,
    base: String,
    key: ApiKey,
    backoff: Duration,
}

impl OpenRouter {
    /// `OpenRouter` itself.
    ///
    /// # Errors
    ///
    /// When the HTTP client cannot be built.
    pub fn new(key: ApiKey) -> anyhow::Result<Self> {
        Self::with_base(key, DEFAULT_BASE_URL)
    }

    /// Another address speaking `OpenRouter`'s API: `https`, or `http` on this computer for tests.
    ///
    /// # Errors
    ///
    /// When `base` is neither, or the HTTP client cannot be built.
    pub fn with_base(key: ApiKey, base: &str) -> anyhow::Result<Self> {
        let base = base.trim_end_matches('/').to_owned();
        let local = base.starts_with("http://127.0.0.1") || base.starts_with("http://localhost");
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
        let body = body(request);
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
                Err(error) => return Err(AgentError::Network(network_error(&error)).into()),
            };
            let status = response.status();
            if status.is_success() {
                return read_stream(response, request.model, deltas, cancel).await;
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
            return Err(status_error(status, &said, request.model).into());
        }
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

/// The request body.
fn body(request: &ChatRequest<'_>) -> Value {
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
    } = request.server_tools;
    if web_search {
        tools.push(json!({"type": "openrouter:web_search"}));
    }
    if web_fetch {
        tools.push(json!({"type": "openrouter:web_fetch"}));
    }
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert(
        "messages".into(),
        Value::Array(request.messages.iter().map(wire_message).collect()),
    );
    body.insert("stream".into(), json!(true));
    body.insert("max_completion_tokens".into(), json!(request.max_tokens));
    body.insert("session_id".into(), json!(request.session_key));
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
        body.insert("parallel_tool_calls".into(), json!(true));
    }
    if let Some(effort) = request.effort {
        body.insert("reasoning".into(), json!({"effort": effort}));
    }
    // Anthropic's models cache a prompt only when asked; the others cache on their own.
    if request.model.starts_with("anthropic/") {
        body.insert("cache_control".into(), json!({"type": "ephemeral"}));
    }
    Value::Object(body)
}

fn wire_message(message: &Message) -> Value {
    match message {
        Message::System { content } => json!({"role": "system", "content": content}),
        Message::User { content } => json!({"role": "user", "content": content}),
        Message::Assistant {
            content,
            reasoning_details,
            tool_calls,
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
) -> Result<Completion, CallError> {
    let mut decoder = SseDecoder::default();
    let mut message = Assembled::default();
    loop {
        let chunk = tokio::select! {
            chunk = tokio::time::timeout(STREAM_IDLE, response.chunk()) => chunk,
            () = cancel.cancelled() => return Err(CallError::Cancelled),
        };
        let chunk = match chunk {
            Err(_) => return Err(AgentError::Stalled.into()),
            Ok(Err(error)) => return Err(AgentError::Network(network_error(&error)).into()),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(bytes))) => bytes,
        };
        for event in decoder.push(&chunk) {
            if event.trim() == "[DONE]" {
                return Ok(finish(message));
            }
            take_event(&event, &mut message, model, deltas).await?;
        }
    }
    if let Some(event) = decoder.finish()
        && event.trim() != "[DONE]"
    {
        take_event(&event, &mut message, model, deltas).await?;
    }
    if message.finish.is_none() && message.content.is_empty() && message.calls.is_empty() {
        return Err(AgentError::Stalled.into());
    }
    Ok(finish(message))
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
    let server_tool_calls = message
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
    Completion {
        content: message.content,
        reasoning_details: message.reasoning_details,
        tool_calls,
        finish,
        usage: message.usage,
        server_tool_calls,
    }
}

fn read_usage(usage: &Value) -> Usage {
    let number = |pointer: &str| usage.pointer(pointer).and_then(Value::as_u64).unwrap_or(0);
    let prompt = number("/prompt_tokens");
    let cached_read = number("/prompt_tokens_details/cached_tokens");
    let cached_write = number("/prompt_tokens_details/cache_write_tokens");
    Usage {
        input_tokens: prompt.saturating_sub(cached_read + cached_write),
        cached_read_tokens: cached_read,
        cached_write_tokens: cached_write,
        output_tokens: number("/completion_tokens"),
        reasoning_tokens: number("/completion_tokens_details/reasoning_tokens"),
        cost_usd: usage.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
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
        StatusCode::UNAUTHORIZED => AgentError::KeyRefused,
        StatusCode::PAYMENT_REQUIRED => AgentError::OutOfCredits,
        StatusCode::TOO_MANY_REQUESTS => AgentError::RateLimited,
        StatusCode::NOT_FOUND => AgentError::ModelUnavailable(model.to_owned()),
        StatusCode::FORBIDDEN if lower.contains("key") => AgentError::KeyRefused,
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
            AgentError::ModelUnavailable(model.to_owned())
        }
        _ if said.is_empty() => AgentError::Provider(format!("HTTP {}", status.as_u16())),
        _ => AgentError::Provider(said),
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
            },
            max_tokens: 8192,
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
            },
            Message::Tool {
                tool_call_id: "call_1".into(),
                content: "hello".into(),
            },
        ];
        let tools = [ToolSpec {
            name: "read_file".into(),
            description: "Read a file.".into(),
            parameters: json!({"type": "object"}),
        }];
        let body = body(&request(&messages, &tools, "anthropic/claude-haiku-5.5"));
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning"], json!({"effort": "medium"}));
        assert_eq!(body["cache_control"], json!({"type": "ephemeral"}));
        assert_eq!(body["session_id"], "s-1");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
        assert_eq!(body["tools"][1], json!({"type": "openrouter:web_search"}));
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
        body(&request(&[], &[], model))
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
            AgentError::KeyRefused
        ));
        assert!(matches!(
            status_error(StatusCode::PAYMENT_REQUIRED, "Insufficient credits", model),
            AgentError::OutOfCredits
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
            AgentError::ModelUnavailable(_)
        ));
        let AgentError::Provider(said) = status_error(
            StatusCode::BAD_REQUEST,
            "bad key sk-or-v1-abcdefabcdefabcdef",
            model,
        ) else {
            panic!("expected a provider error");
        };
        assert!(!said.contains("abcdefabcdef"));
    }
}
