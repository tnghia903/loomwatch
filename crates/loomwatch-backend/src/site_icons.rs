//! A website's own icon, for a source an answer cites (ADR 0116): `GET /api/site-icon?host=…`.
//!
//! The page never loads anything from a link in an answer. It asks here, and the daemon fetches the
//! site's own `https://<site>/favicon.ico`, or, when there is none there, reads the site's home page
//! (`https://<site>/`) for the icon it names, and nothing else:
//! - never the link's own path or query, so a link can't carry anything to the site;
//! - never a site on this computer or its network, by its name and by every address the name
//!   resolves to when connecting, redirects included;
//! - only a picture, by its first bytes (ICO, PNG, GIF, JPEG or WebP, never SVG, which can carry a
//!   script), of at most [`MAX_BYTES`].
//!
//! Each is kept in `site-icons/` in the state folder for [`KEEP`], and a site without one is
//! remembered for [`KEEP_MISSING`], so reading answers again asks nothing. Only `LoomWatch`'s own
//! page, on this computer's own address, can ask.
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use regex::Regex;
use serde::Deserialize;

use crate::agent::tools::link;

/// The most an icon may be, in bytes: a site's icon file can hold several sizes (one government
/// site's is 370 KB).
const MAX_BYTES: usize = 512 * 1024;
/// The most of a home page read for the icon it names: its head comes first.
const PAGE_BYTES: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(3);
/// How long an icon is kept before it is fetched again.
const KEEP: Duration = Duration::from_hours(30 * 24);
/// How long a site without one is left alone.
const KEEP_MISSING: Duration = Duration::from_hours(24);

/// Where a site's icon is asked for: `https://<site>` in use, a stand-in in tests.
type Origin = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// The icons kept, and how new ones are fetched.
#[derive(Clone)]
pub struct SiteIcons {
    dir: PathBuf,
    client: Option<reqwest::Client>,
    origin: Origin,
}

impl SiteIcons {
    /// Icons kept in `site-icons/` under `state_dir`, fetched from each site's own `https` root.
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        Self {
            dir: state_dir.join("site-icons"),
            client: public_client(),
            origin: Arc::new(|site| format!("https://{site}")),
        }
    }

    /// The icon of `site` (already checked by [`site`]) and its kind, from what is kept, else
    /// fetched now; `None` when it has none `LoomWatch` will show.
    async fn get(&self, site: &str) -> Option<(Vec<u8>, &'static str)> {
        let kept = self.dir.join(format!("{site}.icon"));
        let missing = self.dir.join(format!("{site}.none"));
        if fresh(&kept, KEEP).await
            && let Ok(bytes) = tokio::fs::read(&kept).await
            && let Some(kind) = picture(&bytes)
        {
            return Some((bytes, kind));
        }
        if fresh(&missing, KEEP_MISSING).await {
            return None;
        }
        let fetched = self.fetch(site).await;
        // Kept as well as it can be: a folder that can't be written only means asking again.
        let _ = tokio::fs::create_dir_all(&self.dir).await;
        match &fetched {
            Some((bytes, _)) => {
                let _ = tokio::fs::write(&kept, bytes).await;
                let _ = tokio::fs::remove_file(&missing).await;
            }
            None => {
                let _ = tokio::fs::write(&missing, b"").await;
            }
        }
        fetched
    }

    async fn fetch(&self, site: &str) -> Option<(Vec<u8>, &'static str)> {
        let root = (self.origin)(site);
        if let Some(found) = self.picture_at(&format!("{root}/favicon.ico")).await {
            return Some(found);
        }
        // A site with none at its root names its icon in its home page, as usa.gov does.
        let home = url::Url::parse(&format!("{root}/")).ok()?;
        let page = self.read(home.as_str(), PAGE_BYTES).await?;
        for named in named_icons(&String::from_utf8_lossy(&page)) {
            let Ok(icon) = home.join(&named) else {
                continue;
            };
            if icon.scheme() != home.scheme() {
                continue;
            }
            if let Some(found) = self.picture_at(icon.as_str()).await {
                return Some(found);
            }
        }
        None
    }

    /// The picture at `url`, if it is one `LoomWatch` shows.
    async fn picture_at(&self, url: &str) -> Option<(Vec<u8>, &'static str)> {
        let bytes = self.read(url, MAX_BYTES).await?;
        let kind = picture(&bytes)?;
        Some((bytes, kind))
    }

    /// What `url` gives, when it answers well within `limit` bytes.
    async fn read(&self, url: &str, limit: usize) -> Option<Vec<u8>> {
        let mut response = self.client.as_ref()?.get(url).send().await.ok()?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > limit as u64)
        {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > limit {
                return None;
            }
        }
        Some(bytes)
    }
}

