//! The door between other devices and a stand-in `LoomWatch` that records every call it gets
//! (ADR 0102): what a phone may do.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use super::{Devices, Kind, door_router};
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::{Value, json};

const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type Calls = Arc<Mutex<Vec<Value>>>;

/// A stand-in daemon: answers what the phone's routes read, and records the method, path, the
/// headers that matter and the body of each call.
async fn stand_in() -> (String, Calls) {
    let calls: Calls = Arc::default();
    let app = Router::new()
        .route(
            "/api/about",
            get(|| async {
                Json(json!({"version": "0.15.6", "startedAt": "2026-10-28T09:00:00Z"}))
            }),
        )
        .route(
            "/api/runs",
            get(|State(calls): State<Calls>, request: Request| async move {
                record(&calls, request).await;
                Json(json!([{
                    "runId": "r1", "teamName": "Research", "status": "running",
                    "permissionRequests": [{"id": "p1", "agent": "writer", "title": "Run ls",
                                            "since": "2026-10-28T10:00:00Z"}],
                    "spendStops": [], "waitingOn": null
                }]))
            }),
        )
        .route("/api/team-requests", get(|| async { Json(json!([])) }))
        .route(
            "/api/runs/{id}/permissions",
            post(|State(calls): State<Calls>, request: Request| async move {
                record(&calls, request).await;
                Json(json!({"runId": "r1"}))
            }),
        )
        .route(
            "/api/team",
            put(|State(calls): State<Calls>, request: Request| async move {
                record(&calls, request).await;
                Json(json!({}))
            })
            .get(|request: Request| async move {
                let query = request.uri().query().unwrap_or_default().to_owned();
                let yaml = if query == "path=trips%2FTokyo+trip.yaml" {
                    "name: Tokyo trip\nentrypoint: researcher\nagents:\n  - {id: writer, name: Writer, from: {agent: editor, version: 2}}\n  - {id: check, kind: operator}\n  - {id: researcher, name: Researcher}\nedges:\n  - {from: researcher, to: writer}\n  - {from: writer, to: check}\n"
                } else {
                    "name: Unexpected\nagents: []\n"
                };
                Json(json!({"path": query, "yaml": yaml}))
            }),
        )
        .route(
            "/api/teams",
            get(|| async {
                Json(json!({"root": "/Users/me/LoomWatch/teams", "teams": [
                    {"path": "trips/Tokyo trip.yaml", "name": "Tokyo trip"}
                ]}))
            }),
        )
        .route(
            "/api/jobs",
            get(|| async {
                Json(json!({"jobs": [{"id": "editor", "figure": {"kind": "bobbin", "color": "rose"}}]}))
            }),
        )
        .with_state(calls.clone());
    (serve(app).await, calls)
}

