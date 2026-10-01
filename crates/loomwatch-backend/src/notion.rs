//! User-owned Notion connections. Secrets live in the OS credential store only.
//!
//! [`Publisher`] is the delivery side: it turns a routine's Markdown reply into a child
//! page of the connected destination (see `docs/decisions/0010-routines-and-notion-delivery.md`).
use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

#[cfg(target_os = "macos")]
const SERVICE: &str = "LoomWatch.Notion";
#[cfg(target_os = "macos")]
const ACCOUNT: &str = "local-workspace";
const API: &str = "https://api.notion.com/v1";
const VERSION: &str = "2026-03-11";

#[derive(Clone)]
struct NotionState {
    client: Client,
    gate: Arc<Mutex<()>>,
}

// Deliberately no Debug implementation: this structure contains credentials.
#[derive(Serialize, Deserialize)]
struct Connection {
    token: String,
    name: String,
    #[serde(default)]
    destination: Option<Page>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Page {
    id: String,
    title: String,
}

/// The caller must only mount this router on a loopback listener.
///
/// # Errors
/// Returns an error if the HTTPS client cannot be initialized.
pub fn router() -> anyhow::Result<Router> {
    let state = NotionState {
        client: build_client()?,
        gate: Arc::new(Mutex::new(())),
    };
    Ok(Router::new()
        .route(
            "/api/notion/connection",
            get(status).post(connect).delete(disconnect),
        )
        .route("/api/notion/pages", post(pages))
        .route("/api/notion/destination", axum::routing::put(destination))
        .layer(DefaultBodyLimit::max(8192))
        .route_layer(middleware::from_fn(protect))
        .route_layer(middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(state))
}

/// The HTTPS client both the connection router and the publisher use: no redirects,
/// bounded connect and request times.
fn build_client() -> anyhow::Result<Client> {
    Ok(Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()?)
}

async fn protect(request: Request, next: Next) -> Response {
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("x-loomwatch-request")
            .is_none_or(|v| v != "1")
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Open Connections in LoomWatch to manage Notion.",
        )
        .into_response();
    }
    next.run(request).await
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: &'static str,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}
fn failure(status: StatusCode, message: &'static str) -> ApiError {
    ApiError { status, message }
}
type ApiResult<T> = Result<T, ApiError>;

#[cfg(target_os = "macos")]
fn credential() -> ApiResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| storage_error())
}
fn storage_error() -> ApiError {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "The secure credential store is unavailable. Unlock your macOS Keychain and retry. Nothing is saved in project files.",
    )
}

async fn load() -> ApiResult<Option<Connection>> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            match credential()?.get_password() {
                Ok(value) => serde_json::from_str(&value)
                    .map(Some)
                    .map_err(|_| storage_error()),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(storage_error()),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(storage_error())
        }
    })
    .await
    .map_err(|_| storage_error())?
}

async fn save(connection: Option<Connection>) -> ApiResult<()> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let entry = credential()?;
            if let Some(connection) = connection {
                let value = serde_json::to_string(&connection).map_err(|_| storage_error())?;
                entry.set_password(&value).map_err(|_| storage_error())
            } else {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err(storage_error()),
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = connection;
            Err(storage_error())
        }
    })
    .await
    .map_err(|_| storage_error())?
}

fn public_status(connection: Option<&Connection>) -> Value {
    connection.map_or_else(
        || json!({"connected": false}),
        |c| json!({"connected": true, "name": c.name, "destination": c.destination}),
    )
}

async fn status(State(state): State<NotionState>) -> ApiResult<Json<Value>> {
    let _guard = state.gate.lock().await;
    Ok(Json(public_status(load().await?.as_ref())))
}

