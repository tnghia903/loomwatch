//! The person's `ChatGPT` plan, through `OpenAI`'s public Responses API (ADR 0073). Every request
//! carries an access token from the sign-in with `ChatGPT` and counts against the plan, never
//! against dollars.
//!
//! One streamed `POST /v1/responses` per model call, in the shape plan usage takes
//! (developers.openai.com/siwc/token-sharing-open-source/preview-limitations), checked live on
//! 2026-10-19:
//! - `store: false`, so the whole conversation goes in `input` every time, and nothing is kept at
//!   `OpenAI` between calls;
//! - the system prompt in `instructions`: a system-role message is refused;
//! - the tools grouped in one `loomwatch` namespace; a summary keeps them with
//!   `tool_choice: none`;
//! - reasoning returned encrypted (`include`), and every output item sent back exactly as it came,
//!   so the model keeps its reasoning across tool calls;
//! - `prompt_cache_key`, so a session's calls share a cache;
//! - none of the fields plan usage refuses: no `temperature`, `max_output_tokens`, `metadata`,
//!   `user` or `truncation`.
//!
//! The output items arrive only in `response.output_item.done`; `response.completed` carries the
//! usage. A plan's limit ends the turn with "Manage usage" and is never moved to another source.

use std::fmt::Debug;
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{Map, Value, json};

use super::BoxFuture;
use super::error::{AgentError, CallError, redact};
use super::provider::{
    Cancel, ChatRequest, Completion, DeltaSink, Finish, Message, Native, ToolCall, Usage, Written,
};
use super::sse::SseDecoder;
use crate::ai::{ChatGptModel, ModelRef, Source};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const STREAM_IDLE: Duration = Duration::from_mins(3);
const ATTEMPTS: u32 = 4;
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const MAX_ERROR_BYTES: usize = 64 * 1024;
/// The namespace `LoomWatch`'s tools are offered in, as plan usage asks.
const NAMESPACE: &str = "loomwatch";

/// Where an access token comes from: the sign-in with `ChatGPT`, which renews it.
pub trait PlanAccess: Send + Sync + Debug {
    /// A token for the next request. `renew` asks for a new one after `OpenAI` refused the last.
    fn token(&self, renew: bool) -> BoxFuture<'_, Result<String, AgentError>>;
}

/// A connection to the person's `ChatGPT` plan.
#[derive(Debug)]
pub struct ChatGptPlan {
    client: Client,
    base: String,
    access: std::sync::Arc<dyn PlanAccess>,
    models: Vec<ChatGptModel>,
    backoff: Duration,
}

impl ChatGptPlan {
    /// The Responses API at `base` (`https`, or `http` on this computer for tests).
    ///
    /// # Errors
    ///
    /// When `base` is neither, or the HTTP client cannot be built.
    pub fn new(
        access: std::sync::Arc<dyn PlanAccess>,
        base: &str,
        models: Vec<ChatGptModel>,
    ) -> anyhow::Result<Self> {
        let base = base.trim_end_matches('/').to_owned();
        let local = super::is_loopback_http(&base);
        anyhow::ensure!(
            base.starts_with("https://") || local,
            "an OpenAI address must be https"
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
            access,
            models,
            backoff: Duration::from_secs(1),
        })
    }

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
        let model = ModelRef::parse(request.model).id;
        let known = self.models.iter().find(|listed| listed.slug == model);
        let body = body(request, &model, known);
        let mut attempt = 0;
        let mut renewed = false;
        loop {
            attempt += 1;
            let token = self.access.token(false).await?;
            let sent = self
                .client
                .post(format!("{}/v1/responses", self.base))
                .bearer_auth(&token)
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
                    return Err(AgentError::Network(Source::ChatGpt, network_error(&error)).into());
                }
            };
            let status = response.status();
            if status.is_success() {
                match read_stream(response, &model, deltas, cancel).await? {
                    Streamed::Whole(completion) => return Ok(completion),
                    Streamed::Refused(refusal) => {
                        if attempt < ATTEMPTS && refusal.retryable() {
                            self.wait(attempt, None, cancel).await?;
                            continue;
                        }
                        return Err(refusal.error(&model).into());
                    }
                }
            }
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            let refusal = Refusal::read(status, response).await;
            if status == StatusCode::UNAUTHORIZED && !renewed {
                // The token was refused: a new one, once, before telling the person.
                renewed = true;
                self.access.token(true).await?;
                continue;
            }
            if attempt < ATTEMPTS && refusal.retryable() {
                self.wait(attempt, retry_after, cancel).await?;
                continue;
            }
            return Err(refusal.error(&model).into());
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

