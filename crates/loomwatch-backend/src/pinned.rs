//! The agent pinned to the notch (ADR 0083, decision 9): one of My agents the person keeps at the
//! island at the top of the screen, to send it a message without opening `LoomWatch`.
//!
//! This keeps only which agent it is, in `pinned.json` in the state folder, beside About you: what
//! you keep at hand belongs to you on this computer, not to a teams folder you might share. One
//! agent at a time, so pinning another replaces it. An agent taken out of My agents is no longer
//! pinned: the island never offers to message an agent that is not there.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::watch_api::local_evidence;

const FILE_NAME: &str = "pinned.json";
/// The file the Mac app keeps in the state folder while Show at the notch is unticked in its menu:
/// no island on any screen, and ⌃⌥Space given back to macOS. Its twin is `OFF_FILE` in
/// `crates/loomwatch-app/src/island.rs`, which writes it.
const NOTCH_OFF_FILE: &str = "app-notch-off";

/// `pinned.json`, `GET /api/pinned-agent` and the body of `PUT /api/pinned-agent`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct PinnedAgent {
    /// The id of the agent in My agents (its file in `.jobs/`), or `None` when none is pinned.
    pub agent: Option<String>,
}

/// What `GET` and `PUT /api/pinned-agent` answer: the pinned agent, and whether there is an island
/// at the notch to message it from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedNow {
    pub agent: Option<String>,
    /// False while Show at the notch is unticked in the Mac app: the agent stays pinned, but there
    /// is no island and no ⌃⌥Space to reach it until it is ticked again.
    pub notch_shown: bool,
}

/// Which agent is pinned, shared by the routes. `file` and `state_dir` are `None` in tests that
/// keep it in memory.
#[derive(Clone)]
pub struct Pinned {
    file: Option<PathBuf>,
    state_dir: Option<PathBuf>,
    teams_root: PathBuf,
    agent: Arc<RwLock<Option<String>>>,
}

impl Pinned {
    /// What is kept in `state_dir`, for the agents in `teams_root`.
    #[must_use]
    pub fn open(state_dir: &Path, teams_root: &Path) -> Self {
        let file = state_dir.join(FILE_NAME);
        let agent = load(&file);
        Self {
            file: Some(file),
            state_dir: Some(state_dir.to_owned()),
            teams_root: teams_root.to_owned(),
            agent: Arc::new(RwLock::new(agent)),
        }
    }

    /// Kept only in memory.
    #[must_use]
    pub fn in_memory(teams_root: &Path) -> Self {
        Self {
            file: None,
            state_dir: None,
            teams_root: teams_root.to_owned(),
            agent: Arc::new(RwLock::new(None)),
        }
    }

    /// Whether the island is at the notch: so unless the Mac app says Show at the notch is off.
    #[must_use]
    pub fn notch_shown(&self) -> bool {
        self.state_dir
            .as_ref()
            .is_none_or(|state| !state.join(NOTCH_OFF_FILE).exists())
    }

    fn now(&self, pinned: PinnedAgent) -> PinnedNow {
        PinnedNow {
            agent: pinned.agent,
            notch_shown: self.notch_shown(),
        }
    }

    /// The pinned agent, while it is still one of My agents.
    #[must_use]
    pub fn get(&self) -> PinnedAgent {
        let agent = self
            .agent
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .filter(|id| crate::jobs::exists(&self.teams_root, id));
        PinnedAgent { agent }
    }

    /// Pin `next`, or nothing. Returns what is pinned now.
    pub(crate) fn set(&self, next: PinnedAgent) -> Result<PinnedAgent, SetError> {
        let agent = next.agent.map(|id| id.trim().to_owned());
        if let Some(id) = &agent
            && !crate::jobs::exists(&self.teams_root, id)
        {
            return Err(SetError::NotFound(id.clone()));
        }
        let mut kept = self.agent.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(file) = &self.file {
            let text = serde_json::to_vec_pretty(&PinnedAgent {
                agent: agent.clone(),
            })
            .map_err(|error| SetError::Unsaved(error.to_string()))?;
            crate::approvals::write_private(file, &text)
                .map_err(|error| SetError::Unsaved(error.to_string()))?;
        }
        kept.clone_from(&agent);
        Ok(PinnedAgent { agent })
    }
}

/// The stores the daemon's agents look the pin up in: the daemon installs its one at startup, and
/// tests add their own, each for its own teams folder.
static INSTALLED: Mutex<Vec<Pinned>> = Mutex::new(Vec::new());

/// Makes `pinned` the store agents look the pin up in (`front_desk`). The daemon calls this once,
/// at startup.
pub fn install(pinned: Pinned) {
    INSTALLED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(pinned);
}

