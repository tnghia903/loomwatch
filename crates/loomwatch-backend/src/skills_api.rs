//! The Skills page's routes: `LoomWatch`'s skills folder, bringing skills in from the apps on this
//! computer, and installing them from GitHub, skills.sh and `ClawHub`.
//!
//! - `GET /api/skills` → `{folder, skills}`
//! - `DELETE /api/skills/{name}` → `{removed}`
//! - `POST /api/skills/bring-in/preview` → `{candidates}`
//! - `POST /api/skills/bring-in` `{keys}` → `{batchId, imported, skipped}`
//! - `POST /api/skills/bring-in/{batchId}/undo` → `{removed}`
//! - `GET /api/skills/search?q=&source=skills.sh|clawhub` → `{results}`
//! - `POST /api/skills/install/inspect` `{ref, source?}` → `{token, candidates, …}`
//! - `POST /api/skills/install` `{token, paths, replace?}` → `{installed}`
//!
//! Every route answers only this computer's own page, and every change needs the
//! `X-LoomWatch-Request: 1` header a page from another site can't send without asking. Errors
//! are `{error}` in words for the person. Nothing here runs at startup.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, OriginalUri, Path, Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::marketplace::{Endpoints, Marketplace, Source};
use crate::skills_store::{self, SkillsError, SkillsStore};

/// Bring-in keys are 16 characters each; this holds thousands of them.
const BODY_LIMIT: usize = 64 * 1024;
const MAX_KEYS: usize = 5_000;
const MAX_PATHS: usize = 500;

#[derive(Clone)]
struct SkillsState {
    store: Arc<SkillsStore>,
    market: Arc<Marketplace>,
    /// The home folder whose apps' skill folders "Bring in" reads.
    home: Arc<PathBuf>,
}

/// The Skills page's routes. `state_dir` holds `skills/` and `skills.json`; `home` is the folder
/// whose apps' skill folders bring-in reads (`capabilities::configured_home()`).
///
/// The caller must only mount this router on a loopback listener.
pub fn router(state_dir: PathBuf, home: PathBuf) -> Router {
    router_with(
        Arc::new(SkillsStore::new(state_dir)),
        Arc::new(Marketplace::new(Endpoints::public())),
        home,
    )
}

fn router_with(store: Arc<SkillsStore>, market: Arc<Marketplace>, home: PathBuf) -> Router {
    let state = SkillsState {
        store,
        market,
        home: Arc::new(home),
    };
    // A skill may be named like one of the fixed routes; deleting it still works.
    Router::new()
        .route("/api/skills", get(list))
        .route("/api/skills/{name}", delete(remove))
        .route("/api/skills/bring-in", post(bring_in).delete(remove_fixed))
        .route("/api/skills/bring-in/preview", post(preview))
        .route("/api/skills/bring-in/{batch_id}/undo", post(undo))
        .route("/api/skills/search", get(search).delete(remove_fixed))
        .route("/api/skills/install", post(install).delete(remove_fixed))
        .route("/api/skills/install/inspect", post(inspect))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .route_layer(middleware::from_fn(protect))
        .route_layer(middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(state)
}

/// Every change needs `X-LoomWatch-Request: 1`, which only `LoomWatch`'s own page sends.
/// Copied from `notion/mod.rs`.
async fn protect(request: Request, next: Next) -> Response {
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("x-loomwatch-request")
            .is_none_or(|value| value != "1")
    {
        return Failure(
            StatusCode::FORBIDDEN,
            "Open Skills in LoomWatch to change your skills.".to_owned(),
        )
        .into_response();
    }
    next.run(request).await
}

struct Failure(StatusCode, String);

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<SkillsError> for Failure {
    fn from(error: SkillsError) -> Self {
        let status = match &error {
            SkillsError::NotFound(_) => StatusCode::NOT_FOUND,
            SkillsError::Conflict(_) => StatusCode::CONFLICT,
            SkillsError::Invalid(_) | SkillsError::Refused(_) => StatusCode::UNPROCESSABLE_ENTITY,
            SkillsError::Upstream(_) => StatusCode::BAD_GATEWAY,
            SkillsError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status, error.message().to_owned())
    }
}

type Answer = Result<Response, Failure>;

/// Run folder work off the async threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, SkillsError> + Send + 'static,
) -> Result<T, Failure> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| {
            Failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("LoomWatch stopped while changing your skills: {error}"),
            )
        })?
        .map_err(Failure::from)
}

