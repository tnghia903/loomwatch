//! Passing a request on to another `LoomWatch` and its answer back as it comes (ADR 0102): the
//! door to `LoomWatch` on this computer, and a connected computer to the one it shows.
//!
//! What goes on is what a local program's request would carry: the person's key, cookies, the page
//! it came from and what the network in between added are left behind. A live connection (the
//! run's events as they happen) is joined byte for byte once both sides have agreed to it.

use axum::Json;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Passes `request` on to `LoomWatch` at `base` (such as `http://127.0.0.1:3000`), with `key` as
/// `Authorization: Bearer …` when given, and its answer back. None when it can't be reached.
pub async fn pass_on(
    client: &reqwest::Client,
    base: &str,
    mut request: Request,
    key: Option<&str>,
) -> Option<Response> {
    let live = wants_upgrade(request.headers());
    let on_upgrade = live
        .then(|| {
            request
                .extensions_mut()
                .remove::<hyper::upgrade::OnUpgrade>()
        })
        .flatten();
    let (parts, body) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", axum::http::uri::PathAndQuery::as_str);
    let mut out = client.request(parts.method.clone(), format!("{base}{path}"));
    for (name, value) in &parts.headers {
        if goes_on(name) || (live && joins_live(name)) {
            out = out.header(name, value);
        }
    }
    if live {
        out = out
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, parts.headers[header::UPGRADE].clone());
    } else {
        out = out.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    if let Some(key) = key {
        out = out.bearer_auth(key);
    }
    let Ok(reply) = out.send().await else {
        return None;
    };
    let status = reply.status();
    let mut response = Response::builder().status(status);
    for (name, value) in reply.headers() {
        if status == StatusCode::SWITCHING_PROTOCOLS || !hop_by_hop(name) {
            response = response.header(name, value);
        }
    }
    if status == StatusCode::SWITCHING_PROTOCOLS {
        let Some(on_upgrade) = on_upgrade else {
            return Some(problem(
                StatusCode::BAD_REQUEST,
                "LoomWatch couldn't send live updates. Try again.",
            ));
        };
        tokio::spawn(async move {
            let (device, home) = tokio::join!(on_upgrade, reply.upgrade());
            if let (Ok(device), Ok(mut home)) = (device, home) {
                let mut device = hyper_util::rt::TokioIo::new(device);
                let _ = tokio::io::copy_bidirectional(&mut device, &mut home).await;
            }
        });
        return Some(response.body(Body::empty()).unwrap_or_else(|_| broken()));
    }
    Some(
        response
            .body(Body::from_stream(reply.bytes_stream()))
            .unwrap_or_else(|_| broken()),
    )
}

/// The headers a request keeps on its way: what the request is and what it accepts back.
fn goes_on(name: &HeaderName) -> bool {
    let name = name.as_str();
    matches!(
        name,
        "accept"
            | "accept-encoding"
            | "accept-language"
            | "cache-control"
            | "content-encoding"
            | "content-length"
            | "content-type"
            | "if-match"
            | "if-modified-since"
            | "if-none-match"
            | "if-range"
            | "if-unmodified-since"
            | "last-event-id"
            | "range"
    ) || name.starts_with("x-loomwatch-")
}

/// What a live connection's opening needs from the request.
fn joins_live(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-protocol"
            | "sec-websocket-extensions"
    )
}

/// Headers about one connection, never passed on.
fn hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn wants_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn broken() -> Response {
    problem(
        StatusCode::BAD_GATEWAY,
        "LoomWatch's answer didn't come through. Try again.",
    )
}

/// `LoomWatch` here didn't answer.
pub fn not_running() -> Response {
    let mut response = problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "LoomWatch on the computer you connected to isn't answering. Make sure it's open, then try again.",
    );
    response
        .headers_mut()
        .insert("x-loomwatch-state", HeaderValue::from_static("not_running"));
    response
}

pub fn problem(status: StatusCode, message: &str) -> Response {
    let mut response = (status, Json(json!({"error": message}))).into_response();
    no_store(response.headers_mut());
    response
}

pub fn no_store(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_cookies_and_where_a_request_came_from_never_go_on() {
        for left in [
            "authorization",
            "proxy-authorization",
            "cookie",
            "origin",
            "referer",
            "host",
            "sec-fetch-site",
            "sec-fetch-mode",
            "forwarded",
            "x-forwarded-for",
            "tailscale-user-login",
        ] {
            assert!(
                !goes_on(&HeaderName::from_static(left)),
                "{left} would go on"
            );
        }
        for kept in [
            "content-type",
            "if-match",
            "range",
            "accept",
            "x-loomwatch-request",
        ] {
            assert!(
                goes_on(&HeaderName::from_static(kept)),
                "{kept} was dropped"
            );
        }
    }
}
