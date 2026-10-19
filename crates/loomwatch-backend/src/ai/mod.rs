//! The models agents run on: the operator's `OpenRouter` key and `OpenRouter`'s catalog.
//!
//! - `GET /api/ai` says whether a key is set and what `OpenRouter` said about it last time. It never
//!   reads the key itself, so opening the app never brings up a Keychain prompt.
//! - `PUT /api/ai/openrouter` checks a key with `OpenRouter`, then keeps it. A key `OpenRouter` refuses
//!   is never kept.
//! - `POST /api/ai/openrouter/check` asks `OpenRouter` about the kept key again.
//! - `DELETE /api/ai/openrouter` forgets it.
//! - `PUT`/`DELETE /api/ai/anthropic` and `POST /api/ai/anthropic/check` do the same for a Claude
//!   API key (ADR 0073), checked by listing its models; `GET /api/ai` says what was last learned.
//! - `GET /api/models` lists the models an agent can use: `OpenRouter`'s catalog, and the Claude
//!   key's models when one is kept.
//! - `/api/models/reading` reads an agent's whole setup to suggest a model, when the operator turns
//!   that on (`reading.rs`).
//!
//! The router must only be mounted on a loopback listener. Changing requests need the
//! `X-LoomWatch-Request: 1` header the app sends, so another site can't set a key.

pub mod anthropic;
mod keys;
mod models;
mod reading;

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

pub use anthropic::{ClaudeModel, ClaudeStatus};
/// The key file's name in the state folder, where it is kept off a Mac: no agent may touch it.
pub(crate) use keys::FILE_NAME as KEY_FILE;
pub(crate) use keys::PLANS_FILE;
pub use keys::{ChatGptSecret, Keys, PlanSecrets};
pub use models::{
    Catalog, DEFAULT_MODEL, FAST_MODEL, JobNeeds, MODEL_TIERS, Model, ModelRef, ModelTiers, Models,
    Source, openrouter_id,
};
use reading::Reader;

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
    reader: Reader,
    claude_status: anthropic::StatusFile,
    /// Where the Claude key is checked and agents' Claude calls go.
    anthropic_base: String,
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
                reader: Reader::new(
                    state_dir,
                    &reading::decisions_url(key_url.strip_suffix("/key").unwrap_or(key_url)),
                ),
                claude_status: anthropic::StatusFile::new(state_dir),
                anthropic_base: anthropic::base_url(),
            }),
        }
    }

    /// The same, with Claude keys checked and Claude calls sent to `base`, for tests.
    ///
    /// # Panics
    ///
    /// When called on an [`Ai`] that was already cloned.
    #[must_use]
    pub fn with_anthropic_at(mut self, base: &str) -> Self {
        let inner = Arc::get_mut(&mut self.inner)
            .expect("set where the Claude key goes before sharing the Ai");
        base.trim_end_matches('/')
            .clone_into(&mut inner.anthropic_base);
        self
    }

    /// The Claude API key a run uses, if one is kept.
    ///
    /// # Errors
    ///
    /// When the key store can't be read.
    pub async fn claude_key(&self) -> anyhow::Result<Option<ApiKey>> {
        Ok(self
            .inner
            .keys
            .plan_secrets()
            .await?
            .anthropic
            .as_deref()
            .and_then(ApiKey::new))
    }

    /// What was last learned about the Claude key: its models among it. Never reads the key.
    #[must_use]
    pub fn claude_status(&self) -> ClaudeStatus {
        self.inner.claude_status.read()
    }

    /// Where Claude calls go.
    #[must_use]
    pub fn anthropic_base(&self) -> &str {
        &self.inner.anthropic_base
    }

    /// The sources the person has connected, as their statuses say. Never reads a key.
    #[must_use]
    pub fn connected_sources(&self) -> Vec<Source> {
        let mut sources = Vec::new();
        if self.claude_status().connected {
            sources.push(Source::Anthropic);
        }
        if self.status().connected {
            sources.push(Source::OpenRouter);
        }
        sources
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
        .route(
            "/api/ai/anthropic",
            put(connect_claude).delete(disconnect_claude),
        )
        .route("/api/ai/anthropic/check", post(recheck_claude))
        .route("/api/models", get(list_models))
        .layer(DefaultBodyLimit::max(4096))
        // A setup carries an agent's whole instructions.
        .route(
            "/api/models/reading",
            get(reading::status)
                .put(reading::change)
                .post(reading::read)
                .layer(DefaultBodyLimit::max(64 * 1024)),
        )
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
            "Open Connections in LoomWatch to change how agents' models are paid.".to_owned(),
        )
        .into_response();
    }
    next.run(request).await
}

