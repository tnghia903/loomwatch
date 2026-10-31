//! A computer connected to `LoomWatch` on another one (ADR 0102). It runs no agents of its own:
//! `loomwatchd connect` answers on this computer's own address as `LoomWatch` would, so the app,
//! its notch and the browser work as they always do, and passes everything on to the other
//! computer's door with this computer's own key ([`connector`]).
//!
//! Connecting starts in this computer's own `LoomWatch` (Your devices, Connect to another
//! computer, [`api_router`]): the link made on the other computer is traded there for a key, kept
//! in the Keychain (Credential Manager on Windows, the state folder elsewhere), and
//! [`FILE`] says where it goes. `LoomWatch` then stops with [`EXIT_TO_SWITCH`] and the app starts it
//! again, connected. Stopping goes the other way, and the app starts this computer's own again.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, Result};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::watch;

use super::Kind;
use super::door::VIA_DEVICE;
use super::pass::{no_store, pass_on, problem};

/// The exit status that has the app start `LoomWatch` again the other way: connected to another
/// computer, or this computer's own.
pub const EXIT_TO_SWITCH: i32 = 76;

/// In the state folder: where this computer is connected, while it is.
pub const FILE: &str = "connected.json";

/// The key, in the state folder, where it isn't kept in the system's own store.
const KEY_FILE: &str = "connection-key.json";

#[cfg(any(target_os = "macos", windows))]
const SERVICE: &str = "LoomWatch.Connection";
#[cfg(any(target_os = "macos", windows))]
const ACCOUNT: &str = "device-key";

/// Where this computer is connected. Never its key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// The other computer's door, such as `https://mac-mini.tail1234.ts.net:8443`.
    pub address: String,
    /// This computer, in the other one's list of devices.
    pub device_id: String,
    pub name: String,
    pub connected_at: DateTime<Utc>,
}

impl Connection {
    /// Where this computer is connected, from `<state_dir>/connected.json`.
    #[must_use]
    pub fn read(state_dir: &Path) -> Option<Self> {
        let bytes = std::fs::read(state_dir.join(FILE)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// The other computer's name, from its address: `mac-mini` for
    /// `https://mac-mini.tail1234.ts.net:8443`.
    #[must_use]
    pub fn host_name(&self) -> String {
        reqwest::Url::parse(&self.address)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .and_then(|host| host.split('.').next().map(str::to_owned))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "the other computer".to_owned())
    }

    fn write(&self, state_dir: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::approvals::write_private(&state_dir.join(FILE), &bytes)
    }
}

/// Where this computer keeps its key for the other one.
#[derive(Clone)]
pub struct KeyPlace(Place);

#[derive(Clone)]
enum Place {
    #[cfg(any(target_os = "macos", windows))]
    System,
    File(PathBuf),
    #[cfg(test)]
    Memory(Arc<std::sync::Mutex<Option<String>>>),
}

impl KeyPlace {
    /// The Keychain on a Mac and Credential Manager on Windows, as `LoomWatch.Connection`; the state
    /// folder elsewhere, or when `LOOMWATCH_KEY_STORE=file` keeps a trial's keys there.
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        #[cfg(any(target_os = "macos", windows))]
        if !crate::ai::keys_in_file() {
            return Self(Place::System);
        }
        Self(Place::File(state_dir.join(KEY_FILE)))
    }

    #[cfg(test)]
    pub(crate) fn memory() -> Self {
        Self(Place::Memory(Arc::default()))
    }

    /// # Errors
    ///
    /// When the store won't give it, or the file is damaged.
    pub async fn read(&self) -> Result<Option<String>> {
        let place = self.0.clone();
        tokio::task::spawn_blocking(move || match place {
            #[cfg(any(target_os = "macos", windows))]
            Place::System => match keyring::Entry::new(SERVICE, ACCOUNT)?.get_password() {
                Ok(key) => Ok(Some(key)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(error.into()),
            },
            Place::File(path) => match std::fs::read(&path) {
                Ok(bytes) => Ok(serde_json::from_slice::<KeyFile>(&bytes)
                    .context("connection-key.json is damaged")?
                    .key),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.into()),
            },
            #[cfg(test)]
            Place::Memory(slot) => Ok(slot
                .lock()
                .map_err(|_| anyhow::anyhow!("poisoned"))?
                .clone()),
        })
        .await
        .context("the key store stopped")?
    }

