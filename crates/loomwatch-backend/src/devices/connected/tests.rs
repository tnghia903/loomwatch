//! A computer connected to another (ADR 0102): connecting through a real door, and the connector
//! in front of it, against a stand-in `LoomWatch` that records every call it gets.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

use super::super::reach::pair_link;
use super::super::{Devices, Kind, door_router};
use super::{Connection, KeyPlace, api_router, connect, connector, read_link, switch};

type Calls = Arc<Mutex<Vec<Value>>>;

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

async fn record(State(calls): State<Calls>, request: Request) -> Json<Value> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
    };
    calls.lock().unwrap().push(json!({
        "path": request.uri().to_string(),
        "authorization": header("authorization"),
        "origin": header("origin"),
        "via": header("x-loomwatch-via-device"),
    }));
    Json(json!({"teams": []}))
}

async fn echo(upgrade: WebSocketUpgrade) -> axum::response::Response {
    upgrade.on_upgrade(|mut socket| async move {
        while let Some(Ok(message)) = socket.recv().await {
            if let Message::Text(text) = message
                && socket
                    .send(Message::text(format!("echo {}", text.as_str())))
                    .await
                    .is_err()
            {
                break;
            }
        }
    })
}

/// The other computer: a stand-in `LoomWatch` behind a real door.
struct Other {
    door: String,
    devices: Arc<Devices>,
    calls: Calls,
}

