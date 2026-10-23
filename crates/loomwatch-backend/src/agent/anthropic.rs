//! Anthropic's Messages API, on the person's own Claude API key (ADR 0073): a Claude Max or Team
//! plan's monthly API credit, or credits they bought.
//!
//! One streamed `POST /v1/messages` per model call:
//! - the system prompt at the top, the whole request cached (`cache_control`), tools as
//!   `input_schema`, and every tool result of a turn in one user message;
//! - adaptive thinking, shown as summaries, and the effort in `output_config`, where the model
//!   takes them;
//! - each assistant message sent back exactly as Anthropic wrote it ([`Native`]), its signed
//!   thinking unchanged: Claude refuses a history whose earlier turns were edited. The thinking
//!   binding beta drops a block rather than refusing the call, as a last resort;
//! - Anthropic's own web search and page reading for an agent allowed the web;
//! - a summary asks for no tool call (`tool_choice: none`) rather than dropping the tools.
//!
//! Anthropic reports tokens, not dollars, so the cost is worked out from list prices and marked as
//! such. A call `pause_turn` stops (a long web search) is carried on within the same call, a few
//! times; a reply still paused after that is taken without the step Anthropic hadn't run yet, and
//! the model carries on from it in the next call.
//!
//! The same calls go to `OpenRouter`'s Anthropic-shaped `/messages` for a Claude on the operator's
//! `OpenRouter` key ([`Route::OpenRouter`]): there a Claude's own web search is a block of its own
//! between the words around it, where chat completions marks nothing. That route sends the key as
//! `OpenRouter` takes it, offers `OpenRouter`'s web tools held to the team's limits, and takes
//! `OpenRouter`'s exact cost and its refusals.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{Map, Value, json};

use super::ApiKey;
use super::error::{AgentError, CallError, redact};
use super::openrouter;
use super::provider::{
    Cancel, ChatRequest, Completion, DeltaSink, Finish, Message, Native, ToolCall, Usage, Written,
};
use super::sse::SseDecoder;
use crate::ai::anthropic::API_VERSION;
use crate::ai::{ClaudeModel, ModelRef, Source};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Silence allowed between two pieces of a stream. Anthropic sends `ping` events while a model
/// thinks, so this much silence means the connection is gone.
const STREAM_IDLE: Duration = Duration::from_mins(3);
const ATTEMPTS: u32 = 4;
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const MAX_ERROR_BYTES: usize = 64 * 1024;
/// Times a call stopped by `pause_turn` is carried on before its reply is taken as it stands.
const MAX_CONTINUATIONS: u32 = 5;
/// Lets a call drop a signed thinking block whose conversation changed, rather than be refused.
const BINDING_BETA: &str = "thinking-binding-controls-2026-08-01";
/// Dollars per web search Anthropic runs.
const SEARCH_DOLLARS: f64 = 0.01;

/// Dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Price {
    /// From the input and output prices alone: Anthropic reads the cache at a tenth and writes it
    /// at a quarter more.
    #[must_use]
    pub fn from_list(input: f64, output: f64) -> Self {
        Self {
            input,
            output,
            cache_read: input / 10.0,
            cache_write: input * 1.25,
        }
    }
}

/// List prices for the current models, for when `OpenRouter`'s catalog isn't at hand.
const LIST_PRICES: [(&str, f64, f64, f64); 10] = [
    ("claude-fable-5-1", 10.0, 50.0, 0.25),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.20),
    ("claude-opus-5", 5.0, 25.0, 0.50),
    ("claude-opus-4-8", 5.0, 25.0, 0.50),
    ("claude-sonnet-5-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-4-6", 3.0, 15.0, 0.30),
    ("claude-haiku-5-5", 0.10, 0.50, 0.01),
    ("claude-haiku-4-5", 1.0, 5.0, 0.10),
];

/// The list price of `model`, from the table above.
#[must_use]
pub fn list_price(model: &str) -> Option<Price> {
    LIST_PRICES
        .iter()
        .find(|(id, ..)| *id == model)
        .map(|(_, input, output, read)| Price {
            cache_read: *read,
            ..Price::from_list(*input, *output)
        })
}

/// Where a connection's calls go: whose key it carries, which web tools it offers and whose
/// figures its cost is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// Anthropic itself, with the person's Claude API key.
    Anthropic,
    /// `OpenRouter`'s Anthropic-shaped `/messages`, with the operator's `OpenRouter` key.
    OpenRouter,
}

impl Route {
    /// The source its calls are paid through and its errors are about.
    const fn source(self) -> Source {
        match self {
            Self::Anthropic => Source::Anthropic,
            Self::OpenRouter => Source::OpenRouter,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Anthropic => "Anthropic",
            Self::OpenRouter => "OpenRouter",
        }
    }
}

/// A connection to Anthropic with the person's key, or to `OpenRouter`'s `/messages` with the
/// operator's.
#[derive(Debug)]
pub struct Anthropic {
    client: Client,
    route: Route,
    /// Where each call is posted.
    endpoint: String,
    key: ApiKey,
    backoff: Duration,
    /// What each model takes, from the key's last check.
    models: HashMap<String, ClaudeModel>,
    prices: HashMap<String, Price>,
    /// Anthropic refused the thinking binding beta for this key, so it is no longer asked for.
    no_binding: AtomicBool,
    /// Models whose provider refused `OpenRouter`'s web limits, so they get the web tools without
    /// them for as long as the daemon runs.
    unlimited: Mutex<HashSet<String>>,
}

