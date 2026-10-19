//! The person's Claude API key (ADR 0073): a Claude Max or Team plan's monthly API credit, or
//! credits they bought in the Claude Console.
//!
//! The key is checked by listing the models it can use (`GET /v1/models`), which costs nothing,
//! and only a key Anthropic accepts is kept. What the check learned (which models, how much each
//! can read and write, whether it thinks adaptively and at which efforts) is saved in
//! `<state dir>/anthropic.json`, so the app and a run's set-up read it without reading the key.
//! Anthropic tells a key nothing of its balance: the Usage page counts what `LoomWatch` spent and
//! links to the Console for the rest.
//!
//! Only an API key is taken. A Claude sign-in token (`sk-ant-oat…`, what Claude Code keeps) is
//! refused: Anthropic's terms forbid apps to use a Claude subscription's sign-in.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::{ApiKey, is_loopback_http};

/// Where Anthropic's API lives.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// Names a stand-in for Anthropic on this computer, for trial copies and checks that must not
/// spend real credit. Only an `http` address on this computer is taken.
pub const BASE_URL_ENV: &str = "LOOMWATCH_ANTHROPIC_URL";
/// The Messages API version every request names.
pub const API_VERSION: &str = "2023-06-01";
pub(crate) const STATUS_FILE: &str = "anthropic.json";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// Where the daemon reaches Anthropic: [`DEFAULT_BASE_URL`], or the stand-in [`BASE_URL_ENV`] names.
#[must_use]
pub fn base_url() -> String {
    let setting = std::env::var(BASE_URL_ENV).ok();
    let Some(setting) = setting
        .as_deref()
        .map(str::trim)
        .filter(|setting| !setting.is_empty())
    else {
        return DEFAULT_BASE_URL.to_owned();
    };
    let setting = setting.trim_end_matches('/');
    if is_loopback_http(setting) {
        return setting.to_owned();
    }
    eprintln!(
        "warning: {BASE_URL_ENV} must be an http address on this computer (127.0.0.1, localhost \
         or [::1]); using Anthropic itself"
    );
    DEFAULT_BASE_URL.to_owned()
}

/// What the app shows about the Claude key. None of it is the key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub connected: bool,
    /// The key's start and end, such as `sk-ant-api03-…x7Qa`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The models the key can use, as the last check listed them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ClaudeModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    /// Why the last check failed, in plain words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// One model a Claude key can use, as `GET /v1/models` describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    /// `claude-opus-5-5`: what the Messages API calls it.
    pub id: String,
    /// `Claude Opus 5.5`.
    pub name: String,
    /// How many tokens it reads.
    pub context_length: u64,
    /// How many it writes in one reply.
    pub max_output: u64,
    /// It thinks adaptively, as every current Claude does.
    pub adaptive_thinking: bool,
    /// It takes pictures, as every Claude since Claude 3 does: a check from before this was kept
    /// says so.
    #[serde(default = "crate::ai::anthropic::yes")]
    pub sees_pictures: bool,
    /// The efforts it takes (`low` … `max`), none when it takes no effort.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

pub(crate) const fn yes() -> bool {
    true
}

/// Why a key can't be kept, before Anthropic is asked.
pub(crate) fn refuse_shape(key: &str) -> Option<&'static str> {
    if key.starts_with("sk-ant-oat") {
        return Some(
            "That is a Claude sign-in token, not an API key. Anthropic doesn't let apps use a \
             Claude subscription's sign-in. Make an API key in the Claude Console instead.",
        );
    }
    if key.starts_with("sk-ant-admin") {
        return Some(
            "That is an Admin key, which can manage your organization. Make an ordinary API key in \
             the Claude Console instead.",
        );
    }
    if !key.starts_with("sk-ant-") {
        return Some(
            "That doesn't look like a Claude API key. Claude API keys start with sk-ant-api.",
        );
    }
    None
}

/// The key's start and end, for the app to show which key is kept.
pub(crate) fn label(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let start: String = chars.iter().take(13).collect();
    let end: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("{start}…{end}")
}

/// Asks Anthropic which models `key` can use, which also says whether it accepts the key.
pub(crate) async fn check(base: &str, key: &ApiKey) -> Result<Vec<ClaudeModel>, String> {
    let local = is_loopback_http(base);
    let client = reqwest::Client::builder()
        .user_agent(concat!("LoomWatch/", env!("CARGO_PKG_VERSION")))
        .timeout(CHECK_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .https_only(!local)
        .build()
        .map_err(|_| "This computer can't make HTTPS requests.".to_owned())?;
    let mut models = Vec::new();
    let mut after: Option<String> = None;
    // A few pages at most: Anthropic lists a few dozen models.
    for _ in 0..5 {
        let mut url = reqwest::Url::parse(&format!("{base}/v1/models"))
            .map_err(|_| "LoomWatch's address for Anthropic is wrong.".to_owned())?;
        url.query_pairs_mut().append_pair("limit", "100");
        if let Some(after) = &after {
            url.query_pairs_mut().append_pair("after_id", after);
        }
        let request = client
            .get(url)
            .header("x-api-key", key.expose())
            .header("anthropic-version", API_VERSION);
        let response = request.send().await.map_err(|_| {
            "LoomWatch couldn't reach Anthropic. Check this computer's internet connection."
                .to_owned()
        })?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(
                "Anthropic refused this key. Copy it again from the Claude Console's API keys page, \
                 or make a new one."
                    .to_owned(),
            );
        }
        if status == StatusCode::FORBIDDEN {
            return Err(
                "Anthropic says this key isn't allowed to use Claude's models. Check its \
                 workspace in the Claude Console."
                    .to_owned(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "Anthropic couldn't check the key just now (HTTP {}). Try again in a minute.",
                status.as_u16()
            ));
        }
        let page: Value = response
            .json()
            .await
            .map_err(|_| "Anthropic's answer couldn't be read.".to_owned())?;
        models.extend(
            page.get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(model_from),
        );
        let more = page.get("has_more").and_then(Value::as_bool) == Some(true);
        after = page
            .get("last_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if !more || after.is_none() {
            break;
        }
    }
    Ok(models)
}

