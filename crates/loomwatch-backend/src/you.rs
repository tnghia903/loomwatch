//! What the operator tells their agents about themselves (ADR 0074): the name agents call them by,
//! and a few lines about who they are and how they like answers.
//!
//! Every agent `LoomWatch` runs reads it at the start of each session, in its instructions
//! (`agent::prompt::system_prompt`), so an answer fits the person it is for: their language, their
//! work, how long or detailed they like it. The person writes it, on Home's first-run card or the
//! About you page; nothing is guessed or learned.
//!
//! It is kept in `you.json` in the state folder, beside the other things that belong to the person
//! on this computer rather than to a team file they might share. Both parts are optional, and with
//! neither saved every agent's instructions are exactly what they were before this existed.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, PoisonError, RwLock};

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::watch_api::local_evidence;

const FILE_NAME: &str = "you.json";
/// The longest name, in characters.
pub const MAX_NAME_CHARS: usize = 60;
/// The longest About you, in characters: about 250 tokens on every agent's every call.
pub const MAX_ABOUT_CHARS: usize = 1_000;

/// `you.json`, `GET /api/you` and the body of `PUT /api/you`, which replaces it whole.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AboutYou {
    /// What agents call the person: "Mai".
    pub name: Option<String>,
    /// Who they are and how they like answers, in their own words.
    pub about: Option<String>,
    /// They pressed Not now on Home's card, or cleared what they had: the card isn't offered again.
    pub skipped: bool,
}

impl AboutYou {
    /// Neither a name nor an About you: agents are told nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.about.is_none()
    }

    /// Both parts tidied the way they are kept, or why one can't be.
    fn cleaned(self) -> Result<Self, String> {
        let name = self
            .name
            .map(|name| {
                // One line: a line break or tab in a name is a slip, and the instructions show it
                // inside a sentence.
                name.split(|c: char| c.is_whitespace() || c.is_control())
                    .filter(|word| !word.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|name| !name.is_empty());
        if name
            .as_ref()
            .is_some_and(|name| name.chars().count() > MAX_NAME_CHARS)
        {
            return Err(format!("A name can be up to {MAX_NAME_CHARS} characters."));
        }
        let about = self
            .about
            .map(|about| {
                about
                    .replace("\r\n", "\n")
                    .chars()
                    .map(|c| if c == '\t' { ' ' } else { c })
                    .filter(|c| *c == '\n' || !c.is_control())
                    .collect::<String>()
                    .lines()
                    .map(str::trim_end)
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_owned()
            })
            .filter(|about| !about.is_empty());
        if about
            .as_ref()
            .is_some_and(|about| about.chars().count() > MAX_ABOUT_CHARS)
        {
            return Err(format!(
                "About you can be up to {} characters.",
                thousands(MAX_ABOUT_CHARS)
            ));
        }
        Ok(Self {
            name,
            about,
            skipped: self.skipped,
        })
    }
}

fn thousands(count: usize) -> String {
    if count >= 1_000 {
        format!("{},{:03}", count / 1_000, count % 1_000)
    } else {
        count.to_string()
    }
}

/// What the person told their agents, shared by the routes and every session the daemon opens.
/// `file` is `None` in tests that keep it in memory.
#[derive(Clone)]
pub struct You {
    file: Option<PathBuf>,
    contents: Arc<RwLock<AboutYou>>,
}

impl You {
    /// What is kept in `state_dir`.
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        let file = state_dir.join(FILE_NAME);
        let contents = load(&file);
        Self {
            file: Some(file),
            contents: Arc::new(RwLock::new(contents)),
        }
    }

    /// Kept only in memory.
    #[must_use]
    pub fn in_memory(contents: AboutYou) -> Self {
        Self {
            file: None,
            contents: Arc::new(RwLock::new(contents)),
        }
    }

    #[must_use]
    pub fn get(&self) -> AboutYou {
        self.contents
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Replace what is kept with `next`, tidied. Returns what is kept now.
    fn set(&self, next: AboutYou) -> Result<AboutYou, SetError> {
        let next = next.cleaned().map_err(SetError::Invalid)?;
        let mut contents = self
            .contents
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        self.save(&next)?;
        contents.clone_from(&next);
        Ok(next)
    }

    /// Replace what is kept with what `change` makes of it, under one lock, so nothing saved
    /// between the read and the write is lost. `change` answers `None` to leave it as it is.
    /// Returns what is kept now, and whether it changed. Only ever on the person's click: Tell
    /// all my agents and its Undo (ADR 0078, [`crate::lessons`]).
    pub(crate) fn change(
        &self,
        change: impl FnOnce(&AboutYou) -> Option<AboutYou>,
    ) -> Result<(AboutYou, bool), SetError> {
        let mut contents = self
            .contents
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(next) = change(&contents) else {
            return Ok((contents.clone(), false));
        };
        let next = next.cleaned().map_err(SetError::Invalid)?;
        self.save(&next)?;
        contents.clone_from(&next);
        Ok((next, true))
    }

    fn save(&self, next: &AboutYou) -> Result<(), SetError> {
        if let Some(file) = &self.file {
            let text = serde_json::to_vec_pretty(next)
                .map_err(|error| SetError::Unsaved(error.to_string()))?;
            crate::approvals::write_private(file, &text)
                .map_err(|error| SetError::Unsaved(error.to_string()))?;
        }
        Ok(())
    }
}

/// Why what was asked for is not kept.
#[derive(Debug)]
pub(crate) enum SetError {
    /// Too long: the message says which part, and its limit.
    Invalid(String),
    Unsaved(String),
}

/// The one [`You`] the daemon's sessions read, set once at startup.
static INSTALLED: OnceLock<You> = OnceLock::new();

/// Makes `you` the one every session reads. The daemon calls this once, at startup; a second call
/// is ignored.
pub fn install(you: You) {
    let _ = INSTALLED.set(you);
}

/// What the person told their agents, when they told them anything, for an agent working in
/// `folder`. The folder matters only to tests, which tell the agents of one teams folder without
/// telling every other test's; the daemon has one person. `None` in one-off commands, which
/// install nothing.
pub(crate) fn told_in(folder: &Path) -> Option<AboutYou> {
    #[cfg(test)]
    if let Some(you) = testing::told_under(folder) {
        return Some(you);
    }
    #[cfg(not(test))]
    let _ = folder;
    INSTALLED.get().map(You::get).filter(|you| !you.is_empty())
}

/// Telling the agents of one test's teams folder, the way the About you page tells every agent.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, PoisonError};

    use super::AboutYou;

    static TOLD: Mutex<Vec<(PathBuf, AboutYou)>> = Mutex::new(Vec::new());

    /// Until it is dropped, agents working anywhere under `folder` are told `you`.
    #[must_use]
    pub(crate) fn tell_agents_under(folder: &Path, you: AboutYou) -> Told {
        let folder = crate::platform::canonicalize(folder).unwrap_or_else(|_| folder.to_owned());
        TOLD.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((folder.clone(), you));
        Told(folder)
    }

    pub(super) fn told_under(folder: &Path) -> Option<AboutYou> {
        let folder = crate::platform::canonicalize(folder).unwrap_or_else(|_| folder.to_owned());
        TOLD.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|(under, _)| folder.starts_with(under))
            .map(|(_, you)| you.clone())
    }

    pub(crate) struct Told(PathBuf);

    impl Drop for Told {
        fn drop(&mut self) {
            TOLD.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|(under, _)| under != &self.0);
        }
    }
}

