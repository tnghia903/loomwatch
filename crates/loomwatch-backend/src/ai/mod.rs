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
//! - `POST /api/ai/chatgpt/sign-in` starts a sign-in with `ChatGPT` and answers the consent page's
//!   address; `OpenAI` sends the browser back to `GET /api/ai/chatgpt/callback`.
//!   `POST /api/ai/chatgpt/check` lists the plan's models again; `DELETE /api/ai/chatgpt` signs out.
//! - `GET /api/models` lists the models an agent can use: `OpenRouter`'s catalog, the Claude key's
//!   models when one is kept, and the `ChatGPT` plan's when one is signed in.
//! - `/api/models/reading` reads an agent's whole setup to suggest a model, when the operator turns
//!   that on (`reading.rs`).
//!
//! The router must only be mounted on a loopback listener. Changing requests need the
//! `X-LoomWatch-Request: 1` header the app sends, so another site can't set a key.

pub mod anthropic;
pub mod chatgpt;
mod keys;
mod models;
mod reading;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub use anthropic::{ClaudeModel, ClaudeStatus};
pub use chatgpt::{ChatGptModel, ChatGptStatus};
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
    chatgpt: Arc<chatgpt::ChatGpt>,
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
                chatgpt: Arc::new(chatgpt::ChatGpt::new(
                    state_dir,
                    &chatgpt::auth_base(),
                    &chatgpt::api_base(),
                )),
            }),
        }
    }

    /// The same, with the sign-in with `ChatGPT` sent to `auth` and the plan's calls to `api`, for
    /// tests.
    ///
    /// # Panics
    ///
    /// When called on an [`Ai`] that was already cloned.
    #[must_use]
    pub fn with_openai_at(mut self, auth: &str, api: &str) -> Self {
        let inner = Arc::get_mut(&mut self.inner)
            .expect("set where the sign-in with ChatGPT goes before sharing the Ai");
        inner.chatgpt = Arc::new(chatgpt::ChatGpt::new(&inner.state_dir, auth, api));
        self
    }

    /// What was last said about the sign-in with `ChatGPT`. Never reads a token.
    #[must_use]
    pub fn chatgpt_status(&self) -> ChatGptStatus {
        self.inner.chatgpt.status()
    }

    /// Where the plan's calls go.
    #[must_use]
    pub fn chatgpt_api(&self) -> &str {
        self.inner.chatgpt.api()
    }

    /// What gives the plan's calls their access token, renewing it from the sign-in.
    #[must_use]
    pub fn chatgpt_access(&self) -> Arc<dyn crate::agent::PlanAccess> {
        Arc::new(ChatGptAccess {
            chatgpt: self.inner.chatgpt.clone(),
            keys: self.inner.keys.clone(),
        })
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
        let plan = self.chatgpt_status();
        if plan.available && plan.connected && plan.plan_use {
            sources.push(Source::ChatGpt);
        }
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

    /// Whether `model` takes pictures, so an agent on it is shown the pictures it opens. A Claude
    /// or a plan's model missing from its list is taken to, as every current one does; one
    /// `OpenRouter` doesn't list is not, and the offline demo sees none.
    pub async fn sees_pictures(&self, model: &ModelRef) -> bool {
        match model.source {
            Source::Anthropic => self
                .claude_status()
                .models
                .iter()
                .find(|listed| listed.id == model.id)
                .is_none_or(|listed| listed.sees_pictures),
            Source::ChatGpt => self
                .chatgpt_status()
                .models
                .iter()
                .find(|listed| listed.slug == model.id)
                .is_none_or(|listed| listed.sees_pictures),
            // The demo must not wait for the list either.
            Source::OpenRouter if model.id == crate::agent::OFFLINE_MODEL => false,
            Source::OpenRouter => self.models().sees_pictures(&model.id).await,
        }
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
        .route("/api/ai/chatgpt", axum::routing::delete(sign_out_chatgpt))
        .route("/api/ai/chatgpt/sign-in", post(sign_in_chatgpt))
        .route("/api/ai/chatgpt/check", post(check_chatgpt))
        .route(chatgpt::CALLBACK, get(chatgpt_callback))
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
    Json(json!({
        "openrouter": ai.status(),
        "anthropic": ai.claude_status(),
        "chatgpt": ai.chatgpt_status(),
    }))
}

/// Gives the plan's calls an access token from the sign-in with `ChatGPT`.
#[derive(Debug)]
struct ChatGptAccess {
    chatgpt: Arc<chatgpt::ChatGpt>,
    keys: Keys,
}

impl crate::agent::PlanAccess for ChatGptAccess {
    fn token(
        &self,
        renew: bool,
    ) -> crate::agent::BoxFuture<'_, Result<String, crate::agent::AgentError>> {
        Box::pin(self.chatgpt.access_token(&self.keys, renew))
    }
}

