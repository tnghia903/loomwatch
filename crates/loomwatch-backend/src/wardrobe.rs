//! The wardrobe: what the operator's agents earned on quests (docs/QUESTS.md).
//!
//! A quest notices one agent-building practice in a real run: a check that sent work back, a
//! Done when met the first time, a scheduled run that never asked for a key it lacked. The app
//! decides that from the run's own record, the same facts its receipt shows. It then tells this
//! store, and the item it earned goes into one wardrobe that every agent in Your agents can wear.
//!
//! The store keeps only what was earned, when, and by which run, in `wardrobe.json` in the state
//! folder: what you earned belongs to you on this computer, not to a team file you might share.
//! An item is earned once. The first run to earn it keeps it, so its receipt is the one that says
//! so, and earning it again changes nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use axum::extract::State;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::watch_api::local_evidence;

/// Everything a quest can earn (ui/src/lib/quests/catalog.ts names the quest behind each): what
/// any agent can wear (the clothes, worn one at a time, then the accessories), then the figures
/// it can be.
pub(crate) const ACCESSORIES: &[&str] = &[
    "tee", "overalls", "apron", "vest", "chalk", "band", "pin", "cushion", "shuttle", "monocle",
    "patch",
];
pub(crate) const FIGURE_ITEMS: &[&str] = &["scissors", "bobbin"];

const FILE_NAME: &str = "wardrobe.json";

/// Longest run id, team path or agent id the store keeps; past this, the request is refused.
const MAX_FIELD: usize = 400;

fn is_item(item: &str) -> bool {
    ACCESSORIES.contains(&item) || FIGURE_ITEMS.contains(&item)
}

/// One item in the wardrobe: when it was earned, and the run that earned it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Earned {
    pub at: DateTime<Utc>,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_path: Option<String>,
    /// The agent whose work earned it, when one did; a team's run as a whole names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// `wardrobe.json`, and `GET /api/wardrobe`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Contents {
    pub earned: BTreeMap<String, Earned>,
}

/// `POST /api/wardrobe/earned`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Earn {
    item: String,
    run_id: String,
    #[serde(default)]
    team_path: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
}

/// The wardrobe, shared by the routes. `file` is `None` in tests that keep it in memory.
#[derive(Clone)]
pub struct Wardrobe {
    file: Option<PathBuf>,
    contents: Arc<Mutex<Contents>>,
}

impl Wardrobe {
    /// The wardrobe kept in `state_dir`.
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        let file = state_dir.join(FILE_NAME);
        let contents = load(&file);
        Self {
            file: Some(file),
            contents: Arc::new(Mutex::new(contents)),
        }
    }

    /// A wardrobe that is never written to disk.
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            file: None,
            contents: Arc::new(Mutex::new(Contents::default())),
        }
    }

    #[must_use]
    pub fn contents(&self) -> Contents {
        self.contents
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Put `item` in the wardrobe, unless a run already earned it. Returns whether it is new, and
    /// what the wardrobe holds for it now.
    fn earn(&self, item: &str, earned: Earned) -> std::io::Result<(bool, Earned)> {
        let mut contents = self.contents.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = contents.earned.get(item) {
            return Ok((false, held.clone()));
        }
        let mut next = contents.clone();
        next.earned.insert(item.to_owned(), earned.clone());
        if let Some(file) = &self.file {
            let text = serde_json::to_vec_pretty(&next).map_err(std::io::Error::other)?;
            crate::approvals::write_private(file, &text)?;
        }
        *contents = next;
        Ok((true, earned))
    }
}

/// What an earlier start saved. A file that cannot be read is set aside, never overwritten: it
/// holds what the operator earned, and a newer `LoomWatch` may have written it.
fn load(file: &Path) -> Contents {
    let text = match std::fs::read(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Contents::default(),
        Err(error) => {
            eprintln!(
                "warning: the wardrobe in {} could not be read: {error}",
                file.display()
            );
            return Contents::default();
        }
    };
    match serde_json::from_slice::<Contents>(&text) {
        Ok(mut contents) => {
            // An item a newer LoomWatch knows and this one does not stays in the file only while
            // nothing new is earned; this daemon cannot draw it, so it does not list it.
            contents.earned.retain(|item, _| is_item(item));
            contents
        }
        Err(error) => {
            let aside = file.with_extension("unreadable.json");
            eprintln!(
                "warning: the wardrobe in {} could not be read ({error}); it was moved to {}",
                file.display(),
                aside.display()
            );
            let _ = std::fs::rename(file, &aside);
            Contents::default()
        }
    }
}