async fn request(
    client: &Client,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> ApiResult<Value> {
    let mut request = client.request(method, format!("{API}/{path}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request
        .bearer_auth(token)
        .header("Notion-Version", VERSION)
        .send()
        .await
        .map_err(|_| {
            failure(
                StatusCode::BAD_GATEWAY,
                "Could not reach Notion. Check your internet connection and retry.",
            )
        })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => failure(
                StatusCode::UNAUTHORIZED,
                "Notion rejected this token. Reconnect with a valid token.",
            ),
            403 | 404 => failure(
                StatusCode::FORBIDDEN,
                "Notion cannot access this page. Open the page in Notion, choose ••• → Connections, and add your integration.",
            ),
            429 => failure(
                StatusCode::TOO_MANY_REQUESTS,
                "Notion is rate limiting requests. Wait a minute and retry.",
            ),
            _ => failure(
                StatusCode::BAD_GATEWAY,
                "Notion could not complete the request. Retry shortly.",
            ),
        });
    }
    // Bound upstream bodies, including responses without Content-Length.
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        failure(
            StatusCode::BAD_GATEWAY,
            "Notion returned an incomplete response. Retry.",
        )
    })? {
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err(failure(
                StatusCode::BAD_GATEWAY,
                "Notion's response was too large. Use a more specific search.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        failure(
            StatusCode::BAD_GATEWAY,
            "Notion returned an unreadable response. Retry.",
        )
    })
}

#[derive(Deserialize)]
struct Connect {
    token: String,
}
async fn connect(
    State(state): State<NotionState>,
    Json(input): Json<Connect>,
) -> ApiResult<Json<Value>> {
    let token = input.token.trim();
    if !(20..=4096).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "Paste a complete Notion integration token.",
        ));
    }
    let _guard = state.gate.lock().await;
    let bot = request(&state.client, token, Method::GET, "users/me", None).await?;
    let name = bot
        .pointer("/bot/workspace_name")
        .or_else(|| bot.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Notion workspace");
    let connection = Connection {
        token: token.to_owned(),
        name: name.to_owned(),
        destination: None,
    };
    let status = public_status(Some(&connection));
    save(Some(connection)).await?;
    Ok(Json(status))
}
async fn disconnect(State(state): State<NotionState>) -> ApiResult<Json<Value>> {
    let _guard = state.gate.lock().await;
    save(None).await?;
    Ok(Json(public_status(None)))
}
async fn connected() -> ApiResult<Connection> {
    load()
        .await?
        .ok_or_else(|| failure(StatusCode::CONFLICT, "Connect your Notion workspace first."))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    #[serde(default)]
    query: String,
    cursor: Option<String>,
}
async fn pages(
    State(state): State<NotionState>,
    Json(input): Json<Search>,
) -> ApiResult<Json<Value>> {
    if input.query.len() > 200 || input.cursor.as_ref().is_some_and(|c| c.len() > 200) {
        return Err(failure(StatusCode::BAD_REQUEST, "Search text is too long."));
    }
    let _guard = state.gate.lock().await;
    let connection = connected().await?;
    let mut body = json!({"query": input.query, "filter": {"value": "page", "property": "object"}, "page_size": 50});
    if let Some(cursor) = input.cursor {
        body["start_cursor"] = json!(cursor);
    }
    let result = request(
        &state.client,
        &connection.token,
        Method::POST,
        "search",
        Some(body),
    )
    .await?;
    let pages: Vec<Page> = result
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(page)
        .collect();
    Ok(Json(
        json!({"pages": pages, "nextCursor": result.get("next_cursor")}),
    ))
}
fn page(value: &Value) -> Option<Page> {
    if value.get("archived") == Some(&json!(true)) || value.get("in_trash") == Some(&json!(true)) {
        return None;
    }
    let id = uuid::Uuid::parse_str(value.get("id")?.as_str()?)
        .ok()?
        .to_string();
    let title: String = value
        .get("properties")?
        .as_object()?
        .values()
        .filter_map(|v| v.get("title").and_then(Value::as_array))
        .flatten()
        .filter_map(|v| {
            v.get("plain_text")
                .or_else(|| v.pointer("/text/content"))
                .and_then(Value::as_str)
        })
        .collect();
    Some(Page {
        id,
        title: if title.is_empty() {
            "Untitled page".into()
        } else {
            title
        },
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    page_id: String,
}
async fn destination(
    State(state): State<NotionState>,
    Json(input): Json<Destination>,
) -> ApiResult<Json<Value>> {
    let id = uuid::Uuid::parse_str(&input.page_id).map_err(|_| {
        failure(
            StatusCode::BAD_REQUEST,
            "Choose a page from the search results.",
        )
    })?;
    let _guard = state.gate.lock().await;
    let mut connection = connected().await?;
    let result = request(
        &state.client,
        &connection.token,
        Method::GET,
        &format!("pages/{id}"),
        None,
    )
    .await?;
    connection.destination = Some(page(&result).ok_or_else(|| {
        failure(
            StatusCode::BAD_REQUEST,
            "This page is unavailable. Choose another page.",
        )
    })?);
    let status = public_status(Some(&connection));
    save(Some(connection)).await?;
    Ok(Json(status))
}

// ---------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------

/// What the delivery reports when no workspace or destination page is connected.
pub(crate) const NOT_CONNECTED_MESSAGE: &str =
    "Notion is not connected. Open Connections and choose a destination page.";
/// Notion accepts at most this many children per create or append request.
const BLOCKS_PER_REQUEST: usize = 100;
/// Notion rejects a `rich_text` item whose content exceeds this many characters.
const MAX_RICH_TEXT_CHARS: usize = 2000;
/// Upper bound on the blocks one delivery writes; the rest is replaced by a marker.
const MAX_BLOCKS: usize = 500;
const TRUNCATED_MARKER: &str = "… truncated";

/// A page the publisher created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Published {
    pub(crate) page_id: String,
    pub(crate) url: String,
}

/// Why a delivery did not create a page. Every variant carries operator-facing text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PublishError {
    /// The destination already has a child page with exactly this title.
    Duplicate { page_id: String, url: String },
    /// Nothing was written; the message says why in the same words Connections uses.
    Failed(String),
}