    async fn write(&self, key: Option<String>) -> Result<()> {
        let place = self.0.clone();
        tokio::task::spawn_blocking(move || match place {
            #[cfg(any(target_os = "macos", windows))]
            Place::System => {
                let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
                match key {
                    Some(key) => entry.set_password(&key).map_err(Into::into),
                    None => match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                        Err(error) => Err(error.into()),
                    },
                }
            }
            Place::File(path) => match key {
                Some(key) => crate::approvals::write_private(
                    &path,
                    &serde_json::to_vec(&KeyFile { key: Some(key) })?,
                )
                .map_err(Into::into),
                None => match std::fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error.into()),
                },
            },
            #[cfg(test)]
            Place::Memory(slot) => {
                *slot.lock().map_err(|_| anyhow::anyhow!("poisoned"))? = key;
                Ok(())
            }
        })
        .await
        .context("the key store stopped")?
    }
}

#[derive(Default, Serialize, Deserialize)]
struct KeyFile {
    #[serde(default)]
    key: Option<String>,
}

/// A pairing link, read.
#[derive(Debug, PartialEq, Eq)]
pub struct Link {
    pub address: String,
    pub code: String,
}

/// Reads a pairing link made on the other computer: `loomwatch://pair?address=…&code=…`.
///
/// # Errors
///
/// What is wrong with it, in words for the person.
pub fn read_link(text: &str) -> Result<Link, String> {
    let wrong = || {
        "That isn't a link from LoomWatch. On the computer that runs LoomWatch, choose Computer under Your devices and copy the link.".to_owned()
    };
    let url = reqwest::Url::parse(text.trim()).map_err(|_| wrong())?;
    if url.scheme() != "loomwatch" || url.host_str() != Some("pair") {
        return Err(wrong());
    }
    let value = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let (Some(address), Some(code)) = (value("address"), value("code")) else {
        return Err(wrong());
    };
    let to = reqwest::Url::parse(&address).map_err(|_| wrong())?;
    let loopback =
        to.scheme() == "http" && matches!(to.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if to.scheme() != "https" && !loopback {
        return Err(wrong());
    }
    Ok(Link {
        address: address.trim_end_matches('/').to_owned(),
        code,
    })
}

/// Connects this computer to the one the link was made on: trades its code there for this
/// computer's key, keeps the key, and writes down where.
///
/// # Errors
///
/// What went wrong, in words for the person.
pub async fn connect(
    client: &reqwest::Client,
    link: &str,
    name: &str,
    state_dir: &Path,
    keys: &KeyPlace,
) -> Result<Connection, String> {
    let link = read_link(link)?;
    let unreachable = || {
        "Couldn't reach the other computer. Check that it is on, and that both computers are signed in to Tailscale, then try again.".to_owned()
    };
    let reply = client
        .post(format!("{}/devices/v0/claim", link.address))
        .json(&json!({"code": link.code, "name": name, "kind": Kind::Computer}))
        .send()
        .await
        .map_err(|_| unreachable())?;
    let ok = reply.status().is_success();
    let body: serde_json::Value = reply.json().await.map_err(|_| unreachable())?;
    if !ok {
        return Err(body["error"]
            .as_str()
            .map_or_else(unreachable, str::to_owned));
    }
    let (Some(key), Some(device_id)) = (body["key"].as_str(), body["device"]["id"].as_str()) else {
        return Err(unreachable());
    };
    let connection = Connection {
        address: link.address,
        device_id: device_id.to_owned(),
        name: body["device"]["name"].as_str().unwrap_or(name).to_owned(),
        connected_at: Utc::now(),
    };
    keys.write(Some(key.to_owned())).await.map_err(|_| {
        "This computer wouldn't keep its key. Unlock the Keychain and try again.".to_owned()
    })?;
    if connection.write(state_dir).is_err() {
        let _ = keys.write(None).await;
        return Err("LoomWatch couldn't write in its folder on this computer.".to_owned());
    }
    Ok(connection)
}

/// Stops being connected: the key and where it went are forgotten here. The other computer still
/// lists this one until it is removed there.
///
/// # Errors
///
/// When the key or the file can't be removed.
pub async fn disconnect(state_dir: &Path, keys: &KeyPlace) -> Result<()> {
    match std::fs::remove_file(state_dir.join(FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    keys.write(None).await
}

struct Connecting {
    client: reqwest::Client,
    state_dir: PathBuf,
    keys: KeyPlace,
    switch: Switch,
}

#[derive(Deserialize)]
struct ConnectBody {
    link: String,
}

/// This computer's own `LoomWatch`: connecting it to another computer. Mount on a loopback
/// listener only. `switch` is told once connected, so `LoomWatch` stops for the app to start it
/// again, connected.
pub fn api_router(state_dir: PathBuf, keys: KeyPlace, switch: Switch) -> Router {
    Router::new()
        .route("/api/connection", post(connect_here))
        .layer(DefaultBodyLimit::max(4 * 1024))
        .route_layer(axum::middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(Arc::new(Connecting {
            client: client(),
            state_dir,
            keys,
            switch,
        }))
}

async fn connect_here(
    State(connecting): State<Arc<Connecting>>,
    headers: HeaderMap,
    Json(body): Json<ConnectBody>,
) -> Response {
    if headers
        .get("x-loomwatch-request")
        .is_none_or(|value| value != "1")
    {
        return problem(
            StatusCode::FORBIDDEN,
            "Open LoomWatch on this computer to connect it.",
        );
    }
    // A device connected here may not hand this computer to another: it would stop its agents.
    if headers.contains_key(VIA_DEVICE) {
        return problem(
            StatusCode::FORBIDDEN,
            "Connect this computer to another one from its own screen.",
        );
    }
    let name = crate::platform::computer_name().unwrap_or_else(|| "Computer".to_owned());
    match connect(
        &connecting.client,
        &body.link,
        &name,
        &connecting.state_dir,
        &connecting.keys,
    )
    .await
    {
        Ok(connection) => {
            connecting.switch.send_replace(true);
            Json(json!({"address": connection.address, "hostName": connection.host_name()}))
                .into_response()
        }
        Err(message) => problem(StatusCode::BAD_REQUEST, &message),
    }
}

struct Connector {
    client: reqwest::Client,
    connection: Connection,
    key: String,
    state_dir: PathBuf,
    keys: KeyPlace,
    switch: Switch,
}

/// `loomwatchd connect`: this computer's own address answering for `LoomWatch` on the computer it
/// is connected to. Mount on a loopback listener only.
pub fn connector(
    connection: Connection,
    key: String,
    state_dir: PathBuf,
    keys: KeyPlace,
    switch: Switch,
) -> Router {
    let connector = Arc::new(Connector {
        client: client(),
        connection,
        key,
        state_dir,
        keys,
        switch,
    });
    let own = Router::new()
        .route("/connector/v0/state", get(state))
        .route("/connector/v0/stop", post(stop))
        .with_state(connector.clone());
    own.fallback(onward)
        .with_state(connector)
        .layer(axum::middleware::from_fn(only_this_computer))
}

/// What a browser on this computer could be tricked into: another site's page, or a name that only
/// resolves here. The same checks `LoomWatch` makes on its own address, made here because the
/// other computer can't see them.
async fn only_this_computer(request: Request, next: axum::middleware::Next) -> Response {
    let local = request
        .headers()
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .and_then(|host| host.parse::<axum::http::uri::Authority>().ok())
        .is_some_and(|host| matches!(host.host(), "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if !local || !crate::watch_api::from_this_origin(request.headers()) {
        return problem(
            StatusCode::FORBIDDEN,
            "LoomWatch answers only its own page, not requests from other sites",
        );
    }
    next.run(request).await
}

/// Where this computer is connected, for the app's own page and the Mac app.
async fn state(State(connector): State<Arc<Connector>>) -> Response {
    let mut response = Json(json!({
        "address": connector.connection.address,
        "hostName": connector.connection.host_name(),
        "name": connector.connection.name,
    }))
    .into_response();
    no_store(response.headers_mut());
    response
}

/// Stops being connected, so the app starts this computer's own `LoomWatch` again.
async fn stop(State(connector): State<Arc<Connector>>, headers: HeaderMap) -> Response {
    if headers
        .get("x-loomwatch-request")
        .is_none_or(|value| value != "1")
    {
        return problem(
            StatusCode::FORBIDDEN,
            "Open LoomWatch on this computer to change where it runs.",
        );
    }
    if let Err(error) = disconnect(&connector.state_dir, &connector.keys).await {
        eprintln!("warning: couldn't stop being connected: {error:#}");
        return problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LoomWatch couldn't stop being connected. Try again.",
        );
    }
    connector.switch.send_replace(true);
    StatusCode::NO_CONTENT.into_response()
}

/// Everything else, passed on to the other computer with this computer's key.
async fn onward(State(connector): State<Arc<Connector>>, request: Request) -> Response {
    let host = connector.connection.host_name();
    // A file opens on the screen of the computer it is on, which isn't this one.
    if request.method() == Method::POST && request.uri().path() == "/api/files/open" {
        return problem(
            StatusCode::CONFLICT,
            &format!("This file is on {host}. Read it here in LoomWatch, or open it on {host}."),
        );
    }
    let page = wants_page(request.headers());
    let passed = pass_on(
        &connector.client,
        &connector.connection.address,
        request,
        Some(&connector.key),
    )
    .await;
    match passed {
        Some(response) if page && response.status() == StatusCode::UNAUTHORIZED => {
            away_page(&host, Away::Removed)
        }
        Some(response) => response,
        None if page => away_page(&host, Away::Unreachable),
        None => {
            let mut response = problem(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("Can't reach LoomWatch on {host}. It may be asleep, or not on Tailscale."),
            );
            response
                .headers_mut()
                .insert("x-loomwatch-state", HeaderValue::from_static("unreachable"));
            response
        }
    }
}

/// Whether the browser is opening a page, rather than the page asking for data.
fn wants_page(headers: &HeaderMap) -> bool {
    headers
        .get("sec-fetch-mode")
        .is_some_and(|mode| mode == "navigate")
        || headers
            .get(header::ACCEPT)
            .and_then(|accept| accept.to_str().ok())
            .is_some_and(|accept| accept.contains("text/html"))
}

#[derive(Clone, Copy)]
enum Away {
    Unreachable,
    Removed,
}

/// What this computer shows when the other one doesn't let it in: one sentence, Try again, and
/// the way back to running `LoomWatch` here.
fn away_page(host: &str, away: Away) -> Response {
    let host = html_escape(host);
    let said = match away {
        Away::Unreachable => format!(
            "<h1>Can’t reach LoomWatch on {host}</h1><p>It may be asleep, or not on Tailscale. Your agents there keep working.</p>"
        ),
        Away::Removed => format!(
            "<h1>{host} removed this computer</h1><p>Connect it again from Your devices on {host}, or use LoomWatch here.</p>"
        ),
    };
    let page = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LoomWatch</title>
<style>:root{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}}main{{max-width:28rem;padding:2rem}}h1{{font-size:20px;margin:0 0 .5rem}}p{{margin:0 0 1.25rem;opacity:.75}}button{{font:inherit;padding:.4rem .9rem;margin-right:.5rem;border-radius:8px;border:1px solid GrayText;background:none;color:inherit;cursor:pointer}}</style></head>
<body><main>{said}<button type="button" onclick="location.reload()">Try again</button><button type="button" id="here">Use LoomWatch on this computer</button></main>
<script>document.getElementById('here').onclick=function(){{this.disabled=true;fetch('/connector/v0/stop',{{method:'POST',headers:{{'x-loomwatch-request':'1'}}}}).then(function(){{setTimeout(function(){{location.reload()}},4000)}})}}</script></body></html>"#
    );
    let mut response = (StatusCode::SERVICE_UNAVAILABLE, Html(page)).into_response();
    no_store(response.headers_mut());
    response
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("a client with no proxy and default TLS settings builds")
}

/// Runs `loomwatchd connect` on `listen` until told to switch, then returns.
///
/// # Errors
///
/// When this computer isn't connected, its key is gone, or `listen` can't be used.
pub async fn serve_connected(listen: SocketAddr, state_dir: &Path) -> Result<()> {
    anyhow::ensure!(
        listen.ip().is_loopback(),
        "loomwatchd connect answers only on this computer's own address"
    );
    let connection = Connection::read(state_dir)
        .context("this computer isn't connected to LoomWatch on another computer")?;
    let keys = KeyPlace::open(state_dir);
    let key = keys
        .read()
        .await?
        .context("this computer's key for the other one is gone; connect it again")?;
    let switch = switch();
    let app = connector(
        connection.clone(),
        key,
        state_dir.to_path_buf(),
        keys,
        switch.clone(),
    );
    let listener = tokio::net::TcpListener::bind(listen).await?;
    println!(
        "loomwatchd listening on http://{} for LoomWatch on {}",
        listener.local_addr()?,
        connection.address
    );
    let serving = axum::serve(listener, app)
        .with_graceful_shutdown(switched(&switch))
        .into_future();
    // The page's live connections never end by themselves: give them a moment, then go.
    tokio::select! {
        outcome = serving => outcome?,
        () = async {
            switched(&switch).await;
            tokio::time::sleep(SWITCH_GRACE).await;
        } => {}
    }
    Ok(())
}

/// Told once `LoomWatch` should stop for the app to start it again the other way.
pub type Switch = Arc<watch::Sender<bool>>;

/// How long open requests get to finish once `LoomWatch` is switching.
pub const SWITCH_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// A switch nobody has pressed yet.
#[must_use]
pub fn switch() -> Switch {
    Arc::new(watch::channel(false).0)
}

/// Waits until `switch` is pressed.
pub fn switched(switch: &Switch) -> impl std::future::Future<Output = ()> + Send + 'static {
    let mut pressed = switch.subscribe();
    async move {
        let _ = pressed.wait_for(|pressed| *pressed).await;
    }
}

#[cfg(test)]
mod tests;
