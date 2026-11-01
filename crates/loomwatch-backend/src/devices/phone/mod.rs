//! What a phone may do through the door (ADR 0102): see, answer, approve, start and stop, as
//! [`ALLOWED`] lists; and, through its own routes, message the agent pinned to the notch
//! ([`pinned`]) and change a few things on an agent ([`agents`]) or a team ([`teams`]). Keys,
//! sign-ins, what agents read and the app's settings stay on the computer that runs `LoomWatch`.
//!
//! It calls `LoomWatch` on this computer as any local program does ([`daemon`]), so a phone's
//! request passes the same checks as everyone else's.

mod agents;
mod daemon;
mod doing;
pub(super) mod home;
pub(super) mod pinned;
mod studio;
mod talk;
mod teams;

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tower_http::compression::CompressionLayer;

pub use daemon::Daemon;
use home::home_view;
use studio::floor;

/// What a phone request may ask of the daemon: a method and a path, where `{}` stands for one
/// segment (a run id, a request id). Anything else answers 404 and never reaches the daemon.
pub const ALLOWED: &[(&str, &str)] = &[
    ("GET", "/api/teams"),
    ("GET", "/api/jobs"),
    ("GET", "/api/runs"),
    ("GET", "/api/runs/{}"),
    ("GET", "/api/runs/{}/questions"),
    ("GET", "/api/chat"),
    ("GET", "/api/chat/answering"),
    ("GET", "/api/team-requests"),
    ("GET", "/api/session/events"),
    ("GET", "/api/files/raw"),
    ("GET", "/api/files/read"),
    ("GET", "/api/files/stat"),
    // Skills and Quests, read inside Agents: your skills, and what your runs have earned.
    ("GET", "/api/skills"),
    ("GET", "/api/wardrobe"),
    ("POST", "/api/runs"),
    ("POST", "/api/runs/{}/cancel"),
    ("POST", "/api/runs/{}/permissions"),
    ("POST", "/api/runs/{}/spend"),
    ("POST", "/api/runs/{}/answers"),
    ("POST", "/api/chat/messages"),
    // A file sent with a chat message, such as the picture of a part circled in the reader: kept
    // first, then named in the message's `files` (ADR 0082). See [`FILES`].
    ("PUT", "/api/chat/files"),
    // A face on something said in a chat, as the Mac's reactions put one on.
    ("POST", "/api/chat/reactions"),
    // A note that started nothing, started: "Start the team on this".
    ("POST", "/api/chat/messages/{}/start"),
    ("POST", "/api/team-requests/{}"),
    // Ask LoomWatch, to set things up by talking.
    ("POST", "/api/ask/conversations"),
    ("GET", "/api/ask/conversations/{}"),
    ("POST", "/api/ask/conversations/{}/messages"),
    ("DELETE", "/api/ask/conversations/{}"),
];

/// The most a phone may send in one request. Messages, answers and approvals are small.
const BODY_LIMIT: usize = 1024 * 1024;

/// The calls on [`ALLOWED`] that carry a file's bytes rather than words: raw bytes only
/// (`application/octet-stream`), as the daemon takes them, and up to a chat file's size
/// ([`crate::chosen_knowledge::MAX_FILE_BYTES`]) in place of [`BODY_LIMIT`].
const FILES: &[(&str, &str)] = &[("PUT", "/api/chat/files")];

/// The phone's side of the door: `LoomWatch` here, and what each live run's agents were last seen
/// doing.
pub struct Phone {
    daemon: Daemon,
    /// Each live run's newest events, so asking what it is doing reads only what came since.
    steps: tokio::sync::Mutex<std::collections::HashMap<String, Vec<serde_json::Value>>>,
}

impl Phone {
    #[must_use]
    pub fn new(daemon: Daemon) -> Arc<Self> {
        Arc::new(Self {
            daemon,
            steps: tokio::sync::Mutex::default(),
        })
    }
}