/// The agent pinned to the notch, at work in its own chat (ADR 0083, decision 9): it may ask the
/// person's teams (`crate::team_requests`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrontDesk {
    /// Where the person's teams are.
    pub(crate) teams_root: PathBuf,
    /// Its chat's team file, relative to the teams root: `.jobs/.bench/<id>.yaml`.
    pub(crate) chat_path: String,
}

/// Whether `agent`, running the team in `team_path`, is the agent pinned to the notch in its own
/// chat, and if so where its teams are. Any other agent, and the pinned agent placed in a team,
/// is not.
pub(crate) fn front_desk(team_path: &Path, agent: &str) -> Option<FrontDesk> {
    let team_path =
        crate::platform::canonicalize(team_path).unwrap_or_else(|_| team_path.to_owned());
    let installed = INSTALLED.lock().unwrap_or_else(PoisonError::into_inner);
    installed.iter().find_map(|pinned| {
        let id = pinned.get().agent.filter(|id| id == agent)?;
        let chat_path = format!(
            "{}/{}/{id}.yaml",
            crate::jobs::JOBS_DIR,
            crate::jobs::BENCH_DIR
        );
        let teams_root = crate::platform::canonicalize(&pinned.teams_root)
            .unwrap_or_else(|_| pinned.teams_root.clone());
        let chat = teams_root.join(&chat_path);
        let chat = crate::platform::canonicalize(&chat).unwrap_or(chat);
        (chat == team_path).then_some(FrontDesk {
            teams_root,
            chat_path,
        })
    })
}

/// Why a pin was not kept.
#[derive(Debug)]
pub(crate) enum SetError {
    /// No agent in My agents has this id.
    NotFound(String),
    Unsaved(String),
}

/// What an earlier start kept. A file that can't be read counts as nothing pinned: the person pins
/// it again, and the island never offers an agent it half-read.
fn load(file: &Path) -> Option<String> {
    let text = match std::fs::read(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!(
                "warning: the agent pinned to the notch, in {}, could not be read: {error}",
                file.display()
            );
            return None;
        }
    };
    match serde_json::from_slice::<PinnedAgent>(&text) {
        Ok(pinned) => pinned.agent,
        Err(error) => {
            eprintln!(
                "warning: the agent pinned to the notch, in {}, could not be read: {error}",
                file.display()
            );
            None
        }
    }
}

/// `GET /api/pinned-agent` and `PUT /api/pinned-agent`. Loopback and this origin only, and a change
/// only from `LoomWatch`'s own page, which sends `X-LoomWatch-Request`.
pub fn router(pinned: Pinned) -> Router {
    Router::new()
        .route("/api/pinned-agent", get(get_pinned).put(put_pinned))
        .layer(DefaultBodyLimit::max(4 * 1024))
        .route_layer(middleware::from_fn(crate::you::from_loomwatch))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(pinned)
}

async fn get_pinned(State(pinned): State<Pinned>) -> Json<PinnedNow> {
    Json(pinned.now(pinned.get()))
}

