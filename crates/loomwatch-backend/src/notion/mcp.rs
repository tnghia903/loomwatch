//! The slice of the Model Context Protocol `LoomWatch` speaks to Notion's hosted server:
//! `initialize`, then `tools/call`, over Streamable HTTP, whether Notion answers with JSON or an
//! event stream. Only `LoomWatch` itself holds this session, never an agent, so the page a
//! delivery reports is the one Notion's own answer names.
use std::{collections::HashSet, time::Duration};

use axum::http::StatusCode;
use reqwest::{Client, header};
use serde_json::{Value, json};

use super::{
    ApiError, ApiResult, BLOCKS_PER_REQUEST, Page, PublishError, Published, failure,
    markdown_blocks, page_url, sign_in::SIGN_IN_AGAIN, unreachable, unreadable,
};

/// The protocol revision `LoomWatch` asks for; Notion may answer with another it supports.
const PROTOCOL: &str = "2025-06-18";
/// Creating a long page can take Notion a while.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);
/// A fetched destination lists every page under it, so allow more than a REST answer.
const MAX_ANSWER_BYTES: usize = 8_000_000;
/// Kinds of search result and fetched object that cannot hold the answers' pages.
const NOT_PAGES: [&str; 5] = [
    "database",
    "data_source",
    "data-source",
    "collection",
    "view",
];

/// One conversation with Notion's MCP server.
pub(super) struct Session<'a> {
    client: &'a Client,
    url: &'a str,
    bearer: String,
    /// The `Mcp-Session-Id` Notion assigned, echoed on every later request.
    id: Option<String>,
    protocol: String,
    next: u64,
}

impl<'a> Session<'a> {
    pub(super) async fn open(client: &'a Client, url: &'a str, bearer: String) -> ApiResult<Self> {
        let mut session = Self {
            client,
            url,
            bearer,
            id: None,
            protocol: PROTOCOL.to_owned(),
            next: 0,
        };
        let answer = session
            .call(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL,
                    "capabilities": {},
                    "clientInfo": {"name": "LoomWatch", "version": env!("CARGO_PKG_VERSION")},
                }),
            )
            .await?;
        if let Some(version) = answer
            .get("protocolVersion")
            .and_then(Value::as_str)
            .filter(|version| {
                version.len() <= 32
                    && version
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            version.clone_into(&mut session.protocol);
        }
        session
            .send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await?;
        Ok(session)
    }

    /// Call one of Notion's tools and return what it answered.
    pub(super) async fn tool(&mut self, name: &str, arguments: Value) -> ApiResult<Value> {
        let result = self
            .call("tools/call", json!({"name": name, "arguments": arguments}))
            .await?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            let text = output_text(&result);
            eprintln!(
                "warning: Notion's {name} tool refused: {}",
                text.chars().take(300).collect::<String>()
            );
            return Err(tool_error(&text));
        }
        Ok(output(&result))
    }

    async fn call(&mut self, method: &str, params: Value) -> ApiResult<Value> {
        self.next += 1;
        let id = self.next;
        let mut response = self
            .send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        if self.id.is_none() {
            self.id = response
                .headers()
                .get("mcp-session-id")
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.len() <= 256)
                .map(str::to_owned);
        }
        let stream = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        let message = read_answer(&mut response, id, stream).await?;
        if message.get("error").is_some() {
            return Err(failure(
                StatusCode::BAD_GATEWAY,
                "Notion could not complete the request. Retry shortly.",
            ));
        }
        message.get("result").cloned().ok_or_else(unreadable)
    }

    async fn send(&self, body: &Value) -> ApiResult<reqwest::Response> {
        let mut request = self
            .client
            .post(self.url)
            .bearer_auth(&self.bearer)
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", &self.protocol)
            .timeout(CALL_TIMEOUT)
            .json(body);
        if let Some(id) = &self.id {
            request = request.header("mcp-session-id", id);
        }
        let response = request.send().await.map_err(|_| unreachable())?;
        match response.status() {
            status if status.is_success() => Ok(response),
            StatusCode::UNAUTHORIZED => Err(failure(StatusCode::UNAUTHORIZED, SIGN_IN_AGAIN)),
            StatusCode::FORBIDDEN => Err(failure(
                StatusCode::FORBIDDEN,
                "Notion refused LoomWatch. If your workspace only allows approved AI apps, ask an admin to approve LoomWatch, or connect with an integration token under Advanced.",
            )),
            StatusCode::TOO_MANY_REQUESTS => Err(failure(
                StatusCode::TOO_MANY_REQUESTS,
                "Notion is rate limiting requests. Wait a minute and retry.",
            )),
            _ => Err(failure(
                StatusCode::BAD_GATEWAY,
                "Notion could not complete the request. Retry shortly.",
            )),
        }
    }
}