/// The phone's routes, for a request whose key the door has already checked.
pub fn router(helper: Arc<Phone>) -> Router {
    Router::new()
        .route("/phone/v0/hello", get(hello))
        .route("/phone/v0/home", get(home))
        .route("/phone/v0/studio", get(studio_view))
        .route("/phone/v0/pinned", get(pinned_view).post(pin))
        .route("/phone/v0/pinned/messages", post(pinned_message))
        .route("/phone/v0/runs/{id}/talk", get(run_talk))
        .route("/phone/v0/runs/{id}/doing", get(run_doing))
        .route("/phone/v0/ask/{id}", get(ask_view))
        .route("/phone/v0/agents", get(agents_list))
        .route("/phone/v0/agents/{id}", get(agent_view).post(agent_save))
        .route("/phone/v0/agents/{id}/chat", get(agent_chat))
        .route("/phone/v0/agents/{id}/messages", post(agent_message))
        .route("/phone/v0/models", get(models_view))
        .route("/phone/v0/team", get(team_view).post(team_save))
        .fallback(forward)
        .layer(CompressionLayer::new())
        .with_state(helper)
}

/// Whether the phone may make this call: the method and every segment must match one entry.
#[must_use]
pub fn allowed(method: &Method, path: &str) -> bool {
    listed(ALLOWED, method, path)
}

/// Whether one entry of `list` matches the method and every segment.
fn listed(list: &[(&str, &str)], method: &Method, path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    list.iter().any(|(allowed_method, pattern)| {
        let pattern: Vec<&str> = pattern.split('/').collect();
        method.as_str() == *allowed_method
            && pattern.len() == segments.len()
            && pattern.iter().zip(&segments).all(|(want, got)| {
                if *want == "{}" {
                    !got.is_empty() && *got != "." && *got != ".." && !got.contains('%')
                } else {
                    want == got
                }
            })
    })
}

async fn hello(State(helper): State<Arc<Phone>>) -> Response {
    let about = helper.daemon.get_json("/api/about").await.ok();
    Json(json!({
        "helper": env!("CARGO_PKG_VERSION"),
        "loomwatch": {
            "running": about.is_some(),
            "version": about.as_ref().and_then(|about| about.get("version")).cloned(),
        },
    }))
    .into_response()
}

async fn home(State(helper): State<Arc<Phone>>) -> Response {
    let (runs, requests) = tokio::join!(
        helper
            .daemon
            .get_json("/api/runs?finishedWithin=86400&preview=true"),
        helper.daemon.get_json("/api/team-requests"),
    );
    match runs {
        Ok(runs) => Json(home_view(&runs, &requests.unwrap_or_default())).into_response(),
        Err(_) => not_running(),
    }
}

/// The studio: every team as a floor, its agents in team order with their figures, and the teams
/// folder, so the phone can start a team by its full path.
async fn studio_view(State(helper): State<Arc<Phone>>) -> Response {
    let (teams, jobs) = tokio::join!(
        helper.daemon.get_json("/api/teams"),
        helper.daemon.get_json("/api/jobs"),
    );
    let Ok(teams) = teams else {
        return not_running();
    };
    let jobs = jobs.unwrap_or_default();
    let mut floors = Vec::new();
    for team in teams
        .get("teams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(path) = team.get("path").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Ok(file) = helper.daemon.get_json(&team_query(path)).await else {
            continue;
        };
        let yaml = file
            .get("yaml")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let name = team.get("name").and_then(serde_json::Value::as_str);
        floors.push(floor(path, name, yaml, &jobs));
    }
    Json(json!({ "root": teams.get("root"), "floors": floors })).into_response()
}

/// The agent pinned to the notch and its chat ([`pinned`]).
async fn pinned_view(State(helper): State<Arc<Phone>>) -> Response {
    match pinned::pinned_view(&helper.daemon).await {
        Ok(view) => Json(view).into_response(),
        Err(_) => not_running(),
    }
}

