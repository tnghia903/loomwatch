//! Sending through Apple's push service with the person's own key: a token signed with it (ES256)
//! on each request, and the notice to one phone.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use async_trait::async_trait;
use base64::Engine as _;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::DecodePrivateKey as _;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::key::PushKey;
use super::{Environment, Notice, PushTarget, Sender, Sent};

/// Apple takes a token from 20 minutes to an hour old; a new one each time is refused as too many.
const TOKEN_LIFE: Duration = Duration::from_mins(50);

const PRODUCTION: &str = "https://api.push.apple.com";
const SANDBOX: &str = "https://api.sandbox.push.apple.com";

/// The private key in a `.p8` file.
///
/// # Errors
///
/// When the text isn't a P-256 private key in PEM.
pub fn signing_key(p8: &str) -> Result<SigningKey> {
    SigningKey::from_pkcs8_pem(p8.trim())
        .map_err(|_| anyhow::anyhow!("that isn't the .p8 file Apple gave for a push key"))
}

/// Apple's push service, reached with the person's own key.
pub struct Apns {
    key: PushKey,
    signer: SigningKey,
    client: reqwest::Client,
    /// Where each kind of build's pushes go. Apple's own addresses, except in tests.
    production: String,
    sandbox: String,
    token: Mutex<Option<(String, Instant)>>,
}

impl Apns {
    /// # Errors
    ///
    /// When the key can't sign, or no client can be made.
    pub fn new(key: PushKey) -> Result<Self> {
        let client = reqwest::Client::builder()
            .http2_prior_knowledge()
            .timeout(Duration::from_secs(20))
            .build()
            .context("couldn't make a client for Apple's push service")?;
        Self::with(key, client, PRODUCTION, SANDBOX)
    }

    fn with(
        key: PushKey,
        client: reqwest::Client,
        production: &str,
        sandbox: &str,
    ) -> Result<Self> {
        Ok(Self {
            signer: signing_key(&key.p8)?,
            key,
            client,
            production: production.to_owned(),
            sandbox: sandbox.to_owned(),
            token: Mutex::new(None),
        })
    }

    /// Talks to `base` for both kinds of build, over plain HTTP/1, for tests.
    #[cfg(test)]
    pub(super) fn at(key: PushKey, base: &str) -> Self {
        Self::with(key, reqwest::Client::new(), base, base).expect("the test key signs")
    }

    /// The token Apple asks for, made again once it is [`TOKEN_LIFE`] old.
    async fn token(&self) -> String {
        let mut token = self.token.lock().await;
        if let Some((text, made)) = token.as_ref()
            && made.elapsed() < TOKEN_LIFE
        {
            return text.clone();
        }
        let text = sign(&self.key, &self.signer, chrono::Utc::now().timestamp());
        *token = Some((text.clone(), Instant::now()));
        text
    }
}

#[async_trait]
impl Sender for Apns {
    async fn send(&self, to: &PushTarget, notice: &Notice) -> Sent {
        let base = match to.environment {
            Environment::Production => &self.production,
            Environment::Sandbox => &self.sandbox,
        };
        let reply = self
            .client
            .post(format!("{base}/3/device/{}", to.token))
            .bearer_auth(self.token().await)
            .header("apns-topic", &self.key.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-collapse-id", notice.collapse_id())
            .json(&notice.payload())
            .send()
            .await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => return Sent::Failed(format!("couldn't reach Apple: {error}")),
        };
        let status = reply.status();
        if status.is_success() {
            return Sent::Done;
        }
        let reason = reply
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| {
                body.get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        match (status.as_u16(), reason.as_str()) {
            // The app was removed, or the token belongs to the other kind of build.
            (410, _) | (400, "BadDeviceToken" | "DeviceTokenNotForTopic") => Sent::Gone,
            (403, _) => Sent::KeyRefused(reason),
            _ => Sent::Failed(format!("Apple answered {status} {reason}")),
        }
    }
}

/// A token for `key` made at `issued` (seconds since 1970): ES256 over `{alg, kid}.{iss, iat}`.
fn sign(key: &PushKey, signer: &SigningKey, issued: i64) -> String {
    let part = |value: &Value| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string().as_bytes())
    };
    let message = format!(
        "{}.{}",
        part(&json!({ "alg": "ES256", "kid": key.key_id })),
        part(&json!({ "iss": key.team_id, "iat": issued })),
    );
    let signature: Signature = signer.sign(message.as_bytes());
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes());
    format!("{message}.{signature}")
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier as _;
    use p256::pkcs8::{EncodePrivateKey as _, LineEnding};

    use super::*;

    pub(crate) fn test_key() -> PushKey {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).unwrap();
        let signer = SigningKey::from_bytes(&bytes.into()).unwrap();
        let p8 = signer.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        PushKey::new("ABC123DEFG", "SR7RDMR5Z5", None, &p8).unwrap()
    }

    #[test]
    fn the_token_is_signed_with_the_key_and_names_it_and_the_team() {
        let key = test_key();
        let signer = signing_key(&key.p8).unwrap();
        let token = sign(&key, &signer, 1_793_500_000);
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let decode = |part: &str| {
            serde_json::from_slice::<Value>(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(part)
                    .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            decode(parts[0]),
            json!({ "alg": "ES256", "kid": "ABC123DEFG" })
        );
        assert_eq!(
            decode(parts[1]),
            json!({ "iss": "SR7RDMR5Z5", "iat": 1_793_500_000 })
        );
        let signature = Signature::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(parts[2])
                .unwrap(),
        )
        .unwrap();
        VerifyingKey::from(&signer)
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn a_file_that_isnt_a_push_key_is_refused() {
        assert!(
            signing_key("-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----").is_err()
        );
        assert!(PushKey::new("short", "SR7RDMR5Z5", None, &test_key().p8).is_err());
    }

    #[tokio::test]
    async fn the_token_is_kept_until_it_is_old() {
        let apns = Apns::at(test_key(), "http://127.0.0.1:9");
        let first = apns.token().await;
        assert_eq!(apns.token().await, first);
        apns.token.lock().await.as_mut().unwrap().1 =
            Instant::now().checked_sub(TOKEN_LIFE).unwrap();
        apns.token().await;
        let made = apns.token.lock().await.as_ref().unwrap().1;
        assert!(
            made.elapsed() < Duration::from_secs(5),
            "an old token is made again"
        );
    }
}