/// The request body.
fn body(request: &ChatRequest<'_>, model: &str, known: Option<&ChatGptModel>) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("store".into(), json!(false));
    body.insert("stream".into(), json!(true));
    body.insert("prompt_cache_key".into(), json!(request.session_key));
    let instructions: Vec<&str> = request
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::System { content } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    if !instructions.is_empty() {
        body.insert("instructions".into(), json!(instructions.join("\n\n")));
    }
    body.insert("input".into(), Value::Array(input(request.messages)));
    let mut tools = Vec::new();
    if !request.tools.is_empty() {
        tools.push(json!({
            "type": "namespace",
            "name": NAMESPACE,
            "description": "LoomWatch's tools for this agent's work.",
            "tools": request.tools.iter().map(|tool| json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })).collect::<Vec<_>>(),
        }));
    }
    // `OpenAI`'s web search also opens and reads the pages it finds.
    if request.server_tools.any() {
        tools.push(json!({"type": "web_search"}));
    }
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
        body.insert(
            "tool_choice".into(),
            json!(if request.tools_off { "none" } else { "auto" }),
        );
        body.insert("parallel_tool_calls".into(), json!(true));
    }
    let mut reasoning = json!({"summary": "auto"});
    if let Some(effort) = effort_for(request.effort, known) {
        reasoning["effort"] = json!(effort);
    }
    body.insert("reasoning".into(), reasoning);
    body.insert("include".into(), json!(["reasoning.encrypted_content"]));
    Value::Object(body)
}

/// The effort asked for, moved to the nearest one the model takes. `minimal` is refused on the
/// plan; `none` is taken by every model, though it doesn't list it.
fn effort_for(effort: Option<&str>, known: Option<&ChatGptModel>) -> Option<&'static str> {
    let wanted = match effort? {
        "none" => return Some("none"),
        "minimal" | "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "xhigh" => "xhigh",
        "max" => "max",
        "ultra" => "ultra",
        _ => return None,
    };
    let Some(known) = known.filter(|known| !known.efforts.is_empty()) else {
        return Some(if wanted == "ultra" { "max" } else { wanted });
    };
    ["ultra", "max", "xhigh", "high", "medium", "low"]
        .into_iter()
        .skip_while(|level| *level != wanted)
        .find(|level| known.efforts.iter().any(|offered| offered == level))
}

/// The conversation as input items. An assistant message the plan wrote goes back exactly as it
/// came; one from before the session was on the plan goes as plain text and calls.
fn input(history: &[Message]) -> Vec<Value> {
    let mut items = Vec::new();
    for message in history {
        match message {
            Message::System { .. } => {}
            Message::User { content } => items.push(json!({
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": content}],
            })),
            Message::Tool {
                tool_call_id,
                content,
                pictures,
            } => {
                // A picture goes inside the output of the call that opened it, as Codex sends one.
                let output = if pictures.is_empty() {
                    json!(content)
                } else {
                    let mut parts = vec![json!({"type": "input_text", "text": content})];
                    parts.extend(pictures.iter().map(
                        |picture| json!({"type": "input_image", "image_url": picture.data_url()}),
                    ));
                    Value::Array(parts)
                };
                items.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_call_id,
                    "output": output,
                }));
            }
            Message::Assistant {
                content,
                tool_calls,
                native,
                ..
            } => match native {
                Some(native) if native.source == Source::ChatGpt && !native.items.is_empty() => {
                    items.extend(native.items.iter().cloned());
                }
                _ => {
                    if !content.is_empty() {
                        items.push(json!({
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": content}],
                        }));
                    }
                    for call in tool_calls {
                        items.push(json!({
                            "type": "function_call",
                            "call_id": call.id,
                            "name": call.name,
                            "namespace": NAMESPACE,
                            "arguments": call.arguments,
                        }));
                    }
                }
            },
        }
    }
    items
}

