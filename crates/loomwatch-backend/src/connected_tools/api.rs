//! The routes Connections and an agent's Tools block use.
//!
//! - `GET /api/tools` → `{tools, catalog, keptIn}`
//! - `POST /api/tools {url, name?}` → `{tool}` once it is connected, `{tool, needs: "signIn", url}`
//!   for a consent page to open in a new window, or `{tool, needs: "token"}`
//! - `POST /api/tools/{id}/token {token}` → `{tool}`
//! - `POST /api/tools/{id}/sign-in` → `{tool, url}`: sign in again
//! - `POST /api/tools/{id}/check` → `{tool}`: list what it offers again
//! - `DELETE /api/tools/{id}` → `{removed}`: forget it and its secret
//! - `GET /api/tools/sign-in/callback`: where a tool's site sends the browser back
//!
//! Mount on a loopback listener only. Every change needs the `X-LoomWatch-Request: 1` header a page
//! from another site can't send without asking. Errors are `{error}` in words for the person. No
//! answer ever holds a secret.
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::catalog::{self, CATALOG};
use super::client::{self, Hello};
use super::icons;
use super::sign_in::{self, Begun, Outcome};
use super::vault::Secret;
use super::{Auth, ConnectedTool, MAX_TOOLS, Tools, same_address, unique_name};
use crate::api::ApiError;
use crate::mac_apps::App;

/// The longest address accepted.
const MAX_URL_CHARS: usize = 2_048;
/// The longest token accepted: some are signed and long, none this long.
const MAX_TOKEN_CHARS: usize = 8_192;

type ApiResult<T> = Result<T, ApiError>;

/// The routes. Mount on a loopback listener only.
pub fn router(tools: Tools) -> Router {
    let managed = Router::new()
        .route("/api/tools", get(list).post(connect))
        .route("/api/tools/{id}", axum::routing::delete(remove))
        .route("/api/tools/{id}/token", post(token))
        .route("/api/tools/{id}/sign-in", post(sign_in_again))
        .route("/api/tools/{id}/check", post(check))
        .route("/api/tools/{id}/settings", post(open_settings))
        .route("/api/tools/icon/{host}", get(icon))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .route_layer(middleware::from_fn(protect))
        .route_layer(middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(tools.clone());
    // The tool's site sends the browser back here from its own pages, so this one route cannot
    // ask for a same-origin request. The one-time state it has to echo is what proves the visit.
    let callback = Router::new()
        .route(sign_in::CALLBACK, get(finish))
        .route_layer(middleware::from_fn(loopback_only))
        .with_state(tools);
    managed.merge(callback)
}

async fn protect(request: Request, next: Next) -> Response {
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("x-loomwatch-request")
            .is_none_or(|value| value != "1")
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Open Connections in LoomWatch to manage tools.",
        )
        .into_response();
    }
    next.run(request).await
}

/// The `Host` a request named, when it is this computer. A name that resolves here only by DNS
/// rebinding names another host, so it never reaches the sign-in routes.
fn loopback_host(headers: &HeaderMap) -> Option<&str> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let authority = host.parse::<axum::http::uri::Authority>().ok()?;
    matches!(
        authority.host(),
        "localhost" | "127.0.0.1" | "[::1]" | "::1"
    )
    .then_some(host)
}

