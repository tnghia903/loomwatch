//! Connecting tools end to end against a stand-in MCP server on this computer: one anyone may
//! call, one that wants a token, and one that signs in like Linear's or Notion's (protected
//! resource metadata, authorization server metadata, registration, PKCE, tokens).
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Form, State};
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::agent::HostTools;

/// How the stand-in proves who is calling.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Guard {
    Open,
    Token,
    SignIn,
    /// Signs in like `SignIn`, but its metadata names no scopes it needs.
    SignInNamingNoScopes,
}

#[derive(Clone)]
struct Fake {
    guard: Guard,
    base: Arc<Mutex<String>>,
    /// The access token the stand-in's sign-in handed out, once it has.
    issued: Arc<Mutex<Option<String>>>,
    /// Every `tools/call` it was sent.
    called: Arc<Mutex<Vec<Value>>>,
}

const TOKEN: &str = "secret-token-123";
/// The start of a PNG, which is all the icon check reads.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake-icon";
const ACCESS: &str = "access-token-456";

impl Fake {
    fn base(&self) -> String {
        self.base.lock().unwrap().clone()
    }

    fn expected(&self) -> Option<String> {
        match self.guard {
            Guard::Open => None,
            Guard::Token => Some(TOKEN.to_owned()),
            Guard::SignIn | Guard::SignInNamingNoScopes => Some(
                self.issued
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "nobody yet".to_owned()),
            ),
        }
    }
}

/// Starts the stand-in and answers its address.
async fn start(guard: Guard) -> (String, Fake) {
    let fake = Fake {
        guard,
        base: Arc::default(),
        issued: Arc::default(),
        called: Arc::default(),
    };
    let app = Router::new()
        .route(
            "/mcp",
            post(mcp).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(authorization_server),
        )
        .route("/register", post(register))
        // Its home page names its icon, as a real site's does.
        .route(
            "/",
            get(|| async {
                axum::response::Html(r#"<html><head><link rel="icon" href="/logo.svg"><link rel="apple-touch-icon" href="/icon.png"></head></html>"#)
            }),
        )
        .route(
            "/icon.png",
            get(|| async { ([(header::CONTENT_TYPE, "image/png")], PNG.to_vec()) }),
        )
        .route("/token", post(token))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    *fake.base.lock().unwrap() = base.clone();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (base, fake)
}

async fn mcp(State(fake): State<Fake>, headers: HeaderMap, Json(message): Json<Value>) -> Response {
    if let Some(expected) = fake.expected() {
        let sent = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        if sent != Some(expected.as_str()) {
            let challenge = if matches!(fake.guard, Guard::SignIn | Guard::SignInNamingNoScopes) {
                format!(
                    "Bearer realm=\"OAuth\", resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
                    fake.base()
                )
            } else {
                "Bearer realm=\"fake\"".to_owned()
            };
            return (
                StatusCode::UNAUTHORIZED,
                [(header::WWW_AUTHENTICATE, challenge)],
            )
                .into_response();
        }
    }
    let Some(id) = message.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match message["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "1"},
        }),
        "tools/list" => json!({"tools": [
            {
                "name": "create_issue",
                "description": "Create an issue.",
                "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]},
                "annotations": {"title": "Create issue"},
            },
            {"name": "list_teams", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": true}},
        ]}),
        "tools/call" => {
            fake.called.lock().unwrap().push(message["params"].clone());
            let title = message["params"]["arguments"]["title"]
                .as_str()
                .unwrap_or("?");
            json!({"content": [{"type": "text", "text": format!("Created {title}")}]})
        }
        _ => {
            return Json(
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "no"}}),
            )
            .into_response();
        }
    };
    Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
}

async fn protected_resource(State(fake): State<Fake>) -> Response {
    let base = fake.base();
    match fake.guard {
        Guard::SignIn => Json(json!({"resource": format!("{base}/mcp"), "authorization_servers": [base], "scopes_supported": ["issues:read"]})).into_response(),
        Guard::SignInNamingNoScopes => Json(json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]})).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn authorization_server(State(fake): State<Fake>) -> Response {
    if !matches!(fake.guard, Guard::SignIn | Guard::SignInNamingNoScopes) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let base = fake.base();
    Json(json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "registration_endpoint": format!("{base}/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        // More than the tool needs, as Todoist's server offers: LoomWatch must not ask for it all.
        "scopes_supported": ["issues:read", "issues:write", "billing:admin", "offline_access"],
        // It names itself in the browser's way back (RFC 9207), as Notion's does; the other
        // stand-in is an older server that doesn't.
        "authorization_response_iss_parameter_supported": fake.guard == Guard::SignIn,
    }))
    .into_response()
}