/// A message to the pinned agent ([`pinned::send_to_pinned`]).
async fn pinned_message(
    State(helper): State<Arc<Phone>>,
    Json(message): Json<pinned::PinnedMessage>,
) -> Response {
    match pinned::send_to_pinned(&helper.daemon, message).await {
        Ok((status, reply)) => (status, Json(reply)).into_response(),
        Err(_) => not_running(),
    }
}

/// A saved agent's id, as `jobs::is_job_id` takes it: one plain file name.
fn plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `{agent}` to pin, or `null` to unpin.
#[derive(serde::Deserialize)]
struct PinBody {
    agent: Option<String>,
}

/// Pins one of My agents to the Mac's notch ([`pinned::pin`]).
async fn pin(State(helper): State<Arc<Phone>>, Json(body): Json<PinBody>) -> Response {
    if body.agent.as_deref().is_some_and(|id| !plain_id(id)) {
        return problem(StatusCode::NOT_FOUND, "No such agent.");
    }
    match pinned::pin(&helper.daemon, body.agent.as_deref()).await {
        Ok((status, reply)) => (status, Json(reply)).into_response(),
        Err(_) => not_running(),
    }
}

/// One of My agents' own chat ([`pinned::chat_view`]).
async fn agent_chat(
    State(helper): State<Arc<Phone>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if !plain_id(&id) {
        return problem(StatusCode::NOT_FOUND, "No such agent.");
    }
    match pinned::chat_view(&helper.daemon, &id).await {
        Ok(view) => Json(view).into_response(),
        Err(_) => not_running(),
    }
}

/// A message in one of My agents' own chat ([`pinned::send_to`]).
async fn agent_message(
    State(helper): State<Arc<Phone>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(message): Json<pinned::PinnedMessage>,
) -> Response {
    if !plain_id(&id) {
        return problem(StatusCode::NOT_FOUND, "No such agent.");
    }
    match pinned::send_to(&helper.daemon, &id, message).await {
        Ok((status, reply)) => (status, Json(reply)).into_response(),
        Err(_) => not_running(),
    }
}

/// One of My agents, for its bench ([`agents::agent_view`]).
/// My agents with their figures ([`agents::agents_list`]).
async fn agents_list(State(helper): State<Arc<Phone>>) -> Response {
    match agents::agents_list(&helper.daemon).await {
        Ok(list) => Json(list).into_response(),
        Err(_) => not_running(),
    }
}

async fn agent_view(
    State(helper): State<Arc<Phone>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if !plain_id(&id) {
        return problem(StatusCode::NOT_FOUND, "No such agent.");
    }
    match agents::agent_view(&helper.daemon, &id).await {
        Ok(Some(view)) => Json(view).into_response(),
        Ok(None) => problem(
            StatusCode::NOT_FOUND,
            "That agent isn't in My agents any more.",
        ),
        Err(_) => not_running(),
    }
}

/// A change to one of My agents ([`agents::save_agent`]).
async fn agent_save(
    State(helper): State<Arc<Phone>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(change): Json<agents::AgentChange>,
) -> Response {
    if !plain_id(&id) {
        return problem(StatusCode::NOT_FOUND, "No such agent.");
    }
    match agents::save_agent(&helper.daemon, &id, change).await {
        Ok((status, reply)) => (status, Json(reply)).into_response(),
        Err(_) => not_running(),
    }
}

/// `?path=` on a team route.
#[derive(serde::Deserialize)]
struct TeamPath {
    path: String,
}

/// One team's settings and workflow ([`teams::team_view`]).
async fn team_view(
    State(helper): State<Arc<Phone>>,
    axum::extract::Query(query): axum::extract::Query<TeamPath>,
) -> Response {
    match teams::team_view(&helper.daemon, &query.path).await {
        Ok(view) => Json(view).into_response(),
        Err(_) => problem(
            StatusCode::NOT_FOUND,
            "That team isn't on your Mac any more.",
        ),
    }
}

