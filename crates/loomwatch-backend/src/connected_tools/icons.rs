//! Each tool's own icon, so the list reads at a glance: Todoist's red check, Kiwi.com's kiwi.
//!
//! Nothing is bundled: these logos are their makers' marks, and `LoomWatch`'s code license can't
//! hand them on. The daemon fetches a tool's icon from the tool's own site when the app first
//! shows it, the way the Skills page shows a publisher's picture, and keeps a copy for a week.
//! - Where it looks: the site's apple-touch-icon, then its other icons, then `/apple-touch-icon.png`
//!   and `/favicon.ico`.
//! - What it keeps and serves: bitmaps only (PNG, JPEG, GIF, WebP, ICO), never SVG, which can carry
//!   script. They are served with a policy that forbids everything else.
//! - Where it is served: only for the starter list's sites and the tools you connected, so the
//!   route can't be used to fetch arbitrary addresses.
//!
//! A site with no icon it will give (Peek turns away programs; `DeepWiki` rate-limits them) is
//! remembered for a day, and the app shows the tool's first letter instead.
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use super::catalog::CATALOG;
use super::{ConnectedTool, Tools};

/// How long a kept icon is used before it is fetched again. An old copy still serves when the
/// site can't be reached.
const FRESH_FOR: Duration = Duration::from_hours(24 * 7);
/// How long a site that gave no icon is left alone.
const MISSING_FOR: Duration = Duration::from_hours(24);
const MAX_PAGE_BYTES: usize = 600_000;
const MAX_ICON_BYTES: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

/// The folder in the state folder that keeps them.
pub(super) const ICONS_DIR: &str = "tool-icons";

static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<link\b[^>]*>").expect("a valid pattern"));
static REL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\brel\s*=\s*["']?([^"'>]+)"#).expect("a valid pattern"));
static HREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\bhref\s*=\s*["']?([^"'\s>]+)"#).expect("a valid pattern"));

/// The address the app loads `site`'s icon from.
pub(super) fn path(site: &str) -> Option<String> {
    host_of(site).map(|host| format!("/api/tools/icon/{host}"))
}

/// The site a connected tool's icon comes from: the starter list's, or its address's own domain
/// without a leading `mcp.`, `api.` or `ai.` (`mcp.example.com` → `example.com`).
pub(super) fn site_for(tool: &ConnectedTool) -> Option<String> {
    if let Some(entry) = super::catalog::at(&tool.url) {
        return Some(entry.site.to_owned());
    }
    let url = url::Url::parse(&tool.url).ok()?;
    let host = url.host_str()?;
    let local = is_local(host);
    let host = ["mcp.", "api.", "ai."]
        .iter()
        .find_map(|prefix| host.strip_prefix(prefix))
        .filter(|rest| rest.contains('.'))
        .unwrap_or(host);
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!(
        "{}://{host}{port}",
        if local { url.scheme() } else { "https" }
    ))
}

fn is_local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// `site`'s host (with its port, for one on this computer), as the route names it.
fn host_of(site: &str) -> Option<String> {
    let url = url::Url::parse(site).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// The icon of the site the route names as `host`, if it is one `LoomWatch` shows: the bytes and
/// their type. `None` when it isn't, or the site gives none.
pub(super) async fn icon(tools: &Tools, host: &str) -> Option<(Vec<u8>, &'static str)> {
    let host = host.to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 260
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return None;
    }
    let site = known_site(tools, &host).await?;
    let folder = tools.inner.icons.clone();
    let kept = folder.join(file_name(&host));
    let missing = folder.join(format!("{}.none", file_name(&host)));
    let (copy, fresh) = read_kept(&kept);
    if fresh && let Some(copy) = copy {
        return Some(copy);
    }
    if age(&missing).is_some_and(|age| age < MISSING_FOR) {
        return copy;
    }
    let Some((bytes, kind)) = fetch(&tools.inner.http, &site).await else {
        let _ = keep(&folder, &missing, b"");
        return copy;
    };
    let _ = keep(&folder, &kept, &bytes);
    let _ = std::fs::remove_file(&missing);
    Some((bytes, kind))
}

/// The site behind `host`, when it is one of the starter list's or a connected tool's.
async fn known_site(tools: &Tools, host: &str) -> Option<String> {
    let listed = CATALOG.iter().map(|entry| entry.site.to_owned());
    let connected: Vec<String> = tools.list().await.iter().filter_map(site_for).collect();
    listed
        .chain(connected)
        .find(|site| host_of(site).as_deref() == Some(host))
}

fn file_name(host: &str) -> String {
    host.replace(':', "_")
}

fn age(path: &Path) -> Option<Duration> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()
}

