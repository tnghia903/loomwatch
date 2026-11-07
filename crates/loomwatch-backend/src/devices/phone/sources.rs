//! The titles of the pages a run's web searches found, so the phone names a source an answer cites
//! by its page, not its site, as the Mac's chat does (ADR 0116). Read from what each search gave the
//! agent, as the run's events keep it, never by asking the page: a Claude model's search lists each
//! page as `title url` on a line, a `ChatGPT` plan's as its title, then its address, then a few
//! words from it. A search that kept no titles (`OpenRouter`'s own) names nothing.
//!
//! The twin of the Mac's `sourceTitles` and `sourceKey` (`ui/src/lib/story/sourceTitles.ts`), with
//! its web-search test (`isWebSearch` in `ui/src/lib/story/webCalls.ts`) and the way its projection
//! merges a call with its updates (`ui/src/lib/watch/events.ts`). Change them together; the tests
//! below are the Mac's cases.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// A page's address at the end of a line, after its title if it has one there.
static PAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.*?)\s*(https?://\S+)\s*$").expect("a valid pattern"));
/// The line before a search's first page says what was searched for, not a page's title.
static NOT_A_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(Searched the web|Opened|Looked for|Nothing came back|It failed)\b")
        .expect("a valid pattern")
});

/// One tool call as far as its pages go: its name as the Mac shows it, what it was given, and what
/// it said back.
struct Call {
    name: String,
    /// The kind the Mac gives it from its first event (`toolCallKind`): `search` or anything else.
    search: bool,
    tool_kind: Option<String>,
    raw_input: Value,
    content: Value,
    raw_output: Value,
}

/// The title of each page `events`' web searches found, by its [`key`]; the first title a page is
/// given wins.
#[must_use]
pub fn titles(events: &[Value]) -> BTreeMap<String, String> {
    let mut calls: Vec<Call> = Vec::new();
    let mut at: HashMap<(String, String), usize> = HashMap::new();
    for event in events {
        let payload = &event["payload"];
        let agent = event["agentId"].as_str().unwrap_or_default().to_owned();
        match event["kind"].as_str() {
            Some("tool_call") => {
                let Some(id) = payload["callId"].as_str().or(event["id"].as_str()) else {
                    continue;
                };
                let name = payload["name"].as_str();
                let title = payload["title"].as_str().or(name).unwrap_or("tool");
                let tool_kind = payload["toolKind"].as_str().map(str::to_owned);
                let call = Call {
                    name: display_name(name, title),
                    search: called_search(title, tool_kind.as_deref()),
                    tool_kind,
                    raw_input: payload["rawInput"].clone(),
                    content: payload["content"].clone(),
                    raw_output: payload["rawOutput"].clone(),
                };
                at.insert((agent, id.to_owned()), calls.len());
                calls.push(call);
            }
            Some("tool_update") => {
                let Some(call) = payload["callId"]
                    .as_str()
                    .and_then(|id| at.get(&(agent, id.to_owned())))
                    .map(|&index| &mut calls[index])
                else {
                    continue;
                };
                if let Some(output) = payload.get("rawOutput") {
                    call.raw_output = output.clone();
                }
                if let Some(content) = payload.get("content") {
                    call.content = content.clone();
                }
                if let Some(title) = payload["title"].as_str() {
                    call.name = display_name(payload["callId"].as_str(), title);
                }
            }
            _ => {}
        }
    }
    let mut titles = BTreeMap::new();
    for call in calls.iter().filter(|call| web_search(call)) {
        let output = output_text(call);
        let lines: Vec<&str> = output.split('\n').map(str::trim).collect();
        for (index, line) in lines.iter().enumerate() {
            let Some(found) = PAGE.captures(line) else {
                continue;
            };
            let Some(page) = key(&found[2]) else {
                continue;
            };
            if titles.contains_key(&page) {
                continue;
            }
            // On its own line, the address follows its title.
            let before = index.checked_sub(1).map_or("", |at| lines[at]);
            let title = if !found[1].is_empty() {
                &found[1]
            } else if !before.is_empty() && !PAGE.is_match(before) && !NOT_A_TITLE.is_match(before)
            {
                before
            } else {
                ""
            };
            if !title.is_empty() {
                titles.insert(page, title.to_owned());
            }
        }
    }
    titles
}

