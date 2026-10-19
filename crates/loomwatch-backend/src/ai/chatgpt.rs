//! Sign in with `ChatGPT` (ADR 0073): agents run on the person's `ChatGPT` Plus or Pro plan.
//!
//! `OpenAI` lets open-source apps that run on the person's own computer use their plan without
//! asking first (developers.openai.com/siwc/token-sharing-open-source). `LoomWatch` is a public
//! client: no secret, PKCE instead. The first sign-in registers it under `dynamic_agent_client` with
//! the name `LoomWatch`, and `OpenAI` sends back the client id it issued for this account, kept for
//! every later sign-in with this computer's own `ext_agent_host_id`.
//!
//! - The browser comes back to `http://127.0.0.1:<port>/api/ai/chatgpt/callback`: always
//!   `127.0.0.1`, as `OpenAI` asks, on the port the app was opened on.
//! - Only the refresh token is kept, in `LoomWatch.Plans` beside the Claude key. The access token
//!   lasts an hour, lives in memory, and is made again from the refresh token, which rotates each
//!   time; one refresh runs at a time.
//! - Plan use is on only when the person allowed `chatgpt.tokens.use.direct`.
//! - The ID token is taken straight from `OpenAI`'s token endpoint over TLS, so its issuer is
//!   proven by the connection (`OpenID` Connect Core §3.1.3.7); its audience, expiry and nonce are
//!   checked here.
//! - Nothing is ever sent to `ChatGPT`'s own back end: requests go to the public Responses API.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine as _;
use chrono::{SecondsFormat, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::keys::{ChatGptSecret, Keys};
use crate::agent::{AgentError, is_loopback_http};

/// Whether this build offers the `ChatGPT` plan. A build without the `chatgpt` feature hides it, so
/// a paid edition can ship without it until `OpenAI` approves one.
pub const AVAILABLE: bool = cfg!(feature = "chatgpt");
/// Where `OpenAI`'s sign-in lives.
pub const DEFAULT_AUTH_URL: &str = "https://auth.openai.com";
/// Where `OpenAI`'s API lives.
pub const DEFAULT_API_URL: &str = "https://api.openai.com";
/// Name stand-ins for `OpenAI`'s sign-in and API on this computer, for trial copies and checks that
/// must not use a real plan. Only an `http` address on this computer is taken.
pub const AUTH_URL_ENV: &str = "LOOMWATCH_OPENAI_AUTH_URL";
pub const API_URL_ENV: &str = "LOOMWATCH_OPENAI_URL";
/// Where `OpenAI` sends the browser back. It never changes: `OpenAI` lets only the port vary.
pub const CALLBACK: &str = "/api/ai/chatgpt/callback";
/// Where `ChatGPT` shows a plan's usage and each app's share of it.
pub const USAGE_URL: &str = crate::agent::CHATGPT_USAGE_URL;
pub(crate) const STATUS_FILE: &str = "chatgpt.json";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The permission that lets `LoomWatch` use the plan, as against only knowing who signed in.
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const AGENT_NAME: &str = "LoomWatch";
const FIRST_SIGN_IN: &str = "dynamic_agent_client";
const PENDING_FOR: Duration = Duration::from_mins(10);
const MAX_PENDING: usize = 8;
const TIMEOUT: Duration = Duration::from_secs(30);
/// The access token is renewed this long before it lapses when `OpenAI` doesn't say when.
const RENEW_EARLY: Duration = Duration::from_mins(6);
/// The longest an access token is believed to last, whatever the answer says.
const MAX_LIFETIME: Duration = Duration::from_hours(1);

fn chosen(env: &str, default: &str) -> String {
    let setting = std::env::var(env).ok();
    let Some(setting) = setting
        .as_deref()
        .map(str::trim)
        .filter(|setting| !setting.is_empty())
    else {
        return default.to_owned();
    };
    let setting = setting.trim_end_matches('/');
    if is_loopback_http(setting) {
        return setting.to_owned();
    }
    eprintln!(
        "warning: {env} must be an http address on this computer (127.0.0.1, localhost or \
         [::1]); using OpenAI itself"
    );
    default.to_owned()
}

/// Where the sign-in goes: [`DEFAULT_AUTH_URL`], or the stand-in [`AUTH_URL_ENV`] names.
#[must_use]
pub fn auth_base() -> String {
    chosen(AUTH_URL_ENV, DEFAULT_AUTH_URL)
}

/// Where the plan's requests go: [`DEFAULT_API_URL`], or the stand-in [`API_URL_ENV`] names.
#[must_use]
pub fn api_base() -> String {
    chosen(API_URL_ENV, DEFAULT_API_URL)
}

/// What the app shows about the sign-in. None of it is a token.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptStatus {
    /// This build offers the `ChatGPT` plan. Set when the status is served, never kept.
    #[serde(default)]
    pub available: bool,
    pub connected: bool,
    /// The account that signed in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The person allowed `LoomWatch` to use their plan, not only to know who they are.
    #[serde(default)]
    pub plan_use: bool,
    /// The models the plan offers, as the last sign-in or check listed them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ChatGptModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_in_at: Option<String>,
    /// Why the sign-in stopped working, or the last check failed, in plain words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// The client `OpenAI` issued `LoomWatch` for this account, kept for the next sign-in. Not a
    /// secret: a public client has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// This computer's id for `OpenAI`, made once and sent with every sign-in from here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
}