/// A change to a team ([`teams::save_team`]).
async fn team_save(
    State(helper): State<Arc<Phone>>,
    Json(change): Json<teams::TeamChange>,
) -> Response {
    match teams::save_team(&helper.daemon, change).await {
        Ok((status, reply)) => (status, Json(reply)).into_response(),
        Err(_) => not_running(),
    }
}

/// The models an agent may think with ([`agents::models_view`]).
async fn models_view(State(helper): State<Arc<Phone>>) -> Response {
    match agents::models_view(&helper.daemon).await {
        Ok(view) => Json(view).into_response(),
        Err(_) => not_running(),
    }
}

/// An Ask `LoomWatch` conversation: its state and what Ask said, read from its events.
async fn ask_view(
    State(helper): State<Arc<Phone>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if !id.starts_with("ask-") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return problem(StatusCode::NOT_FOUND, "No such conversation.");
    }
    let Ok(status) = helper
        .daemon
        .get_json(&format!("/api/ask/conversations/{id}"))
        .await
    else {
        return problem(StatusCode::NOT_FOUND, "This conversation has ended.");
    };
    let events = helper
        .daemon
        .get_json(&format!(
            "/api/session/events?session={id}&afterSeq=-1&limit=500&lean=true"
        ))
        .await
        .ok()
        .and_then(|events| events.as_array().cloned())
        .unwrap_or_default();
    Json(json!({"status": status, "lines": talk::talk(&events)})).into_response()
}

/// One run's record and what was said in it ([`talk::talk`]), its events read page by page.
async fn run_talk(
    State(helper): State<Arc<Phone>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    const PAGE: usize = 500;
    const MOST: usize = 20;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return problem(StatusCode::NOT_FOUND, "No such work.");
    }
    let Ok(run) = helper.daemon.get_json(&format!("/api/runs/{id}")).await else {
        return not_running();
    };
    let mut events: Vec<serde_json::Value> = Vec::new();
    for _ in 0..MOST {
        let after = events
            .last()
            .and_then(|event| event.get("seq"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(-1);
        let Ok(page) = helper
            .daemon
            .get_json(&format!(
                "/api/session/events?session={id}&afterSeq={after}&limit={PAGE}&lean=true"
            ))
            .await
        else {
            break;
        };
        let page = page.as_array().cloned().unwrap_or_default();
        let full = page.len() == PAGE;
        events.extend(page);
        if !full {
            break;
        }
    }
    Json(json!({"run": run, "lines": talk::talk(&events)})).into_response()
}

/// What one agent of a live run is doing now ([`doing::doing`]): `?agent=<id>`, or the whole run's
/// newest step without it. Reads only the events since the last ask, and keeps the newest few.
async fn run_doing(
    State(helper): State<Arc<Phone>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    const PAGE: usize = 500;
    const KEEP: usize = 400;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return problem(StatusCode::NOT_FOUND, "No such work.");
    }
    let mut steps = helper.steps.lock().await;
    // Runs come and go: keep only a handful.
    if steps.len() > 16 && !steps.contains_key(&id) {
        steps.clear();
    }
    let kept = steps.entry(id.clone()).or_default();
    for _ in 0..20 {
        let after = kept
            .last()
            .and_then(|event| event.get("seq"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(-1);
        let Ok(page) = helper
            .daemon
            .get_json(&format!(
                "/api/session/events?session={id}&afterSeq={after}&limit={PAGE}&lean=true"
            ))
            .await
        else {
            return not_running();
        };
        let page = page.as_array().cloned().unwrap_or_default();
        let full = page.len() == PAGE;
        kept.extend(page);
        if kept.len() > KEEP {
            kept.drain(..kept.len() - KEEP);
        }
        if !full {
            break;
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        });
    Json(doing::doing(
        kept,
        query.get("agent").map(String::as_str),
        now,
    ))
    .into_response()
}

/// `/api/team?path=<path>`, the path encoded as a query value.
pub(crate) fn team_query(path: &str) -> String {
    let mut url = reqwest::Url::parse("http://loomwatch/api/team").expect("a fixed URL parses");
    url.query_pairs_mut().append_pair("path", path);
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

async fn forward(State(helper): State<Arc<Phone>>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if !allowed(&method, &path) {
        return problem(
            StatusCode::NOT_FOUND,
            "The phone can't do this. It stays on the Mac.",
        );
    }
    let file = listed(FILES, &method, &path);
    let path_and_query = request
        .uri()
        .path_and_query()
        .map_or(path, |value| value.as_str().to_owned());
    let content_type = request.headers().get(header::CONTENT_TYPE).cloned();
    let bytes_only = content_type
        .as_ref()
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/octet-stream"));
    if file && !bytes_only {
        return problem(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Send the file as application/octet-stream.",
        );
    }
    let limit = if file {
        crate::chosen_knowledge::MAX_FILE_BYTES
    } else {
        BODY_LIMIT
    };
    let Ok(body) = to_bytes(request.into_body(), limit).await else {
        return problem(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That is too big to send from the phone.",
        );
    };
    let Ok(reply) = helper
        .daemon
        .send(method, &path_and_query, content_type, body)
        .await
    else {
        return not_running();
    };
    let mut response = Response::builder().status(reply.status().as_u16());
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_DISPOSITION,
        header::LAST_MODIFIED,
        header::ETAG,
    ] {
        if let Some(value) = reply.headers().get(name.as_str())
            && let Ok(value) = HeaderValue::from_bytes(value.as_bytes())
        {
            response = response.header(name, value);
        }
    }
    response
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(reply.bytes_stream()))
        .unwrap_or_else(|_| {
            problem(
                StatusCode::BAD_GATEWAY,
                "LoomWatch's answer didn't come through.",
            )
        })
}

fn not_running() -> Response {
    let mut response = problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "LoomWatch isn't running on this Mac.",
    );
    response
        .headers_mut()
        .insert("x-loomwatch-state", HeaderValue::from_static("not_running"));
    response
}