async fn loopback_only(request: Request, next: Next) -> Response {
    if loopback_host(request.headers()).is_none() {
        return failure(
            StatusCode::FORBIDDEN,
            "Open LoomWatch on this computer to connect a tool.",
        )
        .into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

fn failure(status: StatusCode, message: impl Into<String>) -> ApiError {
    ApiError::new(status, message.into())
}

/// A tool as the app shows it: never its secret, its sign-in addresses, or its calls' schemas.
fn public(tool: &ConnectedTool) -> Value {
    json!({
        "id": tool.id,
        "name": tool.name,
        "url": tool.url,
        "auth": tool.auth,
        "calls": tool.calls.iter().map(|call| json!({
            "name": call.name,
            "label": call.label(),
            "description": call.description,
            "readOnly": call.read_only,
            "cantUndo": call.cant_undo,
        })).collect::<Vec<_>>(),
        "checkedAt": tool.checked_at,
        "pending": tool.pending,
        "problem": tool.problem,
        "tokenHelp": catalog::at(&tool.url).and_then(|entry| entry.token_help),
        "example": catalog::at(&tool.url).map(|entry| entry.example),
        "icon": icons::site_for(tool).as_deref().and_then(icons::path),
        // Its sign-in also sends teams' answers to Notion and reads pages for agents (ADR 0070).
        "notion": same_address(&tool.url, crate::notion::MCP_URL),
        // A Mac app that macOS hasn't let in yet: where the person allows it (ADR 0121).
        "settings": App::at(&tool.url)
            .filter(|_| tool.pending || tool.problem.is_some())
            .map(App::settings),
    })
}

async fn list(State(tools): State<Tools>) -> Json<Value> {
    let listed = tools.list().await;
    Json(json!({
        "tools": listed.iter().map(public).collect::<Vec<_>>(),
        "catalog": CATALOG.iter().filter(|entry| shown_here(entry)).map(|entry| {
            let mut shown = serde_json::to_value(entry).unwrap_or_default();
            shown["icon"] = json!(icons::path(entry.site));
            shown
        }).collect::<Vec<_>>(),
        "keptIn": if !tools.inner.vault.available() {
            "nowhere"
        } else if crate::ai::keys_in_file() {
            "file"
        } else if cfg!(windows) {
            "credentialManager"
        } else {
            "keychain"
        },
    }))
}

/// A tool's icon, fetched from its own site and kept (`icons.rs`).
async fn icon(State(tools): State<Tools>, Path(host): Path<String>) -> Response {
    match icons::icon(&tools, &host).await {
        Some((bytes, kind)) => (
            [
                (header::CONTENT_TYPE, kind),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CONTENT_SECURITY_POLICY, "default-src 'none'"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Whether this computer can connect `entry`: the Mac's own apps only on a Mac.
fn shown_here(entry: &catalog::Entry) -> bool {
    entry.auth != Auth::OnThisMac || cfg!(target_os = "macos")
}

#[derive(Deserialize)]
struct Connect {
    url: String,
    #[serde(default)]
    name: Option<String>,
}

async fn connect(
    State(tools): State<Tools>,
    headers: HeaderMap,
    Json(body): Json<Connect>,
) -> ApiResult<Json<Value>> {
    if let Some(app) = App::at(&body.url) {
        return connect_mac_app(&tools, app).await;
    }
    if body.url.trim() == crate::health::URL {
        return connect_health(&tools).await;
    }
    let url = address(&body.url)?;
    let existing = tools.list().await;
    let same = existing
        .iter()
        .find(|tool| same_address(&tool.url, &url))
        .cloned();
    if let Some(tool) = same.as_ref().filter(|tool| !tool.pending) {
        return Err(failure(
            StatusCode::CONFLICT,
            format!("That tool is already connected, as {}.", tool.name),
        ));
    }
    if same.is_none() && existing.len() >= MAX_TOOLS {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            format!("LoomWatch keeps up to {MAX_TOOLS} tools. Remove one you don't use first."),
        ));
    }
    let hello = client::hello(&tools.inner.http, &url)
        .await
        .map_err(|said| failure(StatusCode::BAD_GATEWAY, said))?;
    let wanted = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| catalog::at(&url).map(|entry| entry.name.to_owned()))
        .unwrap_or_else(|| name_from(&url));
    let mut tool = match same {
        // Connecting a tool still waiting for its sign-in or token starts it again.
        Some(waiting) => waiting,
        None => ConnectedTool {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: unique_name(&wanted, &existing),
            url: url.clone(),
            auth: Auth::None,
            calls: Vec::new(),
            checked_at: None,
            metadata: None,
            pending: true,
            problem: None,
        },
    };
    match hello {
        Hello::Open => {
            tool.auth = Auth::None;
            let tool = finish_connecting(&tools, tool).await?;
            Ok(Json(json!({"tool": public(&tool)})))
        }
        Hello::Challenge(challenge) => {
            let redirect = redirect_uri(&headers)?;
            match sign_in::start(&tools, &tool, challenge.as_deref(), &redirect)
                .await
                .map_err(|said| failure(StatusCode::BAD_GATEWAY, said))?
            {
                Begun::Consent { url, metadata } => {
                    tool.auth = Auth::SignIn;
                    tool.metadata = Some(*metadata);
                    keep(&tools, &tool).await?;
                    Ok(Json(
                        json!({"tool": public(&tool), "needs": "signIn", "url": url}),
                    ))
                }
                Begun::NoSignIn => {
                    tool.auth = Auth::Token;
                    tool.metadata = None;
                    keep(&tools, &tool).await?;
                    Ok(Json(json!({"tool": public(&tool), "needs": "token"})))
                }
            }
        }
    }
}

#[derive(Deserialize)]
struct Token {
    token: String,
}

async fn token(
    State(tools): State<Tools>,
    Path(id): Path<String>,
    Json(body): Json<Token>,
) -> ApiResult<Json<Value>> {
    let mut tool = found(&tools, &id).await?;
    let token = body
        .token
        .trim()
        .trim_start_matches("Bearer ")
        .trim()
        .to_owned();
    if token.is_empty() {
        return Err(failure(StatusCode::BAD_REQUEST, "Paste the token first."));
    }
    if token.chars().count() > MAX_TOKEN_CHARS || token.chars().any(char::is_control) {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "That doesn't look like a token. Copy it again from the service.",
        ));
    }
    if !tools.inner.vault.available() {
        return Err(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "This computer has no store LoomWatch can keep a token in. Start LoomWatch with LOOMWATCH_KEY_STORE=file to keep it in a private file.",
        ));
    }
    let before = tools.inner.vault.get(&tool.id).await.ok().flatten();
    tools
        .inner
        .vault
        .set(&tool.id, Some(Secret::Token { token }))
        .await
        .map_err(|said| failure(StatusCode::SERVICE_UNAVAILABLE, said))?;
    tool.auth = Auth::Token;
    match finish_connecting(&tools, tool).await {
        Ok(tool) => Ok(Json(json!({"tool": public(&tool)}))),
        Err(error) => {
            // A token the server refuses is never kept; the one before it, if any, stays.
            let _ = tools.inner.vault.set(&id, before).await;
            Err(error)
        }
    }
}