/// One model the plan offers, as `GET /v1/models` describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptModel {
    /// `gpt-6.1-sol`: what the Responses API calls it.
    pub slug: String,
    /// `GPT-6.1-Sol`.
    pub name: String,
    pub context_length: u64,
    /// The efforts it takes, least first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
    /// `OpenAI`'s order: lower first.
    #[serde(default)]
    pub priority: i64,
}

/// A sign-in the person started and `OpenAI` hasn't sent back yet.
struct Pending {
    state: String,
    verifier: String,
    nonce: String,
    redirect_uri: String,
    /// The client the authorize request named: [`FIRST_SIGN_IN`], or the one issued before.
    client_id: String,
    started: Instant,
}

/// How a sign-in ended, as the landing page and the app's channel say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Connected,
    /// Signed in, but plan use wasn't allowed.
    PlanUseOff,
    Denied,
    Expired,
    Failed,
    Storage,
}

impl Outcome {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::PlanUseOff => "plan_use_off",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Failed => "failed",
            Self::Storage => "storage",
        }
    }
}

/// What the browser brings back.
#[derive(Debug, Default, Deserialize)]
pub struct Return {
    code: Option<String>,
    state: Option<String>,
    scope: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}

/// The access token in use, and a refresh token `OpenAI` rotated that couldn't be kept yet.
#[derive(Default)]
struct Access {
    token: Option<(String, Instant)>,
    unsaved_refresh: Option<String>,
}

/// The sign-in with `ChatGPT`, its tokens and its status.
pub(crate) struct ChatGpt {
    auth: String,
    api: String,
    status_file: PathBuf,
    client: Option<Client>,
    pending: std::sync::Mutex<Vec<Pending>>,
    access: Mutex<Access>,
}

impl std::fmt::Debug for ChatGpt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChatGpt")
            .field("auth", &self.auth)
            .field("api", &self.api)
            .finish_non_exhaustive()
    }
}