/// A kept icon, and whether it is fresh enough to use without asking the site.
fn read_kept(path: &Path) -> (Option<(Vec<u8>, &'static str)>, bool) {
    let copy = std::fs::read(path)
        .ok()
        .and_then(|bytes| image_type(&bytes).map(|kind| (bytes, kind)));
    let fresh = age(path).is_some_and(|age| age < FRESH_FOR);
    (copy, fresh)
}

fn keep(folder: &Path, path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(folder)?;
    std::fs::write(path, bytes)
}

/// The first icon `site` gives: from the links its home page names, then the usual places.
async fn fetch(http: &reqwest::Client, site: &str) -> Option<(Vec<u8>, &'static str)> {
    let base = url::Url::parse(site).ok()?;
    let mut candidates = Vec::new();
    if let Some((page, landed)) = get(http, base.as_str(), "text/html", MAX_PAGE_BYTES).await {
        candidates.extend(links(&String::from_utf8_lossy(&page), &landed));
    }
    candidates.extend(
        ["/apple-touch-icon.png", "/favicon.ico"]
            .iter()
            .filter_map(|path| base.join(path).ok()),
    );
    for candidate in candidates.into_iter().take(8) {
        let allowed = candidate.scheme() == "https"
            || (candidate.scheme() == "http" && candidate.host_str().is_some_and(is_local));
        if !allowed {
            continue;
        }
        if let Some((bytes, _)) = get(http, candidate.as_str(), "image/*", MAX_ICON_BYTES).await
            && let Some(kind) = image_type(&bytes)
        {
            return Some((bytes, kind));
        }
    }
    None
}

/// The icons a page's `<link>` tags name, apple-touch-icons first, SVGs and inline data left out.
fn links(page: &str, landed: &url::Url) -> Vec<url::Url> {
    let mut found: Vec<(bool, url::Url)> = LINK
        .find_iter(page)
        .filter_map(|tag| {
            let tag = tag.as_str();
            let rel = REL.captures(tag)?.get(1)?.as_str().to_ascii_lowercase();
            let href = HREF.captures(tag)?.get(1)?.as_str().replace("&amp;", "&");
            let svg = Path::new(href.split(['?', '#']).next().unwrap_or_default())
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"));
            if !rel.split_whitespace().any(|word| word.contains("icon"))
                || href.starts_with("data:")
                || svg
            {
                return None;
            }
            Some((rel.contains("apple"), landed.join(&href).ok()?))
        })
        .collect();
    found.sort_by_key(|(apple, _)| !apple);
    found.into_iter().map(|(_, url)| url).collect()
}

/// GET `url`, at most `max` bytes, and where it landed after redirects.
async fn get(
    http: &reqwest::Client,
    url: &str,
    accept: &str,
    max: usize,
) -> Option<(Vec<u8>, url::Url)> {
    let mut response = http
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .timeout(TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let landed = response.url().clone();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > max {
            if accept == "text/html" {
                // The icons are named near the top: the start of a long page is enough.
                break;
            }
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some((bytes, landed))
}

/// The kind of bitmap `bytes` is, by its first bytes, whatever the server called it.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_icons_a_page_names_apple_first_and_never_svg() {
        let landed = url::Url::parse("https://www.example.com/home").unwrap();
        let page = r#"<head>
            <link rel="icon" href="/favicon.svg" type="image/svg+xml">
            <link rel="icon" type="image/png" href="/static/icon-32.png?v=2">
            <LINK REL="apple-touch-icon" HREF="https://cdn.example.com/apple.png">
            <link rel="stylesheet" href="/site.css">
            <link rel="shortcut icon" href="data:image/png;base64,AAAA">
        </head>"#;
        let found: Vec<String> = links(page, &landed).into_iter().map(String::from).collect();
        assert_eq!(
            found,
            [
                "https://cdn.example.com/apple.png",
                "https://www.example.com/static/icon-32.png?v=2"
            ]
        );
    }

    #[test]
    fn knows_bitmaps_by_their_first_bytes_and_refuses_the_rest() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(&[0, 0, 1, 0, 1, 0]), Some("image/x-icon"));
        assert_eq!(
            image_type(b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"),
            None
        );
        assert_eq!(image_type(b"<html>"), None);
    }

    #[test]
    fn a_tools_icon_comes_from_its_own_domain() {
        let tool = |url: &str| ConnectedTool {
            id: "1".into(),
            name: "X".into(),
            url: url.into(),
            auth: super::super::Auth::None,
            calls: Vec::new(),
            checked_at: None,
            metadata: None,
            pending: false,
            problem: None,
        };
        assert_eq!(
            site_for(&tool("https://mcp.example.com/mcp")).as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            site_for(&tool("https://mcp.kiwi.com")).as_deref(),
            Some("https://www.kiwi.com")
        );
        assert_eq!(
            site_for(&tool("https://tools.acme.io/v1")).as_deref(),
            Some("https://tools.acme.io")
        );
        assert_eq!(
            site_for(&tool("http://127.0.0.1:9000/mcp")).as_deref(),
            Some("http://127.0.0.1:9000")
        );
        assert_eq!(
            path("https://www.kiwi.com").as_deref(),
            Some("/api/tools/icon/www.kiwi.com")
        );
    }
}