async fn sign_in_chatgpt(
    State(ai): State<Ai>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let port = headers
        .get(axum::http::header::HOST)
        .and_then(|host| host.to_str().ok())
        .and_then(chatgpt::callback_port)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "Open LoomWatch at http://127.0.0.1 on this computer to sign in with ChatGPT."
                    .to_owned(),
            )
        })?;
    let url = ai
        .inner
        .chatgpt
        .start(port)
        .map_err(|said| ApiError::new(StatusCode::BAD_REQUEST, said))?;
    Ok(Json(json!({"url": url})))
}

/// Where `OpenAI` sends the browser back. It carries a code, so the page is never cached and the
/// address never passed on.
async fn chatgpt_callback(
    State(ai): State<Ai>,
    headers: axum::http::HeaderMap,
    Query(back): Query<chatgpt::Return>,
) -> Response {
    let local = headers
        .get(axum::http::header::HOST)
        .and_then(|host| host.to_str().ok())
        .and_then(chatgpt::callback_port)
        .is_some();
    let outcome = if local {
        ai.inner.chatgpt.finish(&ai.inner.keys, back).await
    } else {
        chatgpt::Outcome::Failed
    };
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
            (axum::http::header::REFERRER_POLICY, "no-referrer"),
        ],
        chatgpt::landing_page(outcome),
    )
        .into_response()
}

async fn check_chatgpt(State(ai): State<Ai>) -> Json<Value> {
    Json(json!({"chatgpt": ai.inner.chatgpt.check(&ai.inner.keys).await}))
}

async fn sign_out_chatgpt(State(ai): State<Ai>) -> Result<Json<Value>, ApiError> {
    let revoked = ai
        .inner
        .chatgpt
        .sign_out(&ai.inner.keys)
        .await
        .map_err(|said| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, said))?;
    Ok(Json(
        json!({"chatgpt": ai.chatgpt_status(), "revoked": revoked}),
    ))
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
    chatgpt: Vec<Model>,
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
    let plan = ai.chatgpt_status();
    let chatgpt = if plan.available && plan.connected && plan.plan_use {
        plan.models.iter().map(plan_listing).collect()
    } else {
        Vec::new()
    };
    Ok(Json(json!(ModelList {
        catalog,
        anthropic,
        chatgpt,
    })))
}

/// A `ChatGPT` plan's model as the picker lists it: no price, since the plan pays.
fn plan_listing(model: &ChatGptModel) -> Model {
    Model {
        id: ModelRef {
            source: Source::ChatGpt,
            id: model.slug.clone(),
        }
        .selector(),
        name: model.name.clone(),
        description: String::new(),
        context_length: model.context_length,
        input_price: 0.0,
        output_price: 0.0,
        cached_input_price: None,
        cache_write_price: None,
        free: false,
        reasoning: !model.efforts.is_empty(),
        sees_pictures: model.sees_pictures,
        note: None,
    }
}