fn model_from(entry: &Value) -> Option<ClaudeModel> {
    let id = entry.get("id")?.as_str()?.to_owned();
    let supported = |pointer: &str| {
        entry
            .pointer(&format!("/capabilities{pointer}/supported"))
            .and_then(Value::as_bool)
            == Some(true)
    };
    let efforts = if supported("/effort") {
        ["low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .filter(|effort| supported(&format!("/effort/{effort}")))
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    Some(ClaudeModel {
        name: entry
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned(),
        context_length: entry
            .get("max_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        max_output: entry.get("max_tokens").and_then(Value::as_u64).unwrap_or(0),
        adaptive_thinking: supported("/thinking/types/adaptive"),
        // A model listed without capabilities is from before they were listed, and sees pictures.
        sees_pictures: entry.get("capabilities").is_none() || supported("/image_input"),
        efforts,
        id,
    })
}

/// The status file, kept beside the state folder's other files.
#[derive(Debug)]
pub(crate) struct StatusFile(PathBuf);

impl StatusFile {
    pub(crate) fn new(state_dir: &Path) -> Self {
        Self(state_dir.join(STATUS_FILE))
    }

    /// What was last said about the key. Never reads the key.
    pub(crate) fn read(&self) -> ClaudeStatus {
        std::fs::read(&self.0)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub(crate) fn keep(&self, status: &ClaudeStatus) {
        let written = serde_json::to_vec_pretty(status)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::approvals::write_private(&self.0, &text));
        if let Err(error) = written {
            eprintln!("warning: could not keep the Claude key's status: {error}");
        }
    }
}

/// A status for a key Anthropic just accepted.
pub(crate) fn accepted(key: &ApiKey, models: Vec<ClaudeModel>) -> ClaudeStatus {
    ClaudeStatus {
        connected: true,
        label: Some(label(key.expose())),
        models,
        checked_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
        problem: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_an_api_key_is_taken() {
        assert!(refuse_shape("sk-ant-api03-abcdef").is_none());
        assert!(
            refuse_shape("sk-ant-oat01-abcdef")
                .unwrap()
                .contains("sign-in token")
        );
        assert!(
            refuse_shape("sk-ant-admin01-abcdef")
                .unwrap()
                .contains("Admin key")
        );
        assert!(refuse_shape("sk-or-v1-abc").unwrap().contains("sk-ant-api"));
        assert_eq!(
            label("sk-ant-api03-0123456789abcdWXYZ"),
            "sk-ant-api03-…WXYZ"
        );
    }

    #[test]
    fn a_model_says_how_it_thinks_and_at_which_efforts() {
        let opus = model_from(&json!({
            "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
            "max_input_tokens": 1_000_000, "max_tokens": 128_000,
            "capabilities": {
                "image_input": {"supported": true},
                "thinking": {"supported": true, "types": {"enabled": {"supported": false}, "adaptive": {"supported": true}}},
                "effort": {"supported": true, "low": {"supported": true}, "medium": {"supported": true},
                           "high": {"supported": true}, "xhigh": {"supported": true}, "max": {"supported": true}}
            }
        }))
        .unwrap();
        assert!(opus.adaptive_thinking && opus.sees_pictures);
        assert_eq!(opus.efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!((opus.context_length, opus.max_output), (1_000_000, 128_000));
        let old = model_from(&json!({
            "id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5",
            "max_input_tokens": 200_000, "max_tokens": 64_000,
            "capabilities": {"thinking": {"supported": true, "types": {"enabled": {"supported": true}, "adaptive": {"supported": false}}},
                             "effort": {"supported": false}, "image_input": {"supported": false}}
        }))
        .unwrap();
        assert!(!old.adaptive_thinking && old.efforts.is_empty());
        assert!(!old.sees_pictures, "as its capabilities say");
        let unsaid = model_from(&json!({"id": "claude-x", "max_input_tokens": 200_000})).unwrap();
        assert!(
            unsaid.sees_pictures,
            "every Claude listed without capabilities sees pictures"
        );
        // A model kept by a check from before pictures were recorded.
        let kept: ClaudeModel = serde_json::from_value(json!({
            "id": "claude-opus-5-5", "name": "Claude Opus 5.5", "contextLength": 1_000_000,
            "maxOutput": 128_000, "adaptiveThinking": true
        }))
        .unwrap();
        assert!(kept.sees_pictures);
    }
}
