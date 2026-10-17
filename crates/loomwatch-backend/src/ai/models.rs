//! The models an agent can run on: `OpenRouter`'s catalog, cut down to the ones that can use tools.
//!
//! The catalog is public, so listing it needs no key. It is fetched when first asked for and
//! kept an hour, and the last copy is saved in the state folder so the list still shows when the
//! computer is offline. Nothing is fetched at startup.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::agent::DEFAULT_BASE_URL;

const CACHE_FILE: &str = "models.json";
const KEEP_FOR: Duration = Duration::from_hours(1);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// The catalog is under a megabyte today; ten is plenty of room.
const MAX_CATALOG_BYTES: usize = 10 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS: usize = 400;

/// The model new agents get.
pub const DEFAULT_MODEL: &str = "anthropic/claude-opus-5.5";

/// Models worth a newcomer's first look, in order, with why. One that leaves the catalog is left
/// out; the rest of the catalog is still there to search.
const RECOMMENDED: [(&str, &str); 9] = [
    ("anthropic/claude-opus-5.5", "Best for hard work"),
    ("anthropic/claude-sonnet-5.5", "Strong and quicker"),
    ("anthropic/claude-haiku-5.5", "Fast and very cheap"),
    ("openai/gpt-6.1-sol", "OpenAI's all-rounder"),
    ("google/gemini-4-argon", "Google's newest"),
    ("deepseek/deepseek-v4-pro", "Low cost, good quality"),
    ("z-ai/glm-5.3", "Low cost"),
    (
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "Free, with limits",
    ),
    ("google/gemma-4-31b-it:free", "Free, with limits"),
];

/// One model, as the model picker shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub context_length: u64,
    /// Dollars per million prompt tokens.
    pub input_price: f64,
    /// Dollars per million reply tokens.
    pub output_price: f64,
    /// Dollars per million prompt tokens served from the cache, when the model caches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_price: Option<f64>,
    /// Costs nothing; such models are limited per day and may learn from what they're sent.
    pub free: bool,
    /// Takes a reasoning effort.
    pub reasoning: bool,
    /// Why it is recommended, for the ones that are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The catalog as the app gets it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub fetched_at: String,
    pub default_model: String,
    pub recommended: Vec<Model>,
    pub models: Vec<Model>,
}

impl Catalog {
    /// The model with this id.
    #[must_use]
    pub fn find(&self, id: &str) -> Option<&Model> {
        self.models.iter().find(|model| model.id == id)
    }
}

/// Fetches and keeps the catalog.
#[derive(Clone)]
pub struct Models {
    inner: Arc<Inner>,
}

struct Inner {
    url: String,
    cache_file: Option<PathBuf>,
    client: Option<reqwest::Client>,
    held: Mutex<Option<(Instant, Arc<Catalog>)>>,
}

impl std::fmt::Debug for Models {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Models")
            .field("url", &self.inner.url)
            .finish_non_exhaustive()
    }
}

impl Models {
    /// `OpenRouter`'s catalog, with the last copy kept in `state_dir`.
    #[must_use]
    pub fn new(state_dir: &Path) -> Self {
        Self::with_url(
            &format!("{DEFAULT_BASE_URL}/models"),
            Some(state_dir.join(CACHE_FILE)),
        )
    }

