//! `read_link`: the page at a link the person wrote, for an agent not allowed the web (ADR 0104).
//!
//! The person's own messages are where the links come from: a link in a file, a web page, a
//! teammate's brief or another team's request can't be read with it, so an agent can't send what it
//! read anywhere by writing an address of its own. The daemon fetches the page itself, outside the
//! command sandbox, and gives the agent its words: a web page as text, a PDF's text, or text as it
//! is.
//! - A redirect is followed, but never from a site on the internet to one on this computer or its
//!   network.
//! - A page is read up to [`MAX_BYTES`], and its text up to [`MAX_TEXT_CHARS`]. A long text is set
//!   aside by the session like any long tool output, to be read in parts.
use std::fmt::Write as _;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use super::{Context, Output};

/// The most a page may be, in bytes.
const MAX_BYTES: usize = 20 * 1024 * 1024;
/// The most text a page gives, in characters: a long book's worth.
const MAX_TEXT_CHARS: usize = 1_000_000;
const TIMEOUT: Duration = Duration::from_secs(30);
/// The most links one message gives.
const MAX_LINKS: usize = 50;

static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bhttps?://[^\s<>"'`\[\]{}|\\^]+"#).expect("a valid pattern")
});

/// The links written in `text`, each once, in the order written. A full stop, comma or closing
/// bracket after a link is the sentence's, not the link's: `(see https://example.com/a).`
#[must_use]
pub(crate) fn written_in(text: &str) -> Vec<String> {
    let mut links: Vec<String> = Vec::new();
    for found in LINK.find_iter(text) {
        let link = trimmed(found.as_str());
        if normal(link).is_some() && !links.iter().any(|kept| kept == link) {
            links.push(link.to_owned());
        }
        if links.len() == MAX_LINKS {
            break;
        }
    }
    links
}

/// `link` without the punctuation a sentence put after it. A `)` stays when the link opened one,
/// as Wikipedia's `…/Mercury_(planet)` does.
fn trimmed(mut link: &str) -> &str {
    loop {
        let Some(last) = link.chars().last() else {
            return link;
        };
        let opened = link.matches('(').count();
        let closed = link.matches(')').count();
        let sentences = matches!(last, '.' | ',' | ';' | ':' | '!' | '?' | '*' | '_' | '~');
        if sentences || (last == ')' && closed > opened) {
            link = &link[..link.len() - last.len_utf8()];
        } else {
            return link;
        }
    }
}

/// `link` as it is compared: an `http(s)` address without its `#` part, which names a place on
/// the page and is never sent.
fn normal(link: &str) -> Option<url::Url> {
    let mut url = url::Url::parse(link.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

/// The link the agent asked for, if it is one of the person's `links`.
fn among(asked: &str, links: &[String]) -> Option<url::Url> {
    let asked = normal(asked)?;
    links
        .iter()
        .filter_map(|link| normal(link))
        .any(|link| link == asked)
        .then_some(asked)
}

/// Whether `url` is on this computer or its own network.
fn on_this_network(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => {
            // A host name, not a file's: lowercased first, so the comparisons ignore case.
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            #[allow(clippy::case_sensitive_file_extension_comparisons)]
            let local = name.ends_with(".local");
            name == "localhost" || name.ends_with(".localhost") || local
        }
        Some(url::Host::Ipv4(ip)) => private(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => private(IpAddr::V6(ip)),
        None => true,
    }
}

fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                // 100.64.0.0/10: shared address space, as Tailscale uses.
                || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|ip| private(IpAddr::V4(ip)))
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}

/// One client for every page: it names `LoomWatch`, as a command's Python requests do, and follows
/// redirects only while they stay where the first address was.
static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let started_outside = attempt
            .previous()
            .first()
            .is_some_and(|first| !on_this_network(first));
        if attempt.previous().len() > 10 {
            attempt.error("the page sent the reader on more than 10 times")
        } else if started_outside && on_this_network(attempt.url()) {
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .user_agent(concat!(
            "LoomWatch/",
            env!("CARGO_PKG_VERSION"),
            " (+https://loomwatch.github.io/)"
        ))
        .redirect(policy)
        .timeout(TIMEOUT)
        .build()
        .ok()
});