/// What an earlier start saved. A file that can't be read counts as nothing saved: the person
/// writes it again, and an agent is never told something half-read.
fn load(file: &Path) -> AboutYou {
    let text = match std::fs::read(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return AboutYou::default(),
        Err(error) => {
            eprintln!(
                "warning: what you told your agents, in {}, could not be read: {error}",
                file.display()
            );
            return AboutYou::default();
        }
    };
    match serde_json::from_slice::<AboutYou>(&text).map(AboutYou::cleaned) {
        Ok(Ok(contents)) => contents,
        Ok(Err(error)) => {
            eprintln!(
                "warning: what you told your agents, in {}, was set aside: {error}",
                file.display()
            );
            AboutYou::default()
        }
        Err(error) => {
            eprintln!(
                "warning: what you told your agents, in {}, could not be read: {error}",
                file.display()
            );
            AboutYou::default()
        }
    }
}

/// `GET /api/you` and `PUT /api/you`. Loopback and this origin only, and a change only from
/// `LoomWatch`'s own page, which sends `X-LoomWatch-Request`.
pub fn router(you: You) -> Router {
    Router::new()
        .route("/api/you", get(get_you).put(put_you))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .route_layer(middleware::from_fn(from_loomwatch))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(you)
}

/// A change only from `LoomWatch`'s own page, which sends `X-LoomWatch-Request`. Also on the
/// lessons routes that change About you ([`crate::lessons::router`]).
pub(crate) async fn from_loomwatch(request: Request, next: Next) -> Response {
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("x-loomwatch-request")
            .is_none_or(|value| value != "1")
    {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "Open About you in LoomWatch to change what your agents know about you.".to_owned(),
        )
        .into_response();
    }
    next.run(request).await
}

async fn get_you(State(you): State<You>) -> Json<AboutYou> {
    Json(you.get())
}