async fn status(State(ai): State<Ai>) -> Json<Value> {
    Json(json!({"openrouter": ai.status(), "anthropic": ai.claude_status()}))
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

async fn connect_claude(
    State(ai): State<Ai>,
    Json(body): Json<Connect>,
) -> Result<Json<Value>, ApiError> {
    let Some(key) = ApiKey::new(&body.key) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Paste your Claude API key first.".to_owned(),
        ));
    };
    if let Some(said) = anthropic::refuse_shape(key.expose()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, said.to_owned()));
    }
    let models = anthropic::check(ai.anthropic_base(), &key)
        .await
        .map_err(|said| ApiError::new(StatusCode::BAD_REQUEST, said))?;
    let kept = key.expose().to_owned();
    ai.inner
        .keys
        .change_plan_secrets(move |secrets| secrets.anthropic = Some(kept))
        .await
        .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("{error:#}")))?;
    let status = anthropic::accepted(&key, models);
    ai.inner.claude_status.keep(&status);
    Ok(Json(json!({"anthropic": status})))
}

async fn recheck_claude(State(ai): State<Ai>) -> Result<Json<Value>, ApiError> {
    let key = ai
        .claude_key()
        .await
        .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("{error:#}")))?;
    let Some(key) = key else {
        let status = ClaudeStatus::default();
        ai.inner.claude_status.keep(&status);
        return Ok(Json(json!({"anthropic": status})));
    };
    let status = match anthropic::check(ai.anthropic_base(), &key).await {
        Ok(models) => anthropic::accepted(&key, models),
        Err(problem) => ClaudeStatus {
            connected: true,
            checked_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
            problem: Some(problem),
            ..ai.claude_status()
        },
    };
    ai.inner.claude_status.keep(&status);
    Ok(Json(json!({"anthropic": status})))
}

async fn disconnect_claude(State(ai): State<Ai>) -> Result<Json<Value>, ApiError> {
    ai.inner
        .keys
        .change_plan_secrets(|secrets| secrets.anthropic = None)
        .await
        .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("{error:#}")))?;
    let status = ClaudeStatus::default();
    ai.inner.claude_status.keep(&status);
    Ok(Json(json!({"anthropic": status})))
}

/// The model list as the app gets it: `OpenRouter`'s catalog as before, and the Claude key's models
/// beside it, priced as the catalog lists the same model.
#[derive(Serialize)]
struct ModelList {
    #[serde(flatten)]
    catalog: Arc<Catalog>,
    anthropic: Vec<Model>,
}

async fn list_models(State(ai): State<Ai>) -> Result<Json<Value>, ApiError> {
    let catalog = ai.models().catalog().await.map_err(|error| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("The model list isn't available right now: {error:#}"),
        )
    })?;
    let claude = ai.claude_status();
    let anthropic = if claude.connected {
        claude
            .models
            .iter()
            .map(|model| claude_listing(model, &catalog))
            .collect()
    } else {
        Vec::new()
    };
    Ok(Json(json!(ModelList { catalog, anthropic })))
}

