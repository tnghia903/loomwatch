//! The models agents run on: the operator's `OpenRouter` key and `OpenRouter`'s catalog.
//!
//! - `GET /api/ai` says whether a key is set and what `OpenRouter` said about it last time. It never
//!   reads the key itself, so opening the app never brings up a Keychain prompt.
//! - `PUT /api/ai/openrouter` checks a key with `OpenRouter`, then keeps it. A key `OpenRouter` refuses
//!   is never kept.
//! - `POST /api/ai/openrouter/check` asks `OpenRouter` about the kept key again.
//! - `DELETE /api/ai/openrouter` forgets it.
//! - `GET /api/models` lists the models an agent can use.
//!
//! The router must only be mounted on a loopback listener. Changing requests need the
//! `X-LoomWatch-Request: 1` header the app sends, so another site can't set a key.

mod keys;
mod models;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The key file's name in the state folder, where it is kept off a Mac: no agent may touch it.
pub(crate) use keys::FILE_NAME as KEY_FILE;
pub use keys::Keys;
pub use models::{Catalog, DEFAULT_MODEL, FAST_MODEL, Model, Models, openrouter_id};

use crate::agent::{ApiKey, base_url, is_loopback_http};
use crate::api::ApiError;

const STATUS_FILE: &str = "openrouter.json";
/// `file`: keep the key in `<state dir>/keys.json`, and connected tools' sign-ins (Notion's
/// among them) in `<state dir>/tool-credentials.json`, even on a Mac (trial copies).
pub const KEY_STORE_ENV: &str = "LOOMWATCH_KEY_STORE";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// Where agents get their models from. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Ai {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    keys: Keys,
    models: Models,
    state_dir: PathBuf,
    status_file: PathBuf,
    key_url: String,
    client: Option<reqwest::Client>,
}

/// The one [`Ai`] the daemon's runs use, set once at startup.
static INSTALLED: std::sync::OnceLock<Ai> = std::sync::OnceLock::new();

/// Makes `ai` the one runs use. The daemon calls this once, at startup; a second call is ignored.
pub fn install(ai: Ai) {
    let _ = INSTALLED.set(ai);
}

/// The installed [`Ai`], if the daemon set one. Tests and one-off commands may have none.
pub(crate) fn installed() -> Option<&'static Ai> {
    INSTALLED.get()
}

/// Whether [`KEY_STORE_ENV`] asks for keys in the state folder even on a Mac. Connected tools'
/// sign-ins follow it too (`connected_tools::Tools::open`).
pub(crate) fn keys_in_file() -> bool {
    std::env::var(KEY_STORE_ENV).is_ok_and(|store| store.trim() == "file")
}

/// What the app shows about the `OpenRouter` connection. None of it is the key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub connected: bool,
    /// `OpenRouter`'s short form of the key, such as `sk-or-v1-au7...890`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Dollars this key has spent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spent: Option<f64>,
    /// Dollars this key has spent in the current month (UTC), as `OpenRouter` counts it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spent_this_month: Option<f64>,
    /// Dollars left under the key's own limit, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_remaining: Option<f64>,
    /// The account has never bought credits, so only free models work.
    #[serde(default)]
    pub free_tier: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    /// Why the last check failed, in plain words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

impl Ai {
    /// The real thing: the Keychain (or `keys.json`) and `OpenRouter`.
    ///
    /// [`KEY_STORE_ENV`]` = file` keeps the key in the state folder even on a Mac, so a trial copy
    /// with its own state folder never reads or writes the Keychain item the installed app uses.
    #[must_use]
    pub fn new(state_dir: &Path) -> Self {
        Self::with(
            if keys_in_file() {
                Keys::in_file(state_dir)
            } else {
                Keys::open(state_dir)
            },
            Models::new(state_dir),
            state_dir,
            &format!("{}/key", base_url()),
        )
    }

    /// Any key store, catalog and key-check address, for tests and trial copies.
    #[must_use]
    pub fn with(keys: Keys, models: Models, state_dir: &Path, key_url: &str) -> Self {
        let local = is_loopback_http(key_url);
        let client = reqwest::Client::builder()
            .user_agent(concat!("LoomWatch/", env!("CARGO_PKG_VERSION")))
            .timeout(CHECK_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!local)
            .build()
            .ok();
        Self {
            inner: Arc::new(Inner {
                keys,
                models,
                state_dir: state_dir.to_path_buf(),
                status_file: state_dir.join(STATUS_FILE),
                key_url: key_url.to_owned(),
                client,
            }),
        }
    }