/// An address as a source is matched against what a search found: its site without `www.`, its path
/// without a closing slash, and its query; never its `#` part, which names a place on the page.
#[must_use]
pub fn key(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let path = url.path().trim_end_matches('/');
    let query = url
        .query()
        .filter(|query| !query.is_empty())
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    Some(format!("{host}{path}{query}"))
}

/// A call's name as the Mac shows it (`toolDisplayName`): a connected tool's as `server · tool`,
/// anything else's by its title.
fn display_name(name: Option<&str>, title: &str) -> String {
    if let Some((server, tool)) = name
        .and_then(|name| name.strip_prefix("mcp__"))
        .and_then(|rest| rest.split_once("__"))
        .filter(|(server, tool)| !server.is_empty() && !server.contains('_') && !tool.is_empty())
    {
        return format!("{server} · {}", tool.replace('_', " "));
    }
    let base = if title.is_empty() {
        name.filter(|name| !name.is_empty()).unwrap_or("tool")
    } else {
        title
    };
    base.trim().to_owned()
}

/// Whether the Mac files a call as a search (`toolCallKind`): Claude's adapter titles its search
/// "Web search", and a call of kind `search` is one. (The Mac also files a notebook search as one;
/// its name never passes [`web_search`].)
fn called_search(title: &str, tool_kind: Option<&str>) -> bool {
    let title = title.to_lowercase();
    title.starts_with("web search") || title.starts_with("search \"") || tool_kind == Some("search")
}

/// Code the model ran at its provider for its web tools (`isProviderCode`): runs recorded before the
/// daemon named it "Run code: …" (2026-10-21) titled it "Search the web: the web". A call named as
/// code is never a search by its title anyway.
fn provider_code(call: &Call) -> bool {
    call.tool_kind.as_deref() == Some("fetch") && call.raw_input["code"].is_string()
}

/// A web search, however its app titled it (`isWebSearch`).
fn web_search(call: &Call) -> bool {
    if provider_code(call) {
        return false;
    }
    let title = first_line(&call.name).to_lowercase();
    if title.starts_with("search the web")
        || title.starts_with("web search")
        || title.starts_with("search \"")
    {
        return true;
    }
    call.search && (call.raw_input["type"] == "webSearch" || WEB_SEARCH_NAME.is_match(&call.name))
}

static WEB_SEARCH_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)web_?search").expect("a valid pattern"));

fn first_line(name: &str) -> &str {
    name.split('\n').next().unwrap_or_default().trim()
}