/// A request the plan refused, and what it means.
struct Refusal {
    status: StatusCode,
    code: String,
    param: String,
    said: String,
}

impl Refusal {
    async fn read(status: StatusCode, mut response: reqwest::Response) -> Self {
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > MAX_ERROR_BYTES {
                break;
            }
        }
        let text = String::from_utf8_lossy(&bytes);
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        Self::from_error(status, body.get("error").unwrap_or(&body), &text)
    }

    fn from_error(status: StatusCode, error: &Value, raw: &str) -> Self {
        let field = |key: &str| {
            error
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let said = error
            .get("message")
            .or_else(|| error.get("detail"))
            .and_then(Value::as_str)
            .map_or_else(|| raw.trim().chars().take(300).collect(), str::to_owned);
        Self {
            status,
            code: field("code"),
            param: field("param"),
            said,
        }
    }

    /// Whether trying again later may work: busy, or the plan's usage couldn't be checked. A
    /// plan's limit is not: it holds until the person changes it.
    fn retryable(&self) -> bool {
        match self.code.as_str() {
            "subscription_sharing_usage_limit_exceeded"
            | "subscription_sharing_user_not_eligible" => false,
            "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => {
                true
            }
            _ => self.status == StatusCode::TOO_MANY_REQUESTS || self.status.is_server_error(),
        }
    }

    fn error(&self, model: &str) -> AgentError {
        let said = redact(&self.said);
        match self.code.as_str() {
            "subscription_sharing_usage_limit_exceeded" => return AgentError::PlanLimit,
            "subscription_sharing_user_not_eligible" => return AgentError::PlanNotEligible,
            "subscription_sharing_invalid_user" => return AgentError::SignInAgain,
            "subscription_sharing_unsupported_capability" => {
                let what = if self.param.is_empty() {
                    said
                } else {
                    self.param.clone()
                };
                return AgentError::Provider(
                    Source::ChatGpt,
                    format!("the ChatGPT plan can't take {what}"),
                );
            }
            "context_length_exceeded" => return AgentError::ContextTooLong,
            "model_not_found" => {
                return AgentError::ModelUnavailable(Source::ChatGpt, model.to_owned());
            }
            _ => {}
        }
        let lower = said.to_lowercase();
        match self.status {
            StatusCode::UNAUTHORIZED => AgentError::SignInAgain,
            StatusCode::TOO_MANY_REQUESTS => AgentError::RateLimited(Source::ChatGpt),
            StatusCode::NOT_FOUND => {
                AgentError::ModelUnavailable(Source::ChatGpt, model.to_owned())
            }
            _ if lower.contains("context window") || lower.contains("context length") => {
                AgentError::ContextTooLong
            }
            _ if lower.contains("model") && lower.contains("not") && lower.contains("support") => {
                AgentError::ModelUnavailable(Source::ChatGpt, model.to_owned())
            }
            _ if said.is_empty() => {
                AgentError::Provider(Source::ChatGpt, format!("HTTP {}", self.status.as_u16()))
            }
            _ => AgentError::Provider(Source::ChatGpt, said),
        }
    }
}

enum Streamed {
    Whole(Completion),
    /// Refused before the model wrote anything, so trying again repeats nothing.
    Refused(Refusal),
}