async fn sign_in_again(
    State(tools): State<Tools>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let tool = found(&tools, &id).await?;
    if tool.auth != Auth::SignIn {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            format!("{} doesn't sign in through its site.", tool.name),
        ));
    }
    let redirect = redirect_uri(&headers)?;
    match sign_in::start(&tools, &tool, None, &redirect)
        .await
        .map_err(|said| failure(StatusCode::BAD_GATEWAY, said))?
    {
        Begun::Consent { url, .. } => Ok(Json(json!({"tool": public(&tool), "url": url}))),
        Begun::NoSignIn => Err(failure(
            StatusCode::BAD_GATEWAY,
            format!(
                "{} no longer offers a sign-in. Remove it and connect it again.",
                tool.name
            ),
        )),
    }
}

/// Connect one of this Mac's apps (ADR 0121): macOS asks the person, in `LoomWatch`'s name, the
/// first time. A refusal keeps the tool waiting, with where to allow it, until it is checked again.
async fn connect_mac_app(tools: &Tools, app: App) -> ApiResult<Json<Value>> {
    if !cfg!(target_os = "macos") {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "This tool works only when LoomWatch runs on a Mac.",
        ));
    }
    let existing = tools.list().await;
    let same = existing.iter().find(|tool| tool.url == app.url()).cloned();
    if let Some(tool) = same.as_ref().filter(|tool| !tool.pending) {
        return Err(failure(
            StatusCode::CONFLICT,
            format!("That tool is already connected, as {}.", tool.name),
        ));
    }
    if same.is_none() && existing.len() >= MAX_TOOLS {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            format!("LoomWatch keeps up to {MAX_TOOLS} tools. Remove one you don't use first."),
        ));
    }
    let wanted = catalog::at(app.url()).map_or("Mac app", |entry| entry.name);
    let tool = same.unwrap_or_else(|| ConnectedTool {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: unique_name(wanted, &existing),
        url: app.url().to_owned(),
        auth: Auth::OnThisMac,
        calls: Vec::new(),
        checked_at: None,
        metadata: None,
        pending: true,
        problem: None,
    });
    let tool = finish_mac_app(tools, tool, app).await?;
    if tool.pending {
        return Ok(Json(json!({
            "tool": public(&tool),
            "needs": "macPermission",
            "settings": app.settings(),
        })));
    }
    Ok(Json(json!({"tool": public(&tool)})))
}