fn problem(status: StatusCode, message: &str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (status, headers, Json(json!({"error": message}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_calls_are_allowed() {
        assert!(allowed(&Method::GET, "/api/runs"));
        assert!(allowed(&Method::POST, "/api/runs/abc-123/permissions"));
        assert!(allowed(&Method::POST, "/api/team-requests/7"));
        assert!(allowed(&Method::POST, "/api/chat/reactions"));
        assert!(allowed(&Method::GET, "/api/skills"));
        assert!(allowed(&Method::GET, "/api/wardrobe"));
        assert!(allowed(&Method::PUT, "/api/chat/files"));

        // Not on the list: settings, keys, team edits, other methods.
        assert!(!allowed(&Method::PUT, "/api/team"));
        assert!(!allowed(&Method::PUT, "/api/ai/openrouter"));
        assert!(!allowed(&Method::DELETE, "/api/runs/abc"));
        assert!(!allowed(&Method::POST, "/api/runs/abc/deliver"));
        assert!(!allowed(&Method::GET, "/api/runs/abc/permissions/extra"));
        // Reading skills, never adding, removing or bringing them in from the phone.
        assert!(!allowed(&Method::POST, "/api/skills/install"));
        assert!(!allowed(&Method::DELETE, "/api/skills/x"));
        assert!(!allowed(&Method::POST, "/api/wardrobe/earned"));
        // Sending a chat file, never another way in to the files.
        assert!(!allowed(&Method::POST, "/api/chat/files"));
        assert!(!allowed(&Method::PUT, "/api/chat/files/x"));
        assert!(!allowed(&Method::PUT, "/api/kept"));

        // A wildcard is one plain segment, never a way out of it.
        assert!(!allowed(&Method::POST, "/api/runs//cancel"));
        assert!(!allowed(&Method::POST, "/api/runs/../cancel"));
        assert!(!allowed(&Method::POST, "/api/runs/%2e%2e/cancel"));
    }
}