/// The message a stream assembles.
#[derive(Default)]
struct Assembled {
    items: Vec<Value>,
    usage: Usage,
    incomplete: Option<String>,
    begun: bool,
    done: bool,
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
            Err(_) => return Err(AgentError::Stalled(Source::ChatGpt).into()),
            Ok(Err(error)) => {
                return Err(AgentError::Network(Source::ChatGpt, network_error(&error)).into());
            }
            Ok(Ok(None)) => break,
            Ok(Ok(Some(bytes))) => bytes,
        };
        for event in decoder.push(&chunk) {
            if let Some(refused) = take_event(&event, &mut message, model, deltas).await? {
                return Ok(Streamed::Refused(refused));
            }
            if message.done {
                return Ok(Streamed::Whole(finish(message)));
            }
        }
    }
    if let Some(event) = decoder.finish()
        && let Some(refused) = take_event(&event, &mut message, model, deltas).await?
    {
        return Ok(Streamed::Refused(refused));
    }
    if !message.done {
        // Only `response.completed` says the model finished.
        return Err(AgentError::Stalled(Source::ChatGpt).into());
    }
    Ok(Streamed::Whole(finish(message)))
}

async fn take_event(
    event: &str,
    message: &mut Assembled,
    model: &str,
    deltas: &dyn DeltaSink,
) -> Result<Option<Refusal>, CallError> {
    let Ok(event) = serde_json::from_str::<Value>(event) else {
        return Ok(None);
    };
    match event.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => {
            if let Some(text) = event.get("delta").and_then(Value::as_str)
                && !text.is_empty()
            {
                message.begun = true;
                deltas.text(text).await?;
            }
        }
        Some("response.reasoning_summary_text.delta") => {
            if let Some(text) = event.get("delta").and_then(Value::as_str)
                && !text.is_empty()
            {
                message.begun = true;
                deltas.reasoning(text).await?;
            }
        }
        Some("response.output_item.added") => {
            message.begun = true;
            if event.pointer("/item/type").and_then(Value::as_str) == Some("web_search_call") {
                deltas.server_tool();
            }
        }
        Some("response.output_item.done") => {
            if let Some(item) = event.get("item") {
                message.items.push(item.clone());
            }
        }
        Some("response.completed") => {
            if let Some(usage) = event.pointer("/response/usage") {
                message.usage = read_usage(usage);
            }
            message.done = true;
        }
        Some("response.incomplete") => {
            if let Some(usage) = event.pointer("/response/usage") {
                message.usage = read_usage(usage);
            }
            message.incomplete = event
                .pointer("/response/incomplete_details/reason")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some("incomplete".to_owned()));
            message.done = true;
        }
        Some("response.failed" | "error") => {
            let error = event
                .pointer("/response/error")
                .or_else(|| event.get("error"))
                .unwrap_or(&event);
            let refusal = Refusal::from_error(StatusCode::BAD_GATEWAY, error, "");
            // A plan's limit can arrive after the model began: it stops the turn either way.
            if !message.begun {
                return Ok(Some(refusal));
            }
            return Err(refusal.error(model).into());
        }
        _ => {}
    }
    Ok(None)
}