impl Anthropic {
    /// Anthropic at `base` (`https`, or `http` on this computer for tests), with what the key's
    /// check learned about its models and the prices to count their cost by.
    ///
    /// # Errors
    ///
    /// When `base` is neither, or the HTTP client cannot be built.
    pub fn new(
        key: ApiKey,
        base: &str,
        models: Vec<ClaudeModel>,
        prices: HashMap<String, Price>,
    ) -> anyhow::Result<Self> {
        let base = base.trim_end_matches('/');
        let mut connection = Self::connect(key, Route::Anthropic, &format!("{base}/v1/messages"))?;
        connection.models = models
            .into_iter()
            .map(|model| (model.id.clone(), model))
            .collect();
        connection.prices = prices;
        Ok(connection)
    }

    /// `OpenRouter`'s `/messages` under its API at `base` (`…/api/v1`), with the operator's key.
    ///
    /// # Errors
    ///
    /// When `base` is neither `https` nor `http` on this computer, or the HTTP client cannot be
    /// built.
    pub(crate) fn through_openrouter(key: ApiKey, base: &str) -> anyhow::Result<Self> {
        let base = base.trim_end_matches('/');
        Self::connect(key, Route::OpenRouter, &format!("{base}/messages"))
    }

    fn connect(key: ApiKey, route: Route, endpoint: &str) -> anyhow::Result<Self> {
        let local = super::is_loopback_http(endpoint);
        anyhow::ensure!(
            endpoint.starts_with("https://") || local,
            "an {} address must be https",
            route.name()
        );
        let client = Client::builder()
            .user_agent(concat!("LoomWatch/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!local)
            .build()?;
        Ok(Self {
            client,
            route,
            endpoint: endpoint.to_owned(),
            key,
            backoff: Duration::from_secs(1),
            models: HashMap::new(),
            prices: HashMap::new(),
            no_binding: AtomicBool::new(false),
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
        let model = ModelRef::parse(request.model).id;
        let mut so_far: Vec<Value> = Vec::new();
        let mut usage = Usage::default();
        let mut continued = 0;
        loop {
            let call = self.call(request, &model, &so_far, deltas, cancel).await?;
            usage.add(&call.usage);
            so_far.extend(call.blocks);
            if call.stop != "pause_turn" || continued == MAX_CONTINUATIONS {
                let mut completion = self.finish(&model, so_far, &call.stop, usage);
                // Each request read the conversation again, so the totals count it once a request.
                if continued > 0 {
                    completion.context_tokens =
                        Some(call.usage.prompt_tokens() + call.usage.output_tokens);
                }
                return Ok(completion);
            }
            continued += 1;
        }
    }

    /// One request, retried while nothing has streamed. `so_far` is what a paused reply has
    /// written already, sent back for the model to carry on from.
    async fn call(
        &self,
        request: &ChatRequest<'_>,
        model: &str,
        so_far: &[Value],
        deltas: &dyn DeltaSink,
        cancel: &Cancel,
    ) -> Result<Streamed, CallError> {
        let route = self.route;
        // `OpenRouter` holds its web tools to the team's limits unless this model's provider
        // refused them.
        let mut limited =
            route == Route::OpenRouter && request.server_tools.any() && !self.refuses_limits(model);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let binding = !self.no_binding.load(Ordering::Relaxed);
            let shape = Shape {
                route,
                binding,
                limited,
            };
            let body = body(request, model, self.models.get(model), so_far, shape);
            let mut sent = self
                .client
                .post(&self.endpoint)
                .header("anthropic-version", API_VERSION);
            sent = match route {
                Route::Anthropic => sent.header("x-api-key", self.key.expose()),
                Route::OpenRouter => sent
                    .bearer_auth(self.key.expose())
                    .header("HTTP-Referer", openrouter::REFERER)
                    .header("X-OpenRouter-Title", openrouter::TITLE),
            };
            if binding {
                sent = sent.header("anthropic-beta", BINDING_BETA);
            }
            let response = tokio::select! {
                response = sent.json(&body).send() => response,
                () = cancel.cancelled() => return Err(CallError::Cancelled),
            };
            let response = match response {
                Ok(response) => response,
                Err(error) if attempt < ATTEMPTS && (error.is_connect() || error.is_timeout()) => {
                    self.wait(attempt, None, cancel).await?;
                    continue;
                }
                Err(error) => {
                    return Err(AgentError::Network(route.source(), network_error(&error)).into());
                }
            };
            let status = response.status();
            if status.is_success() {
                match read_stream(response, route, model, deltas, cancel).await? {
                    Outcome::Whole(streamed) => return Ok(streamed),
                    Outcome::Refused { status, said } => {
                        if limited && openrouter::refused_the_limits(status, &said) {
                            self.forget_limits(model);
                            limited = false;
                            continue;
                        }
                        if attempt < ATTEMPTS && retryable(status) {
                            self.wait(attempt, None, cancel).await?;
                            continue;
                        }
                        return Err(status_error(route, status, &said, model).into());
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
            if binding && status == StatusCode::BAD_REQUEST && said.contains("anthropic-beta") {
                // This key can't use the binding beta: send what the API takes as it stands.
                self.no_binding.store(true, Ordering::Relaxed);
                continue;
            }
            if limited && openrouter::refused_the_limits(status, &said) {
                self.forget_limits(model);
                limited = false;
                continue;
            }
            return Err(status_error(route, status, &said, model).into());
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

    /// The finished message, from the blocks every call of it wrote.
    fn finish(
        &self,
        model: &str,
        mut blocks: Vec<Value>,
        stop: &str,
        mut usage: Usage,
    ) -> Completion {
        // `OpenRouter`'s own web tools have no result block, and go back as they were written.
        if self.route == Route::Anthropic && stop == "pause_turn" {
            leave_out_unrun(&mut blocks);
        }
        let mut written = Written::default();
        let mut tool_calls = Vec::new();
        let mut server_tool_calls = Vec::new();
        for block in &blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        written.text(text);
                    }
                }
                Some("tool_use") => tool_calls.push(ToolCall {
                    id: text_of(block, "id"),
                    name: text_of(block, "name"),
                    arguments: block
                        .get("input")
                        .map_or_else(|| "{}".to_owned(), Value::to_string),
                }),
                Some("server_tool_use") => {
                    written.tool();
                    let id = text_of(block, "id");
                    let result = blocks.iter().find(|result| {
                        result.get("tool_use_id").and_then(Value::as_str) == Some(id.as_str())
                    });
                    server_tool_calls.push(json!({
                        "tool_name": text_of(block, "name"),
                        "tool_call_id": id,
                        "arguments": block.get("input").map_or_else(|| "{}".to_owned(), Value::to_string),
                        "result": result.map(result_text).unwrap_or_default(),
                    }));
                }
                _ => {}
            }
        }
        let finish = match stop {
            "tool_use" => Finish::ToolCalls,
            "max_tokens" | "model_context_window_exceeded" => Finish::Length,
            "refusal" => Finish::ContentFilter,
            "pause_turn" => Finish::Paused,
            _ if !tool_calls.is_empty() => Finish::ToolCalls,
            _ => Finish::Stop,
        };
        // `OpenRouter` reports what each call cost; Anthropic reports tokens only.
        if self.route == Route::Anthropic {
            usage.paid_by = Some(Source::Anthropic);
            usage.cost_estimated = true;
            usage.cost_usd = self.cost(model, &usage);
        }
        Completion {
            content: written.content,
            reasoning_details: Vec::new(),
            tool_calls,
            finish,
            usage,
            server_tool_calls,
            answer_from: written.answer_from,
            native: Some(Native {
                source: self.route.source(),
                items: blocks,
            }),
            context_tokens: None,
        }
    }

    /// What `usage` cost at `model`'s list prices, and its searches. Zero for a model with no price
    /// known: better a cost that reads low than one made up.
    fn cost(&self, model: &str, usage: &Usage) -> f64 {
        let Some(price) = self
            .prices
            .get(model)
            .copied()
            .or_else(|| list_price(model))
        else {
            return 0.0;
        };
        #[expect(
            clippy::cast_precision_loss,
            reason = "token counts are far below 2^52, where the cast is exact"
        )]
        let tokens = |count: u64, dollars: f64| count as f64 * dollars / 1_000_000.0;
        #[expect(
            clippy::cast_precision_loss,
            reason = "search counts are far below 2^52, where the cast is exact"
        )]
        let searches = usage.web_searches as f64 * SEARCH_DOLLARS;
        tokens(usage.input_tokens, price.input)
            + tokens(usage.cached_read_tokens, price.cache_read)
            + tokens(usage.cached_write_tokens, price.cache_write)
            + tokens(usage.output_tokens, price.output)
            + searches
    }
}

