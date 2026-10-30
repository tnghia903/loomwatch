//! Pairing, the two kinds of device, Remove, and managing devices from this computer only
//! (ADR 0102), against a stand-in `LoomWatch` that records every call it gets.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{TimeDelta, Utc};
use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

use super::{Devices, Kind, Refused, WRONG_CODES, door_address, door_router};

const KEY: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

type Calls = Arc<Mutex<Vec<Value>>>;

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

/// A stand-in `LoomWatch`: records each call to `/api/team`, and echoes on a live connection.
async fn stand_in() -> (String, Calls) {
    let calls: Calls = Arc::default();
    let app = Router::new()
        .route("/api/team", put(record).get(record))
        .route("/api/live", get(echo))
        .with_state(calls.clone());
    (serve(app).await, calls)
}

async fn record(State(calls): State<Calls>, request: Request) -> Json<Value> {
    let (parts, body) = request.into_parts();
    let header = |name: &str| {
        parts
            .headers
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
    };
    let body = axum::body::to_bytes(body, 1 << 20).await.unwrap();
    calls.lock().unwrap().push(json!({
        "method": parts.method.as_str(),
        "path": parts.uri.to_string(),
        "host": header("host"),
        "authorization": header("authorization"),
        "origin": header("origin"),
        "cookie": header("cookie"),
        "sec-fetch-site": header("sec-fetch-site"),
        "x-loomwatch-request": header("x-loomwatch-request"),
        "if-match": header("if-match"),
        "body": String::from_utf8_lossy(&body),
    }));
    Json(json!({"saved": true}))
}