/// The JSON-RPC message answering request `id`, from a JSON body or an event stream. A stream
/// may stay open after the answer, so reading stops as soon as it has arrived.
async fn read_answer(response: &mut reqwest::Response, id: u64, stream: bool) -> ApiResult<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        failure(
            StatusCode::BAD_GATEWAY,
            "Notion returned an incomplete response. Retry.",
        )
    })? {
        if bytes.len() + chunk.len() > MAX_ANSWER_BYTES {
            return Err(failure(
                StatusCode::BAD_GATEWAY,
                "Notion's response was too large.",
            ));
        }
        bytes.extend_from_slice(&chunk);
        if stream && let Some(message) = answer_in_stream(&bytes, id) {
            return Ok(message);
        }
    }
    if stream {
        answer_in_stream(&bytes, id).ok_or_else(unreadable)
    } else {
        serde_json::from_slice(&bytes).map_err(|_| unreadable())
    }
}

/// The message answering `id` among the events in `bytes`, past Notion's notifications.
fn answer_in_stream(bytes: &[u8], id: u64) -> Option<Value> {
    let text = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    text.split("\n\n").find_map(|event| {
        let data: Vec<&str> = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|data| data.strip_prefix(' ').unwrap_or(data))
            .collect();
        let message: Value = serde_json::from_str(&data.join("\n")).ok()?;
        (message.get("id").and_then(Value::as_u64) == Some(id)).then_some(message)
    })
}

/// What a tool answered: its structured content when it gives one, else its text, read as JSON
/// when it is JSON.
fn output(result: &Value) -> Value {
    if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
        return structured.clone();
    }
    let text = output_text(result);
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

fn output_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A tool's refusal in the words Connections uses. Notion's own text is only logged: it can
/// quote page content.
fn tool_error(text: &str) -> ApiError {
    let text = text.to_lowercase();
    if text.contains("rate limit") {
        failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Notion is rate limiting requests. Wait a minute and retry.",
        )
    } else if [
        "not found",
        "could not find",
        "object_not_found",
        "restricted",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
    {
        failure(
            StatusCode::FORBIDDEN,
            "Notion cannot open that page. Open Connections and choose the destination page again.",
        )
    } else if text.contains("validation") {
        failure(
            StatusCode::BAD_GATEWAY,
            "Notion did not accept the request. Retry; if an answer keeps failing, send a shorter one.",
        )
    } else {
        failure(
            StatusCode::BAD_GATEWAY,
            "Notion could not complete the request. Retry shortly.",
        )
    }
}

/// Pages matching `query`, for choosing the destination. Notion's search also finds databases
/// and, with Notion AI, items from connected apps; only Notion pages can hold the answers.
pub(super) async fn search(session: &mut Session<'_>, query: &str) -> ApiResult<Vec<Page>> {
    // Highlights would quote page content LoomWatch has no use for.
    let mut arguments = json!({"query": query, "query_type": "internal", "page_size": 50, "max_highlight_length": 0});
    if query.is_empty() {
        // Notion refuses an empty query unless a filter or a date sort narrows it, and sorting
        // by date needs a Business plan. "Created since 1990" narrows nothing on any plan.
        arguments["filters"] = json!({"created_date_range": {"start_date": "1990-01-01"}});
    }
    let found = session.tool("notion-search", arguments).await?;
    let mut seen = HashSet::new();
    Ok(found
        .get("results")
        .and_then(Value::as_array)
        .or_else(|| found.as_array())
        .into_iter()
        .flatten()
        .filter_map(search_hit)
        .filter(|page| seen.insert(page.id.clone()))
        .collect())
}