    /// Another address serving the same list, for tests.
    #[must_use]
    pub fn with_url(url: &str, cache_file: Option<PathBuf>) -> Self {
        let local = url.starts_with("http://127.0.0.1");
        let client = reqwest::Client::builder()
            .user_agent(concat!("LoomWatch/", env!("CARGO_PKG_VERSION")))
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(3))
            .https_only(!local)
            .build()
            .inspect_err(|error| eprintln!("warning: the model list is unavailable: {error}"))
            .ok();
        Self {
            inner: Arc::new(Inner {
                url: url.to_owned(),
                cache_file,
                client,
                held: Mutex::new(None),
            }),
        }
    }

    /// The catalog: the copy held if it is under an hour old, else a fresh one, else the last one
    /// saved.
    ///
    /// # Errors
    ///
    /// When it can't be fetched and no copy was ever saved.
    pub async fn catalog(&self) -> Result<Arc<Catalog>> {
        let mut held = self.inner.held.lock().await;
        if let Some((at, catalog)) = held.as_ref()
            && at.elapsed() < KEEP_FOR
        {
            return Ok(catalog.clone());
        }
        match self.fetch().await {
            Ok(catalog) => {
                let catalog = Arc::new(catalog);
                self.save(&catalog);
                *held = Some((Instant::now(), catalog.clone()));
                Ok(catalog)
            }
            Err(error) => {
                if let Some((_, catalog)) = held.as_ref() {
                    return Ok(catalog.clone());
                }
                let saved = self.load().with_context(|| format!("{error:#}"))?;
                let saved = Arc::new(saved);
                // Try again in a minute rather than an hour: this copy may be days old.
                let at = Instant::now()
                    .checked_sub(KEEP_FOR.saturating_sub(Duration::from_mins(1)))
                    .unwrap_or_else(Instant::now);
                *held = Some((at, saved.clone()));
                Ok(saved)
            }
        }
    }

    /// The context size of `model`, if the catalog lists it. Never fetches: a run shouldn't wait
    /// for the list to learn something it can do without.
    pub async fn context_length(&self, model: &str) -> Option<u64> {
        let held = self.inner.held.lock().await;
        held.as_ref()?
            .1
            .find(model)
            .map(|model| model.context_length)
            .filter(|length| *length > 0)
    }

    async fn fetch(&self) -> Result<Catalog> {
        let client = self
            .inner
            .client
            .as_ref()
            .context("this computer can't make HTTPS requests")?;
        let mut response = client
            .get(&self.inner.url)
            .send()
            .await
            .context("couldn't reach OpenRouter for its model list")?;
        anyhow::ensure!(
            response.status().is_success(),
            "OpenRouter's model list answered HTTP {}",
            response.status().as_u16()
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .context("the model list stopped arriving")?
        {
            bytes.extend_from_slice(&chunk);
            anyhow::ensure!(
                bytes.len() <= MAX_CATALOG_BYTES,
                "the model list is too large"
            );
        }
        let listed: Value = serde_json::from_slice(&bytes).context("the model list isn't JSON")?;
        Ok(catalog_from(&listed))
    }

    fn save(&self, catalog: &Catalog) {
        let Some(path) = &self.inner.cache_file else {
            return;
        };
        if let Ok(text) = serde_json::to_vec(catalog)
            && let Err(error) = crate::approvals::write_private(path, &text)
        {
            eprintln!("warning: could not keep a copy of the model list: {error}");
        }
    }

    fn load(&self) -> Result<Catalog> {
        let path = self
            .inner
            .cache_file
            .as_ref()
            .context("no copy of the model list was kept")?;
        let text = std::fs::read(path).context("no copy of the model list was kept")?;
        serde_json::from_slice(&text).context("the kept copy of the model list is damaged")
    }
}