async fn list(State(state): State<SkillsState>) -> Answer {
    let store = state.store.clone();
    let skills = blocking(move || store.list()).await?;
    Ok(Json(json!({
        "folder": state.store.folder().to_string_lossy(),
        "skills": skills,
    }))
    .into_response())
}

async fn remove(State(state): State<SkillsState>, Path(name): Path<String>) -> Answer {
    removed(state, name).await
}

/// `DELETE` on a fixed route's address: a skill with that name.
async fn remove_fixed(State(state): State<SkillsState>, OriginalUri(uri): OriginalUri) -> Answer {
    let name = uri.path().rsplit('/').next().unwrap_or_default().to_owned();
    removed(state, name).await
}

async fn removed(state: SkillsState, name: String) -> Answer {
    let store = state.store.clone();
    let removed = blocking(move || store.remove(&name)).await?;
    Ok(Json(json!({ "removed": removed })).into_response())
}

async fn preview(State(state): State<SkillsState>) -> Answer {
    let store = state.store.clone();
    let home = state.home.clone();
    let candidates = blocking(move || skills_store::preview(&home, &store)).await?;
    Ok(Json(json!({ "candidates": candidates })).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BringIn {
    keys: Vec<String>,
}

async fn bring_in(State(state): State<SkillsState>, Json(body): Json<BringIn>) -> Answer {
    if body.keys.is_empty() || body.keys.len() > MAX_KEYS {
        return Err(Failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Choose the skills to bring in.".to_owned(),
        ));
    }
    let store = state.store.clone();
    let home = state.home.clone();
    let outcome = blocking(move || skills_store::bring_in(&home, &store, &body.keys)).await?;
    Ok(Json(outcome).into_response())
}

async fn undo(State(state): State<SkillsState>, Path(batch_id): Path<String>) -> Answer {
    let store = state.store.clone();
    let removed = blocking(move || store.undo(&batch_id)).await?;
    Ok(Json(json!({ "removed": removed })).into_response())
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    source: Option<String>,
}

async fn search(State(state): State<SkillsState>, Query(query): Query<SearchQuery>) -> Answer {
    let source = query
        .source
        .as_deref()
        .map_or(Some(Source::SkillsSh), Source::parse);
    let Some(source) = source else {
        return Err(Failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Search skills.sh or ClawHub.".to_owned(),
        ));
    };
    let results = state.market.search(&query.q, source).await?;
    Ok(Json(json!({ "results": results })).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inspect {
    #[serde(rename = "ref")]
    reference: String,
    source: Option<String>,
}

async fn inspect(State(state): State<SkillsState>, Json(body): Json<Inspect>) -> Answer {
    let source = match body.source.as_deref() {
        None | Some("") => None,
        Some(text) => Some(Source::parse(text).ok_or_else(|| {
            Failure(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Install from GitHub, skills.sh or ClawHub.".to_owned(),
            )
        })?),
    };
    let inspection = state
        .market
        .inspect(&state.store, &body.reference, source)
        .await?;
    Ok(Json(inspection).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Install {
    token: String,
    paths: Vec<String>,
    #[serde(default)]
    replace: bool,
}

async fn install(State(state): State<SkillsState>, Json(body): Json<Install>) -> Answer {
    if body.paths.len() > MAX_PATHS {
        return Err(Failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Choose fewer skills at once.".to_owned(),
        ));
    }
    let store = state.store.clone();
    let market = state.market.clone();
    let installed =
        blocking(move || market.install(&store, &body.token, &body.paths, body.replace)).await?;
    Ok(Json(json!({ "installed": installed })).into_response())
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;
    use crate::skills_store::tests::{Scratch, skill};

    fn app(state: &Scratch, home: &Scratch) -> Router {
        router(state.path().to_path_buf(), home.path().to_path_buf())
    }

    fn request(method: &str, uri: &str, header: bool, body: Option<Value>) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:3000");
        if header {
            builder = builder.header("X-LoomWatch-Request", "1");
        }
        match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        }
    }

    async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn skills_routes_need_the_header_to_change_anything() {
        let state = Scratch::new("state");
        let home = Scratch::new("home");
        skill(&home.path().join(".claude/skills/pdf"), "pdf", "");
        let app = app(&state, &home);

        let (status, body) = send(&app, request("GET", "/api/skills", false, None)).await;
        assert_eq!(status, StatusCode::OK, "reading needs no header");
        assert_eq!(body["skills"], Value::Array(Vec::new()));
        assert!(body["folder"].as_str().unwrap().ends_with("skills"));

        for (method, uri, body) in [
            ("POST", "/api/skills/bring-in/preview", None),
            ("POST", "/api/skills/bring-in", Some(json!({"keys": ["x"]}))),
            ("POST", "/api/skills/bring-in/abc/undo", None),
            ("DELETE", "/api/skills/pdf", None),
            (
                "POST",
                "/api/skills/install/inspect",
                Some(json!({"ref": "acme/skills"})),
            ),
            (
                "POST",
                "/api/skills/install",
                Some(json!({"token": "t", "paths": ["."]})),
            ),
        ] {
            let (status, answer) = send(&app, request(method, uri, false, body)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
            assert!(answer["error"].as_str().unwrap().contains("Open Skills"));
        }
        assert!(
            !state.path().join("skills").exists(),
            "a refused request changes nothing"
        );

        let (status, body) = send(
            &app,
            request("POST", "/api/skills/bring-in/preview", true, None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let key = body["candidates"][0]["key"].as_str().unwrap().to_owned();
        assert_eq!(body["candidates"][0]["defaultSelected"], true);
        assert_eq!(body["candidates"][0]["alreadyInLoomWatch"], false);

        let (status, body) = send(
            &app,
            request(
                "POST",
                "/api/skills/bring-in",
                true,
                Some(json!({"keys": [key]})),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["imported"][0]["name"], "pdf");
        assert_eq!(body["imported"][0]["origin"]["kind"], "brought_in");
        assert_eq!(body["imported"][0]["origin"]["app"], "Claude Code");
        let batch = body["batchId"].as_str().unwrap().to_owned();

        let (_, body) = send(&app, request("GET", "/api/skills", false, None)).await;
        assert_eq!(body["skills"][0]["name"], "pdf");
        assert_eq!(body["skills"][0]["batchId"], batch.as_str());

        let undo = format!("/api/skills/bring-in/{batch}/undo");
        let (status, body) = send(&app, request("POST", &undo, true, None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["removed"], json!(["pdf"]));
        let (status, _) = send(&app, request("POST", &undo, true, None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn skills_routes_answer_only_this_computer_and_in_words() {
        let state = Scratch::new("state");
        let home = Scratch::new("home");
        let app = app(&state, &home);

        let mut elsewhere = request("GET", "/api/skills", false, None);
        elsewhere
            .headers_mut()
            .insert(header::HOST, "attacker.example".parse().unwrap());
        let (status, _) = send(&app, elsewhere).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a rebound name is refused");

        let (status, body) = send(&app, request("DELETE", "/api/skills/missing", true, None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body["error"].as_str().unwrap().contains("no skill named"));

        let (status, body) = send(
            &app,
            request(
                "POST",
                "/api/skills/install/inspect",
                true,
                Some(json!({"ref": "https://gitlab.com/acme/skills"})),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("GitHub, skills.sh and ClawHub")
        );

        let (status, body) = send(
            &app,
            request(
                "POST",
                "/api/skills/install",
                true,
                Some(json!({"token": "gone", "paths": ["."]})),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].as_str().unwrap().contains("expired"));

        let (status, body) = send(
            &app,
            request("GET", "/api/skills/search?q=&source=clawhub", false, None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["results"], json!([]));
        let (status, _) = send(
            &app,
            request("GET", "/api/skills/search?q=x&source=npm", false, None),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

        // A skill named like a fixed route can still be removed.
        skill(&state.path().join("skills/search"), "search", "");
        let (status, body) = send(&app, request("DELETE", "/api/skills/search", true, None)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["removed"], "search");
    }
}