impl From<ApiError> for PublishError {
    fn from(error: ApiError) -> Self {
        Self::Failed(error.message.to_owned())
    }
}

/// Where the publisher reads its connection from.
enum ConnectionSource {
    Keychain,
    /// Never connected — the not-connected branch without touching the credential store.
    #[cfg(test)]
    Absent,
}

/// Publishes Markdown as a child page of the operator's chosen destination.
pub(crate) struct Publisher {
    client: Client,
    source: ConnectionSource,
}

impl Publisher {
    /// A publisher reading the stored connection, with its own HTTPS client.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTPS client cannot be initialized.
    pub(crate) fn new() -> anyhow::Result<Self> {
        Ok(Self {
            client: build_client()?,
            source: ConnectionSource::Keychain,
        })
    }

    /// A publisher that is never connected, for tests that must not reach the keychain.
    #[cfg(test)]
    pub(crate) fn disconnected() -> Self {
        Self {
            client: build_client().expect("HTTPS client"),
            source: ConnectionSource::Absent,
        }
    }

    /// Create `title` under the connected destination holding `markdown`, unless a child
    /// page with that exact title already exists.
    ///
    /// # Errors
    ///
    /// [`PublishError::Duplicate`] when the guard finds an existing page;
    /// [`PublishError::Failed`] when nothing is connected or Notion refuses a request.
    pub(crate) async fn publish(
        &self,
        title: &str,
        markdown: &str,
    ) -> Result<Published, PublishError> {
        let connection = match self.source {
            ConnectionSource::Keychain => load().await?,
            #[cfg(test)]
            ConnectionSource::Absent => None,
        };
        self.publish_with(connection, title, markdown).await
    }