/// Takes out each step Anthropic runs itself (a search, a page read, code) that has no result, and
/// the calls such code made, from a reply still paused when it is taken as it stands: it ends with
/// the step Anthropic was about to run, and Anthropic refuses a conversation that holds a step with
/// no result. The model is told its reply was paused ([`Finish::Paused`]) and runs the step again if
/// it still needs it.
fn leave_out_unrun(blocks: &mut Vec<Value>) {
    let answered: HashSet<String> = blocks
        .iter()
        .filter_map(|block| block.get("tool_use_id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    let mut unrun: HashSet<String> = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("server_tool_use"))
        .map(|block| text_of(block, "id"))
        .filter(|id| !answered.contains(id))
        .collect();
    if unrun.is_empty() {
        return;
    }
    loop {
        let made_by_unrun: Vec<String> = blocks
            .iter()
            .filter(|block| {
                block
                    .pointer("/caller/tool_id")
                    .and_then(Value::as_str)
                    .is_some_and(|caller| unrun.contains(caller))
            })
            .map(|block| text_of(block, "id"))
            .filter(|id| !id.is_empty() && !unrun.contains(id))
            .collect();
        if made_by_unrun.is_empty() {
            break;
        }
        unrun.extend(made_by_unrun);
    }
    blocks.retain(|block| {
        let id = block.get("id").or_else(|| block.get("tool_use_id"));
        !id.and_then(Value::as_str)
            .is_some_and(|id| unrun.contains(id))
    });
}

fn text_of(block: &Value, key: &str) -> String {
    block
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// A server tool's result as the record shows it: the pages a search found, the page read, or what
/// code the model ran printed.
fn result_text(result: &Value) -> String {
    let content = result.get("content");
    let printed = |key: &str| {
        content
            .and_then(|content| content.get(key))
            .and_then(Value::as_str)
            .map(str::trim_end)
            .filter(|text| !text.is_empty())
    };
    if content.is_some_and(|content| content.get("stdout").is_some()) {
        return [printed("stdout"), printed("stderr")]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(found) = content.and_then(Value::as_array) {
        return found
            .iter()
            .filter_map(|page| {
                let title = page
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let url = page.get("url").and_then(Value::as_str)?;
                Some(format!("{title} {url}").trim().to_owned())
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    content
        .and_then(|content| content.get("url"))
        .and_then(Value::as_str)
        .map(|url| format!("Read {url}"))
        .or_else(|| {
            content
                .and_then(|content| content.get("error_code"))
                .and_then(Value::as_str)
                .map(|code| format!("Failed: {code}"))
        })
        .unwrap_or_default()
}

fn retryable(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() || status.as_u16() == 529
}

/// How one try's body is shaped.
#[derive(Debug, Clone, Copy)]
struct Shape {
    route: Route,
    /// Ask for the thinking binding beta.
    binding: bool,
    /// Hold `OpenRouter`'s web tools to the team's limits.
    limited: bool,
}

/// The request body.
fn body(
    request: &ChatRequest<'_>,
    model: &str,
    known: Option<&ClaudeModel>,
    so_far: &[Value],
    shape: Shape,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("max_tokens".into(), json!(request.max_tokens));
    body.insert("stream".into(), json!(true));
    // The whole request is cached up to its last block, so the next call reads it back cheaply.
    body.insert("cache_control".into(), json!({"type": "ephemeral"}));
    if shape.route == Route::OpenRouter {
        // A session's calls stay on one route and keep their cache.
        body.insert("session_id".into(), json!(request.session_key));
    }
    let system: Vec<&str> = request
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::System { content } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    if !system.is_empty() {
        body.insert("system".into(), json!(system.join("\n\n")));
    }
    let mut messages = wire_messages(request.messages, shape.route.source());
    if !so_far.is_empty() {
        messages.push(json!({"role": "assistant", "content": so_far}));
    }
    body.insert("messages".into(), Value::Array(messages));

    let mut tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            })
        })
        .collect();
    let web = request.server_tools;
    match shape.route {
        Route::Anthropic => {
            if web.web_search {
                let mut search = json!({"type": "web_search_20260209", "name": "web_search"});
                if let Some(uses) = web.limits.searches {
                    search["max_uses"] = json!(uses);
                }
                tools.push(search);
            }
            if web.web_fetch {
                let mut fetch = json!({
                    "type": "web_fetch_20260209",
                    "name": "web_fetch",
                    "max_content_tokens": web.limits.page_tokens,
                });
                if let Some(uses) = web.limits.pages {
                    fetch["max_uses"] = json!(uses);
                }
                tools.push(fetch);
            }
        }
        Route::OpenRouter => {
            tools.extend(openrouter::web_tools(web, shape.limited));
            if let Some(steps) = openrouter::web_steps(web, shape.limited) {
                body.insert("max_tool_calls".into(), json!(steps));
            }
        }
    }
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
        body.insert(
            "tool_choice".into(),
            json!({"type": if request.tools_off { "none" } else { "auto" }}),
        );
    }

    // Every current Claude thinks adaptively; one that doesn't is called without thinking.
    let adaptive = known.is_none_or(|known| known.adaptive_thinking);
    if adaptive {
        let mut thinking = json!({"type": "adaptive", "display": "summarized"});
        if shape.binding {
            thinking["block_binding"] = json!({"prefix_mismatch_behavior": "drop_block"});
        }
        body.insert("thinking".into(), thinking);
    }
    if let Some(effort) = effort_for(request.effort, known) {
        body.insert("output_config".into(), json!({"effort": effort}));
    }
    Value::Object(body)
}

/// The effort the model is asked for: the team file's, moved to the nearest one Claude has, and
/// none for a model that takes none.
fn effort_for(effort: Option<&str>, known: Option<&ClaudeModel>) -> Option<&'static str> {
    let wanted = match effort? {
        "none" | "minimal" | "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "xhigh" => "xhigh",
        "max" | "ultra" => "max",
        _ => return None,
    };
    match known {
        None => Some(wanted),
        Some(known) if known.efforts.iter().any(|offered| offered == wanted) => Some(wanted),
        // The nearest it takes below, else none.
        Some(known) => ["max", "xhigh", "high", "medium", "low"]
            .into_iter()
            .skip_while(|level| *level != wanted)
            .find(|level| known.efforts.iter().any(|offered| offered == level)),
    }
}

/// The conversation as Anthropic's messages. The system prompt goes at the top instead; every tool
/// result of a turn, and the words that follow them, go in one user message; an assistant message
/// this route (`source`) wrote goes back exactly as it was.
fn wire_messages(history: &[Message], source: Source) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut user: Vec<Value> = Vec::new();
    let flush = |messages: &mut Vec<Value>, user: &mut Vec<Value>| {
        if !user.is_empty() {
            messages.push(json!({"role": "user", "content": std::mem::take(user)}));
        }
    };
    for message in history {
        match message {
            Message::System { .. } => {}
            Message::User { content, pictures } => {
                // Pictures the operator sent come before the words about them, each named.
                for picture in pictures {
                    user.push(
                        json!({"type": "text", "text": format!("The picture {}:", picture.name)}),
                    );
                    user.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": picture.media_type,
                            "data": picture.data,
                        },
                    }));
                }
                if !content.is_empty() {
                    user.push(json!({"type": "text", "text": content}));
                }
            }
            Message::Tool {
                tool_call_id,
                content,
                pictures,
            } => {
                let text = if content.is_empty() {
                    "(no output)"
                } else {
                    content.as_str()
                };
                // A picture goes inside the result of the tool that opened it.
                let content = if pictures.is_empty() {
                    json!(text)
                } else {
                    let mut blocks = vec![json!({"type": "text", "text": text})];
                    blocks.extend(pictures.iter().map(|picture| {
                        json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": picture.media_type,
                                "data": picture.data,
                            },
                        })
                    }));
                    Value::Array(blocks)
                };
                user.push(json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                }));
            }
            Message::Assistant {
                content,
                tool_calls,
                native,
                ..
            } => {
                flush(&mut messages, &mut user);
                let blocks = match native {
                    Some(native) if native.source == source && !native.items.is_empty() => {
                        native.items.clone()
                    }
                    _ => written_by_another(content, tool_calls),
                };
                messages.push(json!({"role": "assistant", "content": blocks}));
            }
        }
    }
    flush(&mut messages, &mut user);
    messages
}

