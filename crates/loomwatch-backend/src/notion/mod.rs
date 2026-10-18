//! Sending teams' answers to Notion, and reading the Notion pages agents are given, through the
//! Notion tool's sign-in (ADR 0070). Notion is connected like any other tool, in Connections'
//! Tools section (`crate::connected_tools`); this module asks that tool for an access token and
//! speaks to Notion's hosted MCP server itself ([`mcp`]), so only the daemon ever holds it.
//!
//! [`Publisher`] turns a reply's Markdown into a child page of the page answers go under, which is
//! kept, with no credential, in the state folder ([`Destination`]). [`Reader`] reads the pages
//! agents are given (ADR 0050). A Notion sign-in made in Connections before Notion was a tool
//! (ADR 0049) is moved to the Notion tool once, at startup ([`move_to_tools`]).
mod mcp;
mod moved;

pub use moved::move_to_tools;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::connected_tools::{ConnectedTool, Tools, Unusable};

/// Notion's hosted MCP server: where the Notion tool is connected (`connected_tools::catalog`).
pub(crate) const MCP_URL: &str = "https://mcp.notion.com/mcp";
/// The page answers go under, in the state folder.
const DESTINATION_FILE: &str = "notion-destination.json";
/// What every place that meets a lapsed sign-in tells the operator.
pub(crate) const SIGN_IN_AGAIN: &str =
    "Your Notion sign-in has expired. Open Connections and sign in to Notion again under Tools.";

/// Where [`Publisher`] finds the page answers go under, set once at startup ([`install`]).
static INSTALLED: OnceLock<PathBuf> = OnceLock::new();

/// Names the state folder the page answers go under is kept in. The daemon calls this once, at
/// startup, before anything can send; a second call is ignored.
pub fn install(state_dir: &Path) {
    let _ = INSTALLED.set(state_dir.join(DESTINATION_FILE));
}

/// The page answers go under, kept in the state folder with no credential: `{"page": {id,
/// title}}`. It outlives the Notion tool being removed, so connecting Notion again sends answers
/// to the same page; one the new sign-in can't open says to choose another.
#[derive(Clone)]
struct Destination {
    /// `None` keeps nothing: tests and one-off commands with no state folder.
    path: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
struct DestinationFile {
    page: Page,
}

impl Destination {
    fn in_folder(state_dir: &Path) -> Self {
        Self {
            path: Some(state_dir.join(DESTINATION_FILE)),
        }
    }

    fn installed() -> Self {
        Self {
            path: INSTALLED.get().cloned(),
        }
    }

    /// The page, or `None` when none is chosen or the file can't be read as one.
    async fn read(&self) -> Option<Page> {
        let bytes = tokio::fs::read(self.path.as_ref()?).await.ok()?;
        serde_json::from_slice::<DestinationFile>(&bytes)
            .ok()
            .map(|file| file.page)
    }

    async fn write(&self, page: &Page) -> ApiResult<()> {
        let path = self.path.clone().ok_or_else(destination_unsaved)?;
        let text = serde_json::to_vec(&DestinationFile { page: page.clone() })
            .map_err(|_| destination_unsaved())?;
        tokio::task::spawn_blocking(move || crate::approvals::write_private(&path, &text))
            .await
            .map_err(|_| destination_unsaved())?
            .map_err(|_| destination_unsaved())
    }
}

fn destination_unsaved() -> ApiError {
    failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        "LoomWatch can't write notion-destination.json in its state folder. Check that folder and retry.",
    )
}

/// Notion as everything here reaches it: the Notion tool among the connected ones, and the
/// address that is Notion's. Tests point both at a stand-in.
#[derive(Clone)]
struct Notion {
    client: Client,
    tools: Option<Tools>,
    mcp: Arc<str>,
}

impl Notion {
    /// The tools the daemon installed, which it does before anything here is made.
    fn installed() -> anyhow::Result<Self> {
        Ok(Self {
            client: build_client()?,
            tools: crate::connected_tools::installed().cloned(),
            mcp: MCP_URL.into(),
        })
    }

    #[cfg(test)]
    fn with(tools: Option<Tools>, mcp: &str) -> Self {
        Self {
            client: build_client().expect("HTTPS client"),
            tools,
            mcp: mcp.into(),
        }
    }