/// The catalog from `OpenRouter`'s `/models` answer: models that can call tools, cheapest-looking
/// noise left out, newest first.
pub(crate) fn catalog_from(listed: &Value) -> Catalog {
    let mut entries: Vec<(i64, Model)> = listed
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("supported_parameters")
                .and_then(Value::as_array)
                .is_some_and(|params| params.iter().any(|param| param == "tools"))
        })
        .filter_map(|entry| {
            let created = entry.get("created").and_then(Value::as_i64).unwrap_or(0);
            model_from(entry).map(|model| (created, model))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    let models: Vec<Model> = entries.into_iter().map(|(_, model)| model).collect();
    let recommended = RECOMMENDED
        .iter()
        .filter_map(|(id, note)| {
            models
                .iter()
                .find(|model| model.id == *id)
                .map(|model| Model {
                    note: Some((*note).to_owned()),
                    ..model.clone()
                })
        })
        .collect();
    Catalog {
        fetched_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        default_model: DEFAULT_MODEL.to_owned(),
        recommended,
        models,
    }
}

fn model_from(entry: &Value) -> Option<Model> {
    let id = entry.get("id")?.as_str()?.to_owned();
    let price = |key: &str| {
        entry
            .pointer(&format!("/pricing/{key}"))
            .and_then(|value| match value {
                Value::String(text) => text.parse::<f64>().ok(),
                other => other.as_f64(),
            })
            .map(|per_token| per_token * 1_000_000.0)
    };
    let input_price = price("prompt").unwrap_or(0.0);
    let output_price = price("completion").unwrap_or(0.0);
    let reasoning = entry
        .get("supported_parameters")
        .and_then(Value::as_array)
        .is_some_and(|params| params.iter().any(|param| param == "reasoning"));
    let description: String = entry
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(MAX_DESCRIPTION_CHARS)
        .collect();
    Some(Model {
        name: entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned(),
        free: id.ends_with(":free") || (input_price <= 0.0 && output_price <= 0.0),
        description,
        context_length: entry
            .get("context_length")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        input_price,
        output_price,
        cached_input_price: price("input_cache_read"),
        reasoning,
        note: None,
        id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listed() -> Value {
        json!({"data": [
            {"id": "anthropic/claude-haiku-5.5", "name": "Anthropic: Claude Haiku 5.5", "created": 3, "context_length": 1_000_000,
             "pricing": {"prompt": "0.0000001", "completion": "0.0000005", "input_cache_read": "0.00000001"},
             "supported_parameters": ["tools", "reasoning"]},
            {"id": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5", "created": 1, "context_length": 1_000_000,
             "pricing": {"prompt": "0.000004", "completion": "0.00002"}, "supported_parameters": ["tools", "reasoning"]},
            {"id": "someone/chat-only", "name": "No tools", "created": 9, "pricing": {"prompt": "0", "completion": "0"},
             "supported_parameters": ["temperature"]},
            {"id": "google/gemma-4-31b-it:free", "name": "Gemma 4 (free)", "created": 2, "context_length": 262_144,
             "pricing": {"prompt": "0", "completion": "0"}, "supported_parameters": ["tools"]},
        ]})
    }

    #[test]
    fn only_models_that_use_tools_are_listed_with_prices_per_million() {
        let catalog = catalog_from(&listed());
        let ids: Vec<&str> = catalog
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "anthropic/claude-haiku-5.5",
                "google/gemma-4-31b-it:free",
                "anthropic/claude-opus-5.5"
            ]
        );
        let haiku = catalog.find("anthropic/claude-haiku-5.5").unwrap();
        assert!((haiku.input_price - 0.1).abs() < 1e-9 && (haiku.output_price - 0.5).abs() < 1e-9);
        assert!(haiku.reasoning && !haiku.free);
        assert!(catalog.find("google/gemma-4-31b-it:free").unwrap().free);
        // Recommended keeps its own order and its reasons; missing ones are left out.
        let recommended: Vec<(&str, Option<&str>)> = catalog
            .recommended
            .iter()
            .map(|model| (model.id.as_str(), model.note.as_deref()))
            .collect();
        assert_eq!(
            recommended,
            [
                ("anthropic/claude-opus-5.5", Some("Best for hard work")),
                ("anthropic/claude-haiku-5.5", Some("Fast and very cheap")),
                ("google/gemma-4-31b-it:free", Some("Free, with limits")),
            ]
        );
        assert_eq!(catalog.default_model, DEFAULT_MODEL);
    }

    #[tokio::test]
    async fn the_last_copy_is_used_when_the_list_cant_be_fetched() {
        let folder =
            std::env::temp_dir().join(format!("loomwatch-models-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join(CACHE_FILE);
        std::fs::write(&file, serde_json::to_vec(&catalog_from(&listed())).unwrap()).unwrap();
        // Nothing listens on port 9.
        let models = Models::with_url("http://127.0.0.1:9/models", Some(file));
        let catalog = models.catalog().await.unwrap();
        assert_eq!(catalog.models.len(), 3);
        assert_eq!(
            models.context_length("google/gemma-4-31b-it:free").await,
            Some(262_144)
        );
        let _ = std::fs::remove_dir_all(&folder);
    }
}