/// Ask macOS for `app` and keep `tool` as it answered: connected, or waiting with why.
async fn finish_mac_app(
    tools: &Tools,
    mut tool: ConnectedTool,
    app: App,
) -> ApiResult<ConnectedTool> {
    let granted = tools
        .mac()
        .access(app)
        .await
        .map_err(|said| failure(StatusCode::BAD_GATEWAY, said))?;
    tool.auth = Auth::OnThisMac;
    tool.calls = app.calls();
    tool.checked_at = Some(super::now());
    if granted {
        tool.pending = false;
        tool.problem = None;
    } else {
        // Connected once, it stays given to agents, and tells them what to ask for; never
        // connected, it waits.
        if tool.pending {
            tool.problem = None;
        } else {
            tool.problem = Some(app.refused().to_owned());
        }
    }
    keep(tools, &tool).await?;
    Ok(tool)
}

/// Open System Settings on this Mac where a Mac app's tool is allowed (ADR 0121). The pane is
/// `LoomWatch`'s own, never one the request names.
async fn open_settings(
    State(tools): State<Tools>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let tool = found(&tools, &id).await?;
    let Some(app) = App::at(&tool.url).filter(|_| cfg!(target_os = "macos")) else {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "Only a Mac app's tool is allowed in System Settings.",
        ));
    };
    let opened = tokio::process::Command::new("/usr/bin/open")
        .arg(app.settings())
        .status()
        .await
        .is_ok_and(|status| status.success());
    if !opened {
        return Err(failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "System Settings didn't open. Open it from the Apple menu, then Privacy & Security.",
        ));
    }
    Ok(Json(json!({"opened": true})))
}

/// Connect Apple Health (ADR 0121): connected once a paired iPhone has sent readings. Until then
/// it waits, and Connections says to turn it on in `LoomWatch` on the iPhone.
async fn connect_health(tools: &Tools) -> ApiResult<Json<Value>> {
    let existing = tools.list().await;
    let same = existing
        .iter()
        .find(|tool| tool.url == crate::health::URL)
        .cloned();
    if let Some(tool) = same.as_ref().filter(|tool| !tool.pending) {
        return Err(failure(
            StatusCode::CONFLICT,
            format!("That tool is already connected, as {}.", tool.name),
        ));
    }
    if same.is_none() && existing.len() >= MAX_TOOLS {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            format!("LoomWatch keeps up to {MAX_TOOLS} tools. Remove one you don't use first."),
        ));
    }
    let tool = same.unwrap_or_else(|| ConnectedTool {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: unique_name("Apple Health", &existing),
        url: crate::health::URL.to_owned(),
        auth: Auth::FromPhone,
        calls: Vec::new(),
        checked_at: None,
        metadata: None,
        pending: true,
        problem: None,
    });
    let tool = finish_health(tools, tool).await?;
    Ok(Json(health_answer(&tool)))
}