async fn record(calls: &Calls, request: Request) {
    let (parts, body) = request.into_parts();
    let header = |headers: &HeaderMap, name: &str| {
        headers
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
    };
    let body = axum::body::to_bytes(body, 1 << 20).await.unwrap();
    calls.lock().unwrap().push(json!({
        "method": parts.method.as_str(),
        "path": parts.uri.to_string(),
        "x-loomwatch-request": header(&parts.headers, "x-loomwatch-request"),
        "authorization": header(&parts.headers, "authorization"),
        "origin": header(&parts.headers, "origin"),
        "if-match": header(&parts.headers, "if-match"),
        "if-none-match": header(&parts.headers, "if-none-match"),
        "body": String::from_utf8_lossy(&body),
    }));
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

/// A door in front of `daemon`, with one phone connected whose key is [`KEY`].
async fn phone_door(daemon: &str) -> String {
    door_with(daemon, Kind::Phone).await
}

/// A door in front of `daemon`, with one device of `kind` connected whose key is [`KEY`].
async fn door_with(daemon: &str, kind: Kind) -> String {
    let devices = Devices::memory();
    devices.connect_for_test(kind, KEY);
    serve(door_router(
        devices,
        super::push::key::KeyPlace::memory(),
        daemon,
    ))
    .await
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn a_phone_without_the_key_gets_nothing() {
    let (daemon, calls) = stand_in().await;
    let helper = phone_door(&daemon).await;

    let none = client()
        .get(format!("{helper}/phone/v0/home"))
        .send()
        .await
        .unwrap();
    assert_eq!(none.status(), 401);
    let wrong = client()
        .get(format!("{helper}/api/runs"))
        .bearer_auth(KEY.replace('0', "1"))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);

    assert!(
        calls.lock().unwrap().is_empty(),
        "the daemon was reached without the key"
    );
}

#[tokio::test]
async fn an_allowed_call_reaches_the_daemon_as_a_local_program() {
    let (daemon, calls) = stand_in().await;
    let helper = phone_door(&daemon).await;

    let reply = client()
        .post(format!("{helper}/api/runs/r1/permissions"))
        .bearer_auth(KEY)
        .header("origin", "https://elsewhere.example")
        .json(&json!({"requestId": "p1", "decision": "allow_once"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.json::<Value>().await.unwrap()["runId"], "r1");

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call["method"], "POST");
    assert_eq!(call["path"], "/api/runs/r1/permissions");
    assert_eq!(call["x-loomwatch-request"], "1");
    assert_eq!(
        call["authorization"],
        Value::Null,
        "the phone's key went on to the daemon"
    );
    assert_eq!(
        call["origin"],
        Value::Null,
        "the phone's origin went on to the daemon"
    );
    let body: Value = serde_json::from_str(call["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["decision"], "allow_once");
}

#[tokio::test]
async fn a_call_off_the_list_never_reaches_the_daemon() {
    let (daemon, calls) = stand_in().await;
    let helper = phone_door(&daemon).await;

    let reply = client()
        .put(format!("{helper}/api/team"))
        .bearer_auth(KEY)
        .json(&json!({"path": "research.yaml"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 404);
    assert!(
        calls.lock().unwrap().is_empty(),
        "a team edit reached the daemon"
    );
}

#[tokio::test]
async fn home_shows_what_needs_you_and_comes_compressed() {
    let (daemon, calls) = stand_in().await;
    let helper = phone_door(&daemon).await;

    let gzipped = client()
        .get(format!("{helper}/phone/v0/home"))
        .bearer_auth(KEY)
        .header("accept-encoding", "gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(gzipped.status(), 200);
    assert_eq!(gzipped.headers()["content-encoding"], "gzip");

    let home: Value = client()
        .get(format!("{helper}/phone/v0/home"))
        .bearer_auth(KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(home["needsYou"][0]["kind"], "permission");
    assert_eq!(home["needsYou"][0]["request"]["id"], "p1");
    assert_eq!(home["needsYou"][0]["run"]["teamName"], "Research");
    assert_eq!(home["working"][0]["runId"], "r1");
    assert_eq!(
        calls.lock().unwrap()[0]["path"],
        "/api/runs?finishedWithin=86400&preview=true"
    );
}

#[tokio::test]
async fn says_so_when_loomwatch_is_not_running() {
    // Nothing listens on port 1.
    let helper = phone_door("http://127.0.0.1:1").await;

    let reply = client()
        .get(format!("{helper}/phone/v0/home"))
        .bearer_auth(KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 503);
    assert_eq!(reply.headers()["x-loomwatch-state"], "not_running");

    let hello: Value = client()
        .get(format!("{helper}/phone/v0/hello"))
        .bearer_auth(KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hello["loomwatch"]["running"], false);
}

#[tokio::test]
async fn the_studio_has_each_team_with_its_agents_in_order_wearing_their_figures() {
    let (daemon, _calls) = stand_in().await;
    let helper = phone_door(&daemon).await;

    let studio: Value = client()
        .get(format!("{helper}/phone/v0/studio"))
        .bearer_auth(KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(studio["root"], "/Users/me/LoomWatch/teams");
    let floor = &studio["floors"][0];
    assert_eq!(floor["path"], "trips/Tokyo trip.yaml");
    assert_eq!(floor["name"], "Tokyo trip");
    let ids: Vec<&str> = floor["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|agent| agent["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["researcher", "writer", "check"]);
    // Placed from My agents: wears the saved agent's figure.
    assert_eq!(
        floor["agents"][1]["figure"],
        json!({"kind": "bobbin", "color": "rose"})
    );
    // A team's own agent wears the one its id picks, as on the Mac.
    assert_eq!(
        floor["agents"][0]["figure"],
        json!({"kind": "cone", "color": "sky"})
    );
    assert_eq!(floor["agents"][2]["operator"], true);
}

/// A stand-in daemon with one of My agents, `maya`, pinned (or none), and its chat file as given.
async fn pinned_stand_in(
    pinned: Option<&'static str>,
    chat: Option<&'static str>,
) -> (String, Calls) {
    let calls: Calls = Arc::default();
    let app = Router::new()
        .route(
            "/api/pinned-agent",
            get(move || async move { Json(json!({"agent": pinned, "notchShown": true})) }),
        )
        .route(
            "/api/jobs",
            get(|| async { Json(json!({"jobs": [{"id": "maya", "name": "Maya"}]})) }),
        )
        .route("/api/bench", post(|| async { Json(json!({"folder": ".jobs/.bench"})) }))
        .route(
            "/api/team",
            get(move || async move {
                match chat {
                    Some(yaml) => Ok(Json(json!({"path": ".jobs/.bench/maya.yaml", "yaml": yaml, "revision": "sha256:old"}))),
                    None => Err(axum::http::StatusCode::NOT_FOUND),
                }
            })
            .put(|State(calls): State<Calls>, request: Request| async move {
                record(&calls, request).await;
                Json(json!({"revision": "sha256:new"}))
            }),
        )
        .route(
            "/api/chat/messages",
            post(|State(calls): State<Calls>, request: Request| async move {
                record(&calls, request).await;
                Json(json!({"route": "agent"}))
            }),
        )
        .with_state(calls.clone());
    (serve(app).await, calls)
}

async fn send_pinned(helper: &str, body: Value) -> (u16, Value) {
    let reply = client()
        .post(format!("{helper}/phone/v0/pinned/messages"))
        .bearer_auth(KEY)
        .json(&body)
        .send()
        .await
        .unwrap();
    (
        reply.status().as_u16(),
        reply.json().await.unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn a_message_to_the_pinned_agent_writes_its_chat_as_a_link_once_then_sends() {
    // No chat yet: it is written new, as a link to the saved agent, then the message goes.
    let (daemon, calls) = pinned_stand_in(Some("maya"), None).await;
    let door = phone_door(&daemon).await;
    let (status, _) = send_pinned(&door, json!({"text": " Book it ", "startKey": "phone-1"})).await;
    assert_eq!(status, 200);
    let calls = calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0]["method"], "PUT");
    assert_eq!(calls[0]["if-none-match"], "*");
    let saved: Value = serde_json::from_str(calls[0]["body"].as_str().unwrap()).unwrap();
    assert_eq!(saved["path"], ".jobs/.bench/maya.yaml");
    assert_eq!(
        saved["yaml"],
        super::phone::pinned::chat_yaml("maya", "Maya")
    );
    let sent: Value = serde_json::from_str(calls[1]["body"].as_str().unwrap()).unwrap();
    assert_eq!(
        sent,
        json!({
            "teamPath": ".jobs/.bench/maya.yaml", "text": "Book it",
            "to": {"kind": "agent", "agent": "maya"},
            "expectedRevision": "sha256:new", "startKey": "phone-1",
        })
    );

    // Its chat already the link: nothing is written, the message goes against the file's revision.
    let same = Box::leak(super::phone::pinned::chat_yaml("maya", "Maya").into_boxed_str());
    let (daemon, calls) = pinned_stand_in(Some("maya"), Some(same)).await;
    let door = phone_door(&daemon).await;
    send_pinned(&door, json!({"text": "Again", "startKey": "phone-2"})).await;
    let calls = calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "{calls:?}");
    let sent: Value = serde_json::from_str(calls[0]["body"].as_str().unwrap()).unwrap();
    assert_eq!(sent["expectedRevision"], "sha256:old");

    // A reply carries its quote to the chat, as the Mac's Reply does.
    let quote = json!({"runId": "r1", "messageId": "answer:r1", "from": "maya", "to": null, "kind": "answer", "text": "Leaf opens at 9."});
    let (daemon, calls) = pinned_stand_in(Some("maya"), Some(same)).await;
    let door = phone_door(&daemon).await;
    send_pinned(
        &door,
        json!({"text": "Book it", "startKey": "phone-3", "replyTo": quote}),
    )
    .await;
    let calls = calls.lock().unwrap().clone();
    let sent: Value = serde_json::from_str(calls[0]["body"].as_str().unwrap()).unwrap();
    assert_eq!(sent["replyTo"], quote);

    // Written out in full by the Mac's Chat tab: replaced by the link, against its revision.
    let (daemon, calls) = pinned_stand_in(
        Some("maya"),
        Some("agents:\n  - {id: maya, role: Old words, model: x}\n"),
    )
    .await;
    let door = phone_door(&daemon).await;
    send_pinned(&door, json!({"text": "Third"})).await;
    let calls = calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0]["if-match"], "\"sha256:old\"");
}

#[tokio::test]
async fn with_nothing_pinned_or_nothing_said_no_message_goes() {
    let (daemon, calls) = pinned_stand_in(None, None).await;
    let helper = phone_door(&daemon).await;
    let (status, reply) = send_pinned(&helper, json!({"text": "Hi"})).await;
    assert_eq!(status, 409);
    assert_eq!(reply["error"], "No agent is pinned on your Mac.");

    let (status, _) = send_pinned(&helper, json!({"text": "   "})).await;
    assert_eq!(status, 400);
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_team_the_mac_refuses_is_said_to_be_gone_not_that_loomwatch_is_closed() {
    let app = Router::new().route(
        "/api/team",
        get(|| async {
            (
                axum::http::StatusCode::FORBIDDEN,
                Json(json!({"error": "outside the teams root"})),
            )
        }),
    );
    let daemon = serve(app).await;
    let door = phone_door(&daemon).await;
    let reply = client()
        .post(format!("{door}/phone/v0/team"))
        .bearer_auth(KEY)
        .json(&json!({"path": "/etc/hosts", "revision": "x", "name": "x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status().as_u16(), 404);
    let body: Value = reply.json().await.unwrap();
    assert_eq!(body["error"], "That team isn't on your Mac any more.");
}

/// What a stand-in chat kept of each file sent to it: the path and query, the content type and the
/// bytes.
type Kept = Arc<Mutex<Vec<(String, Option<String>, Vec<u8>)>>>;

/// A stand-in daemon whose chat keeps any file sent to it and counts any message, whatever its
/// size, so only the door can stop one.
async fn files_stand_in() -> (String, Kept, Calls) {
    let kept: Kept = Arc::default();
    let calls: Calls = Arc::default();
    let files = Router::new()
        .route(
            "/api/chat/files",
            put(|State(kept): State<Kept>, request: Request| async move {
                let (parts, body) = request.into_parts();
                let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
                let content_type = parts
                    .headers
                    .get("content-type")
                    .map(|value| value.to_str().unwrap().to_owned());
                kept.lock()
                    .unwrap()
                    .push((parts.uri.to_string(), content_type, bytes.to_vec()));
                Json(json!({"name": "part.png"}))
            }),
        )
        .with_state(kept.clone());
    let messages = Router::new()
        .route(
            "/api/chat/messages",
            post(|State(calls): State<Calls>, request: Request| async move {
                let bytes = axum::body::to_bytes(request.into_body(), usize::MAX)
                    .await
                    .unwrap();
                calls.lock().unwrap().push(json!({"bytes": bytes.len()}));
                Json(json!({"route": "agent"}))
            }),
        )
        .with_state(calls.clone());
    (serve(files.merge(messages)).await, kept, calls)
}

/// Sends `bytes` to a team's chat through the door as a file named `part.png`, and answers the
/// status.
async fn send_file(door: &str, content_type: Option<&str>, bytes: Vec<u8>) -> u16 {
    let mut request = client()
        .put(format!(
            "{door}/api/chat/files?teamPath=trips%2FTokyo+trip.yaml&name=part.png"
        ))
        .bearer_auth(KEY)
        .body(bytes);
    if let Some(content_type) = content_type {
        request = request.header("content-type", content_type);
    }
    request.send().await.unwrap().status().as_u16()
}

/// ADR 0082: a file the phone sends into a chat, such as the picture of a part circled in the
/// reader, goes through as its bytes, up to the size a chat keeps; nothing else does.
#[tokio::test]
async fn a_phone_sends_a_chat_file_as_its_bytes_up_to_the_size_a_chat_keeps() {
    let (daemon, kept, _) = files_stand_in().await;
    let door = phone_door(&daemon).await;
    let octets = Some("application/octet-stream");
    let most = crate::chosen_knowledge::MAX_FILE_BYTES;

    // The biggest file a chat keeps, far over what any other call may carry.
    let file: Vec<u8> = (0..=250u8).cycle().take(most).collect();
    assert_eq!(send_file(&door, octets, file.clone()).await, 200);
    {
        let kept = kept.lock().unwrap();
        assert_eq!(kept.len(), 1);
        let (path, content_type, bytes) = &kept[0];
        assert_eq!(
            path,
            "/api/chat/files?teamPath=trips%2FTokyo+trip.yaml&name=part.png"
        );
        assert_eq!(content_type.as_deref(), octets);
        assert!(*bytes == file, "the file changed on its way");
    }

    // Bytes only, as the chat takes them, refused at the door.
    assert_eq!(
        send_file(&door, Some("image/png"), b"png".to_vec()).await,
        415
    );
    assert_eq!(
        send_file(&door, Some("application/json"), b"{}".to_vec()).await,
        415
    );
    assert_eq!(send_file(&door, None, b"png".to_vec()).await, 415);
    // One byte more than a chat keeps.
    assert_eq!(send_file(&door, octets, vec![7; most + 1]).await, 413);
    // Sending a file is one call, not a way in to others.
    let other = client()
        .post(format!("{door}/api/chat/files?teamPath=trips.yaml&name=x"))
        .bearer_auth(KEY)
        .header("content-type", "application/octet-stream")
        .body(b"x".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), 404);

    assert_eq!(
        kept.lock().unwrap().len(),
        1,
        "a refused file reached the daemon"
    );
}

#[tokio::test]
async fn every_other_call_still_stops_at_a_megabyte() {
    let (daemon, _, calls) = files_stand_in().await;
    let door = phone_door(&daemon).await;
    // The door's own limit for words, answers and approvals.
    let limit = 1024 * 1024;
    let send = |content_type: &'static str, bytes: Vec<u8>| {
        client()
            .post(format!("{door}/api/chat/messages"))
            .bearer_auth(KEY)
            .header("content-type", content_type)
            .body(bytes)
            .send()
    };

    let at_most = send("application/json", vec![b' '; limit]).await.unwrap();
    assert_eq!(at_most.status(), 200);
    let over = send("application/json", vec![b' '; limit + 1])
        .await
        .unwrap();
    assert_eq!(over.status(), 413);
    // Sent as bytes, a message is still a message.
    let as_bytes = send("application/octet-stream", vec![b' '; limit + 1])
        .await
        .unwrap();
    assert_eq!(as_bytes.status(), 413);

    assert_eq!(
        *calls.lock().unwrap(),
        [json!({"bytes": limit})],
        "a call over the limit went on"
    );
}

/// ADR 0082: a message from the phone to an agent, pinned or in one of My agents' own chats,
/// carries the files sent with it to the chat.
#[tokio::test]
async fn a_message_to_an_agent_carries_its_files_to_the_chat() {
    let same = Box::leak(super::phone::pinned::chat_yaml("maya", "Maya").into_boxed_str());
    let part = "/Users/me/LoomWatch/teams/.jobs/.bench/maya.files/chat/Report part.png";
    for route in [
        "/phone/v0/pinned/messages",
        "/phone/v0/agents/maya/messages",
    ] {
        let (daemon, calls) = pinned_stand_in(Some("maya"), Some(same)).await;
        let door = phone_door(&daemon).await;
        let reply = client()
            .post(format!("{door}{route}"))
            .bearer_auth(KEY)
            .json(
                &json!({"text": "What is this?", "startKey": "phone-4", "files": [{"path": part}]}),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 200, "{route}");
        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "{route}: {calls:?}");
        let sent: Value = serde_json::from_str(calls[0]["body"].as_str().unwrap()).unwrap();
        assert_eq!(sent["teamPath"], ".jobs/.bench/maya.yaml", "{route}");
        assert_eq!(sent["text"], "What is this?", "{route}");
        assert_eq!(sent["files"], json!([{"path": part}]), "{route}");
    }
}

/// The real chat behind the door: a file the phone sends is kept in the agent's own chat, and a
/// message naming a file from anywhere else is refused, because every agent of a chat may read
/// what it names without asking (ADR 0082, decision 3).
#[tokio::test]
async fn the_chat_keeps_a_phones_file_with_the_agent_and_refuses_one_from_elsewhere() {
    let dir = crate::runs::tests::TeamsDir::new();
    let bench = dir.0.join(".jobs").join(".bench");
    std::fs::create_dir_all(&bench).unwrap();
    let team = |id: &str| {
        format!(
            "schemaVersion: 1\nid: {id}\nname: Maya\nentrypoint: maya\nagents:\n  - id: maya\n    name: Maya\n    role: plan trips\n    model: fake/offline\nedges: []\n"
        )
    };
    let chat = bench.join("maya.yaml");
    std::fs::write(&chat, team("bench-maya")).unwrap();
    let trip = dir.0.join("trip.yaml");
    std::fs::write(&trip, team("trip")).unwrap();
    let theirs =
        crate::chat_files::store(&trip, "theirs.png", &crate::test_support::png(4, 3, false))
            .unwrap();

    // What the phone's routes read around the chat. The chat file is said to be the link already,
    // so the team above is the one the chat opens.
    let link: &'static str =
        Box::leak(super::phone::pinned::chat_yaml("maya", "Maya").into_boxed_str());
    let around = Router::new()
        .route(
            "/api/pinned-agent",
            get(|| async { Json(json!({"agent": "maya"})) }),
        )
        .route(
            "/api/jobs",
            get(|| async { Json(json!({"jobs": [{"id": "maya", "name": "Maya"}]})) }),
        )
        .route(
            "/api/bench",
            post(|| async { Json(json!({"folder": ".jobs/.bench"})) }),
        )
        .route(
            "/api/team",
            get(move || async move { Json(json!({"yaml": link, "revision": "sha256:old"})) }),
        );
    let chat_routes = crate::chat::router(None, dir.0.clone(), crate::runs::RunRegistry::default());
    let daemon = serve(chat_routes.merge(around)).await;
    let door = phone_door(&daemon).await;

    let picture = crate::test_support::png(6, 4, false);
    let reply = client()
        .put(format!(
            "{door}/api/chat/files?teamPath=.jobs%2F.bench%2Fmaya.yaml&name=part.png"
        ))
        .bearer_auth(KEY)
        .header("content-type", "application/octet-stream")
        .body(picture.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    let kept: Value = reply.json().await.unwrap();
    let kept_at = bench.join("maya.files").join("chat").join("part.png");
    assert_eq!(kept["path"], kept_at.to_string_lossy().as_ref(), "{kept}");
    assert_eq!(kept["picture"], true);
    assert_eq!(std::fs::read(&kept_at).unwrap(), picture);
    // One the agent's chat takes.
    let sent = crate::chat_files::SentFile {
        path: kept_at.to_string_lossy().into_owned(),
    };
    assert!(crate::chat_files::check(&chat, &[sent]).is_ok());

    // Another team's chat file, and the chat's own team file beside its folder.
    for (route, elsewhere) in [
        ("/phone/v0/agents/maya/messages", theirs.path.clone()),
        (
            "/phone/v0/pinned/messages",
            chat.to_string_lossy().into_owned(),
        ),
    ] {
        let reply = client()
            .post(format!("{door}{route}"))
            .bearer_auth(KEY)
            .json(&json!({"text": "What is this?", "files": [{"path": elsewhere}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 400, "{route}");
        let refused: Value = reply.json().await.unwrap();
        let error = refused["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("isn't in this team's chat"),
            "{route}: {refused}"
        );
    }
}
