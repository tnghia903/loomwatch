//! Local-only exact archive evidence. Run control and sanitized provenance are separate.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, Request, State, WebSocketUpgrade};
use axum::http::{StatusCode, header, uri::Authority};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

use crate::archive::EventArchive;

/// Build the evidence router. The caller MUST use a loopback listener when enabled.
pub fn router(archive: Option<EventArchive>) -> Router {
    Router::new()
        .route("/api/sessions", get(sessions))
        .route("/api/session/events", get(events))
        .route("/api/session/stream", get(stream))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(archive)
}

pub(crate) async fn local_evidence(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    let local = host
        .and_then(|v| v.parse::<Authority>().ok())
        .is_some_and(|a| matches!(a.host(), "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if !local || !from_this_origin(request.headers()) {
        return error(
            StatusCode::FORBIDDEN,
            "Exact evidence is available only to the local origin.",
        );
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

/// False when a browser says the request came from another page: an `Origin` that is not this
/// host, or `Sec-Fetch-Site` other than `same-origin` (the UI) or `none` (typed or bookmarked).
/// A tool such as `curl` sends neither header and passes.
///
/// Fetch Metadata matters because a cross-site `GET` from an `<img>` or a link carries no
/// `Origin` and needs no preflight, yet still reaches the handler.
pub(crate) fn from_this_origin(headers: &header::HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let origin_ok = headers.get(header::ORIGIN).is_none_or(|origin| {
        origin.to_str().is_ok_and(|origin| {
            host.is_some_and(|host| {
                origin == format!("http://{host}") || origin == format!("https://{host}")
            })
        })
    });
    let fetch_site_ok = headers
        .get("sec-fetch-site")
        .is_none_or(|site| site == "same-origin" || site == "none");
    origin_ok && fetch_site_ok
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

/// Shared with run control so both surfaces explain a missing archive the same way.
pub(crate) const ARCHIVE_DISABLED_MESSAGE: &str = "Archive watching is disabled. Start loomwatchd serve with --database-url or DATABASE_URL on a loopback address.";

fn disabled() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, ARCHIVE_DISABLED_MESSAGE)
}

async fn sessions(State(archive): State<Option<EventArchive>>) -> Response {
    let Some(archive) = archive else {
        return disabled();
    };
    match archive.list_sessions().await {
        Ok(sessions) => Json(sessions).into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The event archive is unavailable. Retry when PostgreSQL is connected.",
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventQuery {
    session: String,
    #[serde(default = "initial_cursor")]
    after_seq: i64,
    #[serde(default = "page_size")]
    limit: i64,
}
fn initial_cursor() -> i64 {
    -1
}
fn page_size() -> i64 {
    200
}

async fn events(
    State(archive): State<Option<EventArchive>>,
    Query(query): Query<EventQuery>,
) -> Response {
    if query.session.is_empty()
        || query.session.len() > 1024
        || query.after_seq < -1
        || !(1..=500).contains(&query.limit)
    {
        return error(
            StatusCode::BAD_REQUEST,
            "Use a session ID, afterSeq >= -1, and limit between 1 and 500.",
        );
    }
    let Some(archive) = archive else {
        return disabled();
    };
    match archive
        .event_page(&query.session, query.after_seq, query.limit)
        .await
    {
        Ok(events) => Json(events).into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The event archive is unavailable. Retry when PostgreSQL is connected.",
        ),
    }
}

async fn stream(
    State(archive): State<Option<EventArchive>>,
    Query(query): Query<EventQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if query.session.is_empty() || query.session.len() > 1024 || query.after_seq < -1 {
        return error(
            StatusCode::BAD_REQUEST,
            "Use a session ID and afterSeq >= -1.",
        );
    }
    let Some(archive) = archive else {
        return disabled();
    };
    upgrade
        .max_message_size(4096)
        .on_upgrade(move |socket| follow_archive(socket, archive, query))
        .into_response()
}

async fn follow_archive(mut socket: WebSocket, archive: EventArchive, query: EventQuery) {
    let mut cursor = query.after_seq;
    loop {
        let Ok(page) = archive.event_page(&query.session, cursor, 200).await else {
            break;
        };
        let full_page = page.len() == 200;
        for event in page {
            let Ok(seq) = i64::try_from(event.seq) else {
                return;
            };
            // No envelopes, status frames, or projection fields: frozen RunEvent bytes only.
            let Ok(json) = serde_json::to_string(&event) else {
                return;
            };
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(10),
                    socket.send(Message::Text(json.into()))
                )
                .await,
                Ok(Ok(()))
            ) {
                return;
            }
            cursor = seq;
        }
        if full_page {
            continue;
        }
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(500)) => {},
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                    _ => return,
                }
            }
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[sqlx::test(migrations = "../../migrations")]
    async fn websocket_replays_and_follows_exact_events(pool: sqlx::PgPool) {
        use crate::{EventKind, RunEvent};
        use futures_util::StreamExt;
        let archive = EventArchive::from_pool(pool);
        let make_event = |seq| RunEvent {
            id: format!("stream:{seq}"),
            session_id: "stream".into(),
            agent_id: "lead".into(),
            seq,
            ts: "2026-09-10T00:00:00Z".into(),
            kind: EventKind::Process,
            payload: json!({"phase":"spawned", "pid":123}),
            raw: None,
        };
        archive.append(&make_event(0)).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(Some(archive.clone()));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (mut client, _) = tokio_tungstenite::connect_async(format!(
            "ws://{address}/api/session/stream?session=stream"
        ))
        .await
        .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(3), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<RunEvent>(first.to_text().unwrap()).unwrap(),
            make_event(0)
        );
        archive.append(&make_event(1)).await.unwrap();
        let live = tokio::time::timeout(Duration::from_secs(3), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<RunEvent>(live.to_text().unwrap()).unwrap(),
            make_event(1)
        );
        client.close(None).await.unwrap();
        let (mut resumed, _) = tokio_tungstenite::connect_async(format!(
            "ws://{address}/api/session/stream?session=stream&afterSeq=0"
        ))
        .await
        .unwrap();
        let replay = tokio::time::timeout(Duration::from_secs(3), resumed.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<RunEvent>(replay.to_text().unwrap()).unwrap(),
            make_event(1)
        );
        resumed.close(None).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn rejects_remote_origins_and_rebinding_hosts() {
        for (host, origin) in [
            ("evil.example", "http://evil.example"),
            ("localhost:3000", "http://evil.example"),
            ("localhost:3000", "null"),
        ] {
            let response = router(None)
                .oneshot(
                    Request::builder()
                        .uri("/api/sessions")
                        .header("host", host)
                        .header("origin", origin)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn disabled_archive_is_explicit_and_never_cached() {
        let response = router(None)
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn rejects_unbounded_and_negative_event_queries() {
        for query in [
            "session=a&limit=501",
            "session=a&afterSeq=-2",
            "session=a&limit=0",
            "session=",
        ] {
            let response = router(None)
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/session/events?{query}"))
                        .header("host", "localhost")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }
}