async fn finish_health(tools: &Tools, mut tool: ConnectedTool) -> ApiResult<ConnectedTool> {
    let arrived = match crate::health::installed() {
        Some(health) => health.has_readings().await,
        None => false,
    };
    tool.auth = Auth::FromPhone;
    tool.calls = crate::health::calls();
    tool.checked_at = Some(super::now());
    if arrived {
        tool.pending = false;
    }
    keep(tools, &tool).await?;
    Ok(tool)
}

fn health_answer(tool: &ConnectedTool) -> Value {
    if tool.pending {
        json!({"tool": public(tool), "needs": "phoneHealth"})
    } else {
        json!({"tool": public(tool)})
    }
}

async fn check(State(tools): State<Tools>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let tool = found(&tools, &id).await?;
    if tool.url == crate::health::URL {
        let tool = finish_health(&tools, tool).await?;
        return Ok(Json(health_answer(&tool)));
    }
    if let Some(app) = App::at(&tool.url) {
        let tool = finish_mac_app(&tools, tool, app).await?;
        if tool.pending {
            return Ok(Json(json!({
                "tool": public(&tool),
                "needs": "macPermission",
                "settings": app.settings(),
            })));
        }
        return Ok(Json(json!({"tool": public(&tool)})));
    }
    let tool = finish_connecting(&tools, tool).await?;
    Ok(Json(json!({"tool": public(&tool)})))
}

async fn remove(State(tools): State<Tools>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let tool = found(&tools, &id).await?;
    // Apple Health's readings go with the tool (ADR 0121).
    if tool.url == crate::health::URL
        && let Some(health) = crate::health::installed()
    {
        health
            .forget(None)
            .await
            .map_err(|said| failure(StatusCode::INTERNAL_SERVER_ERROR, said))?;
    }
    tools
        .inner
        .vault
        .set(&tool.id, None)
        .await
        .map_err(|said| failure(StatusCode::SERVICE_UNAVAILABLE, said))?;
    tools
        .change(|listed| {
            listed.retain(|kept| kept.id != tool.id);
            Ok(())
        })
        .await
        .map_err(|said| failure(StatusCode::INTERNAL_SERVER_ERROR, said))?;
    Ok(Json(json!({"removed": true})))
}

#[derive(Deserialize)]
struct Callback {
    #[serde(default)]
    state: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    error: Option<String>,
    /// The server that signed in, when it names itself (RFC 9207), as Notion's does.
    #[serde(default)]
    iss: Option<String>,
}

async fn finish(State(tools): State<Tools>, Query(query): Query<Callback>) -> Html<String> {
    let (id, mut outcome) = sign_in::finish(
        &tools,
        &query.state,
        query.code.as_deref(),
        query.iss.as_deref(),
        query.error.is_some(),
    )
    .await;
    let tool = match &id {
        Some(id) => tools.get(id).await,
        None => None,
    };
    if outcome == Outcome::Connected
        && let Some(tool) = tool.clone()
        && finish_connecting(&tools, tool).await.is_err()
    {
        outcome = Outcome::Failed;
    }
    Html(sign_in::landing_page(
        id.as_deref(),
        outcome,
        tool.as_ref().map(|tool| tool.name.as_str()),
    ))
}

/// Open a session with `tool` as it now signs in, list what it offers, and keep it as connected.
async fn finish_connecting(tools: &Tools, mut tool: ConnectedTool) -> ApiResult<ConnectedTool> {
    let listed = match client::open(tools, &tool).await {
        Ok(session) => {
            let listed = client::calls(&session, &tool.name).await;
            let _ = session.cancel().await;
            listed
        }
        Err(said) => Err(said),
    };
    match listed {
        Ok(calls) => {
            tool.calls = calls;
            tool.checked_at = Some(super::now());
            tool.pending = false;
            tool.problem = None;
            keep(tools, &tool).await?;
            Ok(tool)
        }
        Err(said) => {
            if !tool.pending {
                tools.note(&tool.id, Err(&said)).await;
            }
            Err(failure(StatusCode::BAD_GATEWAY, said))
        }
    }
}

