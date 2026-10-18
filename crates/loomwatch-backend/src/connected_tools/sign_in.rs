//! Signing in to a connected tool through its own site, the way the MCP specification lets any
//! app: `LoomWatch` finds where the server signs in (RFC 9728, RFC 8414), registers itself for
//! this sign-in (RFC 7591), and proves the code with PKCE instead of a secret. Notion's sign-in
//! (`notion/sign_in.rs`) does the same for one server; rmcp does it here for any.
//!
//! The consent page opens in a new window, so the page that started it keeps whatever the operator
//! was writing. The server sends that window back to [`CALLBACK`], which finishes the sign-in, says
//! so, and tells the app's other windows over a `BroadcastChannel`.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use rmcp::transport::auth::{
    AuthorizationManager, AuthorizationMetadata, AuthorizationRequest, AuthorizationSession,
};

use super::{ConnectedTool, Tools};

/// Where a tool's site sends the browser back.
pub(super) const CALLBACK: &str = "/api/tools/sign-in/callback";
/// How long a started sign-in waits for the site to send the browser back.
const PENDING_FOR: Duration = Duration::from_mins(10);
/// The most sign-ins under way at once; starting another drops the oldest.
const MAX_PENDING: usize = 8;

/// Sign-ins started and not yet sent back, by the one-time `state` each consent page carries.
#[derive(Default)]
pub(super) struct Pending(std::sync::Mutex<HashMap<String, Started>>);

struct Started {
    tool: String,
    session: AuthorizationSession,
    at: Instant,
}

/// How a sign-in ended, for the page the browser lands on and the app's other windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    Connected,
    /// The operator chose not to allow it on the tool's site.
    Denied,
    /// Nothing waits for this answer: it took over 10 minutes, or another window finished it.
    Expired,
    Failed,
}

impl Outcome {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }
}

/// What starting a sign-in found out.
pub(super) enum Begun {
    /// Open this consent page.
    Consent {
        url: String,
        metadata: Box<AuthorizationMetadata>,
    },
    /// The server publishes no sign-in of its own: it wants a token instead.
    NoSignIn,
}

/// Start signing in to `tool`, whose server answered with `challenge`: register `LoomWatch` with
/// its site for this sign-in, and answer the consent page to open. `redirect_uri` is
/// [`CALLBACK`] on the address the app was opened at.
pub(super) async fn start(
    tools: &Tools,
    tool: &ConnectedTool,
    challenge: Option<&str>,
    redirect_uri: &str,
) -> Result<Begun, String> {
    let mut manager = AuthorizationManager::new(tool.url.as_str())
        .await
        .map_err(|_| couldnt_start(&tool.name))?;
    manager.set_credential_store(tools.sign_in_store(&tool.id));
    let Ok(resolution) = manager.resolve_metadata_from_challenge(challenge).await else {
        return Ok(Begun::NoSignIn);
    };
    if !resolution.source.is_discovered() {
        return Ok(Begun::NoSignIn);
    }
    let metadata = Box::new(resolution.metadata.clone());
    if metadata.registration_endpoint.is_none() {
        // It signs in only apps it registered by hand, which LoomWatch can't be.
        return Ok(Begun::NoSignIn);
    }
    // Least privilege: ask for the scopes the tool itself names (its challenge and its protected
    // resource metadata), and never for everything its sign-in server can grant, which is what
    // rmcp would ask for when the tool names none (Todoist's server offers billing and delete).
    let needed = manager.select_scopes(None, &[]);
    let mut granting = resolution.metadata;
    if needed.is_empty() {
        granting.scopes_supported = None;
    }
    manager.set_metadata(granting);
    let request = AuthorizationRequest::new(redirect_uri).with_client_name("LoomWatch");
    let request = if needed.is_empty() {
        request
    } else {
        request.with_scopes(needed)
    };
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|_| couldnt_start(&tool.name))?;
    let url = session.get_authorization_url().to_owned();
    let state = url::Url::parse(&url)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "state")
                .map(|(_, value)| value.into_owned())
        })
        .ok_or_else(|| couldnt_start(&tool.name))?;
    let mut pending = tools
        .inner
        .sign_ins
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    pending.retain(|_, started| started.at.elapsed() < PENDING_FOR);
    // A second sign-in to the same tool replaces the first: only the newest page can finish.
    pending.retain(|_, started| started.tool != tool.id);
    while pending.len() >= MAX_PENDING {
        let Some(oldest) = pending
            .iter()
            .min_by_key(|(_, started)| started.at)
            .map(|(state, _)| state.clone())
        else {
            break;
        };
        pending.remove(&oldest);
    }
    pending.insert(
        state,
        Started {
            tool: tool.id.clone(),
            session,
            at: Instant::now(),
        },
    );
    Ok(Begun::Consent { url, metadata })
}