/// An assistant message from before this session was on this route, as plain blocks.
fn written_by_another(content: &str, tool_calls: &[ToolCall]) -> Vec<Value> {
    let mut blocks = Vec::new();
    if !content.is_empty() {
        blocks.push(json!({"type": "text", "text": content}));
    }
    for call in tool_calls {
        let input = serde_json::from_str::<Value>(&call.arguments)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        blocks.push(json!({"type": "tool_use", "id": call.id, "name": call.name, "input": input}));
    }
    if blocks.is_empty() {
        // Anthropic takes no empty message; this one said nothing.
        blocks.push(json!({"type": "text", "text": "…"}));
    }
    blocks
}

/// One call's part of a message.
struct Streamed {
    blocks: Vec<Value>,
    stop: String,
    usage: Usage,
}

/// How a stream Anthropic accepted ended.
enum Outcome {
    Whole(Streamed),
    /// It reported an error before the model wrote anything, so trying again repeats nothing.
    Refused {
        status: StatusCode,
        said: String,
    },
}

/// The message a stream assembles, block by block.
#[derive(Default)]
struct Assembled {
    blocks: Vec<Value>,
    /// The JSON text of each tool call's input, as it streams, by block index.
    inputs: HashMap<usize, String>,
    stop: Option<String>,
    usage: Usage,
    begun: bool,
    done: bool,
}