static LINK_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<link\b[^>]*>").expect("a valid pattern"));

/// The icons a home page names in its `<link rel="icon">` tags, as written: the plain ones first,
/// then an Apple touch icon; never an SVG, which is never shown.
fn named_icons(page: &str) -> Vec<String> {
    let mut plain = Vec::new();
    let mut touch = Vec::new();
    for tag in LINK_TAG.find_iter(page) {
        let tag = tag.as_str();
        let (Some(rel), Some(href)) = (attribute(tag, "rel"), attribute(tag, "href")) else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let path = href
            .split(['?', '#'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        #[allow(clippy::case_sensitive_file_extension_comparisons)]
        let svg = path.ends_with(".svg")
            || attribute(tag, "type").is_some_and(|kind| kind.to_ascii_lowercase().contains("svg"));
        if svg || href.is_empty() || rel.contains("mask-icon") {
            continue;
        }
        let words: Vec<&str> = rel.split_whitespace().collect();
        if words.contains(&"icon") {
            plain.push(href.replace("&amp;", "&"));
        } else if words
            .iter()
            .any(|word| word.starts_with("apple-touch-icon"))
        {
            touch.push(href.replace("&amp;", "&"));
        }
    }
    plain.into_iter().chain(touch).take(4).collect()
}

/// The value of `name` in an HTML tag, quoted or not.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r#"(?i)\s{name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#
    ))
    .ok()?;
    let found = pattern.captures(tag)?;
    found
        .get(1)
        .or_else(|| found.get(2))
        .or_else(|| found.get(3))
        .map(|value| value.as_str().trim().to_owned())
}

/// Whether the file at `path` was written within `keep`.
async fn fresh(path: &Path, keep: Duration) -> bool {
    tokio::fs::metadata(path)
        .await
        .and_then(|meta| meta.modified())
        .is_ok_and(|written| {
            SystemTime::now()
                .duration_since(written)
                .is_ok_and(|age| age < keep)
        })
}

/// `asked` as a site whose icon may be fetched: a name on the internet, in lowercase ASCII (an
/// international name as its `xn--` form), with no port, path or user. `None` for an address written
/// as numbers, `localhost`, `.local` and anything else on this computer or its network.
#[must_use]
pub fn site(asked: &str) -> Option<String> {
    let name = asked.trim().trim_end_matches('.');
    if name.is_empty() || name.len() > 253 || name.contains(['/', ':', '@', '?', '#', '\\', ' ']) {
        return None;
    }
    let url::Host::Domain(name) = url::Host::parse(name).ok()? else {
        return None;
    };
    let name = name.to_ascii_lowercase();
    let plain = name.split('.').all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    });
    let url = url::Url::parse(&format!("https://{name}/")).ok()?;
    (plain && name.contains('.') && !link::on_this_network(&url)).then_some(name)
}

/// The kind of picture `bytes` are, by their first bytes; `None` for anything else, SVG included.
fn picture(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0, 0, 1, 0, ..] => Some("image/x-icon"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("image/gif"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ => None,
    }
}

/// The addresses `name` resolves to that are on the internet; an error when none is.
async fn public_addresses(name: &str) -> std::io::Result<Vec<SocketAddr>> {
    let public: Vec<SocketAddr> = tokio::net::lookup_host((name, 443))
        .await?
        .filter(|address| !link::private(address.ip()))
        .collect();
    if public.is_empty() {
        return Err(std::io::Error::other(
            "the site is on this computer or its network",
        ));
    }
    Ok(public)
}

/// Connects only to the internet: a name is resolved here, and an address on this computer or its
/// network is never connected to, whatever the name.
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = public_addresses(&name).await?;
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The client for icons: `https` only, no proxy (so every address goes through [`PublicOnly`]),
/// no cookies, `LoomWatch`'s own name, three seconds, and redirects only to another public `https`
/// address, three at most.
fn public_client() -> Option<reqwest::Client> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 3
            || attempt.url().scheme() != "https"
            || link::on_this_network(attempt.url())
        {
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
        .https_only(true)
        .no_proxy()
        .dns_resolver(Arc::new(PublicOnly))
        .redirect(policy)
        .timeout(TIMEOUT)
        .build()
        .ok()
}

