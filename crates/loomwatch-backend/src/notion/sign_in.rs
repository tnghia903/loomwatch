//! Notion sign-in: the authorization Notion's hosted MCP server offers any app. `LoomWatch`
//! registers itself for each sign-in (dynamic client registration, RFC 7591), proves the code
//! with PKCE instead of a client secret, and keeps the resulting grant in the Keychain. Nothing
//! here needs a developer portal, an integration, or a page shared with one.
use std::time::{Duration, Instant};

use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine as _;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::form_urlencoded::Serializer;

use super::{
    Access, ApiResult, Connection, Endpoints, MAX_RESPONSE_BYTES, NotionState, Store, WRITES,
    failure, loopback_host, not_connected, read_bounded, storage_error, unreachable, unreadable,
};

/// Where Notion sends the browser back.
pub(super) const CALLBACK: &str = "/api/notion/sign-in/callback";
/// What every place that meets a lapsed sign-in tells the operator.
pub(super) const SIGN_IN_AGAIN: &str =
    "Your Notion sign-in has expired. Open Connections and connect Notion again.";
/// How long a started sign-in waits for Notion to send the browser back.
const PENDING_FOR: Duration = Duration::from_mins(10);
/// Seconds before Notion's expiry at which the access token is renewed, so no call starts with
/// a token about to lapse.
const RENEW_EARLY: i64 = 60;
/// The access token's lifetime when Notion's answer does not say.
const DEFAULT_LIFETIME: i64 = 60 * 60;
/// The longest lifetime believed, whatever Notion's answer says.
const MAX_LIFETIME: i64 = 30 * 24 * 60 * 60;

/// The stored grant. Deliberately no Debug implementation: it holds credentials.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Grant {
    /// The client Notion registered for this sign-in. A refresh must name the same one.
    client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    access_token: String,
    refresh_token: String,
    /// Unix seconds at which Notion stops accepting `access_token`.
    expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
}

/// The client Notion registered for one sign-in.
struct Registration {
    id: String,
    secret: Option<String>,
}

/// A sign-in the operator started and Notion has not sent back yet.
pub(super) struct Pending {
    state: String,
    verifier: String,
    client: Registration,
    redirect_uri: String,
    started: Instant,
}

/// `POST /api/notion/sign-in`: register `LoomWatch` with Notion for this sign-in and answer the
/// address of Notion's consent page, which the UI opens in the same tab.
pub(super) async fn start(
    State(state): State<NotionState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    // Refuse here, not after the operator has allowed access in Notion.
    if !state.store.available() {
        return Err(storage_error());
    }
    let host = loopback_host(&headers).ok_or_else(|| {
        failure(
            StatusCode::FORBIDDEN,
            "Open LoomWatch on this computer to connect Notion.",
        )
    })?;
    let redirect_uri = format!("http://{host}{CALLBACK}");
    let client = register(&state.client, &state.endpoints, &redirect_uri).await?;
    let verifier = random(2);
    let csrf = random(1);
    let challenge = challenge(&verifier);
    let url = url::Url::parse_with_params(
        &state.endpoints.authorize,
        [
            ("response_type", "code"),
            ("client_id", client.id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", csrf.as_str()),
            ("resource", state.endpoints.mcp.as_str()),
        ],
    )
    .map_err(|_| unreadable())?;
    // A second click replaces the first: only the newest consent page can finish.
    *state.pending.lock().await = Some(Pending {
        state: csrf,
        verifier,
        client,
        redirect_uri,
        started: Instant::now(),
    });
    Ok(Json(json!({"url": url.as_str()})))
}

async fn register(
    client: &Client,
    endpoints: &Endpoints,
    redirect_uri: &str,
) -> ApiResult<Registration> {
    let mut response = client
        .post(&endpoints.register)
        .json(&json!({
            "client_name": "LoomWatch",
            "client_uri": "https://loomwatch.github.io",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .send()
        .await
        .map_err(|_| unreachable())?;
    if !response.status().is_success() {
        return Err(failure(
            StatusCode::BAD_GATEWAY,
            "Notion did not accept LoomWatch's sign-in request. Retry, or connect with an integration token under Advanced.",
        ));
    }
    let answer: Value =
        serde_json::from_slice(&read_bounded(&mut response, MAX_RESPONSE_BYTES).await?)
            .map_err(|_| unreadable())?;
    Ok(Registration {
        id: text(&answer, "client_id").ok_or_else(unreadable)?,
        secret: text(&answer, "client_secret"),
    })
}

/// What the browser brings back from Notion's consent page.
#[derive(Deserialize)]
pub(super) struct Return {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Why a sign-in ended without a connection: the `notion` query value Connections reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// The operator chose not to allow access in Notion.
    Denied,
    /// No sign-in is waiting for this answer, or it waited too long.
    Expired,
    /// Notion did not complete the exchange.
    Failed,
    /// The Keychain refused to keep the grant.
    Storage,
}

impl Refusal {
    fn code(self) -> &'static str {
        match self {
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Failed => "failed",
            Self::Storage => "storage",
        }
    }
}

/// `GET /api/notion/sign-in/callback`: finish the sign-in and send the browser to Connections,
/// which says how it went. The address carries a code, so the answer is never cached
/// ([`super::loopback_only`]) and never passed on as a referrer.
pub(super) async fn finish(
    State(state): State<NotionState>,
    Query(back): Query<Return>,
) -> Response {
    let target = match complete(&state, back).await {
        Ok(()) => "/connections?notion=connected".to_owned(),
        Err(refusal) => format!("/connections?notion={}", refusal.code()),
    };
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, target),
            (header::REFERRER_POLICY, "no-referrer".to_owned()),
        ],
    )
        .into_response()
}