fn search_hit(hit: &Value) -> Option<Page> {
    if NOT_PAGES.contains(&kind(hit)) {
        return None;
    }
    let id = ["id", "url"]
        .iter()
        .find_map(|key| hit.get(*key).and_then(Value::as_str).and_then(notion_id))?;
    Some(Page {
        id,
        title: title_of(hit),
    })
}

/// The object's kind, or an empty string when the answer does not say. Search results carry
/// it as `type`; a fetched object as `metadata.type`.
fn kind(value: &Value) -> &str {
    value
        .pointer("/metadata/type")
        .or_else(|| value.get("type"))
        .or_else(|| value.get("object"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn title_of(value: &Value) -> String {
    value
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map_or_else(
            || "Untitled page".to_owned(),
            |title| title.chars().take(300).collect(),
        )
}

/// Page `id` as a destination, or `None` when it cannot hold pages.
pub(super) async fn page(session: &mut Session<'_>, id: &str) -> ApiResult<Option<Page>> {
    let fetched = session.tool("notion-fetch", json!({"id": id})).await?;
    if NOT_PAGES.contains(&kind(&fetched)) {
        return Ok(None);
    }
    Ok(Some(Page {
        id: id.to_owned(),
        title: title_of(&fetched),
    }))
}

/// Create `title` under `destination` holding `markdown`, unless the destination already has a
/// child page with exactly that title.
pub(super) async fn publish(
    session: &mut Session<'_>,
    destination: &Page,
    title: &str,
    markdown: &str,
) -> Result<Published, PublishError> {
    let parent = session
        .tool("notion-fetch", json!({"id": destination.id}))
        .await?;
    if let Some((page_id, url)) = child_page(&text_of(&parent), title) {
        return Err(PublishError::Duplicate { page_id, url });
    }
    let blocks = markdown_blocks(markdown);
    let mut chunks = blocks.chunks(BLOCKS_PER_REQUEST).map(notion_markdown);
    // Synchronous, because the delivery reports the page Notion made; links stay links rather
    // than turning into mentions.
    let created = session
        .tool(
            "notion-create-pages",
            json!({
                "parent": {"type": "page_id", "page_id": destination.id},
                "pages": [{
                    "properties": {"title": title},
                    "content": chunks.next().unwrap_or_default(),
                    "preserve_internal_links": true,
                }],
                "allow_async": false,
            }),
        )
        .await?;
    let (page_id, url) = created_page(&created).ok_or_else(|| {
        PublishError::Failed("Notion created the page but returned no id.".to_owned())
    })?;
    for chunk in chunks {
        session
            .tool(
                "notion-update-page",
                json!({
                    "page_id": page_id,
                    "command": "insert_content",
                    "content": chunk,
                    "position": {"type": "end"},
                    "allow_async": false,
                }),
            )
            .await?;
    }
    Ok(Published { page_id, url })
}

/// The fetched page's text, wherever the answer keeps it.
fn text_of(fetched: &Value) -> String {
    match fetched {
        Value::String(text) => text.clone(),
        other => other
            .get("text")
            .or_else(|| other.get("content"))
            .and_then(Value::as_str)
            .map_or_else(|| other.to_string().replace("\\\"", "\""), str::to_owned),
    }
}

/// The id and URL of a child `<page>` in a fetched page's `content` titled exactly `title`.
///
/// A child page is a leaf, `<page url="…">Title</page>`. The fetched page arrives wrapped in its
/// own `<page url="…">` around everything else, so a tag whose text does not run straight to
/// `</page>` is passed over by its opening tag alone.
fn child_page(content: &str, title: &str) -> Option<(String, String)> {
    const OPEN: &str = "<page url=\"";
    let mut rest = content;
    while let Some(start) = rest.find(OPEN) {
        rest = &rest[start + OPEN.len()..];
        let url_end = rest.find('"')?;
        let url = &rest[..url_end];
        let after = &rest[url_end + rest[url_end..].find('>')? + 1..];
        let leaf = first_tag(after).filter(|&at| after[at..].starts_with("</page>"));
        if let Some(at) = leaf
            && unescape(&after[..at]).trim() == title
            && let Some(id) = notion_id(url)
        {
            let url = if is_notion_url(url) {
                url.to_owned()
            } else {
                page_url(&id)
            };
            return Some((id, url));
        }
        rest = after;
    }
    None
}

/// Where the first unescaped `<` in `text` is.
fn first_tag(text: &str) -> Option<usize> {
    let mut escaped = false;
    for (at, c) in text.char_indices() {
        match c {
            '<' if !escaped => return Some(at),
            '\\' => escaped = !escaped,
            _ => escaped = false,
        }
    }
    None
}

/// Notion-flavored Markdown's backslash escapes, removed.
fn unescape(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            plain.extend(chars.next());
        } else {
            plain.push(c);
        }
    }
    plain
}

/// The page Notion says it created: its id, and its address when that is a Notion address.
fn created_page(created: &Value) -> Option<(String, String)> {
    let first = created
        .get("pages")
        .and_then(Value::as_array)
        .or_else(|| created.as_array())
        .and_then(|pages| pages.first())
        .unwrap_or(created);
    let id = ["id", "url"]
        .iter()
        .find_map(|key| first.get(*key).and_then(Value::as_str).and_then(notion_id))?;
    let url = first
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| is_notion_url(url))
        .map_or_else(|| page_url(&id), str::to_owned);
    Some((id, url))
}

