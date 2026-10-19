//! The models an agent can run on: `OpenRouter`'s catalog, cut down to the ones that can use tools.
//!
//! The catalog is public, so listing it needs no key. It is fetched when first asked for and
//! kept an hour, and the last copy is saved in the state folder so the list still shows when the
//! computer is offline. Nothing is fetched at startup.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::agent::{base_url, is_loopback_http};

const CACHE_FILE: &str = "models.json";
const KEEP_FOR: Duration = Duration::from_hours(1);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// The catalog is under a megabyte today; ten is plenty of room.
const MAX_CATALOG_BYTES: usize = 10 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS: usize = 400;

/// The model an agent falls back to: the strong tier's in [`MODEL_TIERS`].
pub const DEFAULT_MODEL: &str = "anthropic/claude-opus-5.5";
/// The step down from the default, for `LoomWatch`'s own short jobs: rewriting instructions after
/// a removal. The fast tier's in [`MODEL_TIERS`].
pub const FAST_MODEL: &str = "anthropic/claude-sonnet-5.5";

/// `schemas/model-tiers.json`, the one table of which model and thinking effort each kind of agent
/// starts on. The app reads the same file (`ui/src/lib/ai/modelIds.ts`) for templates, the builder
/// and new agents; Ask reads it here, through `list_models`.
pub static MODEL_TIERS: LazyLock<ModelTiers> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../schemas/model-tiers.json"))
        .expect("schemas/model-tiers.json is the model table")
});

/// The model table: a model per tier, an effort per effort tier, and each job's two tiers.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTiers {
    /// `strong`, `fast`, `check` → the `OpenRouter` id.
    pub models: BTreeMap<String, String>,
    /// What each model tier is for, in a few words.
    pub tiers: BTreeMap<String, String>,
    /// `light`, `standard`, `deep` → the thinking effort.
    pub efforts: BTreeMap<String, String>,
    /// What each effort tier is for.
    pub effort_for: BTreeMap<String, String>,
    /// An agent made from nothing.
    pub new_agent: JobNeeds,
    /// Each built-in job, by id.
    pub jobs: BTreeMap<String, JobNeeds>,
    /// The tiers' models on the sources besides `OpenRouter`: source → tier → model, as a team file
    /// writes it.
    pub by_source: BTreeMap<Source, BTreeMap<String, String>>,
    /// For each tier, which source to take a model from first, when several are connected. The ones
    /// the person already pays for as a plan come first.
    pub preference: BTreeMap<String, Vec<Source>>,
}

/// One kind of agent's model tier and effort tier.
#[derive(Debug, Clone, Deserialize)]
pub struct JobNeeds {
    pub tier: String,
    pub effort: String,
}

impl ModelTiers {
    /// The model and thinking effort `needs` comes to.
    #[must_use]
    pub fn choose(&self, needs: &JobNeeds) -> (&str, &str) {
        (
            self.models
                .get(&needs.tier)
                .map_or(DEFAULT_MODEL, String::as_str),
            self.efforts
                .get(&needs.effort)
                .map_or("medium", String::as_str),
        )
    }

    /// The model `tier` runs on (ADR 0073, ruled 2026-10-19). The tier names its model first
    /// (`models`), and then who pays: a connected plan that offers it (the Claude credit for
    /// Anthropic's models, the `ChatGPT` plan for `OpenAI`'s), else `OpenRouter` when its key is in.
    /// Only when neither can run it does a connected plan's own model for the tier stand in
    /// (`bySource`, in `preference` order), so an agent made with just a `ChatGPT` plan still runs.
    /// With nothing connected it is the `OpenRouter` model. `offers` says whether a connected plan
    /// lists a model. The same rules live in `ui/src/lib/ai/modelIds.ts` (`modelForTier`).
    #[must_use]
    pub fn model_on(
        &self,
        tier: &str,
        connected: &[Source],
        offers: &dyn Fn(&ModelRef) -> bool,
    ) -> String {
        let first = self
            .models
            .get(tier)
            .map_or(DEFAULT_MODEL, String::as_str)
            .to_owned();
        let named = ModelRef {
            source: Source::OpenRouter,
            id: first.clone(),
        };
        let paid_by_plan = [Source::Anthropic, Source::ChatGpt]
            .into_iter()
            .filter(|plan| connected.contains(plan))
            .filter_map(|plan| named.on(plan))
            .find(|on| offers(on));
        if let Some(on) = paid_by_plan {
            return on.selector();
        }
        if connected.contains(&Source::OpenRouter) {
            return first;
        }
        self.preference
            .get(tier)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|source| **source != Source::OpenRouter && connected.contains(source))
            .find_map(|source| self.by_source.get(source)?.get(tier).cloned())
            .unwrap_or(first)
    }
}

