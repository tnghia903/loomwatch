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

    // The site sends the browser back with a code: LoomWatch trades it for tokens.
    let (status, page) = ask(
        &app,
        "GET",
        &format!("/api/tools/sign-in/callback?state={state}&code=good-code"),
        None,
    )
    .await;
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
    let (_, page) = ask(
        &app,
        "GET",
        &format!("/api/tools/sign-in/callback?state={state}&code=good-code"),
        None,
    )
    .await;
    assert!(page.as_str().unwrap().contains("This sign-in has ended"));
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