/// What a call said back (`outputText`): its content's text, else its raw output.
fn output_text(call: &Call) -> String {
    if let Some(blocks) = call.content.as_array() {
        let said: Vec<&str> = blocks
            .iter()
            .filter_map(|block| {
                block["content"]["text"]
                    .as_str()
                    .or_else(|| block["text"].as_str())
            })
            .filter(|text| !text.is_empty())
            .collect();
        if !said.is_empty() {
            return said.join("\n");
        }
    }
    match &call.raw_output {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A tool call and its update as the run's events keep them, the update carrying what it said.
    fn search(id: &str, title: &str, tool_kind: &str, said: &str) -> [Value; 2] {
        [
            json!({"kind": "tool_call", "agentId": "coby", "id": format!("e{id}"),
                   "payload": {"callId": id, "title": title, "toolKind": tool_kind, "rawInput": {},
                               "status": "pending"}}),
            json!({"kind": "tool_update", "agentId": "coby",
                   "payload": {"callId": id, "status": "completed",
                               "content": [{"type": "content", "content": {"type": "text", "text": said}}]}}),
        ]
    }

    #[test]
    fn reads_a_claude_models_search_a_page_a_line_and_a_chatgpt_plans_a_title_over_its_address() {
        let events: Vec<Value> = [
            search(
                "1",
                "Search the web: US branches of government",
                "fetch",
                &[
                    "Branches of the U.S. government | USAGov https://www.usa.gov/branches-of-government",
                    "https://www.usa.gov/no-title",
                    "Legislative branch | USAGov https://www.usa.gov/legislative-branch/",
                ]
                .join("\n"),
            ),
            search(
                "2",
                "Search the web: Chính phủ Việt Nam",
                "fetch",
                &[
                    "Searched the web for: Chính phủ Việt Nam",
                    "",
                    "Cơ cấu tổ chức của Chính phủ",
                    "https://xaydungchinhsach.chinhphu.vn/co-cau#muc-1",
                    "Chính phủ gồm Thủ tướng, các Phó Thủ tướng…",
                ]
                .join("\n"),
            ),
        ]
        .concat();
        let titles = titles(&events);
        assert_eq!(
            titles
                .get("usa.gov/branches-of-government")
                .map(String::as_str),
            Some("Branches of the U.S. government | USAGov")
        );
        assert_eq!(
            titles.get("usa.gov/legislative-branch").map(String::as_str),
            Some("Legislative branch | USAGov")
        );
        // An address with no title on its line and a page's line before it has none.
        assert!(!titles.contains_key("usa.gov/no-title"), "{titles:?}");
        assert_eq!(
            titles
                .get("xaydungchinhsach.chinhphu.vn/co-cau")
                .map(String::as_str),
            Some("Cơ cấu tổ chức của Chính phủ")
        );
        assert_eq!(titles.len(), 3, "{titles:?}");
    }

    #[test]
    fn names_nothing_from_what_isnt_a_search_or_a_search_that_kept_no_titles() {
        let events: Vec<Value> = [
            search(
                "1",
                "Read https://example.com/a",
                "fetch",
                "Example page https://example.com/a",
            ),
            search("2", "Run npm test", "execute", "see https://example.com/b"),
            search("3", "Search the web: prices", "fetch", "Basic: 139,000 VND"),
        ]
        .concat();
        // Code a model ran at its provider for its web tools, titled as a search by runs recorded
        // before the daemon named it (2026-10-21), and named as code since.
        let code = [
            json!({"kind": "tool_call", "agentId": "coby",
                   "payload": {"callId": "4", "title": "Search the web: the web", "toolKind": "fetch",
                               "rawInput": {"code": "results = web_search('backprop')"},
                               "rawOutput": "Backprop https://example.com/c"}}),
            // A connected tool's search, which the Mac doesn't count as one of the agent's own.
            json!({"kind": "tool_call", "agentId": "coby",
                   "payload": {"callId": "5", "name": "mcp__exa__web_search", "title": "mcp__exa__web_search",
                               "toolKind": "search", "rawInput": {},
                               "rawOutput": "Backprop https://example.com/d"}}),
        ];
        let events = [events, code.to_vec()].concat();
        assert!(titles(&events).is_empty(), "{:?}", titles(&events));
    }

    #[test]
    fn a_search_known_by_its_kind_and_one_whose_update_names_it_are_read_too() {
        // A ChatGPT plan's search: kind `search`, its type in its input, its pages in its raw output.
        let plan = json!({"kind": "tool_call", "agentId": "coby",
                          "payload": {"callId": "w1", "title": "Searching", "toolKind": "search",
                                      "rawInput": {"type": "webSearch"},
                                      "rawOutput": "Gradient descent - Wikipedia https://en.wikipedia.org/wiki/Gradient_descent"}});
        // A call named only once it ends, by another agent: its title comes with its update.
        let later = [
            json!({"kind": "tool_call", "agentId": "ana",
                   "payload": {"callId": "w1", "title": "tool", "toolKind": "fetch", "rawInput": {}}}),
            json!({"kind": "tool_update", "agentId": "ana",
                   "payload": {"callId": "w1", "title": "Search the web: backprop",
                               "rawOutput": "Backpropagation | Brilliant https://brilliant.org/wiki/backpropagation/"}}),
        ];
        let titles = titles(&[vec![plan], later.to_vec()].concat());
        assert_eq!(
            titles
                .get("en.wikipedia.org/wiki/Gradient_descent")
                .map(String::as_str),
            Some("Gradient descent - Wikipedia")
        );
        assert_eq!(
            titles
                .get("brilliant.org/wiki/backpropagation")
                .map(String::as_str),
            Some("Backpropagation | Brilliant")
        );
    }

    /// One call, finished, as its event keeps it.
    fn call(id: &str, title: &str, tool_kind: &str, rest: &Value) -> Value {
        let mut payload =
            json!({"callId": id, "title": title, "toolKind": tool_kind, "rawInput": {}});
        for (field, value) in rest.as_object().expect("an object") {
            payload[field] = value.clone();
        }
        json!({"kind": "tool_call", "agentId": "coby", "payload": payload})
    }

    #[test]
    fn claudes_adapter_titles_and_a_search_known_by_its_name_are_read_too() {
        let events = [
            call(
                "a",
                "Web search",
                "fetch",
                &json!({"rawOutput": "Backpropagation - Wikipedia https://en.wikipedia.org/wiki/Backpropagation"}),
            ),
            call(
                "b",
                "Search \"chain rule\"",
                "fetch",
                &json!({"rawOutput": "Chain rule - Wikipedia https://en.wikipedia.org/wiki/Chain_rule"}),
            ),
            // Its words in a plain text block, not inside a content block.
            call(
                "c",
                "web_search",
                "search",
                &json!({"content": [{"type": "text", "text": "Gradient | Brilliant https://brilliant.org/wiki/gradient"}]}),
            ),
        ];
        assert_eq!(
            titles(&events),
            BTreeMap::from([
                (
                    "en.wikipedia.org/wiki/Backpropagation".to_owned(),
                    "Backpropagation - Wikipedia".to_owned()
                ),
                (
                    "en.wikipedia.org/wiki/Chain_rule".to_owned(),
                    "Chain rule - Wikipedia".to_owned()
                ),
                (
                    "brilliant.org/wiki/gradient".to_owned(),
                    "Gradient | Brilliant".to_owned()
                ),
            ])
        );
    }

    #[test]
    fn the_first_title_a_page_is_given_wins_and_what_was_searched_for_is_never_one() {
        let events = [
            call(
                "1",
                "Search the web: backprop",
                "fetch",
                &json!({"rawOutput": "Searched the web for: backprop\nhttps://example.com/searched\nFirst https://a.com/x\nSecond https://a.com/x/"}),
            ),
            // What it said is read before its raw output.
            call(
                "2",
                "Search the web: chain rule",
                "fetch",
                &json!({"content": [{"type": "content", "content": {"type": "text", "text": "Said https://a.com/said"}}],
                        "rawOutput": "Raw https://a.com/raw"}),
            ),
            // A file read, though its input says web search: not a search.
            call(
                "3",
                "Read web_search.py",
                "read",
                &json!({"rawInput": {"type": "webSearch"}, "rawOutput": "Notes https://a.com/notes"}),
            ),
        ];
        assert_eq!(
            titles(&events),
            BTreeMap::from([
                ("a.com/x".to_owned(), "First".to_owned()),
                ("a.com/said".to_owned(), "Said".to_owned()),
            ])
        );
    }

    #[test]
    fn matches_an_address_whatever_its_www_closing_slash_or_place_on_the_page() {
        assert_eq!(
            key("https://www.USA.gov/branches/#top").as_deref(),
            Some("usa.gov/branches")
        );
        assert_eq!(
            key("http://usa.gov/branches?lang=vi").as_deref(),
            Some("usa.gov/branches?lang=vi")
        );
        assert_eq!(key("https://usa.gov/?").as_deref(), Some("usa.gov"));
        assert_eq!(key("mailto:me@usa.gov"), None);
        assert_eq!(key("ftp://usa.gov/x"), None);
        assert_eq!(key("not a link"), None);
    }
}