async fn put_pinned(
    State(pinned): State<Pinned>,
    Json(next): Json<PinnedAgent>,
) -> Result<Json<PinnedNow>, ApiError> {
    let store = pinned.clone();
    let kept = tokio::task::spawn_blocking(move || store.set(next))
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    match kept {
        Ok(kept) => Ok(Json(pinned.now(kept))),
        Err(SetError::NotFound(id)) => {
            eprintln!("LoomWatch: no agent {id:?} in My agents to pin");
            Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "This agent isn’t in My agents any more.".to_owned(),
            ))
        }
        Err(SetError::Unsaved(error)) => {
            eprintln!("LoomWatch: the pinned agent could not be saved: {error}");
            Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "LoomWatch couldn’t keep the pin. Try again.".to_owned(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use axum::response::Response;
    use tower::ServiceExt as _;

    fn put(json: &str) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri("/api/pinned-agent")
            .header(header::HOST, "localhost")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-loomwatch-request", "1")
            .body(Body::from(json.to_owned()))
            .expect("request")
    }

    fn get() -> Request<Body> {
        Request::builder()
            .uri("/api/pinned-agent")
            .header(header::HOST, "localhost")
            .body(Body::empty())
            .expect("request")
    }

    async fn body(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn folder() -> TempDirectory {
        let path = std::env::temp_dir().join(format!("loomwatch-pinned-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).expect("create temporary directory");
        TempDirectory(path)
    }

    fn agent(teams: &Path, id: &str) {
        let folder = teams.join(".jobs");
        std::fs::create_dir_all(&folder).expect("jobs folder");
        std::fs::write(
            folder.join(format!("{id}.yaml")),
            format!("name: {id}\ninstructions: Help me.\n"),
        )
        .expect("job");
    }

    #[tokio::test]
    async fn one_agent_is_pinned_at_a_time_and_kept_across_a_restart() {
        let teams = folder();
        let state = folder();
        agent(teams.path(), "maya");
        agent(teams.path(), "writer");
        let app = router(Pinned::open(state.path(), teams.path()));
        assert_eq!(
            body(app.clone().oneshot(get()).await.expect("get")).await["agent"],
            serde_json::Value::Null
        );

        let pinned = app
            .clone()
            .oneshot(put(r#"{"agent":"maya"}"#))
            .await
            .expect("pin");
        assert_eq!(pinned.status(), StatusCode::OK);
        assert_eq!(body(pinned).await["agent"], "maya");
        // Pinning another replaces it.
        let replaced = app
            .clone()
            .oneshot(put(r#"{"agent":"writer"}"#))
            .await
            .expect("pin another");
        assert_eq!(body(replaced).await["agent"], "writer");
        assert_eq!(
            body(app.oneshot(get()).await.expect("get")).await["agent"],
            "writer"
        );

        // LoomWatch starts again: the same agent is pinned.
        let again = router(Pinned::open(state.path(), teams.path()));
        assert_eq!(
            body(again.clone().oneshot(get()).await.expect("get")).await["agent"],
            "writer"
        );
        // Unpinned, it stays unpinned.
        let unpinned = again
            .clone()
            .oneshot(put(r#"{"agent":null}"#))
            .await
            .expect("unpin");
        assert_eq!(body(unpinned).await["agent"], serde_json::Value::Null);
        let after = router(Pinned::open(state.path(), teams.path()));
        assert_eq!(
            body(after.oneshot(get()).await.expect("get")).await["agent"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn only_an_agent_in_my_agents_can_be_pinned_and_one_taken_out_is_no_longer() {
        let teams = folder();
        agent(teams.path(), "maya");
        let app = router(Pinned::in_memory(teams.path()));
        // `../.jobs/maya` reaches a real file: only an id that is one of My agents passes.
        for missing in [
            r#"{"agent":"nobody"}"#,
            r#"{"agent":"../maya"}"#,
            r#"{"agent":"../.jobs/maya"}"#,
        ] {
            let refused = app.clone().oneshot(put(missing)).await.expect("pin");
            assert_eq!(refused.status(), StatusCode::NOT_FOUND, "{missing}");
        }
        assert_eq!(
            body(app.clone().oneshot(get()).await.expect("get")).await["agent"],
            serde_json::Value::Null
        );

        let pinned = app
            .clone()
            .oneshot(put(r#"{"agent":"maya"}"#))
            .await
            .expect("pin");
        assert_eq!(pinned.status(), StatusCode::OK);
        // Removed from My agents: its file moves to `.jobs/.removed/`, and the island is told
        // nothing is pinned.
        crate::jobs::remove_job(teams.path(), "maya").expect("remove");
        assert_eq!(
            body(app.oneshot(get()).await.expect("get")).await["agent"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn the_page_hears_when_show_at_the_notch_is_off_and_the_pin_stays() {
        let teams = folder();
        let state = folder();
        agent(teams.path(), "maya");
        let app = router(Pinned::open(state.path(), teams.path()));
        let first = body(app.clone().oneshot(get()).await.expect("get")).await;
        assert_eq!(first["notchShown"], true);
        // The Mac app's Show at the notch, unticked: it writes its file in the state folder.
        std::fs::write(state.path().join("app-notch-off"), b"").expect("off");
        let pinned = body(
            app.clone()
                .oneshot(put(r#"{"agent":"maya"}"#))
                .await
                .expect("pin"),
        )
        .await;
        assert_eq!(pinned["agent"], "maya");
        assert_eq!(pinned["notchShown"], false);
        let off = body(app.clone().oneshot(get()).await.expect("get")).await;
        assert_eq!(off["agent"], "maya");
        assert_eq!(off["notchShown"], false);
        // Ticked again.
        std::fs::remove_file(state.path().join("app-notch-off")).expect("on");
        assert_eq!(
            body(app.oneshot(get()).await.expect("get")).await["notchShown"],
            true
        );
        // What is kept is only which agent: the notch is the app's to say.
        let kept = std::fs::read_to_string(state.path().join("pinned.json")).expect("kept");
        assert!(!kept.contains("notch"), "{kept}");
    }

    #[tokio::test]
    async fn only_loomwatch_itself_can_change_the_pin() {
        let teams = folder();
        agent(teams.path(), "maya");
        let app = router(Pinned::in_memory(teams.path()));
        let request = Request::builder()
            .method("PUT")
            .uri("/api/pinned-agent")
            .header(header::HOST, "localhost")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"agent":"maya"}"#))
            .expect("request");
        let refused = app.clone().oneshot(request).await.expect("put");
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            body(app.oneshot(get()).await.expect("get")).await["agent"],
            serde_json::Value::Null
        );
    }
}
