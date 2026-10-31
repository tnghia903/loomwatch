use std::path::Path;

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Redirect};
use axum::routing::get;
use serde_json::json;

use super::*;
use crate::agent::provider::Cancel;
use crate::test_support::minimal_pdf;

const PAPER: &str = r#"<!DOCTYPE html>
<html><head><title>STAIR: Structure-Aware Retrieval &amp; Reading</title>
<style>body { color: red }</style><script>var hidden = "not words";</script></head>
<body><nav><button>Menu</button></nav>
<h1>STAIR</h1>
<p>We pick leaf sections from a table of contents, scored by <math alttext="P(s \mid q)"><mi>P</mi></math> per section.</p>
<h2>1 Results</h2>
<ul><li>18 books</li><li>Exact-match 71.2%</li></ul>
<svg><text>chart label</text></svg>
</body></html>"#;

/// A site on this computer: a paper, a PDF, plain text, a picture, a missing page and a redirect.
async fn site() -> String {
    let app = axum::Router::new()
        .route(
            "/html/2609.03874v1",
            get(|| async { ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAPER) }),
        )
        .route(
            "/pdf/2609.03874v1",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/pdf")],
                    minimal_pdf(&["Retrieve small, restore the section"]),
                )
            }),
        )
        .route("/notes.txt", get(|| async { "plain words" }))
        .route(
            "/logo.png",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/png")],
                    vec![0x89, b'P', b'N', b'G'],
                )
            }),
        )
        .route(
            "/gone",
            get(|| async { (StatusCode::NOT_FOUND, "no such page").into_response() }),
        )
        .route(
            "/abs",
            get(|| async { Redirect::temporary("/html/2609.03874v1") }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{address}")
}

/// `read_page` of `url`, by an agent the person wrote `links` to, which may use the web or not.
async fn read_page_as(url: &str, links: &[String], web: bool) -> Output {
    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let cancel = Cancel::new(cancel_rx);
    let settings = super::super::CommandSettings::default();
    let context = Context {
        cwd: Path::new("/nowhere"),
        connected: &[],
        cancel: &cancel,
        command: &settings,
        pictures: super::super::Pictures::default(),
        links,
        web,
    };
    tokio::time::timeout(Duration::from_secs(20), run(&json!({"url": url}), &context))
        .await
        .expect("read_page answered")
}

async fn read_link(url: &str, links: &[String]) -> Output {
    read_page_as(url, links, false).await
}

#[test]
fn links_are_found_in_the_words_without_the_sentence_around_them() {
    assert_eq!(
        written_in(
            "let's see how fit this paper with our project: https://arxiv.org/html/2609.03874v1"
        ),
        ["https://arxiv.org/html/2609.03874v1"]
    );
    assert_eq!(
        written_in(
            "Read https://example.com/a. Then (see https://example.com/b), and \
             [the post](https://example.com/c) and <https://example.com/d>, and \
             https://en.wikipedia.org/wiki/Mercury_(planet)! Again: https://example.com/a"
        ),
        [
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/c",
            "https://example.com/d",
            "https://en.wikipedia.org/wiki/Mercury_(planet)",
        ]
    );
    assert!(
        written_in("ftp://example.com/file and mailto:me@example.com and example.com").is_empty()
    );
    assert_eq!(
        written_in("HTTPS://Example.com/Path?q=1&x=2#part"),
        ["HTTPS://Example.com/Path?q=1&x=2#part"]
    );
}

#[test]
fn only_a_link_the_person_wrote_is_one_that_may_be_read() {
    let links = vec!["https://arxiv.org/html/2609.03874v1#S2".to_owned()];
    assert!(among("https://arxiv.org/html/2609.03874v1", &links).is_some());
    assert!(
        among("HTTPS://ARXIV.ORG/html/2609.03874v1#S3", &links).is_some(),
        "the same page, by its place on it"
    );
    assert!(among("https://arxiv.org/html/2609.03874v2", &links).is_none());
    assert!(
        among("https://arxiv.org/html/2609.03874v1?secret=1", &links).is_none(),
        "nothing can be added to it"
    );
    assert!(among("https://evil.example/?q=notes", &links).is_none());
    assert!(among("file:///etc/passwd", &["file:///etc/passwd".to_owned()]).is_none());
}

#[test]
fn addresses_on_this_computer_or_its_network_are_told_apart() {
    for local in [
        "http://localhost:3000/",
        "http://app.localhost/",
        "http://printer.local/",
        "http://127.0.0.1/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://169.254.169.254/latest/meta-data",
        "http://100.101.102.103/",
        "http://0.0.0.0/",
        "http://[::1]/",
        "http://[fd00::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
    ] {
        assert!(on_this_network(&url::Url::parse(local).unwrap()), "{local}");
    }
    for outside in [
        "https://arxiv.org/",
        "http://8.8.8.8/",
        "http://[2606:4700::1111]/",
    ] {
        assert!(
            !on_this_network(&url::Url::parse(outside).unwrap()),
            "{outside}"
        );
    }
}

#[test]
fn a_page_reads_as_its_words_with_headings_items_and_formulas() {
    let (title, text) = page_text(PAPER);
    assert_eq!(
        title.as_deref(),
        Some("STAIR: Structure-Aware Retrieval & Reading")
    );
    assert_eq!(
        text,
        "# STAIR\n\nWe pick leaf sections from a table of contents, scored by P(s \\mid q) per \
         section.\n\n## 1 Results\n\n- 18 books\n- Exact-match 71.2%"
    );
}

#[test]
fn what_a_page_is_comes_from_its_type_or_its_first_bytes() {
    assert_eq!(Page::of("text/html; charset=utf-8", b""), Some(Page::Html));
    assert_eq!(
        Page::of("application/octet-stream", b"%PDF-1.7"),
        Some(Page::Pdf)
    );
    assert_eq!(Page::of("application/pdf", b""), Some(Page::Pdf));
    assert_eq!(Page::of("text/markdown", b"# x"), Some(Page::Text));
    assert_eq!(Page::of("application/ld+json", b"{}"), Some(Page::Text));
    assert_eq!(Page::of("", b"  <!DOCTYPE html><html>"), Some(Page::Html));
    assert_eq!(Page::of("image/png", b"\x89PNG"), None);
}

#[tokio::test]
async fn a_link_the_person_wrote_is_read_as_words_and_any_other_is_refused() {
    let site = site().await;
    let paper = format!("{site}/html/2609.03874v1");
    let pdf = format!("{site}/pdf/2609.03874v1");
    let links = written_in(&format!(
        "let's see how fit this paper with our project: {paper} and {pdf}. Also {site}/notes.txt \
         {site}/logo.png {site}/gone {site}/abs"
    ));

    let read = read_link(&paper, &links).await;
    assert!(!read.failed, "{}", read.text);
    assert!(read.text.starts_with(&format!(
        "Read from {paper}\nTitle: STAIR: Structure-Aware Retrieval & Reading\n\n# STAIR\n"
    )));
    assert!(read.text.contains("- Exact-match 71.2%"), "{}", read.text);
    assert!(!read.text.contains("not words"), "{}", read.text);

    let pdf_read = read_link(&pdf, &links).await;
    assert!(!pdf_read.failed, "{}", pdf_read.text);
    assert!(
        pdf_read
            .text
            .ends_with("Retrieve small, restore the section"),
        "{}",
        pdf_read.text
    );

    let text = read_link(&format!("{site}/notes.txt"), &links).await;
    assert_eq!(
        text.text,
        format!("Read from {site}/notes.txt\n\nplain words")
    );

    let moved = read_link(&format!("{site}/abs"), &links).await;
    assert!(!moved.failed, "{}", moved.text);
    assert!(
        moved.text.starts_with(&format!("Read from {paper}\n")),
        "a redirect on the same site is followed, and says where it landed: {}",
        moved.text
    );

    let picture = read_link(&format!("{site}/logo.png"), &links).await;
    assert!(picture.failed);
    assert!(picture.text.contains("image/png"), "{}", picture.text);

    let gone = read_link(&format!("{site}/gone"), &links).await;
    assert!(gone.failed);
    assert!(gone.text.contains("404"), "{}", gone.text);

    let other = read_link(&format!("{site}/html/other"), &links).await;
    assert!(other.failed);
    assert!(
        other
            .text
            .contains("isn't a link the person wrote to you, and you may not use the web"),
        "{}",
        other.text
    );

    let none = read_link(&paper, &[]).await;
    assert!(none.failed);
    assert!(
        none.text.contains("you may not use the web"),
        "{}",
        none.text
    );

    // Once the person let it use the web, an address of the agent's own is read, but never one on
    // this computer or its network: only a link the person wrote reaches those.
    let own = read_page_as(&format!("{site}/notes.txt"), &[], true).await;
    assert!(own.failed);
    assert!(
        own.text.contains("is on this computer or its network"),
        "{}",
        own.text
    );
    let not_web = read_page_as("file:///etc/passwd", &[], true).await;
    assert!(not_web.failed);
    assert!(
        not_web.text.contains("isn't a web address"),
        "{}",
        not_web.text
    );
}