async fn echo(upgrade: WebSocketUpgrade) -> axum::response::Response {
    upgrade.on_upgrade(|mut socket| async move {
        while let Some(Ok(message)) = socket.recv().await {
            if let Message::Text(text) = message {
                let answer = Message::text(format!("echo {}", text.as_str()));
                if socket.send(answer).await.is_err() {
                    break;
                }
            }
        }
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

async fn claim(door: &str, code: &str) -> reqwest::Response {
    client()
        .post(format!("{door}/devices/v0/claim"))
        .json(&json!({"code": code, "name": "Nghia's iPhone"}))
        .send()
        .await
        .unwrap()
}

fn scratch(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("loomwatch-devices-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_code_pairs_one_device_once_and_only_its_keys_hash_is_kept() {
    let dir = scratch("once");
    let devices = Devices::open(&dir);
    let code = devices.make_code(Kind::Phone);
    let lifetime = code.expires_at - Utc::now();
    assert!(
        lifetime > TimeDelta::minutes(9) && lifetime <= TimeDelta::minutes(10),
        "a code works for ten minutes: {lifetime}"
    );

    let (device, key) = devices
        .claim(&code.code, Some("  Nghia's\n iPhone "), None)
        .unwrap();
    assert_eq!(device.kind, Kind::Phone);
    assert_eq!(device.name, "Nghia's iPhone");
    assert!(key.len() >= 40, "a 256-bit key: {key}");
    assert_eq!(
        devices.check(&key).map(|seen| seen.id),
        Some(device.id.clone())
    );
    assert_eq!(
        devices.claim(&code.code, None, None),
        Err(Refused::NoSuchCode),
        "a code works once"
    );

    let file = std::fs::read_to_string(dir.join("devices.json")).unwrap();
    assert!(!file.contains(&key), "the key itself was written down");
    assert!(file.contains(&super::hex(&super::sha256(&key))));

    // Opened again, as after a restart: still connected, and no one else is.
    let again = Devices::open(&dir);
    assert_eq!(again.check(&key).map(|seen| seen.id), Some(device.id));
    assert_eq!(again.check(KEY), None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wrong_codes_in_a_row_end_the_open_one() {
    let devices = Devices::memory();
    let code = devices.make_code(Kind::Computer);
    for _ in 0..WRONG_CODES {
        assert_eq!(
            devices.claim("a guess", None, None),
            Err(Refused::NoSuchCode)
        );
    }
    assert_eq!(
        devices.claim(&code.code, None, None),
        Err(Refused::NoSuchCode),
        "the right code still worked after {WRONG_CODES} wrong ones"
    );
    assert!(devices.list().is_empty());

    // A code made after that works.
    let code = devices.make_code(Kind::Computer);
    assert!(devices.claim(&code.code, None, None).is_ok());
}

#[test]
fn an_old_code_or_the_one_before_doesnt_pair() {
    let devices = Devices::memory();
    let old = devices.make_code(Kind::Phone);
    devices.state().open.as_mut().unwrap().until = Utc::now() - TimeDelta::seconds(1);
    assert_eq!(
        devices.claim(&old.code, None, None),
        Err(Refused::NoSuchCode)
    );

    let first = devices.make_code(Kind::Phone);
    let second = devices.make_code(Kind::Phone);
    assert_eq!(
        devices.claim(&first.code, None, None),
        Err(Refused::NoSuchCode),
        "a new code ends the one before"
    );
    assert!(devices.claim(&second.code, None, None).is_ok());
}

#[tokio::test]
async fn a_phone_trades_its_code_for_a_key_at_the_door_and_keeps_to_its_list() {
    let (daemon, calls) = stand_in().await;
    let devices = Devices::memory();
    let door = serve(door_router(devices.clone(), &daemon)).await;
    let code = devices.make_code(Kind::Phone);

    let reply = claim(&door, &code.code).await;
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.headers()["cache-control"], "no-store");
    let paired: Value = reply.json().await.unwrap();
    let key = paired["key"].as_str().unwrap().to_owned();
    assert_eq!(paired["device"]["kind"], "phone");
    assert_eq!(paired["device"]["name"], "Nghia's iPhone");
    assert!(paired["device"].get("keySha256").is_none());

    // A phone may not edit a team: it isn't on the phone's list.
    let edit = client()
        .put(format!("{door}/api/team"))
        .bearer_auth(&key)
        .json(&json!({"yaml": "name: A"}))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), 404);
    assert!(calls.lock().unwrap().is_empty(), "a phone edited a team");

    assert_eq!(claim(&door, &code.code).await.status(), 404, "used once");
}

#[tokio::test]
async fn a_computer_reaches_everything_as_a_local_program() {
    let (daemon, calls) = stand_in().await;
    let devices = Devices::memory();
    let code = devices.make_code(Kind::Computer);
    let (_, key) = devices.claim(&code.code, Some("MacBook"), None).unwrap();
    let door = serve(door_router(devices, &daemon)).await;

    let reply = client()
        .put(format!("{door}/api/team?path=a.yaml"))
        .bearer_auth(&key)
        .header("origin", "http://127.0.0.1:3000")
        .header("sec-fetch-site", "same-origin")
        .header("cookie", "session=1")
        .header("x-loomwatch-request", "1")
        .header("if-match", "\"r1\"")
        .json(&json!({"yaml": "name: A"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.json::<Value>().await.unwrap()["saved"], true);

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call["method"], "PUT");
    assert_eq!(call["path"], "/api/team?path=a.yaml");
    assert_eq!(call["host"], daemon.trim_start_matches("http://"));
    assert_eq!(
        call["authorization"],
        Value::Null,
        "the device's key went on"
    );
    assert_eq!(call["origin"], Value::Null);
    assert_eq!(call["sec-fetch-site"], Value::Null);
    assert_eq!(call["cookie"], Value::Null);
    assert_eq!(call["x-loomwatch-request"], "1");
    assert_eq!(call["if-match"], "\"r1\"");
    assert!(call["body"].as_str().unwrap().contains("name: A"));
}

#[tokio::test]
async fn a_computers_live_connection_passes_both_ways_and_needs_its_key() {
    let (daemon, _calls) = stand_in().await;
    let devices = Devices::memory();
    devices.connect_for_test(Kind::Computer, KEY);
    let door = serve(door_router(devices, &daemon)).await;
    let live = format!("ws://{}/api/live", door.trim_start_matches("http://"));

    let mut request = live.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {KEY}").parse().unwrap());
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .unwrap()
    .unwrap();
    socket
        .send(tungstenite::Message::text("hello"))
        .await
        .unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(answer.into_text().unwrap().as_str(), "echo hello");

    let refused = tokio_tungstenite::connect_async(live.into_client_request().unwrap()).await;
    assert!(
        matches!(&refused, Err(tungstenite::Error::Http(answer)) if answer.status() == 401),
        "a live connection without a key: {refused:?}"
    );
}

#[tokio::test]
async fn a_removed_device_is_turned_away_at_once() {
    let (daemon, calls) = stand_in().await;
    let devices = Devices::memory();
    let device = devices.connect_for_test(Kind::Computer, KEY);
    let door = serve(door_router(devices.clone(), &daemon)).await;
    let read = || {
        client()
            .get(format!("{door}/api/team?path=a.yaml"))
            .bearer_auth(KEY)
            .send()
    };

    assert_eq!(read().await.unwrap().status(), 200);
    assert!(devices.remove(&device.id));
    assert_eq!(read().await.unwrap().status(), 401);
    assert_eq!(
        calls.lock().unwrap().len(),
        1,
        "a removed device got through"
    );
    assert!(!devices.remove(&device.id));
}

#[test]
fn the_door_is_only_on_this_computers_own_address() {
    let door: SocketAddr = "127.0.0.1:3440".parse().unwrap();
    assert_eq!(door_address(None), Ok(Some(door)));
    assert_eq!(door_address(Some("")), Ok(Some(door)));
    assert_eq!(door_address(Some(" OFF ")), Ok(None));
    assert_eq!(
        door_address(Some("127.0.0.1:4555")),
        Ok(Some("127.0.0.1:4555".parse().unwrap()))
    );
    assert!(door_address(Some("0.0.0.0:3440")).is_err());
    assert!(door_address(Some("192.168.1.5:3440")).is_err());
    assert!(door_address(Some("my-mac:3440")).is_err());
}

#[tokio::test]
async fn devices_are_managed_only_from_this_computers_own_page() {
    let devices = Devices::memory();
    let manage = serve(super::api::router_with(
        devices.clone(),
        super::api::Door::Open("127.0.0.1:3440".parse().unwrap()),
        Some(PathBuf::from("/no/such/tailscale")),
    ))
    .await;
    let make = |kind: &'static str| {
        client()
            .post(format!("{manage}/api/devices/codes"))
            .json(&json!({"kind": kind}))
    };

    let from_elsewhere = make("computer")
        .header("x-loomwatch-request", "1")
        .header("origin", "https://elsewhere.example")
        .send()
        .await
        .unwrap();
    assert_eq!(
        from_elsewhere.status(),
        403,
        "another site's page made a code"
    );
    let without_the_header = make("computer").send().await.unwrap();
    assert_eq!(without_the_header.status(), 403);
    let renamed = client()
        .get(format!("{manage}/api/devices"))
        .header("host", "elsewhere.example")
        .send()
        .await
        .unwrap();
    assert_eq!(renamed.status(), 403, "a name that only resolves here");
    assert!(devices.state().open.is_none(), "a code was made");

    let code_made: Value = make("phone")
        .header("x-loomwatch-request", "1")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(code_made["kind"], "phone");
    assert_eq!(
        code_made["link"],
        Value::Null,
        "no link while the door isn't shared"
    );
    assert_eq!(code_made["reach"]["state"], "tailscaleOff");
    let (device, _key) = devices
        .claim(code_made["code"].as_str().unwrap(), None, None)
        .unwrap();

    let listed: Value = client()
        .get(format!("{manage}/api/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["door"], "127.0.0.1:3440");
    assert_eq!(listed["devices"][0]["id"], device.id);
    assert_eq!(listed["devices"][0]["name"], "iPhone");
    assert!(listed["devices"][0].get("keySha256").is_none());

    // Every change asks for the page's header, not only making a code.
    let bare_remove = client()
        .delete(format!("{manage}/api/devices/{}", device.id))
        .send()
        .await
        .unwrap();
    assert_eq!(bare_remove.status(), 403);
    assert_eq!(devices.list().len(), 1, "removed without the page's header");
    let bare_share = client()
        .post(format!("{manage}/api/devices/reach"))
        .send()
        .await
        .unwrap();
    assert_eq!(bare_share.status(), 403, "shared without the page's header");

    let remove = || {
        client()
            .delete(format!("{manage}/api/devices/{}", device.id))
            .header("x-loomwatch-request", "1")
            .send()
    };
    assert_eq!(remove().await.unwrap().status(), 204);
    assert_eq!(remove().await.unwrap().status(), 404);
    assert!(devices.list().is_empty());
}

#[tokio::test]
async fn with_the_door_closed_no_code_is_made_and_the_list_says_why() {
    for (door, off) in [
        (super::api::Door::Unavailable, false),
        (super::api::Door::TurnedOff, true),
    ] {
        let devices = Devices::memory();
        let manage = serve(super::api::router_with(
            devices.clone(),
            door,
            Some(PathBuf::from("/no/such/tailscale")),
        ))
        .await;
        let reply = client()
            .post(format!("{manage}/api/devices/codes"))
            .header("x-loomwatch-request", "1")
            .json(&json!({"kind": "phone"}))
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 409);
        assert!(devices.state().open.is_none());
        let listed: Value = client()
            .get(format!("{manage}/api/devices"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed["door"], Value::Null);
        assert_eq!(listed["doorOff"], off, "{door:?}");
    }
}