async fn read_stream(
    mut response: reqwest::Response,
    route: Route,
    model: &str,
    deltas: &dyn DeltaSink,
    cancel: &Cancel,
) -> Result<Outcome, CallError> {
    let mut decoder = SseDecoder::default();
    let mut message = Assembled::default();
    loop {
        let chunk = tokio::select! {
            chunk = tokio::time::timeout(STREAM_IDLE, response.chunk()) => chunk,
            () = cancel.cancelled() => return Err(CallError::Cancelled),
        };
        let chunk = match chunk {
            Err(_) => return Err(AgentError::Stalled(route.source()).into()),
            Ok(Err(error)) => {
                return Err(AgentError::Network(route.source(), network_error(&error)).into());
            }
            Ok(Ok(None)) => break,
            Ok(Ok(Some(bytes))) => bytes,
        };
        for event in decoder.push(&chunk) {
            if let Some(refused) = take_event(&event, &mut message, route, model, deltas).await? {
                return Ok(refused);
            }
            if message.done {
                return Ok(Outcome::Whole(message.into_streamed()));
            }
        }
    }
    if let Some(event) = decoder.finish()
        && let Some(refused) = take_event(&event, &mut message, route, model, deltas).await?
    {
        return Ok(refused);
    }
    if message.stop.is_none() {
        return Err(AgentError::Stalled(route.source()).into());
    }
    Ok(Outcome::Whole(message.into_streamed()))
}

impl Assembled {
    fn into_streamed(self) -> Streamed {
        Streamed {
            blocks: self.blocks,
            stop: self.stop.unwrap_or_else(|| "end_turn".to_owned()),
            usage: self.usage,
        }
    }
}