fn is_notion_url(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some_and(|host| {
                ["notion.so", "notion.com"].contains(&host)
                    || [".notion.so", ".notion.com", ".notion.site"]
                        .iter()
                        .any(|domain| host.ends_with(domain))
            })
    })
}

/// A Notion id in its dashed form, from a bare id or the end of a Notion page address.
fn notion_id(text: &str) -> Option<String> {
    if let Ok(id) = uuid::Uuid::parse_str(text) {
        return Some(id.to_string());
    }
    let path = text.split(['?', '#']).next()?;
    let last = path.rsplit('/').next()?;
    let tail = last.get(last.len().checked_sub(32)?..)?;
    uuid::Uuid::parse_str(tail).ok().map(|id| id.to_string())
}

/// Blocks from [`markdown_blocks`] as Notion-flavored Markdown. Every character of the answer
/// that the format reads as markup is escaped, so an answer quoting a `<page>` or
/// `<mention-user>` tag cannot move a page or notify anyone: only the structure the token path
/// would have written comes through.
fn notion_markdown(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(block_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn block_line(block: &Value) -> Option<String> {
    let kind = block.get("type")?.as_str()?;
    let items = block
        .get(kind)
        .and_then(|body| body.get("rich_text"))
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let prefix = match kind {
        "divider" => return Some("---".to_owned()),
        "code" => {
            // Code is literal in Notion's format; the parser never leaves a fence line inside.
            let code: String = items
                .iter()
                .filter_map(|item| item.pointer("/text/content").and_then(Value::as_str))
                .collect();
            return Some(format!("```\n{code}\n```"));
        }
        "heading_1" => "# ",
        "heading_2" => "## ",
        "heading_3" => "### ",
        "bulleted_list_item" => "- ",
        "numbered_list_item" => "1. ",
        "quote" => "> ",
        _ => "",
    };
    let text: String = items.iter().map(inline).collect();
    (!text.is_empty()).then(|| format!("{prefix}{text}"))
}

/// One rich-text item: escaped text inside its style's markers. A line break inside a block
/// becomes `<br>`, the one tag `LoomWatch` writes itself.
fn inline(item: &Value) -> String {
    let content = item
        .pointer("/text/content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let annotation =
        |name: &str| item.pointer(&format!("/annotations/{name}")) == Some(&json!(true));
    if annotation("code") {
        // A code span never holds a backtick: the parser ends it at the first one.
        return format!("`{}`", content.replace('\n', " "));
    }
    let text = escape(content).replace('\n', "<br>");
    if let Some(url) = item.pointer("/text/link/url").and_then(Value::as_str) {
        return format!("[{text}]({})", link_target(url));
    }
    if annotation("bold") {
        wrap(&text, "**")
    } else if annotation("italic") {
        wrap(&text, "*")
    } else {
        text
    }
}

/// `marker` around `text`, with spaces at its edges left outside so the emphasis still parses.
fn wrap(text: &str, marker: &str) -> String {
    let start = text.len() - text.trim_start().len();
    let end = text.trim_end().len().max(start);
    format!(
        "{}{marker}{}{marker}{}",
        &text[..start],
        &text[start..end],
        &text[end..]
    )
}

/// A backslash before every character Notion-flavored Markdown reads as markup outside code.
///
/// Notion still applies a block attribute such as `{color="red"}` when its brace is escaped, so
/// an escaped `{` is also followed by a zero-width space, which breaks the attribute and is
/// invisible to readers (checked against Notion on 2026-10-05).
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '*' | '~' | '`' | '$' | '[' | ']' | '<' | '>' | '{' | '}' | '|' | '^'
        ) {
            escaped.push('\\');
        }
        escaped.push(c);
        if c == '{' {
            escaped.push('\u{200B}');
        }
    }
    escaped
}