async fn complete(state: &NotionState, back: Return) -> Result<(), Refusal> {
    let pending = {
        let mut slot = state.pending.lock().await;
        // Only the answer to the sign-in in progress may end it, so a stray visit to this
        // address cannot cancel the real one.
        if slot
            .as_ref()
            .is_none_or(|pending| back.state.as_deref() != Some(pending.state.as_str()))
        {
            return Err(Refusal::Expired);
        }
        slot.take().ok_or(Refusal::Expired)?
    };
    if pending.started.elapsed() > PENDING_FOR {
        return Err(Refusal::Expired);
    }
    if let Some(error) = back.error {
        return Err(if error == "access_denied" {
            Refusal::Denied
        } else {
            Refusal::Failed
        });
    }
    let code = back
        .code
        .filter(|code| !code.is_empty() && code.len() <= 4096)
        .ok_or(Refusal::Failed)?;
    let answer = token_request(
        &state.client,
        &state.endpoints.token,
        &pending.client,
        vec![
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &pending.redirect_uri),
            ("code_verifier", &pending.verifier),
            ("resource", &state.endpoints.mcp),
        ],
    )
    .await
    .map_err(|_| Refusal::Failed)?;
    let grant = granted(&answer, pending.client, None).ok_or(Refusal::Failed)?;
    keep(state, grant, workspace_name(&answer))
        .await
        .map_err(|_| Refusal::Storage)
}

/// Store a fresh sign-in. Signing in again to the same workspace keeps the page answers go
/// under, so repairing a lapsed sign-in is one click.
async fn keep(state: &NotionState, grant: Grant, name: String) -> ApiResult<()> {
    let _writes = WRITES.lock().await;
    let destination = match state.store.load().await {
        Ok(Some(Connection {
            access: Access::SignIn { sign_in: previous },
            destination,
            ..
        })) if previous.workspace_id.is_some() && previous.workspace_id == grant.workspace_id => {
            destination
        }
        _ => None,
    };
    state
        .save(Some(&Connection {
            access: Access::SignIn { sign_in: grant },
            name,
            destination,
        }))
        .await
}

/// A usable access token for the stored sign-in, renewed first when it is about to lapse. The
/// renewed grant is saved before it is used, because Notion retires the old refresh token as it
/// answers with the new one.
pub(super) async fn bearer(
    client: &Client,
    endpoints: &Endpoints,
    store: &Store,
) -> ApiResult<String> {
    let _writes = WRITES.lock().await;
    let mut connection = store.load().await?.ok_or_else(not_connected)?;
    let Access::SignIn { sign_in: grant } = &mut connection.access else {
        return Err(failure(
            StatusCode::CONFLICT,
            "The Notion connection changed. Open Connections and retry.",
        ));
    };
    if grant.expires_at - RENEW_EARLY > now() {
        return Ok(grant.access_token.clone());
    }
    let registration = Registration {
        id: grant.client_id.clone(),
        secret: grant.client_secret.clone(),
    };
    let pairs = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", grant.refresh_token.as_str()),
        ("resource", endpoints.mcp.as_str()),
    ];
    let answer = token_request(client, &endpoints.token, &registration, pairs)
        .await
        .map_err(|error| match error {
            TokenError::Rejected => failure(StatusCode::UNAUTHORIZED, SIGN_IN_AGAIN),
            TokenError::Unreachable => unreachable(),
            TokenError::Unavailable => failure(
                StatusCode::BAD_GATEWAY,
                "Notion could not complete the request. Retry shortly.",
            ),
        })?;
    let renewed = granted(&answer, registration, Some(&*grant)).ok_or_else(unreadable)?;
    let access_token = renewed.access_token.clone();
    *grant = renewed;
    store.save(Some(&connection)).await?;
    Ok(access_token)
}