/// The `OpenRouter` id for a team file's `model`, written for an app `LoomWatch` no longer runs or
/// already an `OpenRouter` id.
///
/// - An `OpenRouter` id (`vendor/model`) is kept, and the `openrouter/` or `openrouter:` prefix the
///   old `OpenCode` and Hermes catalogs put in front is taken off.
/// - Claude Code's names (`opus`, `sonnet`, `haiku`, `default`, `claude-sonnet-5-5`) become
///   Anthropic's, Codex's (`gpt-…`) `OpenAI`'s, and Gemini's (`gemini-…`) Google's.
/// - Anything else is the default model.
///
/// The same rules live in `ui/src/lib/ai/modelIds.ts`, with the same test cases: the app reads team
/// files itself.
#[must_use]
pub fn openrouter_id(model: &str) -> String {
    let model = model.trim();
    if model.is_empty() {
        return DEFAULT_MODEL.to_owned();
    }
    let model = model
        .strip_prefix("openrouter/")
        .or_else(|| model.strip_prefix("openrouter:"))
        .unwrap_or(model);
    if model.contains('/') {
        return model.to_owned();
    }
    let lower = model.to_ascii_lowercase();
    let family = |name: &str| format!("anthropic/claude-{name}-5.5");
    match lower.as_str() {
        "opus" | "best" => return family("opus"),
        "sonnet" => return family("sonnet"),
        "haiku" => return family("haiku"),
        "default" => return DEFAULT_MODEL.to_owned(),
        _ => {}
    }
    if let Some(rest) = lower.strip_prefix("claude-") {
        // `claude-sonnet-5-5` → `anthropic/claude-sonnet-5.5`; a `[1m]` context suffix goes.
        let rest = rest.split('[').next().unwrap_or(rest);
        let mut parts: Vec<&str> = rest.split('-').collect();
        let numbers = parts
            .iter()
            .rev()
            .take_while(|part| part.chars().all(|c| c.is_ascii_digit()))
            .count();
        if numbers == 0 {
            return family(rest);
        }
        let version = parts.split_off(parts.len() - numbers).join(".");
        return format!("anthropic/claude-{}-{version}", parts.join("-"));
    }
    if lower.starts_with("gpt-") || lower.starts_with("o3") || lower.starts_with("o4") {
        return format!("openai/{lower}");
    }
    if lower.starts_with("gemini-") {
        return format!("google/{lower}");
    }
    DEFAULT_MODEL.to_owned()
}

/// Who pays for a model call. Each costs differently, so a team file says which one an agent uses
/// in its `model` (ADR 0073): `chatgpt:<slug>`, `anthropic:<id>`, or an `OpenRouter` id as before.
/// A call never moves from one to another by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// An `OpenRouter` key: every maker's models, each call paid from `OpenRouter` credit.
    OpenRouter,
    /// The person's `ChatGPT` Plus or Pro plan, through Sign in with `ChatGPT`.
    #[serde(rename = "chatgpt")]
    ChatGpt,
    /// An Anthropic API key, such as the one that spends a Claude Max or Team plan's monthly API
    /// credit.
    Anthropic,
}

impl Source {
    /// Every source, in the order the model picker shows them.
    pub const ALL: [Self; 3] = [Self::ChatGpt, Self::Anthropic, Self::OpenRouter];

    /// The name a team file and the app use for it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenRouter => "openrouter",
            Self::ChatGpt => "chatgpt",
            Self::Anthropic => "anthropic",
        }
    }

    /// How a sentence names it: "on your `ChatGPT` plan".
    #[must_use]
    pub const fn said(self) -> &'static str {
        match self {
            Self::OpenRouter => "OpenRouter",
            Self::ChatGpt => "your ChatGPT plan",
            Self::Anthropic => "your Claude API credit",
        }
    }

    /// Whether the person already pays for it as a plan, rather than per call.
    #[must_use]
    pub const fn is_subscription(self) -> bool {
        !matches!(self, Self::OpenRouter)
    }

    /// Whether a call through it costs dollars a run's spending limit can count. A `ChatGPT` plan's
    /// calls are paid by the plan's own allowance instead.
    #[must_use]
    pub const fn counts_dollars(self) -> bool {
        !matches!(self, Self::ChatGpt)
    }
}