    /// The Notion tool, once it has finished connecting.
    async fn tool(&self) -> Option<ConnectedTool> {
        self.tools.as_ref()?.at(&self.mcp).await
    }

    /// A session with Notion's MCP server, signed in as the Notion tool is.
    async fn session(&self) -> ApiResult<mcp::Session<'_>> {
        let (Some(tools), Some(tool)) = (self.tools.as_ref(), self.tool().await) else {
            return Err(not_connected());
        };
        let bearer = tools.bearer(&tool).await.map_err(unusable)?;
        mcp::Session::open(&self.client, &self.mcp, bearer).await
    }
}

#[derive(Clone)]
struct NotionState {
    notion: Notion,
    destination: Destination,
    /// One search or choice at a time.
    gate: Arc<Mutex<()>>,
}

impl NotionState {
    /// `GET /api/notion/connection`'s answer: from `tools.json` and the destination file, so it
    /// never reads where the sign-in is kept, and never holds a credential.
    async fn shown(&self) -> Value {
        match self.notion.tool().await {
            Some(tool) => json!({
                "connected": true,
                "name": tool.name,
                "destination": self.destination.read().await,
                "problem": tool.problem,
            }),
            None => json!({"connected": false}),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Page {
    id: String,
    title: String,
}

/// The caller must only mount this router on a loopback listener. The page answers go under is
/// kept in `state_dir`; the sign-in is the Notion tool's, in `tools`.
///
/// # Errors
/// Returns an error if the HTTPS client cannot be initialized.
pub fn router(state_dir: &Path, tools: Tools) -> anyhow::Result<Router> {
    Ok(router_with(NotionState {
        notion: Notion {
            client: build_client()?,
            tools: Some(tools),
            mcp: MCP_URL.into(),
        },
        destination: Destination::in_folder(state_dir),
        gate: Arc::default(),
    }))
}

fn router_with(state: NotionState) -> Router {
    Router::new()
        .route("/api/notion/connection", get(status))
        .route("/api/notion/pages", post(pages))
        .route("/api/notion/destination", put(destination))
        .layer(DefaultBodyLimit::max(8192))
        .route_layer(middleware::from_fn(protect))
        .route_layer(middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(state)
}

/// The HTTPS client the routes, the publisher and the reader use: no redirects, bounded connect
/// and request times.
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

fn unreachable() -> ApiError {
    failure(
        StatusCode::BAD_GATEWAY,
        "Could not reach Notion. Check your internet connection and retry.",
    )
}
fn unreadable() -> ApiError {
    failure(
        StatusCode::BAD_GATEWAY,
        "Notion returned an unreadable response. Retry.",
    )
}
fn storage_error() -> ApiError {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        if cfg!(windows) {
            "Windows Credential Manager is unavailable, so LoomWatch can't use your Notion sign-in. Sign in to Windows with your own account and retry."
        } else {
            "The macOS Keychain is unavailable or locked, so LoomWatch can't use your Notion sign-in. Unlock it and retry."
        },
    )
}

/// Why the Notion tool's sign-in can't be used, in the words every surface uses.
fn unusable(reason: Unusable) -> ApiError {
    match reason {
        Unusable::SignInAgain => failure(StatusCode::UNAUTHORIZED, SIGN_IN_AGAIN),
        Unusable::Unreachable => unreachable(),
        Unusable::Unavailable => storage_error(),
    }
}

fn not_connected() -> ApiError {
    failure(
        StatusCode::CONFLICT,
        "Connect Notion first: open Connections and connect it under Tools.",
    )
}

/// `GET /api/notion/connection`.
async fn status(State(state): State<NotionState>) -> Json<Value> {
    Json(state.shown().await)
}

#[derive(Deserialize)]
struct Search {
    #[serde(default)]
    query: String,
}
/// `POST /api/notion/pages`: pages whose title matches, or recent ones for a blank search.
/// Notion's search tool has no cursor: one answer holds every page it will show.
async fn pages(
    State(state): State<NotionState>,
    Json(input): Json<Search>,
) -> ApiResult<Json<Value>> {
    if input.query.len() > 200 {
        return Err(failure(StatusCode::BAD_REQUEST, "Search text is too long."));
    }
    let _guard = state.gate.lock().await;
    let pages = mcp::search(&mut state.notion.session().await?, input.query.trim()).await?;
    Ok(Json(json!({"pages": pages, "nextCursor": null})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chosen {
    page_id: String,
}
/// `PUT /api/notion/destination`: the page answers go under, once Notion says it can hold pages.
async fn destination(
    State(state): State<NotionState>,
    Json(input): Json<Chosen>,
) -> ApiResult<Json<Value>> {
    let id = uuid::Uuid::parse_str(&input.page_id).map_err(|_| {
        failure(
            StatusCode::BAD_REQUEST,
            "Choose a page from the search results.",
        )
    })?;
    let _guard = state.gate.lock().await;
    let chosen = mcp::page(&mut state.notion.session().await?, &id.to_string())
        .await?
        .ok_or_else(|| {
            failure(
                StatusCode::BAD_REQUEST,
                "This page is unavailable. Choose another page.",
            )
        })?;
    state.destination.write(&chosen).await?;
    Ok(Json(state.shown().await))
}

// ---------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------

/// What the delivery reports when Notion isn't connected, or no page is chosen for answers.
pub(crate) const NOT_CONNECTED_MESSAGE: &str = "Notion is not connected yet. Open Connections, connect Notion under Tools, and choose the page answers go under.";
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

/// Publishes Markdown as a child page of the page answers go under.
pub(crate) struct Publisher {
    notion: Notion,
    destination: Destination,
}

impl Publisher {
    /// A publisher through the installed tools' Notion sign-in, to the page [`install`] keeps,
    /// with its own HTTPS client.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTPS client cannot be initialized.
    pub(crate) fn new() -> anyhow::Result<Self> {
        Ok(Self {
            notion: Notion::installed()?,
            destination: Destination::installed(),
        })
    }

    /// A publisher that is never connected, for tests.
    #[cfg(test)]
    pub(crate) fn disconnected() -> Self {
        Self {
            notion: Notion::with(None, MCP_URL),
            destination: Destination { path: None },
        }
    }

    /// Create `title` under the page answers go under holding `markdown`, unless a child page
    /// with that exact title already exists.
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
        let not_connected = || PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned());
        if self.notion.tool().await.is_none() {
            return Err(not_connected());
        }
        let destination = self.destination.read().await.ok_or_else(not_connected)?;
        let mut session = self.notion.session().await?;
        mcp::publish(&mut session, &destination, title, markdown).await
    }
}

// ---------------------------------------------------------------------------------------
// Reading pages an agent is given
// ---------------------------------------------------------------------------------------

/// What a run says when an agent is given a Notion page and Notion isn't connected.
pub(crate) const READ_NOT_CONNECTED: &str =
    "Notion is not connected. Open Connections and connect Notion under Tools.";

/// Why the pages a team is given could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadError {
    /// The page that failed, or `None` when no page could be read at all: nothing is connected,
    /// or the sign-in has ended.
    pub(crate) page: Option<String>,
    /// Operator-facing, in the words Connections uses.
    pub(crate) message: String,
}

impl ReadError {
    fn connection(error: &ApiError) -> Self {
        Self {
            page: None,
            message: error.message.to_owned(),
        }
    }

    fn page(id: &str, message: &str) -> Self {
        Self {
            page: Some(id.to_owned()),
            message: message.to_owned(),
        }
    }
}

/// Reads the Notion pages agents are given (ADR 0050) through the Notion tool's sign-in. Like
/// [`Publisher`], only the daemon holds the sign-in: an agent is handed the text.
pub(crate) struct Reader {
    notion: Notion,
}

impl Reader {
    /// A reader through the installed tools' Notion sign-in, with its own HTTPS client.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTPS client cannot be initialized.
    pub(crate) fn new() -> anyhow::Result<Self> {
        Ok(Self {
            notion: Notion::installed()?,
        })
    }

    /// Every page in `ids`, each read once, through one session with Notion.
    ///
    /// # Errors
    ///
    /// The first page that cannot be read and why, or why none can.
    pub(crate) async fn read(
        &self,
        ids: &[String],
    ) -> Result<BTreeMap<String, crate::config::NotionPage>, ReadError> {
        if self.notion.tool().await.is_none() {
            return Err(ReadError {
                page: None,
                message: READ_NOT_CONNECTED.to_owned(),
            });
        }
        let mut session = self
            .notion
            .session()
            .await
            .map_err(|error| ReadError::connection(&error))?;
        let mut pages = BTreeMap::new();
        for id in ids {
            let page = match mcp::read(&mut session, id).await {
                Ok(Some(page)) => page,
                Ok(None) => return Err(ReadError::page(id, NOT_A_PAGE)),
                Err(error) if error.message == mcp::PAGE_NOT_FOUND => {
                    return Err(ReadError::page(id, PAGE_GONE));
                }
                Err(error) => return Err(ReadError::page(id, error.message)),
            };
            pages.insert(id.clone(), page);
        }
        Ok(pages)
    }
}

/// A page the sign-in cannot open, read for an agent rather than chosen as a destination.
const PAGE_GONE: &str = "Notion can't open this page any more. It may have been deleted, or moved where your Notion account can't see it. Connect the agent to the page again.";
/// A database or view chosen where a page was expected.
const NOT_A_PAGE: &str = "this is a Notion database, not a page. Choose a page to give an agent.";

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
    use std::fmt::Write as _;

    use axum::body::Body;
    use axum::http::{HeaderMap, Request, header};
    use tower::ServiceExt;

    use super::*;

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
        // Connected, with no page chosen for answers: nothing reaches Notion either.
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        tools
            .connected_for_tests("Notion", "http://127.0.0.1:9/mcp", "test-token")
            .await;
        let publisher = Publisher {
            notion: Notion::with(Some(tools), "http://127.0.0.1:9/mcp"),
            destination: Destination::in_folder(&folder.0),
        };
        assert_eq!(
            publisher.publish("Title", "body").await,
            Err(PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned()))
        );
    }