    /// The key a run uses, if one is set.
    ///
    /// # Errors
    ///
    /// When the key store can't be read.
    pub async fn openrouter_key(&self) -> anyhow::Result<Option<ApiKey>> {
        self.inner.keys.openrouter().await
    }

    #[must_use]
    pub fn models(&self) -> &Models {
        &self.inner.models
    }

    /// `LoomWatch`'s own skills folder, `<state dir>/skills`: every agent can read what is in it.
    #[must_use]
    pub fn skills_folder(&self) -> PathBuf {
        self.inner.state_dir.join("skills")
    }

    /// The state folder: the key file, the database, the approvals. Agents never read it without
    /// asking, the skills folder apart.
    #[must_use]
    pub fn state_dir(&self) -> PathBuf {
        self.inner.state_dir.clone()
    }

    /// What was last said about the key. Never reads the key.
    #[must_use]
    pub fn status(&self) -> KeyStatus {
        std::fs::read(&self.inner.status_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn keep_status(&self, status: &KeyStatus) {
        let written = serde_json::to_vec_pretty(status)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::approvals::write_private(&self.inner.status_file, &text));
        if let Err(error) = written {
            eprintln!("warning: could not keep the OpenRouter status: {error}");
        }
    }

    /// Asks `OpenRouter` about `key`.
    async fn check(&self, key: &ApiKey) -> Result<KeyStatus, String> {
        let client = self
            .inner
            .client
            .as_ref()
            .ok_or_else(|| "This computer can't make HTTPS requests.".to_owned())?;
        let response = client
            .get(&self.inner.key_url)
            .bearer_auth(key.expose())
            .send()
            .await
            .map_err(|_| {
                "LoomWatch couldn't reach OpenRouter. Check this computer's internet connection."
                    .to_owned()
            })?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(
                "OpenRouter refused this key. Copy it again from openrouter.ai/keys, or make a new one."
                    .to_owned(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "OpenRouter couldn't check the key just now (HTTP {}). Try again in a minute.",
                status.as_u16()
            ));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| "OpenRouter's answer couldn't be read.".to_owned())?;
        let data = body.get("data").unwrap_or(&body);
        Ok(KeyStatus {
            connected: true,
            label: data.get("label").and_then(Value::as_str).map(str::to_owned),
            spent: data.get("usage").and_then(Value::as_f64),
            spent_this_month: data.get("usage_monthly").and_then(Value::as_f64),
            limit_remaining: data.get("limit_remaining").and_then(Value::as_f64),
            free_tier: data
                .get("is_free_tier")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            checked_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
            problem: None,
        })
    }
}

/// The routes. Mount on a loopback listener only.
pub fn router(ai: Ai) -> Router {
    Router::new()
        .route("/api/ai", get(status))
        .route("/api/ai/openrouter", put(connect).delete(disconnect))
        .route("/api/ai/openrouter/check", post(recheck))
        .route("/api/models", get(list_models))
        .layer(DefaultBodyLimit::max(4096))
        .route_layer(middleware::from_fn(protect))
        .with_state(ai)
}

async fn protect(request: Request, next: Next) -> Response {
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("x-loomwatch-request")
            .is_none_or(|value| value != "1")
    {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "Open Connections in LoomWatch to change the OpenRouter key.".to_owned(),
        )
        .into_response();
    }
    next.run(request).await
}

async fn status(State(ai): State<Ai>) -> Json<Value> {
    Json(json!({"openrouter": ai.status()}))
}

#[derive(Deserialize)]
struct Connect {
    key: String,
}

async fn connect(State(ai): State<Ai>, Json(body): Json<Connect>) -> Result<Json<Value>, ApiError> {
    let Some(key) = ApiKey::new(&body.key) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Paste your OpenRouter key first.".to_owned(),
        ));
    };
    if !key.expose().starts_with("sk-or-") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "That doesn't look like an OpenRouter key. OpenRouter keys start with sk-or-."
                .to_owned(),
        ));
    }
    let checked = ai
        .check(&key)
        .await
        .map_err(|said| ApiError::new(StatusCode::BAD_REQUEST, said))?;
    ai.inner
        .keys
        .set_openrouter(key.expose())
        .await
        .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("{error:#}")))?;
    ai.keep_status(&checked);
    Ok(Json(json!({"openrouter": checked})))
}