    async fn publish_with(
        &self,
        connection: Option<Connection>,
        title: &str,
        markdown: &str,
    ) -> Result<Published, PublishError> {
        let Some(Connection {
            token,
            destination: Some(destination),
            ..
        }) = connection
        else {
            return Err(PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned()));
        };
        if let Some((page_id, url)) = self.existing_child(&token, &destination.id, title).await? {
            return Err(PublishError::Duplicate { page_id, url });
        }
        let blocks = markdown_blocks(markdown);
        let mut chunks = blocks.chunks(BLOCKS_PER_REQUEST);
        let first = chunks.next().map(<[Value]>::to_vec).unwrap_or_default();
        let created = request(
            &self.client,
            &token,
            Method::POST,
            "pages",
            Some(json!({
                "parent": {"page_id": destination.id},
                "properties": {"title": {"title": [text_item(title)]}},
                "children": first,
            })),
        )
        .await?;
        let page_id = created
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                PublishError::Failed("Notion created the page but returned no id.".to_owned())
            })?
            .to_owned();
        let url = created
            .get("url")
            .and_then(Value::as_str)
            .map_or_else(|| page_url(&page_id), str::to_owned);
        for chunk in chunks {
            request(
                &self.client,
                &token,
                Method::PATCH,
                &format!("blocks/{page_id}/children"),
                Some(json!({"children": chunk})),
            )
            .await?;
        }
        Ok(Published { page_id, url })
    }

    /// The id and URL of a `child_page` of `parent` titled exactly `title`, following
    /// pagination to the end.
    async fn existing_child(
        &self,
        token: &str,
        parent: &str,
        title: &str,
    ) -> Result<Option<(String, String)>, PublishError> {
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!("blocks/{parent}/children?page_size=100");
            if let Some(cursor) = &cursor {
                path.push_str("&start_cursor=");
                path.push_str(cursor);
            }
            let page = request(&self.client, token, Method::GET, &path, None).await?;
            let found = page
                .get("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("child_page"))
                .find(|block| {
                    block.pointer("/child_page/title").and_then(Value::as_str) == Some(title)
                })
                .and_then(|block| block.get("id").and_then(Value::as_str))
                .map(|id| (id.to_owned(), page_url(id)));
            if found.is_some() {
                return Ok(found);
            }
            cursor = page
                .get("next_cursor")
                .and_then(Value::as_str)
                .filter(|next| {
                    !next.is_empty()
                        && next
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok(None);
            }
        }
    }
}

/// The public page URL Notion derives from an id, for responses that carry none.
fn page_url(id: &str) -> String {
    format!("https://www.notion.so/{}", id.replace('-', ""))
}

fn text_item(content: &str) -> Value {
    json!({"type": "text", "text": {"content": content}})
}

/// Translate Markdown into Notion block objects: `#`/`##`/`###` headings, `-`/`*` bullets,
/// `1.` numbered items, `>` quotes, `---` dividers, fenced code, and blank-line-separated
/// paragraphs, with `[text](url)`, `**bold**`, `*italic*`/`_italic_` and `` `code` ``
/// inline. Rich-text items are split at Notion's 2000-character limit and the block count
/// is capped at 500 (the last block then reads "… truncated").
pub(crate) fn markdown_blocks(markdown: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut fence: Option<Vec<&str>> = None;
    for line in markdown.lines() {
        if let Some(code) = fence.as_mut() {
            if line.trim_start().starts_with("```") {
                blocks.push(code_block(&code.join("\n")));
                fence = None;
            } else {
                code.push(line);
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            flush_paragraph(&mut paragraph, &mut blocks);
            fence = Some(Vec::new());
        } else if trimmed.is_empty() {
            flush_paragraph(&mut paragraph, &mut blocks);
        } else if let Some(block) = line_block(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            blocks.push(block);
        } else {
            paragraph.push(trimmed);
        }
    }
    if let Some(code) = fence {
        blocks.push(code_block(&code.join("\n")));
    }
    flush_paragraph(&mut paragraph, &mut blocks);
    if blocks.len() > MAX_BLOCKS {
        blocks.truncate(MAX_BLOCKS - 1);
        blocks.push(rich_block("paragraph", TRUNCATED_MARKER));
    }
    blocks
}

fn flush_paragraph(paragraph: &mut Vec<&str>, blocks: &mut Vec<Value>) {
    if !paragraph.is_empty() {
        blocks.push(rich_block("paragraph", &paragraph.join("\n")));
        paragraph.clear();
    }
}

/// A block for a line that is not paragraph text, or `None` when it is.
fn line_block(line: &str) -> Option<Value> {
    if matches!(line, "---" | "***" | "___") {
        return Some(json!({"object": "block", "type": "divider", "divider": {}}));
    }
    for (prefix, kind) in [
        ("# ", "heading_1"),
        ("## ", "heading_2"),
        ("### ", "heading_3"),
        ("#### ", "heading_3"),
        ("##### ", "heading_3"),
        ("###### ", "heading_3"),
    ] {
        if let Some(text) = line.strip_prefix(prefix) {
            return Some(rich_block(kind, text.trim()));
        }
    }
    if let Some(text) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        return Some(rich_block("bulleted_list_item", text.trim()));
    }
    if let Some(text) = numbered_item(line) {
        return Some(rich_block("numbered_list_item", text.trim()));
    }
    if let Some(text) = line.strip_prefix('>') {
        return Some(rich_block("quote", text.trim()));
    }
    None
}