#[derive(Deserialize)]
struct Asked {
    host: String,
}

/// `GET /api/site-icon?host=<site>`: on this computer's own address and from `LoomWatch`'s own
/// page only.
pub fn router(icons: SiteIcons) -> Router {
    Router::new()
        .route("/api/site-icon", get(icon))
        .route_layer(middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(icons)
}

async fn icon(State(icons): State<SiteIcons>, Query(asked): Query<Asked>) -> Response {
    let Some(site) = site(&asked.host) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match icons.get(&site).await {
        Some((bytes, kind)) => (
            [
                (header::CONTENT_TYPE, kind),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; sandbox",
                ),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    struct Folder(PathBuf);

    impl Folder {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-site-icons-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("folder");
            Self(path)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Sites standing in for the web on this computer: `/<site>/<path>` answers with what `serve`
    /// gives for that site and path (`""` for its home page), and every ask is counted.
    async fn sites(serve: fn(&str, &str) -> (StatusCode, Vec<u8>)) -> (Origin, Arc<AtomicUsize>) {
        let asked = Arc::new(AtomicUsize::new(0));
        let (home, file) = (asked.clone(), asked.clone());
        let app = Router::new()
            .route(
                "/{site}/",
                get(
                    move |axum::extract::Path(site): axum::extract::Path<String>| {
                        let counted = home.clone();
                        async move {
                            counted.fetch_add(1, Ordering::SeqCst);
                            serve(&site, "").into_response()
                        }
                    },
                ),
            )
            .route(
                "/{site}/{*path}",
                get(
                    move |axum::extract::Path((site, path)): axum::extract::Path<(
                        String,
                        String,
                    )>| {
                        let counted = file.clone();
                        async move {
                            counted.fetch_add(1, Ordering::SeqCst);
                            serve(&site, &path).into_response()
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listen");
        let port = listener.local_addr().expect("address").port();
        tokio::spawn(async move { axum::serve(listener, app).await.ok() });
        (
            Arc::new(move |site| format!("http://127.0.0.1:{port}/{site}")),
            asked,
        )
    }

    fn icons(folder: &Folder, origin: Origin) -> SiteIcons {
        SiteIcons {
            dir: folder.0.join("site-icons"),
            client: reqwest::Client::builder().timeout(TIMEOUT).build().ok(),
            origin,
        }
    }

    fn ask(host: &str, from: Option<&str>) -> Request<Body> {
        let mut request = Request::builder()
            .uri(format!("/api/site-icon?host={host}"))
            .header(header::HOST, "127.0.0.1:3000");
        if let Some(site) = from {
            request = request.header("sec-fetch-site", site);
        }
        request.body(Body::empty()).expect("request")
    }

    #[test]
    fn a_site_is_a_name_on_the_internet_and_nothing_else() {
        assert_eq!(site("usa.gov").as_deref(), Some("usa.gov"));
        assert_eq!(site(" WWW.USA.gov. ").as_deref(), Some("www.usa.gov"));
        assert_eq!(
            site("xaydungchinhsach.chinhphu.vn").as_deref(),
            Some("xaydungchinhsach.chinhphu.vn")
        );
        assert_eq!(site("bücher.de").as_deref(), Some("xn--bcher-kva.de"));
        for refused in [
            "",
            "localhost",
            "a.localhost",
            "printer.local",
            "127.0.0.1",
            "10.0.0.2",
            "[::1]",
            "::1",
            "usa.gov:8080",
            "usa.gov/branches",
            "me@usa.gov",
            "usa",
            "-bad.gov",
            "a..gov",
            "usa.gov?x=1",
        ] {
            assert_eq!(site(refused), None, "{refused:?}");
        }
    }

    #[tokio::test]
    async fn a_name_that_points_to_this_computer_is_never_connected_to() {
        assert!(public_addresses("localhost").await.is_err());
        let addresses = [
            SocketAddr::from(([127, 0, 0, 1], 443)),
            SocketAddr::from(([192, 168, 1, 4], 443)),
            SocketAddr::from(([93, 184, 215, 14], 443)),
        ];
        let public: Vec<_> = addresses
            .into_iter()
            .filter(|address| !link::private(address.ip()))
            .collect();
        assert_eq!(public, [SocketAddr::from(([93, 184, 215, 14], 443))]);
    }

    #[test]
    fn only_a_picture_is_an_icon() {
        assert_eq!(picture(PNG), Some("image/png"));
        assert_eq!(picture(&[0, 0, 1, 0, 1, 0]), Some("image/x-icon"));
        assert_eq!(picture(b"GIF89a.."), Some("image/gif"));
        assert_eq!(picture(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(picture(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(
            picture(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
            None
        );
        assert_eq!(picture(b"<!doctype html><title>Not found</title>"), None);
    }

    #[tokio::test]
    async fn an_icon_is_fetched_once_and_kept() {
        let folder = Folder::new();
        let (origin, asked) = sites(|_, _| (StatusCode::OK, PNG.to_vec())).await;
        let app = router(icons(&folder, origin));
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(ask("usa.gov", Some("same-origin")))
                .await
                .expect("answer");
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
            assert!(
                response.headers()[header::CONTENT_SECURITY_POLICY]
                    .to_str()
                    .unwrap()
                    .contains("sandbox")
            );
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body");
            assert_eq!(bytes.as_ref(), PNG);
        }
        assert_eq!(asked.load(Ordering::SeqCst), 1, "fetched once, then kept");
        assert!(folder.0.join("site-icons/usa.gov.icon").exists());
    }

    #[tokio::test]
    async fn a_page_or_an_svg_is_not_an_icon_and_is_not_asked_for_again() {
        let folder = Folder::new();
        let (origin, asked) = sites(|site, path| match (site, path) {
            ("svg.example", "favicon.ico") => (
                StatusCode::OK,
                b"<svg><script>alert(1)</script></svg>".to_vec(),
            ),
            ("big.example", "favicon.ico") => (StatusCode::OK, [PNG, &vec![0; MAX_BYTES]].concat()),
            _ => (StatusCode::NOT_FOUND, b"<!doctype html>".to_vec()),
        })
        .await;
        let app = router(icons(&folder, origin));
        for site in ["svg.example", "big.example", "gone.example", "svg.example"] {
            let response = app
                .clone()
                .oneshot(ask(site, Some("same-origin")))
                .await
                .expect("answer");
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{site}");
        }
        // Its icon and its home page each, once: a site without one is left alone for a day.
        assert_eq!(asked.load(Ordering::SeqCst), 6);
    }

    #[tokio::test]
    async fn a_site_with_none_at_its_root_gives_the_icon_its_home_page_names() {
        let folder = Folder::new();
        let (origin, asked) = sites(|_, path| match path {
            // usa.gov answers its root icon with nothing at all.
            "favicon.ico" => (StatusCode::OK, Vec::new()),
            "" => (StatusCode::OK, br#"<html><head><link rel="icon" type="image/svg+xml" href="mark.svg"><LINK REL='shortcut icon' HREF=images/mark.png?v=2&amp;x=1></head></html>"#.to_vec()),
            "images/mark.png" => (StatusCode::OK, PNG.to_vec()),
            _ => (StatusCode::NOT_FOUND, Vec::new()),
        })
        .await;
        let app = router(icons(&folder, origin));
        let response = app
            .oneshot(ask("usa.gov", Some("same-origin")))
            .await
            .expect("answer");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        // Its root icon, its home page and the PNG it names: never the SVG.
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_home_page_names_its_icons_plain_first_and_never_an_svg() {
        let page = r#"<link rel="apple-touch-icon" href="/touch.png"><link rel="mask-icon" href="/mask.png">
            <link href="/a.svg" rel="icon"><link rel="stylesheet" href="/site.css"><link rel="icon" sizes="32x32" href="/a-32.png">"#;
        assert_eq!(named_icons(page), ["/a-32.png", "/touch.png"]);
        assert!(named_icons("<html><title>No icon</title></html>").is_empty());
    }

    #[tokio::test]
    async fn another_site_or_a_home_address_never_makes_it_fetch() {
        let folder = Folder::new();
        let (origin, asked) = sites(|_, _| (StatusCode::OK, PNG.to_vec())).await;
        let app = router(icons(&folder, origin));
        let response = app
            .clone()
            .oneshot(ask("usa.gov", Some("cross-site")))
            .await
            .expect("answer");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        for home in ["localhost", "127.0.0.1", "printer.local"] {
            let response = app
                .clone()
                .oneshot(ask(home, Some("same-origin")))
                .await
                .expect("answer");
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{home}");
        }
        assert_eq!(asked.load(Ordering::SeqCst), 0);
    }
}