async fn take_event(
    event: &str,
    message: &mut Assembled,
    route: Route,
    model: &str,
    deltas: &dyn DeltaSink,
) -> Result<Option<Outcome>, CallError> {
    let Ok(event) = serde_json::from_str::<Value>(event) else {
        return Ok(None);
    };
    // `OpenRouter` reports an error of its own as `{"error": {"code", "message"}}`, with no type.
    let kind = event.get("type").and_then(Value::as_str).or_else(|| {
        event
            .get("error")
            .filter(|error| error.is_object())
            .map(|_| "error")
    });
    match kind {
        Some("message_start") => {
            if let Some(usage) = event.pointer("/message/usage") {
                read_usage(usage, route, &mut message.usage);
            }
        }
        Some("content_block_start") => {
            let index = block_index(&event);
            let mut block = event.get("content_block").cloned().unwrap_or(Value::Null);
            let kind = block.get("type").and_then(Value::as_str);
            if kind == Some("server_tool_use") {
                deltas.server_tool();
            }
            if matches!(kind, Some("tool_use" | "server_tool_use")) {
                // Its input streams as JSON text; it is put back together when the block ends. A
                // call the model's own code made can come whole here, with nothing streamed after.
                if !block.get("input").is_some_and(Value::is_object) {
                    block["input"] = json!({});
                }
                message.inputs.insert(index, String::new());
            }
            place(&mut message.blocks, index, block);
            message.begun = true;
        }
        Some("content_block_delta") => {
            let index = block_index(&event);
            let delta = event.get("delta").cloned().unwrap_or(Value::Null);
            take_delta(message, index, &delta, deltas).await?;
        }
        Some("content_block_stop") => {
            let index = block_index(&event);
            if let Some(text) = message.inputs.remove(&index)
                && !text.trim().is_empty()
                && let Some(block) = message.blocks.get_mut(index)
            {
                block["input"] = serde_json::from_str::<Value>(&text)
                    .ok()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({}));
            }
        }
        Some("message_delta") => {
            if let Some(stop) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                message.stop = Some(stop.to_owned());
            }
            if let Some(usage) = event.get("usage") {
                read_usage(usage, route, &mut message.usage);
            }
        }
        Some("message_stop") => message.done = true,
        Some("error") => {
            let kind = event
                .pointer("/error/type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let said = event
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("the stream ended with an error")
                .to_owned();
            let code = event
                .pointer("/error/code")
                .and_then(Value::as_u64)
                .and_then(|code| u16::try_from(code).ok())
                .and_then(|code| StatusCode::from_u16(code).ok());
            let status = code.unwrap_or_else(|| match kind {
                "overloaded_error" => StatusCode::from_u16(529).unwrap_or(StatusCode::BAD_GATEWAY),
                "rate_limit_error" => StatusCode::TOO_MANY_REQUESTS,
                "api_error" => StatusCode::INTERNAL_SERVER_ERROR,
                "billing_error" => StatusCode::PAYMENT_REQUIRED,
                "authentication_error" => StatusCode::UNAUTHORIZED,
                _ => StatusCode::BAD_REQUEST,
            });
            if !message.begun {
                return Ok(Some(Outcome::Refused { status, said }));
            }
            return Err(status_error(route, status, &said, model).into());
        }
        _ => {}
    }
    Ok(None)
}