/// What a page is, by what the site said and how its bytes begin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Page {
    Html,
    Pdf,
    Text,
}

impl Page {
    fn of(content_type: &str, start: &[u8]) -> Option<Self> {
        let kind = content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if start.starts_with(b"%PDF") || kind == "application/pdf" {
            Some(Self::Pdf)
        } else if kind == "text/html" || kind == "application/xhtml+xml" {
            Some(Self::Html)
        } else if kind.starts_with("text/")
            || kind.ends_with("+json")
            || kind.ends_with("+xml")
            || matches!(
                kind.as_str(),
                "application/json" | "application/xml" | "application/javascript"
            )
        {
            Some(Self::Text)
        } else if kind.is_empty() && looks_like_html(start) {
            Some(Self::Html)
        } else {
            None
        }
    }
}

fn looks_like_html(start: &[u8]) -> bool {
    let start = String::from_utf8_lossy(&start[..start.len().min(512)]).to_ascii_lowercase();
    let start = start.trim_start();
    start.starts_with("<!doctype html") || start.starts_with("<html")
}

/// Reads the link in `input`, when the person wrote it.
pub(super) async fn run(input: &Value, context: &Context<'_>) -> Output {
    let asked = input.get("url").and_then(Value::as_str).unwrap_or_default();
    let Some(url) = among(asked, context.links) else {
        return Output::failed(if context.links.is_empty() {
            "The person hasn't written a link to you, so there is nothing read_link may read. You \
             aren't allowed the web: ask the person for the page, or say what you couldn't read."
                .to_owned()
        } else {
            format!(
                "{asked} isn't a link the person wrote to you, so it can't be read. read_link reads \
                 only these: {}.",
                context.links.join(", ")
            )
        });
    };
    tokio::select! {
        output = read(url) => output,
        () = context.cancel.cancelled() => Output::failed("Stopped before the page was read."),
    }
}