fn finish(message: Assembled) -> Completion {
    let mut written = Written::default();
    let mut tool_calls = Vec::new();
    let mut server_tool_calls = Vec::new();
    let mut searches = 0_u64;
    for item in &message.items {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for part in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        written.text(text);
                    }
                }
            }
            Some("function_call") => tool_calls.push(ToolCall {
                id: text_of(item, "call_id"),
                name: text_of(item, "name"),
                arguments: item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .filter(|arguments| !arguments.trim().is_empty())
                    .unwrap_or("{}")
                    .to_owned(),
            }),
            Some("web_search_call") => {
                written.tool();
                searches += 1;
                let action = item.get("action").cloned().unwrap_or(Value::Null);
                let reading = action.get("type").and_then(Value::as_str) == Some("open_page");
                server_tool_calls.push(json!({
                    "tool_name": if reading { "web_fetch" } else { "web_search" },
                    "tool_call_id": text_of(item, "id"),
                    "arguments": action.to_string(),
                    "result": "",
                }));
            }
            _ => {}
        }
    }
    let finish = match message.incomplete.as_deref() {
        Some("content_filter") => Finish::ContentFilter,
        Some(_) => Finish::Length,
        None if !tool_calls.is_empty() => Finish::ToolCalls,
        None => Finish::Stop,
    };
    let mut usage = message.usage;
    usage.web_searches = usage.web_searches.max(searches);
    usage.paid_by = Some(Source::ChatGpt);
    usage.cost_usd = 0.0;
    Completion {
        content: written.content,
        reasoning_details: Vec::new(),
        tool_calls,
        finish,
        usage,
        server_tool_calls,
        answer_from: written.answer_from,
        native: Some(Native {
            source: Source::ChatGpt,
            items: message.items,
        }),
    }
}