/// The text after a `1. ` / `1) ` marker.
fn numbered_item(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = &line[digits..];
    rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))
}

fn rich_block(kind: &str, text: &str) -> Value {
    json!({"object": "block", "type": kind, kind: {"rich_text": rich_text(text)}})
}

fn code_block(code: &str) -> Value {
    let items: Vec<Value> = split_long(code)
        .into_iter()
        .map(|chunk| text_item(&chunk))
        .collect();
    json!({"object": "block", "type": "code", "code": {"rich_text": items, "language": "plain text"}})
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Style {
    bold: bool,
    italic: bool,
    code: bool,
    link: Option<String>,
}

/// Inline Markdown → Notion rich-text items. Unmatched markers stay literal text.
fn rich_text(text: &str) -> Vec<Value> {
    let chars: Vec<char> = text.chars().collect();
    let mut spans: Vec<(String, Style)> = Vec::new();
    let mut plain = String::new();
    let mut index = 0;
    while index < chars.len() {
        if let Some((content, style, consumed)) = inline_span(&chars, index) {
            if !plain.is_empty() {
                spans.push((std::mem::take(&mut plain), Style::default()));
            }
            spans.push((content, style));
            index += consumed;
        } else {
            plain.push(chars[index]);
            index += 1;
        }
    }
    if !plain.is_empty() {
        spans.push((plain, Style::default()));
    }
    spans
        .into_iter()
        .flat_map(|(content, style)| {
            split_long(&content)
                .into_iter()
                .map(move |chunk| styled_item(&chunk, &style))
        })
        .collect()
}

/// A styled span starting at `at`: its text, style and how many chars it consumed.
fn inline_span(chars: &[char], at: usize) -> Option<(String, Style, usize)> {
    let rest = &chars[at..];
    let styled = |bold, italic, code| Style {
        bold,
        italic,
        code,
        link: None,
    };
    if rest[0] == '`' {
        let end = find(rest, 1, &['`'])?;
        let content: String = rest[1..end].iter().collect();
        return (!content.is_empty()).then(|| (content, styled(false, false, true), end + 1));
    }
    if rest[0] == '[' {
        let close = find(rest, 1, &[']', '('])?;
        let end = find(rest, close + 2, &[')'])?;
        let url: String = rest[close + 2..end].iter().collect();
        let content: String = rest[1..close].iter().collect();
        let linkable = ["http://", "https://", "mailto:"]
            .iter()
            .any(|scheme| url.starts_with(scheme));
        return (linkable && !content.is_empty()).then(|| {
            let style = Style {
                link: Some(url),
                ..Style::default()
            };
            (content, style, end + 1)
        });
    }
    if rest.starts_with(&['*', '*']) {
        let end = find(rest, 2, &['*', '*'])?;
        let content: String = rest[2..end].iter().collect();
        return (!content.trim().is_empty())
            .then(|| (content, styled(true, false, false), end + 2));
    }
    if rest[0] == '*' || rest[0] == '_' {
        let marker = rest[0];
        let word_boundary_before = marker == '*' || at == 0 || !chars[at - 1].is_alphanumeric();
        if !word_boundary_before || rest.get(1).is_none_or(|next| next.is_whitespace()) {
            return None;
        }
        let end = find(rest, 2, &[marker])?;
        let word_boundary_after =
            marker == '*' || rest.get(end + 1).is_none_or(|next| !next.is_alphanumeric());
        if rest[end - 1].is_whitespace() || !word_boundary_after {
            return None;
        }
        let content: String = rest[1..end].iter().collect();
        return Some((content, styled(false, true, false), end + 1));
    }
    None
}

/// Index of the first occurrence of `needle` in `haystack` at or after `from`.
fn find(haystack: &[char], from: usize, needle: &[char]) -> Option<usize> {
    (from..=haystack.len().checked_sub(needle.len())?)
        .find(|&index| haystack[index..index + needle.len()] == *needle)
}

/// Split `content` into pieces Notion accepts as one rich-text item.
fn split_long(content: &str) -> Vec<String> {
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= MAX_RICH_TEXT_CHARS {
        return vec![content.to_owned()];
    }
    chars
        .chunks(MAX_RICH_TEXT_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

fn styled_item(content: &str, style: &Style) -> Value {
    let mut item = text_item(content);
    if let Some(url) = &style.link {
        item["text"]["link"] = json!({"url": url});
    }
    let mut annotations = serde_json::Map::new();
    for (name, on) in [
        ("bold", style.bold),
        ("italic", style.italic),
        ("code", style.code),
    ] {
        if on {
            annotations.insert(name.to_owned(), Value::Bool(true));
        }
    }
    if !annotations.is_empty() {
        item["annotations"] = Value::Object(annotations);
    }
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use tower::ServiceExt;

    fn kinds(blocks: &[Value]) -> Vec<&str> {
        blocks
            .iter()
            .map(|block| block["type"].as_str().unwrap())
            .collect()
    }

    fn plain(block: &Value) -> String {
        let kind = block["type"].as_str().unwrap();
        block[kind]["rich_text"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["text"]["content"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn markdown_blocks_map_structure_to_notion_block_types() {
        let blocks = markdown_blocks(
            "# Title\n\nFirst line\nsecond line\n\n## Section\n### Sub\n#### Deeper\n- one\n* two\n1. first\n2) second\n> quoted\n---\nlast paragraph\n",
        );
        assert_eq!(
            kinds(&blocks),
            [
                "heading_1",
                "paragraph",
                "heading_2",
                "heading_3",
                "heading_3",
                "bulleted_list_item",
                "bulleted_list_item",
                "numbered_list_item",
                "numbered_list_item",
                "quote",
                "divider",
                "paragraph",
            ]
        );
        assert_eq!(plain(&blocks[0]), "Title");
        assert_eq!(
            plain(&blocks[1]),
            "First line\nsecond line",
            "lines without a blank between them stay one paragraph"
        );
        assert_eq!(plain(&blocks[6]), "two");
        assert_eq!(plain(&blocks[8]), "second");
        assert_eq!(plain(&blocks[9]), "quoted");
        assert_eq!(
            blocks[10],
            json!({"object": "block", "type": "divider", "divider": {}})
        );
        assert_eq!(blocks[11]["object"], "block");
        assert!(markdown_blocks("").is_empty());
        assert!(markdown_blocks("\n\n  \n").is_empty());
    }

    #[test]
    fn markdown_blocks_keep_fenced_code_verbatim() {
        let blocks = markdown_blocks("intro\n```sh\ncargo test\n# not a heading\n```\nafter");
        assert_eq!(kinds(&blocks), ["paragraph", "code", "paragraph"]);
        assert_eq!(blocks[1]["code"]["language"], "plain text");
        assert_eq!(plain(&blocks[1]), "cargo test\n# not a heading");
    }

    #[test]
    fn inline_markdown_becomes_links_and_annotations() {
        let blocks = markdown_blocks(
            "Source: [The Verge](https://www.theverge.com/x) says **big** and *soft* or _quiet_ with `code` and snake_case_name and 2 * 3 * 4.",
        );
        let items = blocks[0]["paragraph"]["rich_text"].as_array().unwrap();
        let rendered: Vec<(String, Value)> = items
            .iter()
            .map(|item| {
                let mut shape = item.clone();
                let content = shape["text"]["content"].as_str().unwrap().to_owned();
                shape["text"].as_object_mut().unwrap().remove("content");
                (content, shape)
            })
            .collect();
        assert_eq!(rendered[0].0, "Source: ");
        assert_eq!(rendered[1].0, "The Verge");
        assert_eq!(
            rendered[1].1["text"]["link"]["url"],
            "https://www.theverge.com/x"
        );
        assert_eq!(rendered[2].0, " says ");
        assert_eq!(rendered[3].0, "big");
        assert_eq!(rendered[3].1["annotations"], json!({"bold": true}));
        assert_eq!(rendered[5].0, "soft");
        assert_eq!(rendered[5].1["annotations"], json!({"italic": true}));
        assert_eq!(rendered[7].0, "quiet");
        assert_eq!(rendered[7].1["annotations"], json!({"italic": true}));
        assert_eq!(rendered[9].0, "code");
        assert_eq!(rendered[9].1["annotations"], json!({"code": true}));
        assert_eq!(
            rendered[10].0, " and snake_case_name and 2 * 3 * 4.",
            "underscores inside words and spaced asterisks stay literal"
        );
        assert!(rendered[0].1.get("annotations").is_none());

        // A relative or unmatched link is left as text; an empty emphasis is literal.
        let blocks = markdown_blocks("see [notes](./notes.md) and [dangling and ** and `");
        assert_eq!(
            plain(&blocks[0]),
            "see [notes](./notes.md) and [dangling and ** and `"
        );
        assert_eq!(
            blocks[0]["paragraph"]["rich_text"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn long_rich_text_is_split_and_block_count_is_capped() {
        let long = "x".repeat(4500);
        let blocks = markdown_blocks(&format!("**{long}**"));
        let items = blocks[0]["paragraph"]["rich_text"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["text"]["content"].as_str().unwrap().len(), 2000);
        assert_eq!(items[2]["text"]["content"].as_str().unwrap().len(), 500);
        assert!(items.iter().all(|item| item["annotations"]["bold"] == true));

        let many = (0..600)
            .map(|i| format!("- item {i}\n"))
            .collect::<Vec<_>>()
            .concat();
        let blocks = markdown_blocks(&many);
        assert_eq!(blocks.len(), MAX_BLOCKS);
        assert_eq!(plain(&blocks[498]), "item 498");
        assert_eq!(blocks[499]["type"], "paragraph");
        assert_eq!(plain(&blocks[499]), TRUNCATED_MARKER);
    }

    #[test]
    fn page_urls_drop_the_dashes() {
        assert_eq!(
            page_url("550e8400-e29b-41d4-a716-446655440000"),
            "https://www.notion.so/550e8400e29b41d4a716446655440000"
        );
    }

    #[tokio::test]
    async fn publishing_without_a_connection_or_destination_fails_before_any_request() {
        let publisher = Publisher::disconnected();
        assert_eq!(
            publisher.publish("Title", "body").await,
            Err(PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned()))
        );
        let no_destination = Connection {
            token: "test-token".into(),
            name: "Workspace".into(),
            destination: None,
        };
        assert_eq!(
            publisher
                .publish_with(Some(no_destination), "Title", "body")
                .await,
            Err(PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned()))
        );
    }
    #[test]
    fn status_never_discloses_a_token() {
        let connection = Connection {
            token: "test-super-secret".into(),
            name: "Workspace".into(),
            destination: None,
        };
        assert!(
            !public_status(Some(&connection))
                .to_string()
                .contains("secret")
        );
        assert_eq!(public_status(Some(&connection))["connected"], true);
    }
    #[test]
    fn page_titles_support_custom_title_properties_and_exclude_deleted_pages() {
        let mut input = json!({"id":"550e8400-e29b-41d4-a716-446655440000", "properties":{"Name":{"title":[{"plain_text":"Tech "},{"text":{"content":"News"}}]}}});
        assert_eq!(page(&input).unwrap().title, "Tech News");
        input["in_trash"] = json!(true);
        assert!(page(&input).is_none());
    }
    #[tokio::test]
    async fn rejects_cross_origin_and_simple_mutations_before_touching_keychain() {
        for (origin, marker) in [("https://evil.example", true), ("http://localhost", false)] {
            let mut request = Request::builder()
                .uri("/api/notion/connection")
                .method("DELETE")
                .header(header::HOST, "localhost")
                .header(header::ORIGIN, origin);
            if marker {
                request = request.header("x-loomwatch-request", "1");
            }
            let response = router()
                .unwrap()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }
}
