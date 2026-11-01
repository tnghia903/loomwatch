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

use crate::archive::{EventArchive, Frames};

/// Build the evidence router. The caller MUST use a loopback listener when enabled.
pub fn router(archive: Option<EventArchive>) -> Router {
    Router::new()
        .route("/api/sessions", get(sessions))
        .route("/api/session/events", get(events))
        .route("/api/session/stream", get(stream))
        .route("/api/usage", get(usage))
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
pub(crate) const ARCHIVE_DISABLED_MESSAGE: &str =
    "This LoomWatch has no run archive open. Start it with loomwatchd serve on a loopback address.";

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
            "The run archive could not be read. The window running LoomWatch says why.",
        ),
    }
}

#[derive(Deserialize)]
struct UsageQuery {
    #[serde(default = "usage_days")]
    days: u32,
}
const fn usage_days() -> u32 {
    30
}

/// What the model calls of the last `days` days used, by source, day and agent (ADR 0073): the
/// Usage page's figures. Read from the archive only; no provider is asked.
async fn usage(
    State(archive): State<Option<EventArchive>>,
    Query(query): Query<UsageQuery>,
) -> Response {
    if !(1..=366).contains(&query.days) {
        return error(StatusCode::BAD_REQUEST, "Use days between 1 and 366.");
    }
    let Some(archive) = archive else {
        return disabled();
    };
    match archive.model_usage(chrono::Utc::now(), query.days).await {
        Ok(report) => Json(report).into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The run archive could not be read. The window running LoomWatch says why.",
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
    /// `lean=true` leaves each event's raw ACP frame out except where the browser reads it
    /// ([`Frames::Lean`]). Off by default, so any other reader still gets every frame.
    #[serde(default)]
    lean: bool,
}
fn initial_cursor() -> i64 {
    -1
}
fn page_size() -> i64 {
    200
}

impl EventQuery {
    fn frames(&self) -> Frames {
        if self.lean { Frames::Lean } else { Frames::All }
    }
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
        .trace_page(&query.session, query.after_seq, query.limit, query.frames())
        .await
    {
        Ok(events) => Json(events).into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The run archive could not be read. The window running LoomWatch says why.",
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

/// How long a live stream waits for the writer's signal before it reads again anyway.
///
/// Only a safety net: every event the daemon writes wakes the stream when its batch commits. Rows
/// that arrive another way, such as an import run from another process, are picked up within this.
const FOLLOW_FALLBACK: Duration = Duration::from_secs(30);

/// Replay a session from the cursor, then send each event as soon as the writer commits it.
///
/// Push, not poll: the stream sleeps until a batch is committed ([`EventArchive::written`]), the
/// client goes away, or [`FOLLOW_FALLBACK`] passes. It reads only what is already committed, so
/// following a run never makes the writer commit early.
async fn follow_archive(mut socket: WebSocket, archive: EventArchive, query: EventQuery) {
    let mut written = archive.written();
    let mut cursor = query.after_seq;
    loop {
        // Seen before the read, not after: a batch that commits once the read has started still
        // counts as a change, so the wait below cannot sleep through it.
        written.mark_unchanged();
        let Ok(page) = archive
            .written_page(&query.session, cursor, 200, query.frames())
            .await
        else {
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
            () = committed(&mut written) => {},
            () = tokio::time::sleep(FOLLOW_FALLBACK) => {},
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

/// Resolve when the writer has committed a batch since the signal was last marked seen.
async fn committed(written: &mut tokio::sync::watch::Receiver<u64>) {
    if written.changed().await.is_err() {
        // The writer has stopped, so nothing more will be committed: wait on the client and the
        // fallback instead of waking at once, forever.
        std::future::pending::<()>().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn websocket_replays_and_follows_exact_events() {
        use crate::{EventKind, RunEvent};
        use futures_util::StreamExt;
        let pool = crate::db::Db::temp().await;
        let archive = EventArchive::new(pool);
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

    /// How soon an event committed while the stream waits must reach it. A stream that missed the
    /// commit's signal reads again only at [`FOLLOW_FALLBACK`], so an event well inside that came
    /// by the signal. Wide enough for a loaded Windows runner, which has taken 461 ms.
    const WOKEN_WITHIN: Duration = Duration::from_secs(2);

    /// The stream is pushed, not polled: an event committed while the stream waits arrives at
    /// once, long before the fallback read, whether the event was written for a caller that
    /// waited or by the writer's own batch window. Closing the socket ends the follow task, which
    /// lets go of the writer's signal.
    #[tokio::test]
    async fn a_waiting_stream_is_woken_by_the_commit_and_ends_with_its_socket() {
        use crate::archive::WriteFailure;
        use crate::{EventKind, RunEvent};
        use futures_util::StreamExt;
        use std::sync::Arc;
        use std::time::Instant;
        assert!(
            WOKEN_WITHIN * 10 <= FOLLOW_FALLBACK,
            "the fallback read is too soon for this test to tell a woken stream from a polling one"
        );
        let db = crate::db::Db::temp().await;
        let archive = EventArchive::new(db.clone());
        let make_event = |seq| RunEvent {
            id: format!("push:{seq}"),
            session_id: "push".into(),
            agent_id: "lead".into(),
            seq,
            ts: "2026-10-16T00:00:00Z".into(),
            kind: EventKind::Process,
            payload: json!({"phase":"spawned", "pid":seq}),
            raw: None,
        };
        archive.append(&make_event(0)).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(Some(archive.clone()));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (mut client, _) = tokio_tungstenite::connect_async(format!(
            "ws://{address}/api/session/stream?session=push"
        ))
        .await
        .unwrap();
        let mut next = async || {
            let message = tokio::time::timeout(Duration::from_secs(3), client.next())
                .await
                .expect("an event arrives")
                .unwrap()
                .unwrap();
            serde_json::from_str::<RunEvent>(message.to_text().unwrap()).unwrap()
        };
        assert_eq!(next().await, make_event(0));
        assert_eq!(db.events().followers(), 1);

        // Long enough for the stream to be waiting, not mid-read.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = Instant::now();
        archive.append(&make_event(1)).await.unwrap();
        assert_eq!(next().await, make_event(1));
        let waited = started.elapsed();
        assert!(
            waited < WOKEN_WITHIN,
            "a committed event took {waited:?} to reach the stream"
        );

        // Handed over without waiting: nobody flushes, the writer's window commits it.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let failure = Arc::new(WriteFailure::default());
        let started = Instant::now();
        archive.enqueue(make_event(2), &failure).await.unwrap();
        assert_eq!(next().await, make_event(2));
        let waited = started.elapsed();
        assert!(
            waited < crate::archive::BATCH_WINDOW + WOKEN_WITHIN,
            "a queued event took {waited:?} to reach the stream"
        );
        failure.check().unwrap();

        client.close(None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while db.events().followers() > 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("closing the socket ends the follow task");
        server.abort();
    }

    /// One event of each kind a lean page treats differently, every one with its raw frame.
    async fn traced_archive() -> (EventArchive, Vec<crate::RunEvent>) {
        use crate::{EventKind, RunEvent};
        let archive = EventArchive::new(crate::db::Db::temp().await);
        let output = "line of output\n".repeat(50);
        let update = |update: serde_json::Value| {
            json!({"jsonrpc": "2.0", "method": "session/update",
                   "params": {"sessionId": "acp", "update": update}})
        };
        let events = [
            (
                EventKind::Message,
                json!({"role": "agent", "content": {"type": "text", "text": "hi"}}),
                update(json!({"sessionUpdate": "agent_message_chunk",
                              "content": {"type": "text", "text": "hi"},
                              "_meta": {"codex": {"phase": "final_answer"}}})),
            ),
            (
                EventKind::ToolCall,
                json!({"callId": "c1", "title": "Run", "status": "pending"}),
                update(json!({"sessionUpdate": "tool_call", "toolCallId": "c1",
                              "title": "Run", "status": "pending"})),
            ),
            (
                EventKind::ToolUpdate,
                json!({"callId": "c1", "status": "completed", "rawOutput": output}),
                update(
                    json!({"sessionUpdate": "tool_call_update", "toolCallId": "c1",
                              "status": "completed", "rawOutput": output}),
                ),
            ),
            (
                EventKind::SessionMeta,
                json!({"phase": "turn_resumed"}),
                json!({"source": "loomwatch", "response": {"result": {"stopReason": "cancelled"}}}),
            ),
            (
                EventKind::TurnEnd,
                json!({"stopReason": "end_turn"}),
                json!({"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn",
                       "_meta": {"quota": {"model_usage": []}}}}),
            ),
        ];
        let mut archived = Vec::new();
        for (seq, (kind, payload, raw)) in events.into_iter().enumerate() {
            let event = RunEvent {
                id: format!("lean:{seq}"),
                session_id: "lean".into(),
                agent_id: "lead".into(),
                seq: seq as u64,
                ts: "2026-10-16T00:00:00Z".into(),
                kind,
                payload,
                raw: Some(raw),
            };
            archive.append(&event).await.unwrap();
            archived.push(event);
        }
        (archive, archived)
    }

    /// What a lean page holds: every event, with the raw frame only where the browser reads it.
    fn leaned(events: &[crate::RunEvent]) -> Vec<crate::RunEvent> {
        use crate::EventKind;
        events
            .iter()
            .map(|event| crate::RunEvent {
                raw: matches!(
                    event.kind,
                    EventKind::Message | EventKind::SessionMeta | EventKind::TurnEnd
                )
                .then(|| event.raw.clone())
                .flatten(),
                ..event.clone()
            })
            .collect()
    }

    #[tokio::test]
    async fn a_lean_page_leaves_out_the_frames_the_browser_never_reads() {
        use http_body_util::BodyExt;
        let (archive, archived) = traced_archive().await;
        let page = async |query: &str| {
            let response = router(Some(archive.clone()))
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/session/events?session=lean{query}"))
                        .header("host", "localhost")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            serde_json::from_slice::<Vec<serde_json::Value>>(&body).unwrap()
        };
        let as_json = |events: &[crate::RunEvent]| -> Vec<serde_json::Value> {
            events
                .iter()
                .map(|event| serde_json::to_value(event).unwrap())
                .collect()
        };
        assert_eq!(page("").await, as_json(&archived), "unchanged by default");
        assert_eq!(page("&lean=false").await, as_json(&archived));
        let lean = page("&lean=true").await;
        assert_eq!(lean, as_json(&leaned(&archived)));
        // Left out as an event with no frame is: no `raw` key at all.
        assert!(lean[2].get("raw").is_none(), "{}", lean[2]);
        assert!(lean[1].get("raw").is_none(), "{}", lean[1]);
        assert_eq!(lean[0]["raw"], archived[0].raw.clone().unwrap());
    }

    #[tokio::test]
    async fn a_lean_stream_leaves_out_the_frames_the_browser_never_reads() {
        use futures_util::StreamExt;
        let (archive, archived) = traced_archive().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(Some(archive.clone()));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        for (query, expected) in [("&lean=true", leaned(&archived)), ("", archived.clone())] {
            let (mut client, _) = tokio_tungstenite::connect_async(format!(
                "ws://{address}/api/session/stream?session=lean{query}"
            ))
            .await
            .unwrap();
            let mut streamed = Vec::new();
            while streamed.len() < expected.len() {
                let message = tokio::time::timeout(Duration::from_secs(3), client.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                streamed.push(
                    serde_json::from_str::<crate::RunEvent>(message.to_text().unwrap()).unwrap(),
                );
            }
            assert_eq!(streamed, expected, "{query}");
            client.close(None).await.unwrap();
        }
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
