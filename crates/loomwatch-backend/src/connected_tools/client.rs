//! Talking to a connected tool's server: one anonymous hello to learn how it signs in, then
//! sessions over Streamable HTTP through rmcp, which lists its calls and makes them.
use std::time::Duration;

use rmcp::ServiceExt as _;
use rmcp::model::{CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation};
use rmcp::service::{ClientInitializeError, RoleClient, RunningService};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::auth::{AuthClient, AuthError, AuthorizationManager};
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, InsufficientScopeError, StreamableHttpClientTransportConfig,
};
use serde_json::{Value, json};

use super::vault::Secret;
use super::{Auth, ConnectedTool, MAX_CALLS, ToolCall, Tools, Unusable};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Saying hello, signing in included.
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// One call. A tool that takes longer is told it took too long; the agent carries on.
pub(super) const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Listing every call it offers.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest description of one call kept: some servers write pages.
const MAX_DESCRIPTION_CHARS: usize = 1_000;

/// A conversation with one tool's server.
pub(super) type Session = RunningService<RoleClient, ClientConfig>;

/// The HTTPS client every tool session and sign-in uses. No overall timeout: a server may answer
/// a call as an event stream that stays open; each step has its own limit instead.
pub(super) fn http() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("LoomWatch/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// What an address answered an anonymous hello with.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Hello {
    /// It talks to anyone.
    Open,
    /// It wants to know who is calling: its `WWW-Authenticate` header, if it sent one.
    Challenge(Option<String>),
}

/// Say hello to `url` without signing in, to learn whether it is a tool server and how it signs
/// in. Nothing is kept.
pub(super) async fn hello(http: &reqwest::Client, url: &str) -> Result<Hello, String> {
    let response = http
        .post(url)
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
        .timeout(OPEN_TIMEOUT)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "LoomWatch", "version": env!("CARGO_PKG_VERSION")},
            },
        }))
        .send()
        .await
        .map_err(|_| {
            "LoomWatch couldn't reach that address. Check it, and that this computer is online."
                .to_owned()
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(Hello::Open);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        let challenge = response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        return Ok(Hello::Challenge(challenge));
    }
    Err(match status.as_u16() {
        403 => "That tool refused LoomWatch. If the service lists approved apps, ask its admin to allow LoomWatch.".to_owned(),
        404 | 405 | 406 | 415 => "That address isn't a tool's address. Use the one the service lists as its “MCP server” address, which often ends in /mcp.".to_owned(),
        429 => "That tool is busy. Wait a minute and try again.".to_owned(),
        _ => format!("That tool answered with an error ({status}). Try again shortly."),
    })
}

/// What `LoomWatch` says it is when it says hello.
fn client_info() -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("LoomWatch", env!("CARGO_PKG_VERSION")),
    )
}

/// Open a session with `tool`'s server, signed in as it was connected.
pub(super) async fn open(tools: &Tools, tool: &ConnectedTool) -> Result<Session, String> {
    let http = tools.inner.http.clone();
    let config = StreamableHttpClientTransportConfig::with_uri(tool.url.as_str());
    let opened = match tool.auth {
        Auth::None => {
            tokio::time::timeout(
                OPEN_TIMEOUT,
                client_info().serve(StreamableHttpClientTransport::with_client(http, config)),
            )
            .await
        }
        Auth::Token => {
            let Ok(Some(Secret::Token { token })) = tools.inner.vault.get(&tool.id).await else {
                return Err(token_again(&tool.name));
            };
            tokio::time::timeout(
                OPEN_TIMEOUT,
                client_info().serve(StreamableHttpClientTransport::with_client(
                    http,
                    config.auth_header(token),
                )),
            )
            .await
        }
        Auth::SignIn => {
            let mut manager = AuthorizationManager::new(tool.url.as_str())
                .await
                .map_err(|_| unreachable(&tool.name))?;
            manager.set_credential_store(tools.sign_in_store(&tool.id));
            if let Some(metadata) = &tool.metadata {
                manager.set_metadata(metadata.clone());
            }
            match manager.initialize_from_store().await {
                Ok(true) => {}
                Ok(false) => return Err(sign_in_again(&tool.name)),
                Err(AuthError::CredentialStoreError(said)) => {
                    return Err(said);
                }
                Err(_) => return Err(unreachable(&tool.name)),
            }
            let client = AuthClient::new(http, manager);
            tokio::time::timeout(
                OPEN_TIMEOUT,
                client_info().serve(StreamableHttpClientTransport::with_client(client, config)),
            )
            .await
        }
    };
    match opened {
        Ok(Ok(session)) => Ok(session),
        Ok(Err(error)) => Err(refused(tool, &error)),
        Err(_) => Err(format!(
            "{} took too long to answer. Try again shortly.",
            tool.name
        )),
    }
}