/// Ask Notion to forget `grant`. Best effort: disconnecting has already removed it here, and an
/// offline Mac must still be able to disconnect.
pub(super) async fn revoke(client: &Client, endpoints: &Endpoints, grant: &Grant) {
    let mut pairs = vec![
        ("token", grant.refresh_token.as_str()),
        ("token_type_hint", "refresh_token"),
        ("client_id", grant.client_id.as_str()),
    ];
    if let Some(secret) = &grant.client_secret {
        pairs.push(("client_secret", secret));
    }
    let _ = client
        .post(&endpoints.revoke)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .timeout(Duration::from_secs(5))
        .body(form(&pairs))
        .send()
        .await;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenError {
    /// Notion could not be reached.
    Unreachable,
    /// Notion refused the grant: the operator has to sign in again.
    Rejected,
    /// Anything else Notion answered.
    Unavailable,
}

/// An `application/x-www-form-urlencoded` body.
fn form(pairs: &[(&str, &str)]) -> String {
    Serializer::new(String::new()).extend_pairs(pairs).finish()
}

async fn token_request(
    client: &Client,
    url: &str,
    registration: &Registration,
    mut pairs: Vec<(&str, &str)>,
) -> Result<Value, TokenError> {
    pairs.push(("client_id", &registration.id));
    if let Some(secret) = &registration.secret {
        pairs.push(("client_secret", secret));
    }
    let mut response = client
        .post(url)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ACCEPT, "application/json")
        .body(form(&pairs))
        .send()
        .await
        .map_err(|_| TokenError::Unreachable)?;
    let status = response.status();
    let answer = read_bounded(&mut response, MAX_RESPONSE_BYTES)
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .unwrap_or(Value::Null);
    if status.is_success() {
        Ok(answer)
    } else if status == StatusCode::UNAUTHORIZED
        || answer.get("error").and_then(Value::as_str) == Some("invalid_grant")
    {
        Err(TokenError::Rejected)
    } else {
        Err(TokenError::Unavailable)
    }
}

/// The grant in Notion's token answer. A refresh may leave the refresh token as it was, in which
/// case `previous`'s stays in use.
fn granted(answer: &Value, client: Registration, previous: Option<&Grant>) -> Option<Grant> {
    let access_token = text(answer, "access_token")?;
    let refresh_token = text(answer, "refresh_token")
        .or_else(|| previous.map(|grant| grant.refresh_token.clone()))?;
    let lifetime = answer
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_LIFETIME)
        .min(MAX_LIFETIME);
    let workspace_id = text(answer, "workspace_id")
        .or_else(|| {
            answer
                .pointer("/workspace/id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| previous.and_then(|grant| grant.workspace_id.clone()));
    Some(Grant {
        client_id: client.id,
        client_secret: client.secret,
        access_token,
        refresh_token,
        expires_at: now() + lifetime,
        workspace_id,
    })
}

/// The workspace's name when Notion's answer carries one.
fn workspace_name(answer: &Value) -> String {
    ["/workspace_name", "/workspace/name"]
        .iter()
        .find_map(|pointer| answer.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map_or_else(
            || "your Notion workspace".to_owned(),
            |name| name.chars().take(200).collect(),
        )
}

/// A non-empty string field of bounded length.
fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= 8192)
        .map(str::to_owned)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// `count` × 122 random bits as lowercase hex, for PKCE verifiers and state values.
fn random(count: usize) -> String {
    (0..count)
        .map(|_| uuid::Uuid::new_v4().simple().to_string())
        .collect()
}

/// The PKCE `S256` challenge for `verifier`.
fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
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
    fn verifiers_and_states_are_long_unreserved_and_fresh() {
        let verifier = random(2);
        assert_eq!(verifier.len(), 64, "PKCE needs 43 to 128 characters");
        assert!(verifier.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(random(1), random(1));
    }

    #[test]
    fn a_refresh_without_a_new_refresh_token_keeps_the_old_one() {
        let first = granted(
            &json!({"access_token": "a1", "refresh_token": "r1", "expires_in": 3600, "workspace_id": "w"}),
            Registration {
                id: "c".into(),
                secret: None,
            },
            None,
        )
        .unwrap();
        assert!((first.expires_at - now() - 3600).abs() <= 1);
        let renewed = granted(
            &json!({"access_token": "a2"}),
            Registration {
                id: "c".into(),
                secret: None,
            },
            Some(&first),
        )
        .unwrap();
        assert_eq!(renewed.refresh_token, "r1");
        assert_eq!(renewed.access_token, "a2");
        assert_eq!(renewed.workspace_id.as_deref(), Some("w"));
        assert!(
            granted(
                &json!({"access_token": "a"}),
                Registration {
                    id: "c".into(),
                    secret: None
                },
                None
            )
            .is_none(),
            "a first sign-in without a refresh token would lapse within hours"
        );
    }

    #[test]
    fn the_workspace_is_named_when_notion_says_and_described_when_not() {
        assert_eq!(
            workspace_name(&json!({"workspace_name": " Team space "})),
            "Team space"
        );
        assert_eq!(
            workspace_name(&json!({"workspace": {"name": "Acme"}})),
            "Acme"
        );
        assert_eq!(workspace_name(&json!({})), "your Notion workspace");
    }
}