async fn other() -> Other {
    let calls: Calls = Arc::default();
    let home = Router::new()
        .route("/api/teams", get(record))
        .route("/api/files/open", post(record))
        .route("/api/live", get(echo))
        .with_state(calls.clone());
    let home = serve(home).await;
    let devices = Devices::memory();
    let door = serve(door_router(
        devices.clone(),
        super::super::push::key::KeyPlace::memory(),
        &home,
    ))
    .await;
    Other {
        door,
        devices,
        calls,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

fn scratch(test: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("loomwatch-connected-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// This computer, connected to `other`: the connector's address, where it keeps its key, and its
/// switch.
async fn connected(
    other: &Other,
    test: &str,
) -> (String, KeyPlace, super::Switch, std::path::PathBuf) {
    let dir = scratch(test);
    let keys = KeyPlace::memory();
    let code = other.devices.make_code(Kind::Computer);
    let link = pair_link(&other.door, &code.code);
    let connection = connect(&client(), &link, "MacBook", &dir, &keys)
        .await
        .unwrap();
    let key = keys.read().await.unwrap().unwrap();
    let switch = switch();
    let app = connector(connection, key, dir.clone(), keys.clone(), switch.clone());
    (serve(app).await, keys, switch, dir)
}

#[tokio::test]
async fn connecting_trades_the_code_for_a_key_kept_out_of_its_file() {
    let other = other().await;
    let (_, keys, _, dir) = connected(&other, "connect").await;

    let listed = other.devices.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "MacBook");
    assert_eq!(listed[0].kind, Kind::Computer);

    let connection = Connection::read(&dir).unwrap();
    assert_eq!(connection.address, other.door);
    assert_eq!(connection.device_id, listed[0].id);
    let key = keys.read().await.unwrap().unwrap();
    let file = std::fs::read_to_string(dir.join(super::FILE)).unwrap();
    assert!(
        !file.contains(&key),
        "the key was written in connected.json"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_phones_code_is_refused_here_and_still_works_for_the_phone() {
    let other = other().await;
    let dir = scratch("phone-code");
    let keys = KeyPlace::memory();
    let code = other.devices.make_code(Kind::Phone);
    let link = pair_link(&other.door, &code.code);

    let refused = connect(&client(), &link, "MacBook", &dir, &keys)
        .await
        .unwrap_err();
    assert!(refused.contains("This code is for a phone"), "{refused}");
    assert!(Connection::read(&dir).is_none());
    assert!(keys.read().await.unwrap().is_none());
    assert!(other.devices.list().is_empty(), "a stray device was added");
    assert!(
        other
            .devices
            .claim(&code.code, None, Some(Kind::Phone))
            .is_ok(),
        "the phone's code stopped working"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_link_that_isnt_loomwatchs_is_refused_in_plain_words() {
    let link = read_link(
        " loomwatch://pair?address=https%3A%2F%2Fmac-mini.tail1234.ts.net%3A8443%2F&code=abc ",
    )
    .unwrap();
    assert_eq!(link.address, "https://mac-mini.tail1234.ts.net:8443");
    assert_eq!(link.code, "abc");
    assert!(read_link("loomwatch://pair?address=http%3A%2F%2F127.0.0.1%3A3440&code=abc").is_ok());

    for wrong in [
        "",
        "https://mac-mini.tail1234.ts.net:8443",
        "loomwatch://pair?address=https%3A%2F%2Fmac-mini.tail1234.ts.net",
        "loomwatch://pair?code=abc",
        "loomwatch://other?address=https%3A%2F%2Fa.b&code=abc",
        // Never plain HTTP across a network.
        "loomwatch://pair?address=http%3A%2F%2Fmac-mini.tail1234.ts.net&code=abc",
    ] {
        let said = read_link(wrong).unwrap_err();
        assert!(
            said.starts_with("That isn't a link from LoomWatch"),
            "{wrong}: {said}"
        );
    }
}

#[tokio::test]
async fn the_connector_passes_everything_on_with_this_computers_key() {
    let other = other().await;
    let (here, _, _, dir) = connected(&other, "onward").await;
    let origin = here.clone();

    let reply = client()
        .get(format!("{here}/api/teams"))
        .header("origin", &origin)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.json::<Value>().await.unwrap(), json!({"teams": []}));

    let calls = other.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["path"], "/api/teams");
    assert_eq!(
        calls[0]["authorization"],
        Value::Null,
        "the key went past the door"
    );
    assert_eq!(calls[0]["origin"], Value::Null);
    assert_eq!(
        calls[0]["via"], "1",
        "the other computer can't tell it came from a device"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_connector_refuses_other_sites_and_other_names() {
    let other = other().await;
    let (here, _, _, dir) = connected(&other, "refuses").await;

    let from_elsewhere = client()
        .get(format!("{here}/api/teams"))
        .header("origin", "https://elsewhere.example")
        .send()
        .await
        .unwrap();
    assert_eq!(from_elsewhere.status(), 403);
    let cross_site = client()
        .get(format!("{here}/api/teams"))
        .header("sec-fetch-site", "cross-site")
        .send()
        .await
        .unwrap();
    assert_eq!(cross_site.status(), 403);
    let renamed = client()
        .get(format!("{here}/api/teams"))
        .header("host", "elsewhere.example")
        .send()
        .await
        .unwrap();
    assert_eq!(renamed.status(), 403);
    assert!(
        other.calls.lock().unwrap().is_empty(),
        "another site reached the other computer"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_file_opens_on_the_computer_it_is_on_not_this_one() {
    let other = other().await;
    let (here, _, _, dir) = connected(&other, "open").await;
    let reply = client()
        .post(format!("{here}/api/files/open"))
        .header("x-loomwatch-request", "1")
        .json(&json!({"path": "/Users/me/LoomWatch/teams/a.md"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 409);
    let said: Value = reply.json().await.unwrap();
    assert!(
        said["error"]
            .as_str()
            .unwrap()
            .starts_with("This file is on 127.")
    );
    assert!(
        other.calls.lock().unwrap().is_empty(),
        "the file opened on the other screen"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_page_says_so_when_the_other_computer_cant_be_reached_or_removed_this_one() {
    let other = other().await;
    let (here, _, _, dir) = connected(&other, "away").await;

    // Removed there: the page says so.
    let device = other.devices.list().remove(0);
    other.devices.remove(&device.id);
    let page = client()
        .get(format!("{here}/"))
        .header("accept", "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 503);
    assert!(page.text().await.unwrap().contains("removed this computer"));

    // Unreachable: the page says so, and the app's data calls are told in words.
    let gone = Connection {
        address: "http://127.0.0.1:1".into(),
        device_id: "d".into(),
        name: "MacBook".into(),
        connected_at: chrono::Utc::now(),
    };
    let away = serve(connector(
        gone,
        "k".into(),
        dir.clone(),
        KeyPlace::memory(),
        switch(),
    ))
    .await;
    let page = client()
        .get(format!("{away}/"))
        .header("sec-fetch-mode", "navigate")
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 503);
    let page = page.text().await.unwrap();
    assert!(page.contains("Can’t reach LoomWatch on 127"), "{page}");
    assert!(page.contains("Use LoomWatch on this computer"));
    let data = client()
        .get(format!("{away}/api/teams"))
        .send()
        .await
        .unwrap();
    assert_eq!(data.status(), 503);
    assert_eq!(data.headers()["x-loomwatch-state"], "unreachable");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn stopping_forgets_the_connection_and_switches() {
    let other = other().await;
    let (here, keys, switch, dir) = connected(&other, "stop").await;
    let stop = || client().post(format!("{here}/connector/v0/stop"));

    assert_eq!(
        stop().send().await.unwrap().status(),
        403,
        "stopped without the page's header"
    );
    assert!(Connection::read(&dir).is_some());

    let stopped = stop()
        .header("x-loomwatch-request", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(stopped.status(), 204);
    assert!(Connection::read(&dir).is_none());
    assert!(keys.read().await.unwrap().is_none());
    assert!(
        *switch.borrow(),
        "the app wasn't told to start LoomWatch again"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_live_connection_goes_through_both_ends() {
    let other = other().await;
    let (here, _, _, dir) = connected(&other, "live").await;
    let live = format!("ws://{}/api/live", here.trim_start_matches("http://"))
        .into_client_request()
        .unwrap();
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(live),
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
    let _ = std::fs::remove_dir_all(&dir);
}

/// Asks this computer's own `LoomWatch` to connect to `other` with a fresh computer's code, as its
/// page does, or as a device connected to it would (`via_device`).
async fn connect_here(
    other: &Other,
    test: &str,
    via_device: bool,
) -> (
    reqwest::Response,
    KeyPlace,
    super::Switch,
    std::path::PathBuf,
) {
    let dir = scratch(test);
    let keys = KeyPlace::memory();
    let switch = switch();
    let here = serve(api_router(dir.clone(), keys.clone(), switch.clone())).await;
    let code = other.devices.make_code(Kind::Computer);
    let mut asked = client()
        .post(format!("{here}/api/connection"))
        .header("x-loomwatch-request", "1")
        .json(&json!({"link": pair_link(&other.door, &code.code)}));
    if via_device {
        asked = asked.header("x-loomwatch-via-device", "1");
    }
    (asked.send().await.unwrap(), keys, switch, dir)
}

#[tokio::test]
async fn connecting_from_this_computers_own_page_connects_and_switches() {
    let other = other().await;
    let (reply, keys, switch, dir) = connect_here(&other, "here", false).await;
    assert_eq!(reply.status(), 200);
    assert!(Connection::read(&dir).is_some());
    assert!(keys.read().await.unwrap().is_some());
    assert!(
        *switch.borrow(),
        "LoomWatch didn't stop to start again connected"
    );
    assert_eq!(other.devices.list().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_device_connected_here_cant_hand_this_computer_to_another() {
    let other = other().await;
    let (reply, keys, switch, dir) = connect_here(&other, "handed", true).await;
    assert_eq!(reply.status(), 403);
    let said: Value = reply.json().await.unwrap();
    assert_eq!(
        said["error"],
        "Connect this computer to another one from its own screen."
    );
    assert!(Connection::read(&dir).is_none());
    assert!(keys.read().await.unwrap().is_none());
    assert!(!*switch.borrow());
    assert!(
        other.devices.list().is_empty(),
        "it connected before refusing"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