/// A Claude key's model as the picker lists it, with the prices `OpenRouter` lists for the same
/// model: Anthropic's own list prices, which the API doesn't report. A model the catalog doesn't
/// list takes the bundled list price, and one neither knows is listed at 0, which the app says it
/// can't price.
fn claude_listing(model: &ClaudeModel, catalog: &Catalog) -> Model {
    let reference = ModelRef {
        source: Source::Anthropic,
        id: model.id.clone(),
    };
    let listed = catalog.find(&reference.openrouter_equivalent());
    let bundled = crate::agent::list_price(&model.id);
    let (input_price, output_price, cached_input_price, cache_write_price) = match (listed, bundled)
    {
        (Some(listed), _) => (
            listed.input_price,
            listed.output_price,
            listed.cached_input_price,
            listed.cache_write_price,
        ),
        (None, Some(price)) => (
            price.input,
            price.output,
            Some(price.cache_read),
            Some(price.cache_write),
        ),
        (None, None) => (0.0, 0.0, None, None),
    };
    Model {
        id: reference.selector(),
        name: model.name.clone(),
        description: listed
            .map(|listed| listed.description.clone())
            .unwrap_or_default(),
        context_length: model.context_length,
        input_price,
        output_price,
        cached_input_price,
        cache_write_price,
        free: false,
        reasoning: model.adaptive_thinking || !model.efforts.is_empty(),
        sees_pictures: model.sees_pictures,
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

    /// What each model list says decides whether an agent is shown pictures. The lists here are
    /// the copies kept on disk, as after a restart with no network.
    #[tokio::test]
    async fn the_model_lists_say_who_sees_pictures() {
        let folder = std::env::temp_dir().join(format!("loomwatch-ai-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let catalog = crate::ai::models::catalog_from(&json!({"data": [
            {"id": "openai/gpt-6.1-sol", "supported_parameters": ["tools"],
             "architecture": {"input_modalities": ["text", "image"]}},
            {"id": "z-ai/glm-5.3", "supported_parameters": ["tools"],
             "architecture": {"input_modalities": ["text"]}},
        ]}));
        let kept = folder.join("models.json");
        std::fs::write(&kept, serde_json::to_vec(&catalog).unwrap()).unwrap();
        std::fs::write(
            folder.join(anthropic::STATUS_FILE),
            json!({"connected": true, "models": [{
                "id": "claude-text-only", "name": "Text only", "contextLength": 200_000,
                "maxOutput": 8_000, "adaptiveThinking": false, "seesPictures": false
            }]})
            .to_string(),
        )
        .unwrap();
        let ai = Ai::with(
            Keys::in_memory(),
            Models::with_url("http://127.0.0.1:9/models", Some(kept)),
            &folder,
            "http://127.0.0.1:9/api/v1/key",
        );
        for (model, sees) in [
            ("openai/gpt-6.1-sol", true),
            ("z-ai/glm-5.3", false),
            ("someone/unlisted", false),
            (crate::agent::OFFLINE_MODEL, false),
            ("anthropic:claude-opus-5-5", true),
            ("anthropic:claude-text-only", false),
            ("chatgpt:gpt-6.1-sol", true),
        ] {
            assert_eq!(
                ai.sees_pictures(&ModelRef::parse(model)).await,
                sees,
                "{model}"
            );
        }
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_claude_model_is_priced_from_the_catalog_else_the_bundled_list_else_not_at_all() {
        let catalog = crate::ai::models::catalog_from(&json!({"data": [{
            "id": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5",
            "pricing": {"prompt": "0.000004", "completion": "0.00002"},
            "supported_parameters": ["tools"],
        }]}));
        let claude = |id: &str| ClaudeModel {
            id: id.to_owned(),
            name: id.to_owned(),
            context_length: 200_000,
            max_output: 64_000,
            adaptive_thinking: true,
            sees_pictures: true,
            efforts: Vec::new(),
        };
        let listed = claude_listing(&claude("claude-opus-5-5"), &catalog);
        assert_eq!(listed.id, "anthropic:claude-opus-5-5");
        assert!(
            (listed.input_price - 4.0).abs() < 1e-9 && (listed.output_price - 20.0).abs() < 1e-9
        );
        // Not in the catalog: Anthropic's list price, not "free".
        let bundled = claude_listing(&claude("claude-haiku-5-5"), &catalog);
        assert!(
            (bundled.input_price - 0.10).abs() < 1e-9 && (bundled.output_price - 0.50).abs() < 1e-9
        );
        assert_eq!(bundled.cached_input_price, Some(0.01));
        let unknown = claude_listing(&claude("claude-next-9"), &catalog);
        assert!(unknown.input_price == 0.0 && unknown.output_price == 0.0 && !unknown.free);
    }

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

    /// What a stand-in for `OpenAI` saw and must answer.
    #[derive(Clone, Default)]
    struct FakeOpenAi {
        /// The nonce the next ID token carries, as the authorize address asked.
        nonce: Arc<std::sync::Mutex<String>>,
        /// The issuer the ID token names: the stand-in's own address.
        issuer: Arc<std::sync::Mutex<String>>,
        forms: Arc<std::sync::Mutex<Vec<String>>>,
    }

    fn jwt(claims: &Value) -> String {
        use base64::Engine as _;
        let encode = |value: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        format!(
            "{}.{}.c2ln",
            encode(&json!({"alg": "RS256"})),
            encode(claims)
        )
    }

    async fn fake_openai() -> (FakeOpenAi, String) {
        async fn token(State(fake): State<FakeOpenAi>, body: String) -> Response {
            fake.forms.lock().unwrap().push(body.clone());
            let form: std::collections::HashMap<String, String> =
                url::form_urlencoded::parse(body.as_bytes())
                    .into_owned()
                    .collect();
            if form.get("refresh_token").map(String::as_str) == Some("rt_dead") {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "invalid_grant"})),
                )
                    .into_response();
            }
            let client = form.get("client_id").cloned().unwrap_or_default();
            let rotated = if form["grant_type"] == "refresh_token" {
                "rt_2"
            } else {
                "rt_1"
            };
            let issuer = fake.issuer.lock().unwrap().clone();
            let nonce = fake.nonce.lock().unwrap().clone();
            let id_token = jwt(&json!({"iss": issuer, "aud": [client], "sub": "user-1",
                "email": "a@example.com", "nonce": nonce, "exp": Utc::now().timestamp() + 3600}));
            // A person who declined plan use on the consent page gets the sign-in alone.
            let scope = if form.get("code").map(String::as_str) == Some("c_noplan") {
                "openid profile email offline_access"
            } else {
                "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
            };
            Json(json!({"access_token": format!("at_{rotated}"), "refresh_token": rotated, "id_token": id_token,
                "expires_in": 3600, "token_type": "Bearer", "scope": scope}))
            .into_response()
        }
        async fn revoke(State(fake): State<FakeOpenAi>, body: String) -> StatusCode {
            fake.forms.lock().unwrap().push(format!("revoke:{body}"));
            StatusCode::OK
        }
        async fn models(headers: axum::http::HeaderMap) -> Response {
            let auth = headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            if !auth.starts_with("Bearer at_") {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            Json(json!({"models": [{"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", "visibility": "list",
                "priority": 1, "context_window": 500_000, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}]}]}))
            .into_response()
        }
        let fake = FakeOpenAi::default();
        let app = Router::new()
            .route("/api/accounts/oauth/token", post(token))
            .route("/api/accounts/oauth/revoke", post(revoke))
            .route("/v1/models", get(models))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let base = format!("http://{address}");
        fake.issuer.lock().unwrap().clone_from(&base);
        (fake, base)
    }

    async fn sign_in_at(app: &Router, host: &str) -> (StatusCode, Value) {
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/api/ai/chatgpt/sign-in")
            .header("x-loomwatch-request", "1")
            .header("host", host)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn come_back(app: &Router, query: &str) -> String {
        let request = HttpRequest::builder()
            .uri(format!("{}?{query}", chatgpt::CALLBACK))
            .header("host", "127.0.0.1:3999")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.headers()["cache-control"], "no-store");
        String::from_utf8(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap()
    }

    fn query_of(url: &str) -> std::collections::HashMap<String, String> {
        url::Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    /// The first sign-in registers `LoomWatch` and keeps the client `OpenAI` issued; a later one
    /// names that client and this computer's id; tokens rotate on refresh; a grant `OpenAI` ended
    /// asks for a new sign-in; and signing out revokes the token but keeps the client.
    #[tokio::test]
    async fn signing_in_with_chatgpt_keeps_only_the_refresh_token_and_the_issued_client() {
        let folder = std::env::temp_dir().join(format!("loomwatch-ai-{}", uuid::Uuid::new_v4()));
        let keys = Keys::in_memory();
        let (fake, base) = fake_openai().await;
        let ai = Ai::with(
            keys.clone(),
            Models::with_url("http://127.0.0.1:9/models", None),
            &folder,
            &fake_openrouter().await,
        )
        .with_openai_at(&base, &base);
        let app = router(ai.clone());

        let (_, body) = send(&app, "GET", "/api/ai", None, false).await;
        assert_eq!(body["chatgpt"]["available"], chatgpt::AVAILABLE);
        assert_eq!(body["chatgpt"]["connected"], false);
        assert_eq!(
            sign_in_at(&app, "[::1]:3000").await.0,
            StatusCode::FORBIDDEN
        );

        let (status, body) = sign_in_at(&app, "127.0.0.1:3999").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let asked = query_of(body["url"].as_str().unwrap());
        assert_eq!(asked["client_id"], "dynamic_agent_client");
        assert_eq!(asked["agent_name_hint"], "LoomWatch");
        assert_eq!(
            asked["redirect_uri"],
            "http://127.0.0.1:3999/api/ai/chatgpt/callback"
        );
        assert_eq!(asked["code_challenge_method"], "S256");
        assert!(asked["scope"].contains("chatgpt.tokens.use.direct"));
        assert!(asked["ext_agent_host_id"].starts_with("urn:uuid:"));
        let host_id = asked["ext_agent_host_id"].clone();

        // A state nobody started is an ended sign-in.
        assert!(
            come_back(&app, "code=x&state=nobody")
                .await
                .contains("This sign-in has ended")
        );

        fake.nonce.lock().unwrap().clone_from(&asked["nonce"]);
        let page = come_back(
            &app,
            &format!("code=c1&state={}&client_id=oaiapp_1", asked["state"]),
        )
        .await;
        assert!(page.contains("Connected"), "{page}");
        assert!(page.contains("loomwatch-ai"));
        let status = ai.chatgpt_status();
        assert!(status.connected && status.plan_use);
        assert_eq!(status.email.as_deref(), Some("a@example.com"));
        assert_eq!(status.client_id.as_deref(), Some("oaiapp_1"));
        assert_eq!(status.models[0].slug, "gpt-6.1-sol");
        let secret = keys.plan_secrets().await.unwrap().chatgpt.unwrap();
        assert_eq!(
            (secret.client_id.as_str(), secret.refresh_token.as_str()),
            ("oaiapp_1", "rt_1")
        );
        assert!(fake.forms.lock().unwrap()[0].contains("client_id=oaiapp_1"));
        if chatgpt::AVAILABLE {
            assert!(ai.connected_sources().contains(&Source::ChatGpt));
        }
        let (_, models) = send(&app, "GET", "/api/ai", None, false).await;
        assert!(!models.to_string().contains("rt_1"));

        // The token from the sign-in is used while fresh; a renewal rotates the refresh token.
        let access = ai.chatgpt_access();
        assert_eq!(access.token(false).await.unwrap(), "at_rt_1");
        assert_eq!(access.token(true).await.unwrap(), "at_rt_2");
        assert_eq!(
            keys.plan_secrets()
                .await
                .unwrap()
                .chatgpt
                .unwrap()
                .refresh_token,
            "rt_2"
        );

        // A later sign-in names the issued client and this computer, and no new name.
        let (_, body) = sign_in_at(&app, "127.0.0.1:3999").await;
        let again = query_of(body["url"].as_str().unwrap());
        assert_eq!(again["client_id"], "oaiapp_1");
        assert_eq!(again["ext_agent_host_id"], host_id);
        assert_eq!(again["login_hint"], "a@example.com");
        assert!(!again.contains_key("agent_name_hint"));

        let _ = std::fs::remove_dir_all(&folder);
    }

    /// A stand-in `OpenAI`, an [`Ai`] that signs in with it, and that sign-in done.
    async fn signed_in() -> (Ai, Router, FakeOpenAi, Keys, std::path::PathBuf) {
        let folder = std::env::temp_dir().join(format!("loomwatch-ai-{}", uuid::Uuid::new_v4()));
        let keys = Keys::in_memory();
        let (fake, base) = fake_openai().await;
        let ai = Ai::with(
            keys.clone(),
            Models::with_url("http://127.0.0.1:9/models", None),
            &folder,
            &fake_openrouter().await,
        )
        .with_openai_at(&base, &base);
        let app = router(ai.clone());
        let (_, body) = sign_in_at(&app, "127.0.0.1:3999").await;
        let asked = query_of(body["url"].as_str().unwrap());
        fake.nonce.lock().unwrap().clone_from(&asked["nonce"]);
        let page = come_back(
            &app,
            &format!("code=c1&state={}&client_id=oaiapp_1", asked["state"]),
        )
        .await;
        assert!(page.contains("Connected"), "{page}");
        (ai, app, fake, keys, folder)
    }

    /// Signing out revokes the refresh token and forgets it, keeping the client for next time; a
    /// grant `OpenAI` ended asks for a new sign-in and says so.
    #[tokio::test]
    async fn signing_out_revokes_and_an_ended_grant_asks_to_sign_in_again() {
        let (ai, app, fake, keys, folder) = signed_in().await;
        let access = ai.chatgpt_access();
        assert_eq!(access.token(true).await.unwrap(), "at_rt_2");
        let (status, body) = send(&app, "DELETE", "/api/ai/chatgpt", None, true).await;
        assert_eq!(
            (status, body["revoked"].clone()),
            (StatusCode::OK, json!(true))
        );
        assert!(
            fake.forms
                .lock()
                .unwrap()
                .iter()
                .any(|form| form.starts_with("revoke:") && form.contains("token=rt_2"))
        );
        assert!(keys.plan_secrets().await.unwrap().chatgpt.is_none());
        let status = ai.chatgpt_status();
        assert!(!status.connected);
        assert_eq!(status.client_id.as_deref(), Some("oaiapp_1"));
        assert!(matches!(
            access.token(false).await,
            Err(crate::agent::AgentError::SignInAgain)
        ));

        // A grant OpenAI ended asks for a new sign-in and says so.
        keys.change_plan_secrets(|secrets| {
            secrets.chatgpt = Some(ChatGptSecret {
                client_id: "oaiapp_1".into(),
                refresh_token: "rt_dead".into(),
                subject: "user-1".into(),
                email: String::new(),
                scopes: vec!["chatgpt.tokens.use.direct".into()],
            });
        })
        .await
        .unwrap();
        assert!(matches!(
            access.token(true).await,
            Err(crate::agent::AgentError::SignInAgain)
        ));
        assert!(keys.plan_secrets().await.unwrap().chatgpt.is_none());
        assert!(
            ai.chatgpt_status()
                .problem
                .unwrap()
                .contains("Sign in with ChatGPT again")
        );
        let _ = std::fs::remove_dir_all(&folder);
    }

    /// An ID token made for another sign-in (another nonce) is refused, and nothing is kept.
    #[tokio::test]
    async fn an_id_token_from_another_sign_in_is_refused() {
        let folder = std::env::temp_dir().join(format!("loomwatch-ai-{}", uuid::Uuid::new_v4()));
        let keys = Keys::in_memory();
        let (fake, base) = fake_openai().await;
        let ai = Ai::with(
            keys.clone(),
            Models::with_url("http://127.0.0.1:9/models", None),
            &folder,
            &fake_openrouter().await,
        )
        .with_openai_at(&base, &base);
        let app = router(ai.clone());
        let (_, body) = sign_in_at(&app, "127.0.0.1:3999").await;
        let asked = query_of(body["url"].as_str().unwrap());
        *fake.nonce.lock().unwrap() = "someone-elses".to_owned();
        let page = come_back(
            &app,
            &format!("code=c1&state={}&client_id=oaiapp_1", asked["state"]),
        )
        .await;
        assert!(page.contains("Not connected"), "{page}");
        assert!(keys.plan_secrets().await.unwrap().chatgpt.is_none());
        assert!(!ai.chatgpt_status().connected);
        let _ = std::fs::remove_dir_all(&folder);
    }

    /// Signing in without allowing plan use keeps the account but no plan: the app says to turn it on.
    #[tokio::test]
    async fn a_sign_in_without_plan_use_is_kept_but_off() {
        let folder = std::env::temp_dir().join(format!("loomwatch-ai-{}", uuid::Uuid::new_v4()));
        let (fake, base) = fake_openai().await;
        let ai = Ai::with(
            Keys::in_memory(),
            Models::with_url("http://127.0.0.1:9/models", None),
            &folder,
            &fake_openrouter().await,
        )
        .with_openai_at(&base, &base);
        let start = ai.inner.chatgpt.start(3999).unwrap();
        let asked = query_of(&start);
        fake.nonce.lock().unwrap().clone_from(&asked["nonce"]);
        let back = chatgpt::back(&[
            ("code", "c_noplan"),
            ("state", asked["state"].as_str()),
            ("client_id", "oaiapp_1"),
        ]);
        let outcome = ai.inner.chatgpt.finish(&ai.inner.keys, back).await;
        assert_eq!(outcome, chatgpt::Outcome::PlanUseOff);
        let status = ai.chatgpt_status();
        assert!(status.connected && !status.plan_use);
        assert!(!ai.connected_sources().contains(&Source::ChatGpt));
        assert!(matches!(
            ai.chatgpt_access().token(true).await,
            Err(crate::agent::AgentError::PlanUseOff)
        ));
        // The person declined on the consent page.
        let start = ai.inner.chatgpt.start(3999).unwrap();
        let asked = query_of(&start);
        let declined = ai
            .inner
            .chatgpt
            .finish(
                &ai.inner.keys,
                chatgpt::back(&[
                    ("state", asked["state"].as_str()),
                    ("error", "access_denied"),
                ]),
            )
            .await;
        assert_eq!(declined, chatgpt::Outcome::Denied);
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