impl std::fmt::Display for Source {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A team file's `model`, read for where it is paid and what the provider calls it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelRef {
    pub source: Source,
    /// The model as its source names it: `gpt-6.1-sol`, `claude-opus-5-5`, or an `OpenRouter` id.
    pub id: String,
}

impl ModelRef {
    /// Reads `model` without its `[effort]` suffix. `chatgpt:` and `anthropic:` name their source;
    /// anything else is read the way it always was, by [`openrouter_id`]. A prefix with nothing
    /// after it keeps its source, so the run fails plainly instead of quietly running on
    /// `OpenRouter`.
    #[must_use]
    pub fn parse(model: &str) -> Self {
        let mut model = model.trim();
        if let Some((base, suffix)) = model.rsplit_once('[')
            && suffix
                .strip_suffix(']')
                .is_some_and(crate::config::is_known_effort)
        {
            model = base.trim_end();
        }
        if let Some((prefix, id)) = model.split_once(':') {
            let source = match prefix.to_ascii_lowercase().as_str() {
                "chatgpt" => Some(Source::ChatGpt),
                "anthropic" => Some(Source::Anthropic),
                _ => None,
            };
            if let Some(source) = source {
                return Self {
                    source,
                    id: id.trim().to_owned(),
                };
            }
        }
        Self {
            source: Source::OpenRouter,
            id: openrouter_id(model),
        }
    }

    /// `model` as a team file should write it, its `[effort]` kept: `sonnet[high]` becomes
    /// `anthropic/claude-sonnet-5.5[high]`, `chatgpt:gpt-6.1-sol` stays as it is.
    #[must_use]
    pub fn normalized(model: &str) -> String {
        let model = model.trim();
        let effort = model
            .rsplit_once('[')
            .and_then(|(_, suffix)| suffix.strip_suffix(']'))
            .filter(|effort| crate::config::is_known_effort(effort));
        let selector = Self::parse(model).selector();
        effort.map_or_else(
            || selector.clone(),
            |effort| format!("{selector}[{effort}]"),
        )
    }

    /// As a team file writes it.
    #[must_use]
    pub fn selector(&self) -> String {
        match self.source {
            Source::OpenRouter => self.id.clone(),
            Source::ChatGpt => format!("chatgpt:{}", self.id),
            Source::Anthropic => format!("anthropic:{}", self.id),
        }
    }

    /// The same model in `OpenRouter`'s catalog, where its context size and prices are listed.
    #[must_use]
    pub fn openrouter_equivalent(&self) -> String {
        match self.source {
            Source::OpenRouter => self.id.clone(),
            Source::ChatGpt => format!("openai/{}", self.id),
            Source::Anthropic => openrouter_id(&self.id),
        }
    }

    /// The same model through `source`, when it can be named there. Whether that source really
    /// offers it is for the caller to check against its list.
    #[must_use]
    pub fn on(&self, source: Source) -> Option<Self> {
        if source == self.source {
            return Some(self.clone());
        }
        let openrouter = self.openrouter_equivalent();
        let id = match source {
            Source::OpenRouter => openrouter,
            Source::ChatGpt => openrouter.strip_prefix("openai/")?.to_owned(),
            Source::Anthropic => {
                let name = openrouter.strip_prefix("anthropic/")?;
                // A variant (`:thinking`) or an alias (`~anthropic/…`) has no Anthropic id.
                if name.contains(':') || !name.starts_with("claude-") {
                    return None;
                }
                name.replace('.', "-")
            }
        };
        Some(Self { source, id })
    }
}