async fn put_you(
    State(you): State<You>,
    Json(next): Json<AboutYou>,
) -> Result<Json<AboutYou>, ApiError> {
    let store = you.clone();
    let kept = tokio::task::spawn_blocking(move || store.set(next))
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    match kept {
        Ok(kept) => Ok(Json(kept)),
        Err(SetError::Invalid(message)) => {
            Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, message))
        }
        Err(SetError::Unsaved(error)) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("What you wrote could not be saved: {error}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use tower::ServiceExt as _;

    fn put(json: &str) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri("/api/you")
            .header(header::HOST, "localhost")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-loomwatch-request", "1")
            .body(Body::from(json.to_owned()))
            .expect("request")
    }

    fn get() -> Request<Body> {
        Request::builder()
            .uri("/api/you")
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

    #[tokio::test]
    async fn what_the_person_writes_is_kept_tidied_and_read_back() {
        let you = You::in_memory(AboutYou::default());
        let app = router(you.clone());
        let saved = app
            .clone()
            .oneshot(put(
                r#"{"name":"  Mai\n Tran ","about":"\r\n I teach English.\t \r\nAnswer in Vietnamese.\u0007  \n\n"}"#,
            ))
            .await
            .expect("put");
        assert_eq!(saved.status(), StatusCode::OK);
        let kept = AboutYou {
            name: Some("Mai Tran".into()),
            about: Some("I teach English.\nAnswer in Vietnamese.".into()),
            skipped: false,
        };
        assert_eq!(you.get(), kept);
        let read = body(app.clone().oneshot(get()).await.expect("get")).await;
        assert_eq!(read["name"], "Mai Tran");
        assert_eq!(read["about"], "I teach English.\nAnswer in Vietnamese.");
        assert_eq!(read["skipped"], false);

        // A PUT replaces it whole: Clear sends nothing but that the card stays away.
        let cleared = app
            .oneshot(put(r#"{"name":"  ","skipped":true}"#))
            .await
            .expect("clear");
        assert_eq!(cleared.status(), StatusCode::OK);
        assert_eq!(
            you.get(),
            AboutYou {
                skipped: true,
                ..AboutYou::default()
            }
        );
        assert!(you.get().is_empty());
    }

    #[tokio::test]
    async fn too_long_or_unknown_is_refused_and_nothing_changes() {
        let kept = AboutYou {
            name: Some("Mai".into()),
            ..AboutYou::default()
        };
        let you = You::in_memory(kept.clone());
        let app = router(you.clone());
        let long_name = format!(r#"{{"name":"{}"}}"#, "a".repeat(MAX_NAME_CHARS + 1));
        let long_about = format!(r#"{{"about":"{}"}}"#, "é".repeat(MAX_ABOUT_CHARS + 1));
        for (json, said) in [
            (long_name.as_str(), "A name can be up to 60 characters."),
            (
                long_about.as_str(),
                "About you can be up to 1,000 characters.",
            ),
        ] {
            let response = app.clone().oneshot(put(json)).await.expect("put");
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(body(response).await["error"], said);
        }
        // Exactly the limit is fine, counted in characters rather than bytes.
        let at_limit = format!(r#"{{"about":"{}"}}"#, "é".repeat(MAX_ABOUT_CHARS));
        assert_eq!(
            app.clone()
                .oneshot(put(&at_limit))
                .await
                .expect("put")
                .status(),
            StatusCode::OK
        );
        you.set(kept.clone()).ok();
        let unknown = app
            .oneshot(put(r#"{"name":"Mai","email":"mai@example.com"}"#))
            .await
            .expect("put");
        assert!(unknown.status().is_client_error());
        assert_eq!(you.get(), kept);
    }

    #[tokio::test]
    async fn only_loomwatchs_own_page_can_change_it_and_no_other_site_can_read_it() {
        let you = You::in_memory(AboutYou {
            name: Some("Mai".into()),
            ..AboutYou::default()
        });
        let app = router(you.clone());
        let mut bare = put(r#"{"name":"Someone else"}"#);
        bare.headers_mut().remove("x-loomwatch-request");
        assert_eq!(
            app.clone().oneshot(bare).await.expect("put").status(),
            StatusCode::FORBIDDEN
        );
        let mut elsewhere = get();
        elsewhere.headers_mut().insert(
            header::ORIGIN,
            "https://example.com".parse().expect("origin"),
        );
        assert_eq!(
            app.oneshot(elsewhere).await.expect("get").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(you.get().name.as_deref(), Some("Mai"));
    }

    #[test]
    fn it_survives_a_restart_privately_and_an_unreadable_file_means_nothing_saved() {
        let dir = std::env::temp_dir().join(format!("loomwatch-you-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let you = You::open(&dir);
        assert_eq!(you.get(), AboutYou::default());
        let kept = AboutYou {
            name: Some("Mai".into()),
            about: Some("I teach English.".into()),
            skipped: false,
        };
        assert!(you.set(kept.clone()).is_ok());
        assert_eq!(You::open(&dir).get(), kept);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join(FILE_NAME))
                .expect("file")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        std::fs::write(dir.join(FILE_NAME), b"{ not json").expect("corrupt");
        assert_eq!(You::open(&dir).get(), AboutYou::default());
        let long = format!(r#"{{"name":"{}"}}"#, "a".repeat(MAX_NAME_CHARS + 1));
        std::fs::write(dir.join(FILE_NAME), long).expect("too long");
        assert_eq!(You::open(&dir).get(), AboutYou::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