async fn take_delta(
    message: &mut Assembled,
    index: usize,
    delta: &Value,
    deltas: &dyn DeltaSink,
) -> Result<(), CallError> {
    let text = |key: &str| delta.get(key).and_then(Value::as_str).unwrap_or_default();
    match delta.get("type").and_then(Value::as_str) {
        Some("text_delta") => {
            let piece = text("text");
            append(&mut message.blocks, index, "text", piece);
            if !piece.is_empty() {
                deltas.text(piece).await?;
            }
        }
        Some("thinking_delta") => {
            let piece = text("thinking");
            append(&mut message.blocks, index, "thinking", piece);
            if !piece.is_empty() {
                deltas.reasoning(piece).await?;
            }
        }
        Some("signature_delta") => {
            if let Some(block) = message.blocks.get_mut(index) {
                block["signature"] = json!(text("signature"));
            }
        }
        Some("input_json_delta") => {
            message
                .inputs
                .entry(index)
                .or_default()
                .push_str(text("partial_json"));
        }
        Some("citations_delta") => {
            if let (Some(block), Some(citation)) =
                (message.blocks.get_mut(index), delta.get("citation"))
            {
                match block.get_mut("citations").and_then(Value::as_array_mut) {
                    Some(citations) => citations.push(citation.clone()),
                    None => block["citations"] = json!([citation]),
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn block_index(event: &Value) -> usize {
    event
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .unwrap_or(0)
}

/// Puts `block` at `index`, which the stream numbers from 0 in order.
fn place(blocks: &mut Vec<Value>, index: usize, block: Value) {
    if index < blocks.len() {
        blocks[index] = block;
    } else {
        blocks.resize(index, json!({"type": "text", "text": ""}));
        blocks.push(block);
    }
}

fn append(blocks: &mut [Value], index: usize, key: &str, piece: &str) {
    if let Some(block) = blocks.get_mut(index) {
        let held = block.get(key).and_then(Value::as_str).unwrap_or_default();
        block[key] = json!(format!("{held}{piece}"));
    }
}

/// Anthropic's usage: `message_start` gives the prompt, each `message_delta` the running totals.
/// `input_tokens` already leaves out what the cache served or wrote. `OpenRouter` adds the exact
/// `cost` to the last one, and counts the pages it read itself among its tool calls.
fn read_usage(usage: &Value, route: Route, into: &mut Usage) {
    let number = |key: &str| usage.get(key).and_then(Value::as_u64);
    if let Some(input) = number("input_tokens") {
        into.input_tokens = input;
    }
    if let Some(read) = number("cache_read_input_tokens") {
        into.cached_read_tokens = read;
    }
    if let Some(written) = number("cache_creation_input_tokens") {
        into.cached_write_tokens = written;
    }
    if let Some(output) = number("output_tokens") {
        into.output_tokens = output;
    }
    if route == Route::OpenRouter {
        if let Some(cost) = usage.get("cost").and_then(Value::as_f64) {
            into.cost_usd = cost;
        }
        if usage.get("server_tool_use").is_some_and(Value::is_object) {
            let web = openrouter::web_use(usage);
            into.web_searches = web.searches;
            into.web_fetches = web.fetches;
        }
        return;
    }
    if let Some(searches) = usage
        .pointer("/server_tool_use/web_search_requests")
        .and_then(Value::as_u64)
    {
        into.web_searches = searches;
    }
    if let Some(fetches) = usage
        .pointer("/server_tool_use/web_fetch_requests")
        .and_then(Value::as_u64)
    {
        into.web_fetches = fetches;
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

/// What a refused request means for the person: in `OpenRouter`'s terms on that route.
fn status_error(route: Route, status: StatusCode, said: &str, model: &str) -> AgentError {
    if route == Route::OpenRouter {
        return openrouter::status_error(status, said, model);
    }
    let said = redact(said);
    let lower = said.to_lowercase();
    if lower.contains("credit balance is too low") || status == StatusCode::PAYMENT_REQUIRED {
        return AgentError::OutOfCredits(Source::Anthropic);
    }
    match status {
        StatusCode::UNAUTHORIZED => AgentError::KeyRefused(Source::Anthropic),
        StatusCode::FORBIDDEN if lower.contains("key") => AgentError::KeyRefused(Source::Anthropic),
        StatusCode::TOO_MANY_REQUESTS => AgentError::RateLimited(Source::Anthropic),
        StatusCode::NOT_FOUND => AgentError::ModelUnavailable(Source::Anthropic, model.to_owned()),
        StatusCode::PAYLOAD_TOO_LARGE => AgentError::ContextTooLong,
        _ if lower.contains("prompt is too long") || lower.contains("context window") => {
            AgentError::ContextTooLong
        }
        _ if lower.contains("model") && lower.contains("not found") => {
            AgentError::ModelUnavailable(Source::Anthropic, model.to_owned())
        }
        _ if said.is_empty() => {
            AgentError::Provider(Source::Anthropic, format!("HTTP {}", status.as_u16()))
        }
        _ => AgentError::Provider(Source::Anthropic, said),
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

    fn opus() -> ClaudeModel {
        ClaudeModel {
            id: "claude-opus-5-5".into(),
            name: "Claude Opus 5.5".into(),
            context_length: 1_000_000,
            max_output: 128_000,
            adaptive_thinking: true,
            sees_pictures: true,
            efforts: ["low", "medium", "high", "xhigh", "max"]
                .map(str::to_owned)
                .to_vec(),
        }
    }

    fn shape(route: Route, binding: bool) -> Shape {
        Shape {
            route,
            binding,
            limited: true,
        }
    }

    fn request<'a>(messages: &'a [Message], tools: &'a [ToolSpec]) -> ChatRequest<'a> {
        ChatRequest {
            model: "anthropic:claude-opus-5-5",
            effort: Some("ultra"),
            messages,
            tools,
            server_tools: ServerTools::default(),
            max_tokens: 16_000,
            tools_off: false,
            session_key: "s-1",
            agent_id: "writer",
        }
    }

    /// A picture goes inside the result of the tool that opened it, where Claude reads it with
    /// the tool's words; a result without one stays the text it always was.
    #[test]
    fn a_picture_goes_inside_the_result_of_the_tool_that_opened_it() {
        let history = [
            Message::Tool {
                tool_call_id: "toolu_1".into(),
                content: "shot.png: a picture, 40×20 pixels.".into(),
                pictures: vec![crate::agent::provider::Picture {
                    name: "shot.png".into(),
                    media_type: "image/png".into(),
                    data: "iVBORw0K".into(),
                }],
            },
            Message::Tool {
                tool_call_id: "toolu_2".into(),
                content: "B".into(),
                pictures: Vec::new(),
            },
        ];
        assert_eq!(
            wire_messages(&history, Source::Anthropic),
            [json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": [
                    {"type": "text", "text": "shot.png: a picture, 40×20 pixels."},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0K"}},
                ]},
                {"type": "tool_result", "tool_use_id": "toolu_2", "content": "B"},
            ]})]
        );
    }

    /// Pictures the operator sent with a message go before its words, each named (ADR 0082).
    #[test]
    fn pictures_sent_with_a_message_go_before_its_words() {
        let sent = Message::User {
            content: "What is wrong here?".into(),
            pictures: vec![crate::agent::provider::Picture {
                name: "shot.png".into(),
                media_type: "image/png".into(),
                data: "iVBORw0K".into(),
            }],
        };
        assert_eq!(
            wire_messages(&[sent], Source::Anthropic),
            [json!({"role": "user", "content": [
                {"type": "text", "text": "The picture shot.png:"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0K"}},
                {"type": "text", "text": "What is wrong here?"},
            ]})]
        );
    }

    /// The system prompt goes on top, a turn's tool results and the words after them share one user
    /// message, Anthropic's own message goes back exactly as written, and a summary keeps the
    /// tools while asking for no call.
    #[test]
    fn the_body_keeps_the_conversation_as_anthropic_wrote_it() {
        let signed = vec![
            json!({"type": "thinking", "thinking": "plan", "signature": "sig-1"}),
            json!({"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "a.md"}}),
            json!({"type": "tool_use", "id": "toolu_2", "name": "read_file", "input": {"path": "b.md"}}),
        ];
        let history = [
            Message::System {
                content: "Be brief.".into(),
            },
            Message::User {
                content: "Read both.".into(),
                pictures: Vec::new(),
            },
            Message::Assistant {
                content: String::new(),
                reasoning_details: Vec::new(),
                tool_calls: Vec::new(),
                native: Some(Native {
                    source: Source::Anthropic,
                    items: signed.clone(),
                }),
            },
            Message::Tool {
                tool_call_id: "toolu_1".into(),
                content: "A".into(),
                pictures: Vec::new(),
            },
            Message::Tool {
                tool_call_id: "toolu_2".into(),
                content: String::new(),
                pictures: Vec::new(),
            },
            Message::User {
                content: "Now sum up.".into(),
                pictures: Vec::new(),
            },
        ];
        let tools = [ToolSpec {
            name: "read_file".into(),
            description: "Reads a file".into(),
            parameters: json!({"type": "object"}),
        }];
        let sent = body(
            &request(&history, &tools),
            "claude-opus-5-5",
            Some(&opus()),
            &[],
            shape(Route::Anthropic, true),
        );
        assert_eq!(sent["system"], "Be brief.");
        assert_eq!(sent["cache_control"], json!({"type": "ephemeral"}));
        assert_eq!(
            sent["messages"][0],
            json!({"role": "user", "content": [{"type": "text", "text": "Read both."}]})
        );
        assert_eq!(sent["messages"][1]["content"], json!(signed));
        assert_eq!(
            sent["messages"][2]["content"],
            json!([
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "A"},
                {"type": "tool_result", "tool_use_id": "toolu_2", "content": "(no output)"},
                {"type": "text", "text": "Now sum up."},
            ])
        );
        assert_eq!(sent["messages"].as_array().unwrap().len(), 3);
        assert_eq!(sent["tools"][0]["input_schema"], json!({"type": "object"}));
        assert_eq!(sent["tool_choice"], json!({"type": "auto"}));
        assert_eq!(sent["thinking"]["type"], "adaptive");
        assert_eq!(
            sent["thinking"]["block_binding"]["prefix_mismatch_behavior"],
            "drop_block"
        );
        assert_eq!(sent["output_config"]["effort"], "max");
        assert!(sent.get("temperature").is_none());

        let summary = ChatRequest {
            tools_off: true,
            ..request(&history, &tools)
        };
        let sent = body(
            &summary,
            "claude-opus-5-5",
            Some(&opus()),
            &[],
            shape(Route::Anthropic, false),
        );
        assert_eq!(sent["tool_choice"], json!({"type": "none"}));
        assert_eq!(sent["tools"].as_array().unwrap().len(), 1);
        assert!(sent["thinking"].get("block_binding").is_none());
    }

    #[test]
    fn an_effort_moves_to_the_nearest_one_the_model_takes() {
        let mut fewer = opus();
        fewer.efforts = vec!["low".into(), "medium".into(), "high".into()];
        assert_eq!(effort_for(Some("xhigh"), Some(&fewer)), Some("high"));
        assert_eq!(effort_for(Some("minimal"), Some(&fewer)), Some("low"));
        assert_eq!(effort_for(Some("default"), Some(&fewer)), None);
        let mut none = opus();
        none.efforts.clear();
        assert_eq!(effort_for(Some("high"), Some(&none)), None);
        assert_eq!(effort_for(Some("max"), None), Some("max"));
    }

    #[test]
    fn a_cost_is_worked_out_from_list_prices() {
        let provider = Anthropic::new(
            ApiKey::new("sk-ant-api03-test").unwrap(),
            "http://127.0.0.1:9",
            vec![opus()],
            HashMap::new(),
        )
        .unwrap();
        let usage = Usage {
            input_tokens: 1_000_000,
            cached_read_tokens: 1_000_000,
            cached_write_tokens: 0,
            output_tokens: 100_000,
            web_searches: 2,
            ..Usage::default()
        };
        // $4 in, $0.20 cached, $2 out, $0.02 for two searches.
        assert!((provider.cost("claude-opus-5-5", &usage) - 6.22).abs() < 1e-9);
        assert!(provider.cost("claude-unknown", &usage).abs() < 1e-12);
    }

    #[test]
    fn refusals_read_in_plain_words() {
        let model = "claude-opus-5-5";
        assert!(matches!(
            status_error(
                Route::Anthropic,
                StatusCode::BAD_REQUEST,
                "Your credit balance is too low to access the Anthropic API.",
                model
            ),
            AgentError::OutOfCredits(Source::Anthropic)
        ));
        assert!(matches!(
            status_error(
                Route::Anthropic,
                StatusCode::UNAUTHORIZED,
                "invalid x-api-key",
                model
            ),
            AgentError::KeyRefused(Source::Anthropic)
        ));
        assert!(matches!(
            status_error(
                Route::Anthropic,
                StatusCode::NOT_FOUND,
                "model: claude-x",
                model
            ),
            AgentError::ModelUnavailable(Source::Anthropic, _)
        ));
        assert!(matches!(
            status_error(
                Route::Anthropic,
                StatusCode::BAD_REQUEST,
                "prompt is too long: 1200000 tokens > 1000000",
                model
            ),
            AgentError::ContextTooLong
        ));
        let AgentError::Provider(Source::Anthropic, said) = status_error(
            Route::Anthropic,
            StatusCode::BAD_REQUEST,
            "bad key sk-ant-api03-abcdefabcdefabcdef",
            model,
        ) else {
            panic!("expected a provider error");
        };
        assert!(!said.contains("abcdefabcdef"));
    }
}