impl ChatGpt {
    pub(crate) fn new(state_dir: &Path, auth: &str, api: &str) -> Self {
        let auth = auth.trim_end_matches('/').to_owned();
        let api = api.trim_end_matches('/').to_owned();
        let local = is_loopback_http(&auth) && is_loopback_http(&api);
        let client = Client::builder()
            .user_agent(concat!("LoomWatch/", env!("CARGO_PKG_VERSION")))
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!local)
            .build()
            .ok();
        Self {
            auth,
            api,
            status_file: state_dir.join(STATUS_FILE),
            client,
            pending: std::sync::Mutex::default(),
            access: Mutex::default(),
        }
    }

    pub(crate) fn api(&self) -> &str {
        &self.api
    }

    /// What was last said about the sign-in. Never reads a token.
    pub(crate) fn status(&self) -> ChatGptStatus {
        let mut status: ChatGptStatus = std::fs::read(&self.status_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        status.available = AVAILABLE;
        status
    }

    fn keep_status(&self, status: &ChatGptStatus) {
        let written = serde_json::to_vec_pretty(status)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::approvals::write_private(&self.status_file, &text));
        if let Err(error) = written {
            eprintln!("warning: could not keep the ChatGPT sign-in's status: {error}");
        }
    }

    fn client(&self) -> Result<&Client, String> {
        self.client
            .as_ref()
            .ok_or_else(|| "This computer can't make HTTPS requests.".to_owned())
    }

    /// The address of `OpenAI`'s consent page for a new sign-in. `port` is the one the app was
    /// opened on; the browser comes back to `127.0.0.1` on it.
    pub(crate) fn start(&self, port: u16) -> Result<String, String> {
        if !AVAILABLE {
            return Err("This copy of LoomWatch doesn't offer the ChatGPT plan.".to_owned());
        }
        let mut status = self.status();
        let host_id = status
            .host_id
            .clone()
            .unwrap_or_else(|| format!("urn:uuid:{}", uuid::Uuid::new_v4()));
        if status.host_id.as_deref() != Some(host_id.as_str()) {
            status.host_id = Some(host_id.clone());
            self.keep_status(&status);
        }
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK}");
        let client_id = status
            .client_id
            .clone()
            .unwrap_or_else(|| FIRST_SIGN_IN.to_owned());
        let pending = Pending {
            state: random(2),
            verifier: random(2),
            nonce: random(1),
            redirect_uri,
            client_id,
            started: Instant::now(),
        };
        let challenge = challenge(&pending.verifier);
        let mut params = vec![
            ("response_type", "code"),
            ("client_id", pending.client_id.as_str()),
            ("redirect_uri", pending.redirect_uri.as_str()),
            ("scope", SCOPE),
            ("resource", "https://api.openai.com/v1"),
            ("state", pending.state.as_str()),
            ("nonce", pending.nonce.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("ext_agent_host_id", host_id.as_str()),
        ];
        if pending.client_id == FIRST_SIGN_IN {
            params.push(("agent_name_hint", AGENT_NAME));
        } else if let Some(email) = status.email.as_deref() {
            params.push(("login_hint", email));
        }
        let url =
            url::Url::parse_with_params(&format!("{}/api/accounts/authorize", self.auth), params)
                .map_err(|_| "LoomWatch's address for OpenAI is wrong.".to_owned())?;
        let mut waiting = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        waiting.retain(|pending| pending.started.elapsed() < PENDING_FOR);
        if waiting.len() >= MAX_PENDING {
            waiting.remove(0);
        }
        waiting.push(pending);
        Ok(url.to_string())
    }

    /// Finishes a sign-in `OpenAI` sent back: the code exchanged, the ID token checked, the refresh
    /// token kept, and the plan's models listed.
    pub(crate) async fn finish(&self, keys: &Keys, back: Return) -> Outcome {
        let Some(pending) = self.take_pending(back.state.as_deref()) else {
            return Outcome::Expired;
        };
        if back.error.is_some() {
            return Outcome::Denied;
        }
        let signed = match self.exchange(&pending, back).await {
            Ok(signed) => signed,
            Err(outcome) => return outcome,
        };
        let plan_use = signed.scopes.iter().any(|scope| scope == PLAN_SCOPE);
        crate::agent::hide_secret(&signed.refresh);
        crate::agent::hide_secret(&signed.access);
        let secret = ChatGptSecret {
            client_id: signed.client_id.clone(),
            refresh_token: signed.refresh,
            subject: signed.identity.subject,
            email: signed.identity.email.clone().unwrap_or_default(),
            scopes: signed.scopes,
        };
        if keys
            .change_plan_secrets(move |secrets| secrets.chatgpt = Some(secret))
            .await
            .is_err()
        {
            return Outcome::Storage;
        }
        *self.access.lock().await = Access {
            token: Some((signed.access.clone(), Instant::now() + signed.lifetime)),
            unsaved_refresh: None,
        };
        let models = if plan_use {
            self.list_models(&signed.access).await.unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut status = self.status();
        status.connected = true;
        status.email = signed.identity.email;
        status.plan_use = plan_use;
        status.models = models;
        status.signed_in_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
        status.problem = None;
        status.client_id = Some(signed.client_id);
        self.keep_status(&status);
        if plan_use {
            Outcome::Connected
        } else {
            Outcome::PlanUseOff
        }
    }

    /// The sign-in waiting for `state`, taken off the list; none for one nobody started or that
    /// waited too long.
    fn take_pending(&self, state: Option<&str>) -> Option<Pending> {
        let mut waiting = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let position = state.and_then(|state| {
            waiting.iter().position(|pending| {
                pending.state == state && pending.started.elapsed() < PENDING_FOR
            })
        })?;
        Some(waiting.remove(position))
    }

    /// The code exchanged for tokens, and the ID token checked against the sign-in.
    async fn exchange(&self, pending: &Pending, back: Return) -> Result<Signed, Outcome> {
        let code = back.code.ok_or(Outcome::Failed)?;
        // A first sign-in names the client `OpenAI` just issued; a later one must keep its own.
        let client_id = match (pending.client_id.as_str(), back.client_id) {
            (FIRST_SIGN_IN, Some(issued)) if !issued.is_empty() => issued,
            (FIRST_SIGN_IN, _) => return Err(Outcome::Failed),
            (kept, Some(issued)) if issued != kept => return Err(Outcome::Failed),
            (kept, _) => kept.to_owned(),
        };
        let tokens = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id.as_str()),
                ("code", code.as_str()),
                ("code_verifier", pending.verifier.as_str()),
                ("redirect_uri", pending.redirect_uri.as_str()),
                ("resource", "https://api.openai.com/v1"),
            ])
            .await
            .map_err(|_| Outcome::Failed)?;
        let identity = tokens
            .id_token
            .as_deref()
            .and_then(|token| self.identity(token, &client_id, &pending.nonce))
            .ok_or(Outcome::Failed)?;
        let (Some(refresh), Some(access)) = (tokens.refresh_token, tokens.access_token) else {
            return Err(Outcome::Failed);
        };
        let scopes = tokens
            .scope
            .or(back.scope)
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        Ok(Signed {
            client_id,
            identity,
            refresh,
            access,
            scopes,
            lifetime: tokens.lifetime,
        })
    }

    /// The ID token's account, once its audience, expiry and nonce are this sign-in's.
    fn identity(&self, token: &str, client_id: &str, nonce: &str) -> Option<Identity> {
        let payload = token.split('.').nth(1)?;
        let claims: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload.trim_end_matches('='))
                .ok()?,
        )
        .ok()?;
        let issuer = claims.get("iss").and_then(Value::as_str)?;
        let audience = match claims.get("aud")? {
            Value::String(one) => one == client_id,
            Value::Array(many) => many.iter().any(|one| one == client_id),
            _ => false,
        };
        let fresh = claims
            .get("exp")
            .and_then(Value::as_i64)
            .is_some_and(|exp| exp > Utc::now().timestamp());
        let ours = claims.get("nonce").and_then(Value::as_str) == Some(nonce);
        if issuer.trim_end_matches('/') != self.auth || !audience || !fresh || !ours {
            return None;
        }
        Some(Identity {
            subject: claims.get("sub").and_then(Value::as_str)?.to_owned(),
            email: claims
                .get("email")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<Tokens, TokenError> {
        let client = self.client().map_err(|_| TokenError::Unreachable)?;
        let response = client
            .post(format!("{}/api/accounts/oauth/token", self.auth))
            .header(reqwest::header::CONTENT_TYPE, FORM)
            .body(form_body(form))
            .send()
            .await
            .map_err(|_| TokenError::Unreachable)?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let code = body
                .get("error")
                .and_then(|error| error.as_str().or_else(|| error.get("code")?.as_str()))
                .unwrap_or_default();
            // These mean the grant is gone; anything else may pass.
            let ended = matches!(
                code,
                "invalid_grant"
                    | "invalid_refresh_token"
                    | "token_expired"
                    | "refresh_token_expired"
                    | "refresh_token_invalidated"
                    | "refresh_token_reused"
            );
            return Err(if ended {
                TokenError::Ended
            } else if status.is_server_error() {
                TokenError::Unreachable
            } else {
                TokenError::Refused
            });
        }
        let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_owned);
        let lifetime = body
            .get("expires_in")
            .and_then(Value::as_u64)
            .map_or(MAX_LIFETIME, Duration::from_secs)
            .min(MAX_LIFETIME);
        // Renewed at `earliest_refresh_at` when `OpenAI` says it, else a few minutes early.
        let renew_in = body
            .get("earliest_refresh_at")
            .and_then(Value::as_i64)
            .and_then(|at| u64::try_from(at - Utc::now().timestamp()).ok())
            .map(Duration::from_secs)
            .filter(|renew| *renew < lifetime)
            .unwrap_or_else(|| lifetime.saturating_sub(RENEW_EARLY));
        Ok(Tokens {
            access_token: text("access_token"),
            refresh_token: text("refresh_token"),
            id_token: text("id_token"),
            scope: text("scope"),
            lifetime: renew_in,
        })
    }

    /// An access token for the plan's requests: the one in memory while it is fresh, else a new one
    /// from the refresh token. `renew` asks for a new one even if the one held looks fresh, after
    /// `OpenAI` refused it.
    pub(crate) async fn access_token(
        &self,
        keys: &Keys,
        renew: bool,
    ) -> Result<String, AgentError> {
        let mut access = self.access.lock().await;
        if !renew
            && let Some((token, until)) = &access.token
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        let secrets = keys.plan_secrets().await.map_err(|error| {
            AgentError::Provider(crate::ai::Source::ChatGpt, format!("{error:#}"))
        })?;
        let Some(secret) = secrets.chatgpt else {
            return Err(AgentError::SignInAgain);
        };
        if !secret.scopes.iter().any(|scope| scope == PLAN_SCOPE) {
            return Err(AgentError::PlanUseOff);
        }
        let refresh = access
            .unsaved_refresh
            .clone()
            .unwrap_or_else(|| secret.refresh_token.clone());
        let tokens = match self
            .token_request(&[
                ("grant_type", "refresh_token"),
                ("client_id", secret.client_id.as_str()),
                ("refresh_token", refresh.as_str()),
                ("resource", "https://api.openai.com/v1"),
            ])
            .await
        {
            Ok(tokens) => tokens,
            Err(TokenError::Ended) => {
                access.token = None;
                access.unsaved_refresh = None;
                drop(access);
                self.ended(keys).await;
                return Err(AgentError::SignInAgain);
            }
            Err(TokenError::Refused) => return Err(AgentError::SignInAgain),
            Err(TokenError::Unreachable) => {
                return Err(AgentError::Network(
                    crate::ai::Source::ChatGpt,
                    "couldn't renew the sign-in with ChatGPT".to_owned(),
                ));
            }
        };
        let Some(token) = tokens.access_token else {
            return Err(AgentError::SignInAgain);
        };
        crate::agent::hide_secret(&token);
        if let Some(rotated) = tokens.refresh_token {
            crate::agent::hide_secret(&rotated);
            let kept = rotated.clone();
            let saved = keys
                .change_plan_secrets(move |secrets| {
                    if let Some(chatgpt) = secrets.chatgpt.as_mut() {
                        chatgpt.refresh_token = kept;
                    }
                })
                .await;
            // A rotated token that couldn't be kept is the only one that works now: hold it.
            access.unsaved_refresh = saved.is_err().then_some(rotated);
        }
        access.token = Some((token.clone(), Instant::now() + tokens.lifetime));
        Ok(token)
    }

    /// The sign-in can't be renewed any more: its tokens go, the client and this computer's id
    /// stay for the next sign-in, and the app says to sign in again.
    async fn ended(&self, keys: &Keys) {
        let _ = keys
            .change_plan_secrets(|secrets| secrets.chatgpt = None)
            .await;
        let mut status = self.status();
        status.connected = false;
        status.problem = Some(
            "Your sign-in with ChatGPT has ended. Sign in with ChatGPT again to keep using your \
             plan."
                .to_owned(),
        );
        self.keep_status(&status);
    }

    /// Signs out: the refresh token is revoked with `OpenAI`, and the tokens forgotten here. The
    /// client and this computer's id stay for the next sign-in. Says whether `OpenAI` confirmed it.
    pub(crate) async fn sign_out(&self, keys: &Keys) -> Result<bool, String> {
        let secrets = keys
            .plan_secrets()
            .await
            .map_err(|error| format!("{error:#}"))?;
        let mut revoked = true;
        if let Some(secret) = secrets.chatgpt {
            revoked = match self.client() {
                Ok(client) => client
                    .post(format!("{}/api/accounts/oauth/revoke", self.auth))
                    .header(reqwest::header::CONTENT_TYPE, FORM)
                    .body(form_body(&[
                        ("token", secret.refresh_token.as_str()),
                        ("token_type_hint", "refresh_token"),
                        ("client_id", secret.client_id.as_str()),
                    ]))
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success()),
                Err(_) => false,
            };
        }
        keys.change_plan_secrets(|secrets| secrets.chatgpt = None)
            .await
            .map_err(|error| format!("{error:#}"))?;
        *self.access.lock().await = Access::default();
        let mut status = self.status();
        status.connected = false;
        status.plan_use = false;
        status.models.clear();
        status.problem = None;
        status.signed_in_at = None;
        self.keep_status(&status);
        Ok(revoked)
    }

    /// Lists the plan's models again, which also proves the sign-in still works.
    pub(crate) async fn check(&self, keys: &Keys) -> ChatGptStatus {
        let mut status = self.status();
        match self.access_token(keys, false).await {
            Ok(token) => match self.list_models(&token).await {
                Ok(models) => {
                    status.models = models;
                    status.problem = None;
                }
                Err(problem) => status.problem = Some(problem),
            },
            Err(error) => {
                status = self.status();
                status.problem = Some(error.to_string());
            }
        }
        self.keep_status(&status);
        self.status()
    }

    /// The models the plan offers, in `OpenAI`'s order.
    async fn list_models(&self, token: &str) -> Result<Vec<ChatGptModel>, String> {
        let response = self
            .client()?
            .get(format!("{}/v1/models", self.api))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "LoomWatch couldn't reach ChatGPT for its model list.".to_owned())?;
        if !response.status().is_success() {
            return Err(format!(
                "ChatGPT couldn't list its models just now (HTTP {}).",
                response.status().as_u16()
            ));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| "ChatGPT's model list couldn't be read.".to_owned())?;
        Ok(models_from(&body))
    }
}