async fn read(url: url::Url) -> Output {
    let Some(client) = CLIENT.as_ref() else {
        return Output::failed("LoomWatch couldn't set up its page reader.");
    };
    let mut response = match client.get(url.clone()).send().await {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return Output::failed(format!(
                "{url} didn't answer within {} seconds.",
                TIMEOUT.as_secs()
            ));
        }
        Err(error) => {
            return Output::failed(format!("{url} couldn't be reached: {}", why(&error)));
        }
    };
    let landed = response.url().clone();
    let status = response.status();
    if status.is_redirection() {
        return Output::failed(format!(
            "{url} sent the reader to an address on this computer or its network, which read_link \
             doesn't follow."
        ));
    }
    if !status.is_success() {
        return Output::failed(format!("{url} answered {status}, so it wasn't read."));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > MAX_BYTES {
                    return Output::failed(format!(
                        "{url} is more than the {} MB read_link reads.",
                        MAX_BYTES / 1024 / 1024
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => {
                return Output::failed(format!("{url} stopped part way: {}", why(&error)));
            }
        }
    }
    let Some(page) = Page::of(&content_type, &bytes) else {
        return Output::failed(format!(
            "{url} is {}, which read_link doesn't read: it reads web pages, PDFs and text.",
            if content_type.is_empty() {
                "a file of no stated kind".to_owned()
            } else {
                format!("a {content_type} file")
            }
        ));
    };
    let (title, text) = match page {
        Page::Html => page_text(&String::from_utf8_lossy(&bytes)),
        Page::Text => (None, String::from_utf8_lossy(&bytes).into_owned()),
        Page::Pdf => match pdf_text(bytes).await {
            Ok(text) => (None, text),
            Err(said) => return Output::failed(format!("{url} is a PDF: {said}")),
        },
    };
    let text = text.trim();
    if text.is_empty() {
        return Output::failed(format!(
            "{url} has no words in it that read_link can read. A page that builds itself with \
             script shows its words only in a browser."
        ));
    }
    let mut out = format!("Read from {landed}\n");
    if let Some(title) = title {
        let _ = writeln!(out, "Title: {title}");
    }
    out.push('\n');
    let mut chars = text.char_indices();
    match chars.nth(MAX_TEXT_CHARS) {
        Some((cut, _)) => {
            out.push_str(&text[..cut]);
            let _ = write!(
                out,
                "\n… The rest is past the {MAX_TEXT_CHARS} characters read_link reads from one page."
            );
        }
        None => out.push_str(text),
    }
    Output::ok(out)
}

/// What went wrong, down to its cause: "error sending request" alone says nothing. The address is
/// left out, as the message already names it.
fn why(error: &reqwest::Error) -> String {
    let mut said = error.to_string();
    if let Some(url) = error.url() {
        said = said.replace(&format!(" ({url})"), "");
    }
    let mut cause = std::error::Error::source(error);
    while let Some(next) = cause {
        said.push_str(": ");
        said.push_str(&next.to_string());
        cause = next.source();
    }
    said
}

/// A PDF's text, read the way `read_file` reads one, from a copy in the temporary folder.
async fn pdf_text(bytes: Vec<u8>) -> Result<String, String> {
    let copy = std::env::temp_dir().join(format!("loomwatch-link-{}.pdf", uuid::Uuid::new_v4()));
    tokio::task::spawn_blocking(move || {
        std::fs::write(&copy, &bytes).map_err(|error| format!("it couldn't be kept: {error}"))?;
        let text = crate::documents::text(&copy);
        let _ = std::fs::remove_file(&copy);
        text
    })
    .await
    .unwrap_or_else(|error| Err(format!("the reader stopped: {error}")))
}

static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").expect("a valid pattern"));
/// Formulas, as the page's own `alttext` (TeX on arXiv) rather than the symbols spelled out.
static MATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<math\b[^>]*?\balttext\s*=\s*"([^"]*)"[^>]*>.*?</math>"#)
        .expect("a valid pattern")
});
static HIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<(svg|noscript|button|select)\b.*?</(svg|noscript|button|select)\s*>")
        .expect("a valid pattern")
});
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<h([1-6])\b[^>]*>").expect("a valid pattern"));
static ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<li\b[^>]*>").expect("a valid pattern"));
static CELL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</t[dh]\s*>").expect("a valid pattern"));
static BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)</?(p|div|section|article|header|footer|main|aside|nav|blockquote|pre|table|thead|tbody|tr|ul|ol|dl|dt|dd|figure|figcaption|caption|h[1-6]|hr|address|details|summary)\b[^>]*>",
    )
    .expect("a valid pattern")
});

/// A web page's title and words, its headings marked with `#` and its list items with `-`, so the
/// agent reads where each part begins.
fn page_text(html: &str) -> (Option<String>, String) {
    let title = TITLE
        .captures(html)
        .map(|found| mail_parser::decoders::html::html_to_text(&found[1]))
        .map(|title| title.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|title| !title.is_empty());
    let html = MATH.replace_all(html, " $1 ");
    let html = HIDDEN.replace_all(&html, " ");
    let html = HEADING.replace_all(&html, |found: &regex::Captures<'_>| {
        let level: usize = found[1].parse().unwrap_or(2);
        format!("<br><br>{} ", "#".repeat(level))
    });
    let html = ITEM.replace_all(&html, "<br>- ");
    let html = CELL.replace_all(&html, " | ");
    let html = BLOCK.replace_all(&html, "<br>");
    let text = mail_parser::decoders::html::html_to_text(&html);
    (title, tidy(&text))
}

/// Lines trimmed, at most one blank line in a row.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = false;
    for line in text.lines().map(str::trim) {
        if line.is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank { "\n\n" } else { "\n" });
        }
        blank = false;
        out.push_str(line);
    }
    out
}

#[cfg(test)]
mod tests;