async fn register(Json(body): Json<Value>) -> Response {
    (
        StatusCode::CREATED,
        Json(json!({"client_id": "client-1", "redirect_uris": body["redirect_uris"]})),
    )
        .into_response()
}

async fn token(
    State(fake): State<Fake>,
    Form(form): Form<std::collections::HashMap<String, String>>,
) -> Response {
    let fine = form.get("grant_type").map(String::as_str) == Some("authorization_code")
        && form.get("code").map(String::as_str) == Some("good-code")
        && form
            .get("code_verifier")
            .is_some_and(|verifier| !verifier.is_empty());
    if !fine {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_grant"})),
        )
            .into_response();
    }
    *fake.issued.lock().unwrap() = Some(ACCESS.to_owned());
    Json(json!({
        "access_token": ACCESS,
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": "refresh-789",
    }))
    .into_response()
}

struct Folder(std::path::PathBuf);

impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("loomwatch-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn tools_file(&self) -> String {
        std::fs::read_to_string(self.0.join(TOOLS_FILE)).unwrap_or_default()
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One request to the routes, as the app on this computer sends it.
async fn ask(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, "127.0.0.1:3000")
        .header("x-loomwatch-request", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, value)
}

#[tokio::test]
async fn connects_an_open_tool_and_an_agent_calls_it() {
    let (base, fake) = start(Guard::Open).await;
    let folder = Folder::new();
    let tools = Tools::for_tests(&folder.0);
    let app = router(tools.clone());

    let (status, body) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": format!("{base}/mcp")})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["tool"]["name"], "Local tool");
    assert_eq!(body["tool"]["auth"], "none");
    assert_eq!(body["tool"]["pending"], false);
    let labels: Vec<&str> = body["tool"]["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| call["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["Create issue", "List teams"]);
    assert_eq!(body["tool"]["calls"][1]["readOnly"], true);

    // The same address again is refused rather than kept twice.
    let (status, again) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": format!("{base}/mcp")})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");

    // An agent given it is offered its calls, and a call reaches the server.
    let given = tools.named_now("local TOOL").expect("found ignoring case");
    let offered = OutsideTools::new(tools.clone(), vec![given]);
    let names: Vec<String> = offered.specs().into_iter().map(|spec| spec.name).collect();
    assert_eq!(
        names,
        ["local_tool__create_issue", "local_tool__list_teams"]
    );
    let (text, failed) = offered
        .call("local_tool__create_issue", json!({"title": "Fix login"}))
        .await;
    assert_eq!((text.as_str(), failed), ("Created Fix login", false));
    assert_eq!(fake.called.lock().unwrap()[0]["name"], "create_issue");

    // Removing it forgets it.
    let id = body["tool"]["id"].as_str().unwrap();
    let (status, _) = ask(&app, "DELETE", &format!("/api/tools/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(tools.list().await.is_empty());
}

/// A tool's icon comes from its own site, is kept, and is served as a bitmap with nothing else
/// allowed; a site `LoomWatch` doesn't show is never fetched.
#[tokio::test]
async fn serves_a_tools_icon_from_its_own_site() {
    let (base, _fake) = start(Guard::Open).await;
    let folder = Folder::new();
    let tools = Tools::for_tests(&folder.0);
    let app = router(tools.clone());
    let (_, body) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": format!("{base}/mcp")})),
    )
    .await;
    let host = base.trim_start_matches("http://");
    let icon = format!("/api/tools/icon/{host}");
    assert_eq!(body["tool"]["icon"], icon.as_str());
    let request = |uri: &str| {
        Request::builder()
            .uri(uri)
            .header(header::HOST, "127.0.0.1:3000")
            .body(Body::empty())
            .unwrap()
    };
    let response = app.clone().oneshot(request(&icon)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        response.headers()[header::CONTENT_SECURITY_POLICY],
        "default-src 'none'"
    );
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], PNG);
    // Kept, under the state folder.
    let kept = folder.0.join("tool-icons").join(host.replace(':', "_"));
    assert_eq!(std::fs::read(kept).unwrap(), PNG);
    // Not a site LoomWatch shows: refused without a fetch.
    let response = app
        .oneshot(request("/api/tools/icon/evil.example"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // The starter list names each entry's icon.
    let (_, listed) = ask(&router(tools), "GET", "/api/tools", None).await;
    let kiwi = listed["catalog"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "Kiwi.com")
        .unwrap();
    assert_eq!(kiwi["icon"], "/api/tools/icon/www.kiwi.com");
}

#[tokio::test]
async fn a_tool_that_wants_a_token_keeps_only_one_it_accepts() {
    let (base, _fake) = start(Guard::Token).await;
    let folder = Folder::new();
    let tools = Tools::for_tests(&folder.0);
    let app = router(tools.clone());

    let (status, body) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": format!("{base}/mcp"), "name": "Tracker"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["needs"], "token");
    assert_eq!(body["tool"]["pending"], true);
    let id = body["tool"]["id"].as_str().unwrap().to_owned();
    // Waiting for its token, nothing can use it yet.
    assert!(tools.named_now("Tracker").is_none());

    let (status, refused) = ask(
        &app,
        "POST",
        &format!("/api/tools/{id}/token"),
        Some(json!({"token": "wrong"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{refused}");
    assert_eq!(
        refused["error"],
        "Tracker refused its token. Open Connections and paste a new one."
    );
    assert!(
        tools.inner.vault.get(&id).await.unwrap().is_none(),
        "a refused token is never kept"
    );

    let (status, body) = ask(
        &app,
        "POST",
        &format!("/api/tools/{id}/token"),
        Some(json!({"token": format!("Bearer {TOKEN}")})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["tool"]["pending"], false);
    assert_eq!(body["tool"]["auth"], "token");
    assert!(tools.named_now("Tracker").is_some());
    // The token is in the vault and nowhere the app or an agent reads.
    assert!(tools.inner.vault.raw().unwrap().contains(TOKEN));
    assert!(!folder.tools_file().contains(TOKEN));
    let (_, listed) = ask(&app, "GET", "/api/tools", None).await;
    assert!(!listed.to_string().contains(TOKEN));
}

#[tokio::test]
async fn signs_in_through_the_tools_own_site() {
    let (base, _fake) = start(Guard::SignIn).await;
    let folder = Folder::new();
    let tools = Tools::for_tests(&folder.0);
    let app = router(tools.clone());

    let (status, body) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": format!("{base}/mcp"), "name": "Linear"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["needs"], "signIn");
    let consent = url::Url::parse(body["url"].as_str().unwrap()).unwrap();
    assert_eq!(
        consent.as_str().split('?').next(),
        Some(format!("{base}/authorize").as_str())
    );
    let param = |key: &str| {
        consent
            .query_pairs()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
    };
    assert_eq!(param("client_id").as_deref(), Some("client-1"));
    assert_eq!(param("code_challenge_method").as_deref(), Some("S256"));
    // Only what the tool names, plus a refresh token: never all its sign-in server could grant.
    assert_eq!(
        param("scope").as_deref(),
        Some("issues:read offline_access")
    );
    assert_eq!(
        param("redirect_uri").as_deref(),
        Some("http://127.0.0.1:3000/api/tools/sign-in/callback")
    );
    let state = param("state").unwrap();

    // A made-up state finds nothing to finish.
    let (_, page) = ask(
        &app,
        "GET",
        "/api/tools/sign-in/callback?state=nope&code=good-code",
        None,
    )
    .await;
    assert!(page.as_str().unwrap().contains("This sign-in has ended"));

    // The site sends the browser back with a code and its own name: LoomWatch trades the code
    // for tokens.
    let (status, page) = ask(&app, "GET", &sent_back(&state, Some(&base)), None).await;
    assert_eq!(status, StatusCode::OK);
    let page = page.as_str().unwrap();
    assert!(page.contains("Linear is connected to LoomWatch"), "{page}");
    assert!(page.contains("loomwatch-tools"));

    let tool = tools.named_now("Linear").expect("connected");
    assert_eq!(tool.auth, Auth::SignIn);
    assert_eq!(tool.calls.len(), 2);
    assert!(tool.metadata.is_some());
    // The tokens are in the vault only.
    let kept = tools.inner.vault.raw().unwrap();
    assert!(kept.contains(ACCESS) && kept.contains("refresh-789"));
    assert!(!folder.tools_file().contains(ACCESS));
    assert!(!folder.tools_file().contains("refresh-789"));

    // A run's agent uses the stored sign-in.
    let offered = OutsideTools::new(tools.clone(), vec![tool]);
    let (text, failed) = offered
        .call("linear__create_issue", json!({"title": "Ship it"}))
        .await;
    assert_eq!((text.as_str(), failed), ("Created Ship it", false));

    // The same state can't finish twice.
    let (_, page) = ask(&app, "GET", &sent_back(&state, Some(&base)), None).await;
    assert!(page.as_str().unwrap().contains("This sign-in has ended"));
}

/// Where a tool's site sends the browser back: the one-time `state`, a code, and the `iss` naming
/// the server that signed in, when it names one.
fn sent_back(state: &str, iss: Option<&str>) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query
        .append_pair("state", state)
        .append_pair("code", "good-code");
    if let Some(iss) = iss {
        query.append_pair("iss", iss);
    }
    format!("/api/tools/sign-in/callback?{}", query.finish())
}

/// A server that names itself on the way back (RFC 9207) must name itself, and be the one
/// `LoomWatch` started signing in with: a code sent back under another name, or under none, could
/// come from another site, so it is never traded for tokens.
#[tokio::test]
async fn a_sign_in_sent_back_under_another_name_or_none_is_refused() {
    let (base, _fake) = start(Guard::SignIn).await;
    let folder = Folder::new();
    let tools = Tools::for_tests(&folder.0);
    let app = router(tools.clone());
    let state_of = |body: &Value| {
        url::Url::parse(body["url"].as_str().unwrap())
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
            .unwrap()
    };

    let (status, body) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": format!("{base}/mcp"), "name": "Linear"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["tool"]["id"].as_str().unwrap().to_owned();
    let (_, page) = ask(
        &app,
        "GET",
        &sent_back(&state_of(&body), Some("https://elsewhere.example")),
        None,
    )
    .await;
    assert!(page.as_str().unwrap().contains("Not connected"), "{page}");

    let (status, body) = ask(&app, "POST", &format!("/api/tools/{id}/sign-in"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, page) = ask(&app, "GET", &sent_back(&state_of(&body), None), None).await;
    assert!(page.as_str().unwrap().contains("Not connected"), "{page}");

    assert!(tools.named_now("Linear").is_none(), "not connected");
    assert!(!tools.inner.vault.raw().unwrap_or_default().contains(ACCESS));
}

/// A tool that names no scopes is signed in to with none asked for, never with every scope its
/// sign-in server offers (least privilege).
#[tokio::test]
async fn a_tool_naming_no_scopes_asks_for_none() {
    let (base, _fake) = start(Guard::SignInNamingNoScopes).await;
    let folder = Folder::new();
    let app = router(Tools::for_tests(&folder.0));
    let (status, body) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": format!("{base}/mcp")})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["needs"], "signIn");
    let consent = url::Url::parse(body["url"].as_str().unwrap()).unwrap();
    assert!(
        !consent.query_pairs().any(|(key, _)| key == "scope"),
        "{consent}"
    );
}

/// An address nothing answers at: connecting is refused, as it is offline or behind a proxy that
/// refuses.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

/// Where the sign-in for a tool at `base` signs in and renews, as a moved Notion sign-in has it.
fn sign_in_metadata(base: &str) -> AuthorizationMetadata {
    let mut metadata = AuthorizationMetadata::default();
    metadata.authorization_endpoint = format!("{base}/authorize");
    metadata.token_endpoint = format!("{base}/token");
    metadata.registration_endpoint = Some(format!("{base}/register"));
    metadata.code_challenge_methods_supported = Some(vec!["S256".to_owned()]);
    metadata
}

/// A sign-in received now whose access token lasts `expires_in` seconds: 0 to renew it first.
fn kept_sign_in(expires_in: i64) -> StoredCredentials {
    serde_json::from_value(json!({
        "client_id": "client-1",
        "token_response": {
            "access_token": "old-access",
            "token_type": "bearer",
            "expires_in": expires_in,
            "refresh_token": "old-refresh",
        },
        "granted_scopes": [],
        "token_received_at": chrono::Utc::now().timestamp(),
    }))
    .unwrap()
}

/// The v0.7.1 trial: a Notion sign-in moved while nothing outside could be reached. The tool
/// can't be reached, and says so; its sign-in hasn't expired, whether its token was still good or
/// due to be renewed (which couldn't reach the sign-in site either).
#[tokio::test]
async fn a_sign_in_tool_that_cant_be_reached_has_not_expired() {
    for expires_in in [3600, 0] {
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let offline = closed_address();
        let url = format!("{offline}/mcp");
        let adopted = tools
            .adopt_sign_in(
                "Notion",
                &url,
                sign_in_metadata(&offline),
                kept_sign_in(expires_in),
            )
            .await;
        assert_eq!(adopted, Ok(Adopted::Kept));
        let tool = tools.at(&url).await.expect("kept all the same");
        assert_eq!(
            tool.problem,
            Some(client::unreachable("Notion")),
            "token lasting {expires_in}s"
        );
        assert_eq!(
            client::open(&tools, &tool).await.err(),
            Some(client::unreachable("Notion"))
        );
        let bearer = tools.bearer(&tool).await;
        if expires_in == 0 {
            assert_eq!(bearer, Err(Unusable::Unreachable));
        } else {
            assert_eq!(bearer.as_deref(), Ok("old-access"));
        }
        let secrets = tools.secrets_for_tests();
        assert!(secrets.contains("old-refresh"), "the sign-in is kept");
    }
}

/// A sign-in the tool's server turns down, and whose renewal its site turns down, is the one case
/// that says to sign in again: whether the token looked good or was due to be renewed.
#[tokio::test]
async fn a_sign_in_the_tool_turns_down_says_to_sign_in_again() {
    let (base, _fake) = start(Guard::SignIn).await;
    for expires_in in [3600, 0] {
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let url = format!("{base}/mcp");
        let adopted = tools
            .adopt_sign_in(
                "Notion",
                &url,
                sign_in_metadata(&base),
                kept_sign_in(expires_in),
            )
            .await;
        assert_eq!(adopted, Ok(Adopted::Kept));
        let tool = tools.at(&url).await.expect("kept all the same");
        assert_eq!(
            tool.problem,
            Some(client::sign_in_again("Notion")),
            "token lasting {expires_in}s"
        );
        assert_eq!(
            client::open(&tools, &tool).await.err(),
            Some(client::sign_in_again("Notion"))
        );
    }
    // Renewing it is turned down too, so nothing can be sent for it.
    let folder = Folder::new();
    let tools = Tools::for_tests(&folder.0);
    tools
        .adopt_sign_in(
            "Notion",
            &format!("{base}/mcp"),
            sign_in_metadata(&base),
            kept_sign_in(0),
        )
        .await
        .unwrap();
    let tool = tools.at(&format!("{base}/mcp")).await.unwrap();
    assert_eq!(tools.bearer(&tool).await, Err(Unusable::SignInAgain));
}

/// A tool with a token, or none, that can't be reached says so; one whose server turns it away
/// says what to do about that.
#[tokio::test]
async fn token_and_open_tools_say_whether_they_were_turned_away_or_unreachable() {
    let folder = Folder::new();
    let tools = Tools::for_tests(&folder.0);
    let offline = format!("{}/mcp", closed_address());
    let tool = tools.connected_for_tests("Tracker", &offline, TOKEN).await;
    assert_eq!(
        client::open(&tools, &tool).await.err(),
        Some(client::unreachable("Tracker"))
    );

    let (base, _fake) = start(Guard::Token).await;
    let url = format!("{base}/mcp");
    let tool = tools.connected_for_tests("Tracker 2", &url, "wrong").await;
    assert_eq!(
        client::open(&tools, &tool).await.err(),
        Some(client::token_again("Tracker 2"))
    );

    let open = |url: &str| ConnectedTool {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: "Docs".into(),
        url: url.to_owned(),
        auth: Auth::None,
        calls: Vec::new(),
        checked_at: None,
        metadata: None,
        pending: false,
        problem: None,
    };
    assert_eq!(
        client::open(&tools, &open(&url)).await.err().as_deref(),
        Some("Docs now asks who is calling. Remove it in Connections and connect it again.")
    );
    assert_eq!(
        client::open(&tools, &open(&offline)).await.err(),
        Some(client::unreachable("Docs"))
    );
}

#[tokio::test]
async fn refuses_changes_from_another_site_and_addresses_that_arent_https() {
    let folder = Folder::new();
    let app = router(Tools::for_tests(&folder.0));
    let request = Request::builder()
        .method("POST")
        .uri("/api/tools")
        .header(header::HOST, "127.0.0.1:3000")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"url": "https://mcp.example.com/mcp"}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let (status, body) = ask(
        &app,
        "POST",
        "/api/tools",
        Some(json!({"url": "http://mcp.example.com/mcp"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("https://"));
}

#[test]
fn slugs_and_names_stay_inside_their_limits() {
    assert_eq!(slug("Microsoft Learn"), "microsoft_learn");
    assert_eq!(slug("  !!  "), "tool");
    assert_eq!(slug("A very long tool name indeed"), "a_very_long_tool_nam");
    let taken = vec![ConnectedTool {
        id: "1".into(),
        name: "Linear".into(),
        url: "https://mcp.linear.app/mcp".into(),
        auth: Auth::SignIn,
        calls: Vec::new(),
        checked_at: None,
        metadata: None,
        pending: false,
        problem: None,
    }];
    assert_eq!(unique_name("linear", &taken), "linear 2");
    assert_eq!(unique_name("  Docs   site ", &taken), "Docs site");
}