/// A link address that cannot close the Markdown link early.
fn link_target(url: &str) -> String {
    url.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
        .replace('<', "%3C")
        .replace('>', "%3E")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_cannot_smuggle_notion_tags_or_formatting() {
        let markdown = "Read <page url=\"https://www.notion.so/Secret-0123456789abcdef0123456789abcdef\">Secret</page> and <mention-user url=\"user://1\"/> {color=\"red\"} costs $5 | a^b ~x~ [y]\n\nback\\slash";
        let written = notion_markdown(&markdown_blocks(markdown));
        assert_eq!(
            written,
            "Read \\<page url=\"https://www.notion.so/Secret-0123456789abcdef0123456789abcdef\"\\>Secret\\</page\\> and \\<mention-user url=\"user://1\"/\\> \\{\u{200B}color=\"red\"\\} costs \\$5 \\| a\\^b \\~x\\~ \\[y\\]\nback\\\\slash"
        );
        assert!(!written.contains(" <"), "no tag survives unescaped");
    }

    #[test]
    fn structure_and_inline_styles_come_through() {
        let markdown = "# Title\n\nFirst line\nsecond line\n\n## Section\n- one **big** step\n1. see [The Verge](https://www.theverge.com/x) and *soft* and `code <x>`\n> quoted\n---\n```\nlet x = a < b;\n```";
        assert_eq!(
            notion_markdown(&markdown_blocks(markdown)),
            "# Title\nFirst line<br>second line\n## Section\n- one **big** step\n1. see [The Verge](https://www.theverge.com/x) and *soft* and `code <x>`\n> quoted\n---\n```\nlet x = a < b;\n```"
        );
    }

    #[test]
    fn link_addresses_cannot_close_the_link_early() {
        assert_eq!(
            link_target("https://example.com/a (b)<c>"),
            "https://example.com/a%20%28b%29%3Cc%3E"
        );
    }

    #[test]
    fn emphasis_keeps_edge_spaces_outside_its_markers() {
        assert_eq!(wrap(" big ", "**"), " **big** ");
        assert_eq!(wrap("big", "*"), "*big*");
    }

    #[test]
    fn stream_answers_are_found_past_notifications() {
        let stream = b"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\r\ndata: \"result\":{\"ok\":true}}\r\n\r\n";
        assert_eq!(
            answer_in_stream(stream, 2),
            Some(json!({"jsonrpc": "2.0", "id": 2, "result": {"ok": true}}))
        );
        assert_eq!(answer_in_stream(stream, 3), None);
        assert_eq!(answer_in_stream(&stream[..40], 2), None);
    }

    #[test]
    fn tool_output_prefers_structured_content_then_json_text() {
        assert_eq!(
            output(
                &json!({"structuredContent": {"a": 1}, "content": [{"type": "text", "text": "{\"b\":2}"}]})
            ),
            json!({"a": 1})
        );
        assert_eq!(
            output(&json!({"content": [{"type": "text", "text": "{\"b\":2}"}]})),
            json!({"b": 2})
        );
        assert_eq!(
            output(&json!({"content": [{"type": "text", "text": "plain"}]})),
            json!("plain")
        );
    }

    #[test]
    fn notion_ids_come_from_ids_and_page_addresses() {
        let dashed = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(notion_id(dashed).as_deref(), Some(dashed));
        assert_eq!(
            notion_id("550e8400e29b41d4a716446655440000").as_deref(),
            Some(dashed)
        );
        assert_eq!(
            notion_id(
                "https://www.notion.so/acme/Daily-News-550e8400e29b41d4a716446655440000?pvs=4"
            )
            .as_deref(),
            Some(dashed)
        );
        assert_eq!(notion_id("https://slack.com/archives/C1/p1"), None);
        assert_eq!(notion_id("Tiêu đề"), None);
    }

    #[test]
    fn search_keeps_only_pages() {
        let hits = [
            json!({"id": "550e8400-e29b-41d4-a716-446655440000", "title": " Daily ", "type": "page"}),
            json!({"id": "650e8400-e29b-41d4-a716-446655440000", "title": "Tasks", "type": "database"}),
            json!({"url": "https://www.notion.so/Notes-750e8400e29b41d4a716446655440000", "title": ""}),
            json!({"id": "slack-1", "title": "A message", "type": "page"}),
        ];
        let pages: Vec<(String, String)> = hits
            .iter()
            .filter_map(search_hit)
            .map(|page| (page.id, page.title))
            .collect();
        assert_eq!(
            pages,
            [
                (
                    "550e8400-e29b-41d4-a716-446655440000".to_owned(),
                    "Daily".to_owned()
                ),
                (
                    "750e8400-e29b-41d4-a716-446655440000".to_owned(),
                    "Untitled page".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn child_pages_are_matched_by_exact_unescaped_title() {
        // As notion-fetch answers: the page wrapped in its own <page>, children as leaves.
        let content = "<page url=\"https://app.notion.com/p/450e8400e29b41d4a716446655440000\">\n<properties>{\"title\":\"Daily\"}</properties>\n<content>\nIntro\n<page url=\"https://app.notion.com/p/550e8400e29b41d4a716446655440000\">News — 2026\\-10\\-05</page>\n<page url=\"https://evil.example/650e8400e29b41d4a716446655440000\">Pick \\[me\\]</page>\n<page url=\"https://app.notion.com/p/750e8400e29b41d4a716446655440000\">A \\<b\\></page>\n</content>\n</page>";
        assert_eq!(
            child_page(content, "News — 2026-10-05"),
            Some((
                "550e8400-e29b-41d4-a716-446655440000".to_owned(),
                "https://app.notion.com/p/550e8400e29b41d4a716446655440000".to_owned()
            )),
            "the first child is not swallowed by the page's own wrapper"
        );
        assert_eq!(
            child_page(content, "Pick [me]"),
            Some((
                "650e8400-e29b-41d4-a716-446655440000".to_owned(),
                "https://www.notion.so/650e8400e29b41d4a716446655440000".to_owned()
            )),
            "an address outside Notion is never reported"
        );
        assert_eq!(
            child_page(content, "A <b>").map(|(id, _)| id).as_deref(),
            Some("750e8400-e29b-41d4-a716-446655440000"),
            "an escaped < in a title does not end it"
        );
        assert_eq!(child_page(content, "News"), None);
        assert_eq!(
            child_page(content, "Daily"),
            None,
            "the page itself is not its own child"
        );
    }

    #[test]
    fn a_fetched_object_names_its_kind_under_metadata() {
        assert_eq!(
            kind(&json!({"metadata": {"type": "database"}, "title": "Tasks"})),
            "database"
        );
        assert_eq!(kind(&json!({"type": "page"})), "page");
        assert_eq!(kind(&json!({"title": "?"})), "");
    }

    #[test]
    fn created_pages_report_notion_addresses_only() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            created_page(
                &json!({"pages": [{"id": id, "url": "https://www.notion.so/x-550e8400e29b41d4a716446655440000"}]})
            ),
            Some((
                id.to_owned(),
                "https://www.notion.so/x-550e8400e29b41d4a716446655440000".to_owned()
            ))
        );
        assert_eq!(
            created_page(
                &json!([{"id": id, "url": "https://app.notion.com/p/550e8400e29b41d4a716446655440000"}])
            ),
            Some((
                id.to_owned(),
                "https://app.notion.com/p/550e8400e29b41d4a716446655440000".to_owned()
            ))
        );
        assert_eq!(
            created_page(&json!([{"id": id, "url": "http://www.notion.so/x"}])),
            Some((id.to_owned(), page_url(id)))
        );
        assert_eq!(
            created_page(&json!([{"id": id, "url": "https://notion.com.evil.example/x"}])),
            Some((id.to_owned(), page_url(id)))
        );
        assert_eq!(created_page(&json!({"pages": []})), None);
    }
}