async fn recheck(State(ai): State<Ai>) -> Result<Json<Value>, ApiError> {
    let key = ai
        .openrouter_key()
        .await
        .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("{error:#}")))?;
    let Some(key) = key else {
        let status = KeyStatus::default();
        ai.keep_status(&status);
        return Ok(Json(json!({"openrouter": status})));
    };
    let status = match ai.check(&key).await {
        Ok(status) => status,
        Err(problem) => KeyStatus {
            connected: true,
            checked_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
            problem: Some(problem),
            ..ai.status()
        },
    };
    ai.keep_status(&status);
    Ok(Json(json!({"openrouter": status})))
}

async fn disconnect(State(ai): State<Ai>) -> Result<Json<Value>, ApiError> {
    ai.inner
        .keys
        .remove_openrouter()
        .await
        .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("{error:#}")))?;
    let status = KeyStatus::default();
    ai.keep_status(&status);
    Ok(Json(json!({"openrouter": status})))
}

async fn list_models(State(ai): State<Ai>) -> Result<Json<Arc<Catalog>>, ApiError> {
    ai.models().catalog().await.map(Json).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("The model list isn't available right now: {error:#}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn fake_openrouter() -> String {
        async fn key(headers: axum::http::HeaderMap) -> Response {
            let auth = headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            if auth == "Bearer sk-or-v1-good" {
                Json(json!({"data": {"label": "sk-or-v1-goo...ood", "usage": 1.25, "limit_remaining": null, "is_free_tier": false}}))
                    .into_response()
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"error": {"code": 401, "message": "No auth"}})),
                )
                    .into_response()
            }
        }
        let app = Router::new().route("/api/v1/key", get(key));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/api/v1/key")
    }

    async fn send(
        app: &Router,
        method: &str,
        path: &str,
        body: Option<Value>,
        trusted: bool,
    ) -> (StatusCode, Value) {
        let mut request = HttpRequest::builder().method(method).uri(path);
        if trusted {
            request = request.header("x-loomwatch-request", "1");
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn a_key_is_kept_only_after_openrouter_accepts_it() {
        let folder = std::env::temp_dir().join(format!("loomwatch-ai-{}", uuid::Uuid::new_v4()));
        let keys = Keys::in_memory();
        let ai = Ai::with(
            keys.clone(),
            Models::with_url("http://127.0.0.1:9/models", None),
            &folder,
            &fake_openrouter().await,
        );
        let app = router(ai.clone());

        let (status, body) = send(&app, "GET", "/api/ai", None, false).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["openrouter"]["connected"], false);

        // Another site can't set a key.
        let (status, _) = send(
            &app,
            "PUT",
            "/api/ai/openrouter",
            Some(json!({"key": "sk-or-v1-good"})),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = send(
            &app,
            "PUT",
            "/api/ai/openrouter",
            Some(json!({"key": "not-a-key"})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("start with sk-or-")
        );

        let (status, body) = send(
            &app,
            "PUT",
            "/api/ai/openrouter",
            Some(json!({"key": "sk-or-v1-wrong"})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("refused this key"));
        assert!(keys.openrouter().await.unwrap().is_none());

        let (status, body) = send(
            &app,
            "PUT",
            "/api/ai/openrouter",
            Some(json!({"key": " sk-or-v1-good "})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["openrouter"]["label"], "sk-or-v1-goo...ood");
        assert_eq!(body["openrouter"]["spent"], 1.25);
        assert_eq!(
            ai.openrouter_key().await.unwrap().unwrap().expose(),
            "sk-or-v1-good"
        );
        // The status the app reads later says so, without the key in it.
        let (_, body) = send(&app, "GET", "/api/ai", None, false).await;
        assert_eq!(body["openrouter"]["connected"], true);
        assert!(!body.to_string().contains("sk-or-v1-good\""));

        let (status, body) = send(&app, "DELETE", "/api/ai/openrouter", None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["openrouter"]["connected"], false);
        assert!(ai.openrouter_key().await.unwrap().is_none());
        let _ = std::fs::remove_dir_all(&folder);
    }
}