/// The listed models from `GET /v1/models`, hidden ones left out, `OpenAI`'s order kept.
pub(crate) fn models_from(body: &Value) -> Vec<ChatGptModel> {
    let mut models: Vec<ChatGptModel> = body
        .get("models")
        .or_else(|| body.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            model
                .get("visibility")
                .and_then(Value::as_str)
                .unwrap_or("list")
                == "list"
        })
        .filter(|model| model.get("supported_in_api").and_then(Value::as_bool) != Some(false))
        .filter_map(|model| {
            let slug = model
                .get("slug")
                .or_else(|| model.get("id"))?
                .as_str()?
                .to_owned();
            Some(ChatGptModel {
                name: model
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(&slug)
                    .to_owned(),
                context_length: model
                    .get("context_window")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                efforts: model
                    .get("supported_reasoning_levels")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|level| level.get("effort").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect(),
                priority: model
                    .get("priority")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX),
                slug,
            })
        })
        .collect();
    models.sort_by_key(|model| model.priority);
    models
}

/// The page the browser lands on after `OpenAI`. It tells the app how the sign-in went and closes.
pub(crate) fn landing_page(outcome: Outcome) -> String {
    let (title, said) = match outcome {
        Outcome::Connected => (
            "Connected",
            "LoomWatch can use your ChatGPT plan now. You can close this tab.",
        ),
        Outcome::PlanUseOff => (
            "Signed in, but plan use is off",
            "You signed in without allowing LoomWatch to use your plan. Turn it on from \
             LoomWatch's Connections page.",
        ),
        Outcome::Denied => (
            "Not connected",
            "You didn't allow LoomWatch, so nothing was connected. You can close this tab.",
        ),
        Outcome::Expired => (
            "This sign-in has ended",
            "It took over 10 minutes, or was finished in another window. Start it again in \
             LoomWatch.",
        ),
        Outcome::Failed => (
            "Not connected",
            "ChatGPT sent LoomWatch back without a sign-in it could use. Start it again in \
             LoomWatch.",
        ),
        Outcome::Storage => (
            "Not connected",
            "LoomWatch couldn't keep the sign-in safely on this computer. Unlock the Keychain, then \
             start it again.",
        ),
    };
    let message = json!({"source": "chatgpt", "outcome": outcome.as_str()}).to_string();
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{title}</title>\
<style>:root{{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}}body{{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}}main{{max-width:28rem;padding:2rem 1.5rem;text-align:center}}h1{{font-size:1.25rem;margin:0 0 .5rem}}p{{margin:0;line-height:1.5;opacity:.8}}</style></head>\
<body><main><h1>{title}</h1><p>{said}</p></main>\
<script>try{{new BroadcastChannel('loomwatch-ai').postMessage({message})}}catch(e){{}}try{{if(window.opener)setTimeout(function(){{window.close()}},1200)}}catch(e){{}}</script></body></html>"
    )
}