impl std::fmt::Display for ModelRef {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.selector())
    }
}

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
    /// Dollars per million prompt tokens written to the cache, when writing costs more than
    /// reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_price: Option<f64>,
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
            &format!("{}/models", base_url()),
            Some(state_dir.join(CACHE_FILE)),
        )
    }

    /// Another address serving the same list, for tests.
    #[must_use]
    pub fn with_url(url: &str, cache_file: Option<PathBuf>) -> Self {
        let local = is_loopback_http(url);
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
        cache_write_price: price("input_cache_write"),
        reasoning,
        note: None,
        id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The daemon's own model names are the table's, and every job in it comes to a model and an
    /// effort the table has.
    #[test]
    fn the_model_table_is_whole_and_agrees_with_the_daemon() {
        let tiers = &*MODEL_TIERS;
        assert_eq!(tiers.models["strong"], DEFAULT_MODEL);
        assert_eq!(tiers.models["fast"], FAST_MODEL);
        let jobs = tiers.jobs.iter().map(|(job, needs)| (job.as_str(), needs));
        for (job, needs) in jobs.chain([("new agent", &tiers.new_agent)]) {
            assert!(tiers.models.contains_key(&needs.tier), "{job}");
            assert!(tiers.efforts.contains_key(&needs.effort), "{job}");
            assert!(
                tiers.tiers.contains_key(&needs.tier)
                    && tiers.effort_for.contains_key(&needs.effort),
                "{job}"
            );
        }
        assert_eq!(tiers.choose(&tiers.jobs["editor"]), (DEFAULT_MODEL, "low"));
        assert_eq!(tiers.choose(&tiers.new_agent), (DEFAULT_MODEL, "medium"));
    }
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

    /// The same cases are in `ui/src/lib/ai/modelIds.test.ts`.
    #[test]
    fn old_model_names_become_openrouter_ids() {
        for (given, expected) in [
            ("anthropic/claude-haiku-5.5", "anthropic/claude-haiku-5.5"),
            ("openrouter/openai/gpt-6.1-sol", "openai/gpt-6.1-sol"),
            (
                "openrouter:anthropic/claude-sonnet-5.5",
                "anthropic/claude-sonnet-5.5",
            ),
            ("fake/offline", "fake/offline"),
            ("sonnet", "anthropic/claude-sonnet-5.5"),
            ("opus", "anthropic/claude-opus-5.5"),
            ("default", DEFAULT_MODEL),
            ("claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"),
            ("claude-opus-5-5[1m]", "anthropic/claude-opus-5.5"),
            ("claude-haiku-4-5", "anthropic/claude-haiku-4.5"),
            ("gpt-5.5", "openai/gpt-5.5"),
            ("gemini-3.8-flash", "google/gemini-3.8-flash"),
            ("", DEFAULT_MODEL),
            ("something-unknown", DEFAULT_MODEL),
        ] {
            assert_eq!(openrouter_id(given), expected, "{given}");
        }
    }

    /// The same cases are in `ui/src/lib/ai/modelIds.test.ts`.
    #[test]
    fn a_model_says_where_it_is_paid() {
        for (given, source, id) in [
            ("chatgpt:gpt-6.1-sol", Source::ChatGpt, "gpt-6.1-sol"),
            ("ChatGPT: gpt-6-luna ", Source::ChatGpt, "gpt-6-luna"),
            (
                "anthropic:claude-opus-5-5",
                Source::Anthropic,
                "claude-opus-5-5",
            ),
            // A prefix with nothing after it keeps its source rather than running on OpenRouter.
            ("chatgpt:", Source::ChatGpt, ""),
            (
                "anthropic:claude-opus-5-5[high]",
                Source::Anthropic,
                "claude-opus-5-5",
            ),
            (
                "anthropic/claude-opus-5.5[max]",
                Source::OpenRouter,
                "anthropic/claude-opus-5.5",
            ),
            (
                "claude-opus-5-5[1m]",
                Source::OpenRouter,
                "anthropic/claude-opus-5.5",
            ),
            (
                "anthropic/claude-opus-5.5",
                Source::OpenRouter,
                "anthropic/claude-opus-5.5",
            ),
            (
                "openrouter:openai/gpt-6.1-sol",
                Source::OpenRouter,
                "openai/gpt-6.1-sol",
            ),
            (
                "google/gemma-4-31b-it:free",
                Source::OpenRouter,
                "google/gemma-4-31b-it:free",
            ),
            ("sonnet", Source::OpenRouter, "anthropic/claude-sonnet-5.5"),
            ("", Source::OpenRouter, DEFAULT_MODEL),
        ] {
            let model = ModelRef::parse(given);
            assert_eq!((model.source, model.id.as_str()), (source, id), "{given}");
        }
        assert_eq!(
            ModelRef::parse("anthropic:claude-opus-5-5").selector(),
            "anthropic:claude-opus-5-5"
        );
        assert_eq!(
            ModelRef::parse("sonnet").selector(),
            "anthropic/claude-sonnet-5.5"
        );
        assert_eq!(
            ModelRef::normalized("sonnet[high]"),
            "anthropic/claude-sonnet-5.5[high]"
        );
        assert_eq!(
            ModelRef::normalized(" chatgpt:gpt-6.1-sol "),
            "chatgpt:gpt-6.1-sol"
        );
        assert_eq!(ModelRef::normalized("x/y[max]"), "x/y[max]");
    }

    #[test]
    fn the_same_model_is_named_on_each_source() {
        let claude = ModelRef::parse("anthropic/claude-opus-5.5");
        let direct = claude.on(Source::Anthropic).unwrap();
        assert_eq!(direct.selector(), "anthropic:claude-opus-5-5");
        assert_eq!(direct.openrouter_equivalent(), "anthropic/claude-opus-5.5");
        assert_eq!(direct.on(Source::OpenRouter).unwrap(), claude);
        assert_eq!(claude.on(Source::ChatGpt), None);
        let gpt = ModelRef::parse("chatgpt:gpt-6.1-sol");
        assert_eq!(gpt.openrouter_equivalent(), "openai/gpt-6.1-sol");
        assert_eq!(
            ModelRef::parse("openai/gpt-6.1-sol")
                .on(Source::ChatGpt)
                .unwrap(),
            gpt
        );
        assert_eq!(gpt.on(Source::Anthropic), None);
        // Variants and aliases have no Anthropic id.
        assert_eq!(
            ModelRef::parse("anthropic/claude-opus-5.5:thinking").on(Source::Anthropic),
            None
        );
        assert_eq!(
            ModelRef::parse("~anthropic/claude-opus-latest").on(Source::Anthropic),
            None
        );
    }

    /// The tier names the model, a connected plan that offers it pays, else `OpenRouter`, else a
    /// connected plan's own model stands in; with nothing connected the tiers are `OpenRouter`'s.
    #[test]
    fn a_tier_names_its_model_then_a_plan_that_offers_it_pays_else_openrouter() {
        let tiers = &*MODEL_TIERS;
        let all = |_: &ModelRef| true;
        assert_eq!(tiers.model_on("strong", &[], &all), DEFAULT_MODEL);
        assert_eq!(
            tiers.model_on("strong", &[Source::OpenRouter], &all),
            DEFAULT_MODEL
        );
        let everything = [Source::OpenRouter, Source::ChatGpt, Source::Anthropic];
        assert_eq!(
            tiers.model_on("strong", &everything, &all),
            "anthropic:claude-opus-5-5"
        );
        assert_eq!(
            tiers.model_on("check", &everything, &all),
            "chatgpt:gpt-6.1-sol"
        );
        // The ChatGPT plan doesn't offer Claude Opus: OpenRouter pays for it, not the plan's own model.
        assert_eq!(
            tiers.model_on("strong", &[Source::OpenRouter, Source::ChatGpt], &all),
            "anthropic/claude-opus-5.5"
        );
        assert_eq!(
            tiers.model_on("check", &[Source::OpenRouter, Source::Anthropic], &all),
            "openai/gpt-6.1-sol"
        );
        // Nothing connected can run the first choice: the plan's own model for the tier stands in.
        assert_eq!(
            tiers.model_on("strong", &[Source::ChatGpt], &all),
            "chatgpt:gpt-6.1-sol"
        );
        assert_eq!(
            tiers.model_on("check", &[Source::Anthropic], &all),
            "anthropic:claude-opus-5-5"
        );
        // A plan that doesn't list the model doesn't pay for it.
        let no_opus = |model: &ModelRef| model.id != "claude-opus-5-5";
        assert_eq!(
            tiers.model_on("strong", &[Source::OpenRouter, Source::Anthropic], &no_opus),
            DEFAULT_MODEL
        );
        // Every tier has a model on every source alone, and every source is in the preferences.
        for tier in tiers.models.keys() {
            for source in Source::ALL {
                assert!(tiers.preference[tier].contains(&source), "{tier} {source}");
                let model = ModelRef::parse(&tiers.model_on(tier, &[source], &all));
                assert_eq!(model.source, source, "{tier}");
            }
        }
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