/// Finish the sign-in the site sent back with `state` and `code`: trade the code for tokens,
/// which rmcp keeps in the vault. Answers the tool's id, and how it ended.
pub(super) async fn finish(
    tools: &Tools,
    state: &str,
    code: Option<&str>,
    denied: bool,
) -> (Option<String>, Outcome) {
    let started = tools
        .inner
        .sign_ins
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(state);
    let Some(started) = started.filter(|started| started.at.elapsed() < PENDING_FOR) else {
        return (None, Outcome::Expired);
    };
    let tool = Some(started.tool.clone());
    if denied {
        return (tool, Outcome::Denied);
    }
    let Some(code) = code.filter(|code| !code.is_empty()) else {
        return (tool, Outcome::Failed);
    };
    match started.session.handle_callback(code, state).await {
        Ok(_) => (tool, Outcome::Connected),
        Err(error) => {
            eprintln!("warning: a tool sign-in could not be finished: {error}");
            (tool, Outcome::Failed)
        }
    }
}

fn couldnt_start(name: &str) -> String {
    format!(
        "{name} didn't let LoomWatch start a sign-in. Try again, or paste a token instead if the service gives you one."
    )
}

/// The page the browser lands on after a sign-in: what happened, in words, and a message to the
/// app's other windows so the one that started it carries on.
pub(super) fn landing_page(tool: Option<&str>, outcome: Outcome, name: Option<&str>) -> String {
    let name = name.unwrap_or("the tool");
    let (title, said) = match outcome {
        Outcome::Connected => (
            "Connected".to_owned(),
            format!("{name} is connected to LoomWatch. You can close this tab."),
        ),
        Outcome::Denied => (
            "Not connected".to_owned(),
            format!("You didn't allow LoomWatch on {name}'s site, so nothing was connected. You can close this tab."),
        ),
        Outcome::Expired => (
            "This sign-in has ended".to_owned(),
            "It took over 10 minutes, or was finished in another window. Start it again in LoomWatch.".to_owned(),
        ),
        Outcome::Failed => (
            "Not connected".to_owned(),
            format!("{name} sent LoomWatch back without a sign-in it could use. Start it again in LoomWatch."),
        ),
    };
    let message = serde_json::json!({"tool": tool, "outcome": outcome.as_str()}).to_string();
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{title}</title>\
<style>:root{{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}}body{{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}}main{{max-width:28rem;padding:2rem 1.5rem;text-align:center}}h1{{font-size:1.25rem;margin:0 0 .5rem}}p{{margin:0;line-height:1.5;opacity:.8}}</style></head>\
<body><main><h1>{title}</h1><p>{said}</p></main>\
<script>try{{new BroadcastChannel('loomwatch-tools').postMessage({message})}}catch(e){{}}try{{if(window.opener)setTimeout(function(){{window.close()}},1200)}}catch(e){{}}</script></body></html>",
        title = escape(&title),
        said = escape(&said),
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