/// `GET /api/wardrobe` and `POST /api/wardrobe/earned`. Loopback and this origin only, like the
/// evidence they are earned from.
pub fn router(wardrobe: Wardrobe) -> Router {
    Router::new()
        .route("/api/wardrobe", get(get_wardrobe))
        .route("/api/wardrobe/earned", post(post_earned))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(wardrobe)
}

async fn get_wardrobe(State(wardrobe): State<Wardrobe>) -> Json<Contents> {
    Json(wardrobe.contents())
}

fn field(name: &str, value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = value.map(|value| value.trim().to_owned()) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_FIELD || value.chars().any(char::is_control) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("{name} is not one LoomWatch would send."),
        ));
    }
    Ok(Some(value))
}

/// Answers `201` with the entry when the item is new, `200` with the entry already held when a run
/// earned it before.
async fn post_earned(
    State(wardrobe): State<Wardrobe>,
    Json(earn): Json<Earn>,
) -> Result<Response, ApiError> {
    let item = earn.item.trim();
    if !is_item(item) {
        let mut known = ACCESSORIES.to_vec();
        known.extend_from_slice(FIGURE_ITEMS);
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Unknown item {item:?}. Use one of: {}.", known.join(", ")),
        ));
    }
    let Some(run_id) = field("runId", Some(earn.run_id))? else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "runId names the run that earned it.".into(),
        ));
    };
    let earned = Earned {
        at: Utc::now(),
        run_id,
        team_path: field("teamPath", earn.team_path)?,
        agent_id: field("agentId", earn.agent_id)?,
    };
    let item = item.to_owned();
    let store = wardrobe.clone();
    let (new, held) = tokio::task::spawn_blocking(move || store.earn(&item, earned))
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("The wardrobe could not be saved: {error}"),
            )
        })?;
    let status = if new {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(held)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use tower::ServiceExt as _;

    fn post(json: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/wardrobe/earned")
            .header(header::HOST, "localhost")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json.to_owned()))
            .expect("request")
    }

    async fn body(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    #[tokio::test]
    async fn the_first_run_to_earn_an_item_keeps_it() {
        let wardrobe = Wardrobe::in_memory();
        let app = router(wardrobe.clone());
        let first = app
            .clone()
            .oneshot(post(
                r#"{"item":"monocle","runId":"run-1","teamPath":"research.yaml","agentId":"checker"}"#,
            ))
            .await
            .expect("first");
        assert_eq!(first.status(), StatusCode::CREATED);
        let again = app
            .clone()
            .oneshot(post(r#"{"item":"monocle","runId":"run-2"}"#))
            .await
            .expect("again");
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(body(again).await["runId"], "run-1");
        let listed = app
            .oneshot(
                Request::builder()
                    .uri("/api/wardrobe")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("list");
        let listed = body(listed).await;
        assert_eq!(listed["earned"]["monocle"]["agentId"], "checker");
        assert_eq!(
            listed["earned"].as_object().map(serde_json::Map::len),
            Some(1)
        );
    }

    #[tokio::test]
    async fn only_items_a_quest_earns_and_a_named_run_are_taken() {
        let app = router(Wardrobe::in_memory());
        for json in [
            r#"{"item":"crown","runId":"run-1"}"#,
            r#"{"item":"band","runId":"  "}"#,
            r#"{"item":"band","runId":"run\u0000"}"#,
        ] {
            let response = app.clone().oneshot(post(json)).await.expect("response");
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "{json}"
            );
        }
    }

    #[tokio::test]
    async fn another_site_cannot_read_or_fill_the_wardrobe() {
        let app = router(Wardrobe::in_memory());
        let mut request = post(r#"{"item":"band","runId":"run-1"}"#);
        request.headers_mut().insert(
            header::ORIGIN,
            "https://example.com".parse().expect("origin"),
        );
        let response = app.oneshot(request).await.expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn the_wardrobe_survives_a_restart_and_an_unreadable_file_is_set_aside() {
        let dir = std::env::temp_dir().join(format!(
            "loomwatch-wardrobe-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let wardrobe = Wardrobe::open(&dir);
        let earned = Earned {
            at: Utc::now(),
            run_id: "run-1".into(),
            team_path: None,
            agent_id: None,
        };
        assert!(wardrobe.earn("patch", earned.clone()).expect("earn").0);
        assert_eq!(
            Wardrobe::open(&dir).contents().earned.get("patch"),
            Some(&earned)
        );

        std::fs::write(dir.join(FILE_NAME), b"{ not json").expect("corrupt");
        assert!(Wardrobe::open(&dir).contents().earned.is_empty());
        assert!(dir.join("wardrobe.unreadable.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