struct Identity {
    subject: String,
    email: Option<String>,
}

/// A sign-in that came back whole.
struct Signed {
    client_id: String,
    identity: Identity,
    refresh: String,
    access: String,
    scopes: Vec<String>,
    lifetime: Duration,
}

struct Tokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    scope: Option<String>,
    /// How long until the access token should be renewed.
    lifetime: Duration,
}

enum TokenError {
    /// The grant is gone: sign in again.
    Ended,
    /// `OpenAI` refused for another reason.
    Refused,
    /// `OpenAI` couldn't be reached or failed: try later, keep everything.
    Unreachable,
}

const FORM: &str = "application/x-www-form-urlencoded";

/// `pairs` as a form body, the way `OpenAI`'s token and revoke endpoints take them.
fn form_body(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

/// `count` random UUIDs' worth of hex: 128 bits each.
fn random(count: usize) -> String {
    (0..count)
        .map(|_| uuid::Uuid::new_v4().simple().to_string())
        .collect()
}

/// The PKCE `S256` challenge for `verifier`.
fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The port `host` names, when it is this computer's loopback name. `[::1]` is refused: `OpenAI`
/// sends the browser back to `127.0.0.1`, which a daemon listening on `[::1]` alone wouldn't hear.
#[must_use]
pub fn callback_port(host: &str) -> Option<u16> {
    let authority = host.parse::<axum::http::uri::Authority>().ok()?;
    if !matches!(authority.host(), "localhost" | "127.0.0.1") {
        return None;
    }
    Some(authority.port_u16().unwrap_or(80))
}

/// The query an `OpenAI` callback carries, for tests.
#[cfg(test)]
pub(crate) fn back(pairs: &[(&str, &str)]) -> Return {
    let map: std::collections::BTreeMap<&str, &str> = pairs.iter().copied().collect();
    let get = |key: &str| map.get(key).map(|value| (*value).to_owned());
    Return {
        code: get("code"),
        state: get("state"),
        scope: get("scope"),
        client_id: get("client_id"),
        error: get("error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_rfc_7636_s256() {
        // RFC 7636, appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_browser_comes_back_to_127_0_0_1_on_the_apps_port() {
        assert_eq!(callback_port("127.0.0.1:3004"), Some(3004));
        assert_eq!(callback_port("localhost:3000"), Some(3000));
        assert_eq!(callback_port("[::1]:3000"), None);
        assert_eq!(callback_port("evil.example:3000"), None);
    }

    #[test]
    fn listed_models_keep_openais_order_and_leave_hidden_ones_out() {
        let models = models_from(&json!({"models": [
            {"slug": "gpt-6-luna", "display_name": "GPT-6-Luna", "visibility": "list", "priority": 4,
             "context_window": 272_000, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}]},
            {"slug": "gpt-reserve", "visibility": "hide", "priority": 0},
            {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", "visibility": "list", "priority": 1,
             "context_window": 500_000, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "ultra"}]},
        ]}));
        let slugs: Vec<&str> = models.iter().map(|model| model.slug.as_str()).collect();
        assert_eq!(slugs, ["gpt-6.1-sol", "gpt-6-luna"]);
        assert_eq!(models[0].context_length, 500_000);
        assert_eq!(models[1].efforts, ["low", "high"]);
    }
}