fn text_of(item: &Value, key: &str) -> String {
    item.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// The Responses API's usage. Its input count includes what the cache served or wrote.
fn read_usage(usage: &Value) -> Usage {
    let number = |pointer: &str| usage.pointer(pointer).and_then(Value::as_u64).unwrap_or(0);
    let input = number("/input_tokens");
    let cached = number("/input_tokens_details/cached_tokens");
    let written = number("/input_tokens_details/cache_write_tokens");
    Usage {
        input_tokens: input.saturating_sub(cached + written),
        cached_read_tokens: cached,
        cached_write_tokens: written,
        output_tokens: number("/output_tokens"),
        reasoning_tokens: number("/output_tokens_details/reasoning_tokens"),
        ..Usage::default()
    }
}

fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the request timed out".to_owned()
    } else if error.is_connect() {
        "couldn't connect; check this computer's internet connection".to_owned()
    } else {
        redact(&error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::provider::{ServerTools, ToolSpec};

    fn sol() -> ChatGptModel {
        ChatGptModel {
            slug: "gpt-6.1-sol".into(),
            name: "GPT-6.1-Sol".into(),
            context_length: 500_000,
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
                .map(str::to_owned)
                .to_vec(),
            priority: 1,
            sees_pictures: true,
        }
    }

    fn request<'a>(messages: &'a [Message], tools: &'a [ToolSpec]) -> ChatRequest<'a> {
        ChatRequest {
            model: "chatgpt:gpt-6.1-sol",
            effort: Some("minimal"),
            messages,
            tools,
            server_tools: ServerTools::default(),
            max_tokens: 16_000,
            tools_off: false,
            session_key: "s-1",
            agent_id: "writer",
        }
    }

    /// A picture goes inside the output of the call that opened it, as Codex sends one; an output
    /// without one stays the text it always was.
    #[test]
    fn a_picture_goes_inside_the_output_of_the_call_that_opened_it() {
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
        ];
        assert_eq!(
            input(&history),
            [
                json!({"type": "function_call_output", "call_id": "call_1", "output": [
                    {"type": "input_text", "text": "shot.png: a picture, 40×20 pixels."},
                    {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0K"},
                ]}),
                json!({"type": "function_call_output", "call_id": "call_2", "output": "B"}),
            ]
        );
    }

    /// The shape plan usage takes: instructions instead of a system message, nothing stored, the
    /// tools in one namespace, the plan's own items sent back as they came, and none of the fields
    /// it refuses.
    #[test]
    fn the_body_is_in_the_shape_plan_usage_takes() {
        let items = vec![
            json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "enc", "summary": []}),
            json!({"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file", "namespace": "loomwatch", "arguments": "{\"path\":\"a.md\"}", "status": "completed"}),
        ];
        let history = [
            Message::System {
                content: "Be brief.".into(),
            },
            Message::User {
                content: "Read it.".into(),
            },
            Message::Assistant {
                content: String::new(),
                reasoning_details: Vec::new(),
                tool_calls: Vec::new(),
                native: Some(Native {
                    source: Source::ChatGpt,
                    items: items.clone(),
                }),
            },
            Message::Tool {
                tool_call_id: "call_1".into(),
                content: "A".into(),
                pictures: Vec::new(),
            },
        ];
        let tools = [ToolSpec {
            name: "read_file".into(),
            description: "Reads a file".into(),
            parameters: json!({"type": "object"}),
        }];
        let sent = body(&request(&history, &tools), "gpt-6.1-sol", Some(&sol()));
        assert_eq!(sent["instructions"], "Be brief.");
        assert_eq!(sent["store"], false);
        assert_eq!(sent["stream"], true);
        assert_eq!(sent["prompt_cache_key"], "s-1");
        let input = sent["input"].as_array().unwrap();
        assert!(input.iter().all(|item| item["role"] != "system"));
        assert_eq!(input[1..3], items[..]);
        assert_eq!(
            input[3],
            json!({"type": "function_call_output", "call_id": "call_1", "output": "A"})
        );
        assert_eq!(sent["tools"][0]["type"], "namespace");
        assert_eq!(sent["tools"][0]["tools"][0]["name"], "read_file");
        assert_eq!(sent["tool_choice"], "auto");
        assert_eq!(sent["reasoning"]["effort"], "low");
        assert_eq!(sent["include"], json!(["reasoning.encrypted_content"]));
        for refused in [
            "temperature",
            "max_output_tokens",
            "metadata",
            "user",
            "truncation",
            "previous_response_id",
        ] {
            assert!(sent.get(refused).is_none(), "{refused}");
        }
        let summary = ChatRequest {
            tools_off: true,
            ..request(&history, &tools)
        };
        assert_eq!(
            body(&summary, "gpt-6.1-sol", Some(&sol()))["tool_choice"],
            "none"
        );
    }

    #[test]
    fn an_effort_moves_to_the_nearest_one_the_plan_takes() {
        let mut luna = sol();
        luna.efforts = ["low", "medium", "high", "xhigh", "max"]
            .map(str::to_owned)
            .to_vec();
        assert_eq!(effort_for(Some("ultra"), Some(&luna)), Some("max"));
        assert_eq!(effort_for(Some("ultra"), Some(&sol())), Some("ultra"));
        assert_eq!(effort_for(Some("none"), Some(&luna)), Some("none"));
        assert_eq!(effort_for(Some("minimal"), None), Some("low"));
        assert_eq!(effort_for(Some("default"), None), None);
    }

    #[test]
    fn a_plans_refusals_read_in_plain_words() {
        let refusal = |status: StatusCode, error: Value| Refusal::from_error(status, &error, "");
        let limit = refusal(
            StatusCode::TOO_MANY_REQUESTS,
            json!({"code": "subscription_sharing_usage_limit_exceeded", "message": "limit"}),
        );
        assert!(!limit.retryable());
        assert!(matches!(limit.error("m"), AgentError::PlanLimit));
        let busy = refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"code": "subscription_sharing_usage_unavailable"}),
        );
        assert!(busy.retryable());
        assert!(matches!(
            refusal(
                StatusCode::FORBIDDEN,
                json!({"code": "subscription_sharing_user_not_eligible"})
            )
            .error("m"),
            AgentError::PlanNotEligible
        ));
        let AgentError::Provider(Source::ChatGpt, said) = refusal(
            StatusCode::BAD_REQUEST,
            json!({"code": "subscription_sharing_unsupported_capability", "param": "temperature"}),
        )
        .error("m") else {
            panic!("expected a provider error");
        };
        assert!(said.contains("temperature"));
        // A refusal before admission says only `detail`.
        let admission = Refusal::from_error(
            StatusCode::FORBIDDEN,
            &json!({"detail": "System messages are not allowed"}),
            "",
        );
        assert!(
            matches!(admission.error("m"), AgentError::Provider(Source::ChatGpt, said) if said.contains("System messages"))
        );
    }
}