/// Every call `session` offers, the first [`MAX_CALLS`] of them.
pub(super) async fn calls(session: &Session, name: &str) -> Result<Vec<ToolCall>, String> {
    let listed = tokio::time::timeout(LIST_TIMEOUT, session.peer().list_all_tools())
        .await
        .map_err(|_| format!("{name} took too long to say what it offers."))?
        .map_err(|_| format!("{name} couldn't say what it offers. Try again shortly."))?;
    let mut calls = Vec::new();
    for tool in listed {
        let Ok(tool) = serde_json::to_value(&tool) else {
            continue;
        };
        if let Some(call) = call_of(&tool)
            && !calls.iter().any(|known: &ToolCall| known.name == call.name)
        {
            calls.push(call);
        }
        if calls.len() == MAX_CALLS {
            break;
        }
    }
    Ok(calls)
}

/// One call, from a tool definition `{name, title, description, inputSchema, annotations}`.
fn call_of(tool: &Value) -> Option<ToolCall> {
    let name = tool.get("name")?.as_str()?.trim();
    if name.is_empty() || name.len() > 128 {
        return None;
    }
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let annotations = tool.get("annotations");
    let title =
        text(tool.get("title")).or_else(|| text(annotations.and_then(|notes| notes.get("title"))));
    let description: String = text(tool.get("description"))
        .unwrap_or_default()
        .chars()
        .take(MAX_DESCRIPTION_CHARS)
        .collect();
    let input_schema = match tool.get("inputSchema") {
        Some(schema @ Value::Object(_)) => schema.clone(),
        _ => json!({"type": "object"}),
    };
    Some(ToolCall {
        name: name.to_owned(),
        title,
        description,
        input_schema,
        read_only: annotations
            .and_then(|notes| notes.get("readOnlyHint"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Make call `name` with `arguments`, and answer what it returned as text, and whether it failed.
pub(super) async fn call(
    session: &Session,
    tool: &str,
    name: &str,
    arguments: Value,
) -> (String, bool) {
    let Value::Object(arguments) = arguments else {
        return ("The arguments must be a JSON object.".to_owned(), true);
    };
    let params = CallToolRequestParams::new(name.to_owned()).with_arguments(arguments);
    match tokio::time::timeout(CALL_TIMEOUT, session.call_tool(params)).await {
        Ok(Ok(result)) => serde_json::to_value(&result).map_or_else(
            |_| {
                (
                    format!("{tool} answered in a way LoomWatch can't read."),
                    true,
                )
            },
            |result| answer(&result),
        ),
        Ok(Err(error)) => (
            format!(
                "{tool} couldn't do that: {}",
                first_line(&error.to_string())
            ),
            true,
        ),
        Err(_) => (
            format!(
                "{tool} took longer than {} seconds, so LoomWatch stopped waiting. It may still have done it.",
                CALL_TIMEOUT.as_secs()
            ),
            true,
        ),
    }
}

/// A call result `{content: [...], structuredContent, isError}` as text, and whether it failed.
fn answer(result: &Value) -> (String, bool) {
    let failed = result.get("isError").and_then(Value::as_bool) == Some(true);
    let mut parts: Vec<String> = Vec::new();
    for part in result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let field = |pointer: &str| part.pointer(pointer).and_then(Value::as_str);
        match field("/type") {
            Some("text") => parts.extend(field("/text").map(str::to_owned)),
            Some(kind @ ("image" | "audio")) => {
                parts.push(format!(
                    "[The tool returned {}, which isn't shown here.]",
                    if kind == "image" { "an image" } else { "audio" }
                ));
            }
            Some("resource") => parts.push(field("/resource/text").map_or_else(
                || format!("[A file: {}]", field("/resource/uri").unwrap_or("unnamed")),
                str::to_owned,
            )),
            Some("resource_link") => {
                parts.push(format!("[A link: {}]", field("/uri").unwrap_or("unnamed")));
            }
            _ => {}
        }
    }
    if parts.is_empty()
        && let Some(structured) = result
            .get("structuredContent")
            .filter(|value| !value.is_null())
    {
        parts.push(structured.to_string());
    }
    if parts.is_empty() {
        parts.push(
            if failed {
                "The tool reported an error and said nothing more."
            } else {
                "The tool returned nothing."
            }
            .to_owned(),
        );
    }
    (parts.join("\n"), failed)
}

fn first_line(text: &str) -> String {
    text.lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

/// Why opening a session failed, in words. Read from the kinds of error rmcp chains, never from
/// its text: that names the transport's Rust type, which for a sign-in tool includes `AuthClient`,
/// so a sign-in tool that was only offline read as one whose sign-in had expired.
fn refused(tool: &ConnectedTool, error: &ClientInitializeError) -> String {
    // The outer error names no source; the transport's own error chains to a 401's challenge, or
    // to what went wrong renewing the sign-in.
    let ClientInitializeError::TransportError { error, .. } = error else {
        return unreachable(&tool.name);
    };
    let causes =
        std::iter::successors(Some(error as &(dyn std::error::Error + 'static)), |cause| {
            cause.source()
        });
    for cause in causes {
        if cause.is::<AuthRequiredError>() || cause.is::<InsufficientScopeError>() {
            return turned_away(tool);
        }
        if let Some(error) = cause.downcast_ref::<AuthError>() {
            if let AuthError::CredentialStoreError(said) = error {
                return said.clone();
            }
            // Read as [`Tools::bearer`] reads it: a renewal that couldn't reach the tool's site
            // is not one it turned down.
            return if Unusable::of(error) == Unusable::SignInAgain {
                turned_away(tool)
            } else {
                unreachable(&tool.name)
            };
        }
    }
    unreachable(&tool.name)
}

/// What to do when `tool`'s server turns away who is calling.
fn turned_away(tool: &ConnectedTool) -> String {
    match tool.auth {
        Auth::Token => token_again(&tool.name),
        Auth::SignIn => sign_in_again(&tool.name),
        Auth::None => format!(
            "{} now asks who is calling. Remove it in Connections and connect it again.",
            tool.name
        ),
    }
}

pub(super) fn sign_in_again(name: &str) -> String {
    format!("Your {name} sign-in has expired. Open Connections and sign in to {name} again.")
}

pub(super) fn token_again(name: &str) -> String {
    format!("{name} refused its token. Open Connections and paste a new one.")
}

pub(super) fn unreachable(name: &str) -> String {
    format!("LoomWatch couldn't reach {name}. Check this computer is online and try again shortly.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_tool_definition_and_keeps_only_the_hint_it_gives() {
        let call = call_of(&json!({
            "name": "create_issue",
            "description": "Create a Linear issue.",
            "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}},
            "annotations": {"title": "Create issue", "readOnlyHint": false},
        }))
        .expect("a call");
        assert_eq!(call.name, "create_issue");
        assert_eq!(call.title.as_deref(), Some("Create issue"));
        assert!(!call.read_only);
        assert_eq!(call.input_schema["properties"]["title"]["type"], "string");

        let bare =
            call_of(&json!({"name": "list_teams", "inputSchema": "nonsense"})).expect("a call");
        assert_eq!(bare.input_schema, json!({"type": "object"}));
        assert_eq!(bare.label(), "List teams");
        assert!(call_of(&json!({"name": "  "})).is_none());
    }

    #[test]
    fn answers_text_and_names_what_it_cannot_show() {
        let (text, failed) = answer(&json!({
            "content": [
                {"type": "text", "text": "Created ENG-12"},
                {"type": "image", "data": "aGk=", "mimeType": "image/png"},
                {"type": "resource_link", "uri": "https://linear.app/x/ENG-12", "name": "ENG-12"},
            ],
        }));
        assert!(!failed);
        assert_eq!(
            text,
            "Created ENG-12\n[The tool returned an image, which isn't shown here.]\n[A link: https://linear.app/x/ENG-12]"
        );
        let (text, failed) =
            answer(&json!({"content": [], "structuredContent": {"id": 7}, "isError": true}));
        assert!(failed);
        assert_eq!(text, r#"{"id":7}"#);
        assert_eq!(answer(&json!({})).0, "The tool returned nothing.");
    }

    /// A server that takes the connection and never answers, so the request gives up: a sign-in
    /// tool that took too long can't be reached, which says nothing about its sign-in.
    #[tokio::test]
    async fn a_sign_in_tool_that_times_out_is_unreachable_not_expired() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((connection, _)) = listener.accept().await {
                held.push(connection);
            }
        });
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let manager = AuthorizationManager::new(url.as_str()).await.unwrap();
        let transport = StreamableHttpClientTransport::with_client(
            AuthClient::new(http, manager),
            StreamableHttpClientTransportConfig::with_uri(url.as_str()),
        );
        let Err(error) = client_info().serve(transport).await else {
            panic!("a server that never answers opened a session");
        };
        let tool = ConnectedTool {
            id: "1".into(),
            name: "Notion".into(),
            url,
            auth: Auth::SignIn,
            calls: Vec::new(),
            checked_at: None,
            metadata: None,
            pending: false,
            problem: None,
        };
        assert_eq!(refused(&tool, &error), unreachable("Notion"));
    }
}