/// Keep `tool` in the list, replacing the one with its id, or adding it.
async fn keep(tools: &Tools, tool: &ConnectedTool) -> ApiResult<()> {
    let tool = tool.clone();
    tools
        .change(move |listed| {
            if let Some(kept) = listed.iter_mut().find(|kept| kept.id == tool.id) {
                *kept = tool;
            } else {
                listed.push(tool);
            }
            Ok(())
        })
        .await
        .map_err(|said| failure(StatusCode::INTERNAL_SERVER_ERROR, said))
}

async fn found(tools: &Tools, id: &str) -> ApiResult<ConnectedTool> {
    tools.get(id).await.ok_or_else(|| {
        failure(
            StatusCode::NOT_FOUND,
            "That tool isn't connected any more. Reload and try again.",
        )
    })
}

/// [`sign_in::CALLBACK`] on the address the app was opened at, which must be this computer's.
fn redirect_uri(headers: &HeaderMap) -> ApiResult<String> {
    let host = loopback_host(headers).ok_or_else(|| {
        failure(
            StatusCode::FORBIDDEN,
            "Open LoomWatch on this computer to connect a tool.",
        )
    })?;
    Ok(format!("http://{host}{}", sign_in::CALLBACK))
}

/// The server address the operator pasted, as one `LoomWatch` will connect to: HTTPS, or plain HTTP
/// only on this computer's own address, with no password in it.
fn address(raw: &str) -> ApiResult<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "Paste the tool's address.",
        ));
    }
    if raw.chars().count() > MAX_URL_CHARS {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "That address is too long.",
        ));
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let not_an_address = || {
        failure(
            StatusCode::BAD_REQUEST,
            "That isn't a web address. Paste the server address the service gives, such as https://mcp.example.com/mcp.",
        )
    };
    let mut url = url::Url::parse(&with_scheme).map_err(|_| not_an_address())?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        "http" => {
            return Err(failure(
                StatusCode::BAD_REQUEST,
                "LoomWatch only connects to tools over https://, so nobody on the way can read what an agent sends.",
            ));
        }
        _ => return Err(not_an_address()),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(not_an_address());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "Take the name and password out of the address. If the tool needs a token, LoomWatch asks for it next.",
        ));
    }
    url.set_fragment(None);
    Ok(url.into())
}

/// A name for a tool from its address: `https://mcp.example.com/mcp` → "Example".
fn name_from(url: &str) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    if host == "localhost" || host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() {
        return "Local tool".to_owned();
    }
    let labels: Vec<&str> = host.split('.').collect();
    let label = labels
        .iter()
        .find(|label| !matches!(**label, "mcp" | "api" | "www" | "app"))
        .copied()
        .unwrap_or(host.as_str());
    let mut chars = label.chars();
    chars.next().map_or_else(
        || "Tool".to_owned(),
        |first| first.to_uppercase().chain(chars).collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_https_addresses_and_this_computers_own() {
        assert_eq!(
            address(" mcp.linear.app/mcp ").unwrap(),
            "https://mcp.linear.app/mcp"
        );
        assert_eq!(
            address("http://127.0.0.1:9000/mcp#x").unwrap(),
            "http://127.0.0.1:9000/mcp"
        );
        for refused in [
            "",
            "http://mcp.example.com/mcp",
            "ftp://example.com",
            "https://me:secret@example.com/mcp",
            "file:///etc/passwd",
        ] {
            assert!(address(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn names_a_tool_from_its_address() {
        assert_eq!(name_from("https://mcp.example.com/mcp"), "Example");
        assert_eq!(name_from("https://api.acme.io/v1/mcp"), "Acme");
        assert_eq!(name_from("http://127.0.0.1:9000/mcp"), "Local tool");
    }
}