    #[tokio::test]
    async fn rejects_cross_origin_and_simple_mutations() {
        for (origin, marker) in [("https://evil.example", true), ("http://localhost", false)] {
            let mut request = Request::builder()
                .uri("/api/notion/destination")
                .method("PUT")
                .header(header::HOST, "localhost")
                .header(header::ORIGIN, origin)
                .header(header::CONTENT_TYPE, "application/json");
            if marker {
                request = request.header("x-loomwatch-request", "1");
            }
            let folder = Folder::new();
            let response = router(&folder.0, Tools::for_tests(&folder.0))
                .unwrap()
                .oneshot(
                    request
                        .body(Body::from(json!({"pageId": DESTINATION}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    // -----------------------------------------------------------------------------------
    // End to end against a stand-in for Notion's MCP server and its token endpoint
    // -----------------------------------------------------------------------------------

    pub(super) const DESTINATION: &str = "550e8400-e29b-41d4-a716-446655440000";
    const DATABASE: &str = "650e8400-e29b-41d4-a716-446655440000";
    const EXISTING: &str = "750e8400-e29b-41d4-a716-446655440000";
    const CREATED: &str = "850e8400-e29b-41d4-a716-446655440000";
    const MISSING: &str = "950e8400-e29b-41d4-a716-446655440000";

    fn notion_url(id: &str) -> String {
        format!("https://app.notion.com/p/{}", id.replace('-', ""))
    }

    /// What the stand-in has been asked and what it will accept next.
    #[derive(Default)]
    pub(super) struct Fake {
        /// The bearer its MCP server takes.
        pub(super) access: String,
        /// The refresh token its token endpoint takes.
        pub(super) refresh: String,
        pub(super) refreshed: usize,
        pub(super) revoked: Vec<String>,
        pub(super) tools: Vec<(String, Value)>,
    }
    pub(super) type Shared = Arc<std::sync::Mutex<Fake>>;

    /// The stand-in, running.
    pub(super) struct Stand {
        pub(super) base: String,
        pub(super) fake: Shared,
    }

    impl Stand {
        pub(super) fn mcp(&self) -> String {
            format!("{}/mcp", self.base)
        }

        pub(super) fn endpoints(&self) -> moved::Endpoints {
            moved::Endpoints {
                mcp: self.mcp(),
                authorize: format!("{}/authorize", self.base),
                token: format!("{}/token", self.base),
                register: format!("{}/register", self.base),
            }
        }
    }

    async fn fake_token(State(fake): State<Shared>, body: String) -> Response {
        let form: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
        let mut fake = fake.lock().unwrap();
        match form.get("grant_type").map(String::as_str) {
            Some("refresh_token") if form["refresh_token"] == fake.refresh => {
                fake.refreshed += 1;
                "access-2".clone_into(&mut fake.access);
                "refresh-2".clone_into(&mut fake.refresh);
                Json(json!({"access_token": "access-2", "token_type": "Bearer", "refresh_token": "refresh-2", "expires_in": 3600})).into_response()
            }
            Some(_) => (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_grant"})),
            )
                .into_response(),
            None => {
                fake.revoked.push(form["token"].clone());
                StatusCode::OK.into_response()
            }
        }
    }

    async fn fake_mcp(
        State(fake): State<Shared>,
        headers: HeaderMap,
        Json(message): Json<Value>,
    ) -> Response {
        let mut fake = fake.lock().unwrap();
        if headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            != Some(format!("Bearer {}", fake.access).as_str())
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let Some(id) = message.get("id").cloned() else {
            return StatusCode::ACCEPTED.into_response();
        };
        let answer = |result: Value| json!({"jsonrpc": "2.0", "id": id, "result": result});
        let text = |value: Value| json!({"content": [{"type": "text", "text": value.to_string()}]});
        match message["method"].as_str().unwrap() {
            "initialize" => (
                [("mcp-session-id", "session-1")],
                Json(answer(json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}}))),
            )
                .into_response(),
            // What an agent given the Notion tool is offered.
            "tools/list" => Json(answer(json!({"tools": [
                {"name": "notion-search", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": true}},
                {"name": "notion-create-pages", "inputSchema": {"type": "object"}},
            ]})))
            .into_response(),
            "tools/call" => {
                assert_eq!(headers["mcp-session-id"], "session-1");
                assert_eq!(headers["mcp-protocol-version"], "2025-06-18");
                let name = message["params"]["name"].as_str().unwrap().to_owned();
                let arguments = message["params"]["arguments"].clone();
                fake.tools.push((name.clone(), arguments.clone()));
                match name.as_str() {
                    // Search answers as an event stream, after a progress notification.
                    "notion-search" => (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        format!(
                            "event: message\ndata: {}\n\nevent: message\ndata: {}\n\n",
                            json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}),
                            answer(text(json!({"type": "workspace_search", "results": [
                                {"id": DESTINATION, "title": "Daily", "type": "page", "url": notion_url(DESTINATION)},
                                {"id": DATABASE, "title": "Tasks", "type": "database", "url": notion_url(DATABASE)},
                            ]}))),
                        ),
                    )
                        .into_response(),
                    "notion-fetch" if arguments["id"] == DATABASE => Json(answer(text(json!({
                        "metadata": {"type": "database"},
                        "title": "Tasks",
                    }))))
                    .into_response(),
                    "notion-fetch" if arguments["id"] == MISSING => Json(answer(json!({
                        "isError": true,
                        "content": [{"type": "text", "text": "Could not find page with ID: missing"}],
                    })))
                    .into_response(),
                    // As Notion fetches a page: wrapped in its own <page>, children as leaves.
                    "notion-fetch" => Json(answer(text(json!({
                        "metadata": {"type": "page"},
                        "title": "Daily",
                        "url": notion_url(DESTINATION),
                        "text": format!(
                            "<page url=\"{}\">\n<properties>{{\"title\":\"Daily\"}}</properties>\n<content>\nIntro\n<page url=\"{}\">Existing</page>\n</content>\n</page>",
                            notion_url(DESTINATION),
                            notion_url(EXISTING),
                        ),
                    }))))
                    .into_response(),
                    "notion-create-pages" => Json(answer(text(json!({"pages": [
                        {"id": CREATED, "url": notion_url(CREATED)},
                    ]}))))
                    .into_response(),
                    "notion-update-page" => Json(answer(text(json!({"id": CREATED})))).into_response(),
                    other => panic!("unexpected tool {other}"),
                }
            }
            other => panic!("unexpected method {other}"),
        }
    }

    /// Starts the stand-in, taking `access` as its bearer.
    pub(super) async fn fake_notion(access: &str) -> Stand {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let fake: Shared = Arc::default();
        access.clone_into(&mut fake.lock().unwrap().access);
        let app = Router::new()
            .route(
                "/mcp",
                post(fake_mcp).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
            )
            .route("/token", post(fake_token))
            .with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Stand { base, fake }
    }

    async fn send(
        router: &Router,
        request: axum::http::request::Builder,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let request = request.header(header::HOST, "127.0.0.1:3000");
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        };
        let response = router.clone().oneshot(request.unwrap()).await.unwrap();
        let (parts, body) = response.into_parts();
        let bytes = http_body_util::BodyExt::collect(body)
            .await
            .unwrap()
            .to_bytes();
        (
            parts.status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// The UI's own request: same origin, with the marker header.
    fn from_ui(method: &str, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("x-loomwatch-request", "1")
            .header("sec-fetch-site", "same-origin")
    }

    /// `LoomWatch`'s state folder for one test, removed after it.
    pub(super) struct Folder(pub(super) PathBuf);

    impl Folder {
        pub(super) fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-notion-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        pub(super) fn destination(&self) -> String {
            std::fs::read_to_string(self.0.join(DESTINATION_FILE)).unwrap_or_default()
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The routes, the publisher and the reader, all through `tools`' Notion tool at `mcp`.
    pub(super) fn notion_with(
        tools: &Tools,
        mcp: &str,
        folder: &Folder,
    ) -> (Router, Publisher, Reader) {
        let notion = Notion::with(Some(tools.clone()), mcp);
        let destination = Destination::in_folder(&folder.0);
        (
            router_with(NotionState {
                notion: notion.clone(),
                destination: destination.clone(),
                gate: Arc::default(),
            }),
            Publisher {
                notion: notion.clone(),
                destination,
            },
            Reader { notion },
        )
    }

    pub(super) async fn shown_by(router: &Router) -> Value {
        send(router, from_ui("GET", "/api/notion/connection"), None)
            .await
            .1
    }

    /// Search, choose the page answers go under, publish and read pages, all through the Notion
    /// tool's sign-in; the status says so from `tools.json` and the page file alone.
    #[tokio::test]
    #[allow(clippy::too_many_lines)] // one story, told in order: search, choose, publish, read
    async fn the_notion_tool_searches_chooses_publishes_and_reads() {
        let stand = fake_notion("access-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let (router, publisher, reader) = notion_with(&tools, &stand.mcp(), &folder);
        assert_eq!(shown_by(&router).await, json!({"connected": false}));
        let (status, body) = send(
            &router,
            from_ui("POST", "/api/notion/pages"),
            Some(json!({"query": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(
            body["error"].as_str().unwrap().contains("under Tools"),
            "{body}"
        );

        tools
            .connected_for_tests("Notion", &stand.mcp(), "access-1")
            .await;
        assert_eq!(
            shown_by(&router).await,
            json!({"connected": true, "name": "Notion", "destination": null, "problem": null})
        );

        // Search goes through Notion's tool and keeps only pages.
        let (status, found) = send(
            &router,
            from_ui("POST", "/api/notion/pages"),
            Some(json!({"query": " dai "})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{found}");
        assert_eq!(
            found,
            json!({"pages": [{"id": DESTINATION, "title": "Daily"}], "nextCursor": null})
        );
        // Notion refuses an empty query on its own; browsing narrows by a filter every plan has.
        let (status, _) = send(
            &router,
            from_ui("POST", "/api/notion/pages"),
            Some(json!({"query": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // A database can't hold the answers; a page can, and is kept with no credential.
        let (status, _) = send(
            &router,
            from_ui("PUT", "/api/notion/destination"),
            Some(json!({"pageId": DATABASE})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, chosen) = send(
            &router,
            from_ui("PUT", "/api/notion/destination"),
            Some(json!({"pageId": DESTINATION})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{chosen}");
        assert_eq!(
            chosen["destination"],
            json!({"id": DESTINATION, "title": "Daily"})
        );
        assert!(!folder.destination().contains("access-1"));
        // A daemon started later shows the same.
        let (later, _, _) = notion_with(&tools, &stand.mcp(), &folder);
        assert_eq!(shown_by(&later).await, chosen);

        // Publishing: the duplicate guard, then an answer whose tags arrive escaped, in chunks.
        assert_eq!(
            publisher.publish("Existing", "hello").await,
            Err(PublishError::Duplicate {
                page_id: EXISTING.to_owned(),
                url: notion_url(EXISTING),
            })
        );
        let long = (0..150).fold(String::new(), |mut list, i| {
            writeln!(list, "- item {i}").unwrap();
            list
        });
        let answer = format!(
            "# Hi\n\nSee <page url=\"https://www.notion.so/x-{}\">Secret</page>\n\n{long}",
            EXISTING.replace('-', "")
        );
        let page = publisher.publish("Report", &answer).await.unwrap();
        assert_eq!(page.page_id, CREATED);
        assert_eq!(page.url, notion_url(CREATED));
        let called = std::mem::take(&mut stand.fake.lock().unwrap().tools);
        let names: Vec<&str> = called.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "notion-search",
                "notion-search",
                "notion-fetch",
                "notion-fetch",
                "notion-fetch",
                "notion-fetch",
                "notion-create-pages",
                "notion-update-page"
            ]
        );
        assert_eq!(
            called[0].1,
            json!({"query": "dai", "query_type": "internal", "page_size": 50, "max_highlight_length": 0})
        );
        assert_eq!(called[1].1["query"], "");
        assert_eq!(
            called[1].1["filters"],
            json!({"created_date_range": {"start_date": "1990-01-01"}})
        );
        let create = &called[6].1;
        assert_eq!(
            create["parent"],
            json!({"type": "page_id", "page_id": DESTINATION})
        );
        assert_eq!(
            create["allow_async"], false,
            "the delivery reports the page Notion made"
        );
        assert_eq!(create["pages"][0]["properties"], json!({"title": "Report"}));
        assert_eq!(create["pages"][0]["preserve_internal_links"], true);
        let content = create["pages"][0]["content"].as_str().unwrap();
        assert!(content.starts_with("# Hi\nSee \\<page url="), "{content}");
        assert!(
            content
                .match_indices('<')
                .all(|(at, _)| content[..at].ends_with('\\')),
            "every tag the answer carried arrives escaped: {content}"
        );
        assert_eq!(
            content.lines().count(),
            100,
            "one request carries at most 100 blocks"
        );
        let append = &called[7].1;
        assert_eq!(append["page_id"], CREATED);
        assert_eq!(append["command"], "insert_content");
        assert_eq!(append["position"], json!({"type": "end"}));
        assert_eq!(append["allow_async"], false, "chunks land in order");
        assert_eq!(append["content"].as_str().unwrap().lines().count(), 52);

        // ADR 0050: a run reads every page its agents are given, in one session, as the page's
        // body; a database and a page Notion can no longer open each say what to do instead.
        let pages = reader
            .read(&[DESTINATION.to_owned()])
            .await
            .expect("a page reads");
        assert_eq!(
            pages[DESTINATION],
            crate::config::NotionPage {
                title: "Daily".to_owned(),
                url: notion_url(DESTINATION),
                text: format!(
                    "Intro\n<page url=\"{}\">Existing</page>",
                    notion_url(EXISTING)
                ),
                truncated: false,
            }
        );
        assert_eq!(
            std::mem::take(&mut stand.fake.lock().unwrap().tools),
            vec![("notion-fetch".to_owned(), json!({"id": DESTINATION}))],
            "only a fetch: reading changes nothing in Notion"
        );
        for (id, expected) in [(DATABASE, NOT_A_PAGE), (MISSING, PAGE_GONE)] {
            assert_eq!(
                reader.read(&[DESTINATION.to_owned(), id.to_owned()]).await,
                Err(ReadError::page(id, expected))
            );
        }
        // The status never carries the sign-in.
        assert!(!shown_by(&router).await.to_string().contains("access-1"));
    }

    /// With no Notion tool, a run that reads a page says where to connect it, and so does
    /// sending an answer; a token Notion no longer takes says to sign in again.
    #[tokio::test]
    async fn without_a_working_notion_tool_each_place_says_what_to_do() {
        let stand = fake_notion("access-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let (router, _, reader) = notion_with(&tools, &stand.mcp(), &folder);
        assert_eq!(
            reader.read(&[DESTINATION.to_owned()]).await,
            Err(ReadError {
                page: None,
                message: READ_NOT_CONNECTED.to_owned()
            })
        );
        tools
            .connected_for_tests("Notion", &stand.mcp(), "retired")
            .await;
        let (status, body) = send(
            &router,
            from_ui("POST", "/api/notion/pages"),
            Some(json!({"query": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], SIGN_IN_AGAIN);
        assert_eq!(
            reader.read(&[DESTINATION.to_owned()]).await,
            Err(ReadError {
                page: None,
                message: SIGN_IN_AGAIN.to_owned()
            })
        );
    }
}