/// A Claude key's model as the picker lists it, with the prices `OpenRouter` lists for the same
/// model: Anthropic's own list prices, which the API doesn't report.
fn claude_listing(model: &ClaudeModel, catalog: &Catalog) -> Model {
    let reference = ModelRef {
        source: Source::Anthropic,
        id: model.id.clone(),
    };
    let listed = catalog.find(&reference.openrouter_equivalent());
    Model {
        id: reference.selector(),
        name: model.name.clone(),
        description: listed
            .map(|listed| listed.description.clone())
            .unwrap_or_default(),
        context_length: model.context_length,
        input_price: listed.map_or(0.0, |listed| listed.input_price),
        output_price: listed.map_or(0.0, |listed| listed.output_price),
        cached_input_price: listed.and_then(|listed| listed.cached_input_price),
        cache_write_price: listed.and_then(|listed| listed.cache_write_price),
        free: false,
        reasoning: model.adaptive_thinking || !model.efforts.is_empty(),
        note: None,
    }
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

    async fn fake_anthropic() -> String {
        async fn models(headers: axum::http::HeaderMap) -> Response {
            let key = headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            let versioned = headers.get("anthropic-version").is_some();
            if key == "sk-ant-api03-good" && versioned {
                Json(json!({"data": [{
                    "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
                    "max_input_tokens": 1_000_000, "max_tokens": 128_000,
                    "capabilities": {"thinking": {"supported": true, "types": {"adaptive": {"supported": true}}},
                                     "effort": {"supported": true, "low": {"supported": true}, "high": {"supported": true}}}
                }], "has_more": false, "last_id": "claude-opus-5-5"}))
                .into_response()
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})),
                )
                    .into_response()
            }
        }
        let app = Router::new().route("/v1/models", get(models));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    /// Only a Claude API key Anthropic accepts is kept, beside the `OpenRouter` key and never in its
    /// place, and what its check learned is what `/api/ai` says. A Claude sign-in token is refused
    /// before Anthropic is asked.
    #[tokio::test]
    async fn a_claude_key_is_kept_only_after_anthropic_accepts_it() {
        let folder = std::env::temp_dir().join(format!("loomwatch-ai-{}", uuid::Uuid::new_v4()));
        let keys = Keys::in_memory();
        keys.set_openrouter("sk-or-v1-kept").await.unwrap();
        let ai = Ai::with(
            keys.clone(),
            Models::with_url("http://127.0.0.1:9/models", None),
            &folder,
            &fake_openrouter().await,
        )
        .with_anthropic_at(&fake_anthropic().await);
        let app = router(ai.clone());

        let (_, body) = send(&app, "GET", "/api/ai", None, false).await;
        assert_eq!(body["anthropic"]["connected"], false);
        assert!(ai.connected_sources().is_empty());

        let (status, body) = send(
            &app,
            "PUT",
            "/api/ai/anthropic",
            Some(json!({"key": "sk-ant-oat01-subscription"})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("sign-in token"));

        let (status, body) = send(
            &app,
            "PUT",
            "/api/ai/anthropic",
            Some(json!({"key": "sk-ant-api03-wrong"})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("refused this key"));
        assert!(ai.claude_key().await.unwrap().is_none());

        let (status, body) = send(
            &app,
            "PUT",
            "/api/ai/anthropic",
            Some(json!({"key": " sk-ant-api03-good "})),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["anthropic"]["models"][0]["id"], "claude-opus-5-5");
        assert_eq!(
            body["anthropic"]["models"][0]["efforts"],
            json!(["low", "high"])
        );
        assert_eq!(
            ai.claude_key().await.unwrap().unwrap().expose(),
            "sk-ant-api03-good"
        );
        assert_eq!(
            keys.openrouter().await.unwrap().unwrap().expose(),
            "sk-or-v1-kept"
        );
        assert_eq!(ai.connected_sources(), [Source::Anthropic]);
        let (_, body) = send(&app, "GET", "/api/ai", None, false).await;
        assert_eq!(body["anthropic"]["connected"], true);
        assert!(!body.to_string().contains("sk-ant-api03-good"));

        let (status, body) = send(&app, "POST", "/api/ai/anthropic/check", None, true).await;
        assert_eq!(
            (status, body["anthropic"]["connected"].clone()),
            (StatusCode::OK, json!(true))
        );

        let (status, body) = send(&app, "DELETE", "/api/ai/anthropic", None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["anthropic"]["connected"], false);
        assert!(ai.claude_key().await.unwrap().is_none());
        assert_eq!(
            keys.openrouter().await.unwrap().unwrap().expose(),
            "sk-or-v1-kept"
        );
        let _ = std::fs::remove_dir_all(&folder);
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
