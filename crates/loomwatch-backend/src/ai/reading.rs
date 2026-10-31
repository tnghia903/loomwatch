//! Reading an agent's whole setup to suggest a model for it, when the operator turns that on.
//!
//! The app suggests a model for each agent from its name and a few words of its instructions, for
//! free (`ui/src/lib/team-file/modelSuggestion.ts`). Where those can't place an agent
//! (`ui/src/lib/team-file/agentSetup.ts`, `needsReading`), and only when the operator has turned
//! reading on, the app asks here. This asks [`READING_MODEL`], `TypeSafe`'s Jev, a small model that
//! answers a typed question instead of writing text, through `OpenRouter`'s Decisions API with the
//! operator's own key: which kind of work the agent does. Each reading costs a little of their
//! credit, so:
//!
//! - it is off until the operator turns on Let AI choose, and every reading is refused while off;
//! - a setup is read once: the answer is kept in the state folder under a hash of exactly what was
//!   sent, so the same agent in another team, or its picker opened again, costs nothing;
//! - one reading at a time, so two pickers open on the same agent pay once;
//! - at most [`DAILY_LIMIT`] calls a day, and none for a while after one fails;
//! - only the agent's own setup is sent, by name: never a skill's text, a file, a folder's path,
//!   the team's Brief or its teammates. The team's shape is applied after, by the app's rules.
//!
//! Routes, on the AI router:
//!
//! - `GET /api/models/reading` says whether it is on, how many setups it read and what that cost.
//! - `PUT /api/models/reading` turns it on or off.
//! - `POST /api/models/reading` reads one setup, or answers from what was kept.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::Ai;
use crate::agent::{ApiKey, OPENROUTER_REFERER, OPENROUTER_TITLE};

/// The model that reads. Pinned: a new version answers differently, so moving to one is a change
/// to make and test on purpose, not one that arrives on its own.
pub const READING_MODEL: &str = "typesafe/jev-1.14";
/// What is asked and sent. A change to either changes every answer, so kept answers start over.
const QUESTION_VERSION: u32 = 1;
const SETTINGS_FILE: &str = "model-reading.json";
const KEPT_FILE: &str = "model-readings.json";
/// Calls a day, at most. A team of ten new agents is ten; this many is someone or something stuck.
pub const DAILY_LIMIT: u32 = 50;
/// After a call fails, none for this long: a reading that can't be had falls back to the free one.
const REST_AFTER_FAILURE: Duration = Duration::from_mins(10);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Answers kept. Each is a few hundred bytes; past this the oldest go.
const MAX_KEPT: usize = 2000;
/// Instructions past this are cut: an agent's job is said at the top, and every token is paid for.
const MAX_INSTRUCTIONS_CHARS: usize = 6000;
const MAX_ITEMS: usize = 30;
const MAX_ITEM_CHARS: usize = 200;
/// A reading's answer is a few hundred bytes.
const MAX_ANSWER_BYTES: usize = 64 * 1024;

const QUESTION: &str = "The state describes one AI agent in a team of agents: its name, its instructions, and what it is given to work with. Which kind of work does this agent do? Judge by what its instructions tell it to do, not by jobs they mention only to say they belong to another agent.";

/// The kinds of work a reading tells apart: the model tiers of `ui/src/lib/ai/modelIds.ts`.
const KINDS: [(&str, &str); 3] = [
    (
        "gather",
        "It collects, fetches, reads, filters, sorts or tags information and hands it on to another agent, which writes or decides the result. It does not write the finished piece, decide the result, or judge another agent's work.",
    ),
    (
        "produce",
        "It makes or decides the result itself: it writes, edits, designs, codes, analyses, plans, teaches, or leads other agents. Its own work is the finished piece, or shapes it.",
    ),
    (
        "check",
        "It checks another agent's finished work and gives a verdict on it: met or not met, pass or fail, or a list of problems. It does not make the piece itself.",
    ),
];

/// One agent's own setup, as the app sends it (`agentSetup.ts`, `setupOf`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Setup {
    pub name: String,
    pub instructions: String,
    pub done_when: Vec<String>,
    pub skills: Vec<String>,
    pub tools: Vec<String>,
    /// The folders, files and Notion pages it reads, by their labels.
    pub reads: Vec<String>,
    /// What it may do without asking: `web`, `edits`, `commands`.
    pub allow: Vec<String>,
    pub recruits: bool,
}

/// What a reading found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// `gather`, `produce` or `check`.
    pub kind: String,
    /// Each kind's probability, together about 1, when the model says: the Decisions API may leave
    /// them out.
    #[serde(default)]
    pub probabilities: BTreeMap<String, f64>,
    /// How sure the reading is overall, when the model says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// What is kept between days: whether reading is on, and what it has cost.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
    enabled: bool,
    /// Setups read, ever.
    readings: u64,
    /// Dollars those readings cost, as `OpenRouter` reported.
    spent: f64,
    /// The UTC day `today` counts.
    day: String,
    /// Calls made on `day`, those that failed too.
    today: u32,
}

/// What the app shows about reading.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatus {
    pub enabled: bool,
    pub readings: u64,
    pub spent: f64,
    pub today: u32,
    pub daily_limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Kept {
    reading: Reading,
    at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct KeptFile {
    #[serde(default)]
    readings: BTreeMap<String, Kept>,
}

/// Reads setups for one state folder. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Reader {
    inner: Arc<ReaderInner>,
}

#[derive(Debug)]
struct ReaderInner {
    url: String,
    settings_file: PathBuf,
    kept_file: PathBuf,
    /// One reading at a time, and the kept answers with it.
    turn: tokio::sync::Mutex<()>,
    /// Each change to the settings file, so turning reading off while a reading is under way is
    /// never written back on.
    settings: std::sync::Mutex<()>,
    resting_until: std::sync::Mutex<Option<Instant>>,
    /// Where each call is counted, with every other model call, for the Usage page: set once the
    /// run history is open (`count_in`).
    archive: std::sync::OnceLock<crate::archive::EventArchive>,
}

/// The Decisions API beside `OpenRouter`'s `…/api/v1`: `…/api/alpha/decisions`.
pub(crate) fn decisions_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    base.strip_suffix("/v1").map_or_else(
        || format!("{base}/decisions"),
        |api| format!("{api}/alpha/decisions"),
    )
}

fn today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

fn cut(text: &str, limit: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(limit) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

fn items(list: &[String]) -> Vec<String> {
    list.iter()
        .map(|item| {
            cut(
                &item.split_whitespace().collect::<Vec<_>>().join(" "),
                MAX_ITEM_CHARS,
            )
        })
        .filter(|item| !item.is_empty())
        .take(MAX_ITEMS)
        .collect()
}

/// The setup as the model reads it: plain lines, the same text for the same setup, so it is also
/// what an answer is kept under.
fn state_of(setup: &Setup) -> String {
    let instructions: Vec<&str> = setup.instructions.lines().map(str::trim_end).collect();
    let mut instructions = instructions.join("\n");
    while instructions.contains("\n\n\n") {
        instructions = instructions.replace("\n\n\n", "\n\n");
    }
    let mut lines = vec![
        format!("Name: {}", cut(&setup.name, MAX_ITEM_CHARS)),
        "Instructions:".to_owned(),
        cut(&instructions, MAX_INSTRUCTIONS_CHARS),
    ];
    let done_when = items(&setup.done_when);
    if !done_when.is_empty() {
        lines.push("Its finished result must satisfy:".to_owned());
        lines.extend(done_when.iter().map(|item| format!("- {item}")));
    }
    for (label, list) in [
        ("Skills it is given", &setup.skills),
        ("Connected tools it is given", &setup.tools),
        ("Folders, files and pages it reads", &setup.reads),
    ] {
        let list = items(list);
        if !list.is_empty() {
            lines.push(format!("{label}: {}", list.join(", ")));
        }
    }
    let allowed: Vec<&str> = ["web", "edits", "commands"]
        .into_iter()
        .filter(|switch| setup.allow.iter().any(|allowed| allowed == switch))
        .map(|switch| match switch {
            "web" => "search the web and read pages",
            "edits" => "create and change files in its folder",
            _ => "run commands",
        })
        .collect();
    if !allowed.is_empty() {
        lines.push(format!("It may, without asking: {}", allowed.join("; ")));
    }
    if setup.recruits {
        lines.push("It may take on helper agents during a run.".to_owned());
    }
    lines.join("\n") + "\n"
}

fn key_for(state: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(format!("{QUESTION_VERSION}\n{READING_MODEL}\n").as_bytes());
    hash.update(state.as_bytes());
    format!("{:x}", hash.finalize())
}

fn request_body(state: &str) -> Value {
    let criteria: serde_json::Map<String, Value> = KINDS
        .iter()
        .map(|(kind, means)| ((*kind).to_owned(), Value::String((*means).to_owned())))
        .collect();
    json!({
        "model": READING_MODEL,
        "state": state,
        "questions": {
            "job": {"type": "choice", "instructions": QUESTION, "criteria": criteria},
        },
    })
}

/// The answer to the `job` question, read leniently: `answers` at the top or under `data`, and
/// probabilities and a confidence that may be missing, as the Decisions API allows. A choice that
/// isn't one of the kinds is no answer.
fn read_answer(body: &Value) -> Option<Reading> {
    let answer = body
        .get("answers")
        .or_else(|| body.pointer("/data/answers"))?
        .get("job")?;
    let kind = answer.get("choice").and_then(Value::as_str)?;
    if !KINDS.iter().any(|(known, _)| *known == kind) {
        return None;
    }
    let probabilities: BTreeMap<String, f64> = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(name, _)| KINDS.iter().any(|(known, _)| known == name))
        .filter_map(|(name, value)| {
            value
                .as_f64()
                .filter(|p| p.is_finite())
                .map(|p| (name.clone(), p.clamp(0.0, 1.0)))
        })
        .collect();
    Some(Reading {
        kind: kind.to_owned(),
        probabilities,
        confidence: answer
            .get("confidence")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite())
            .map(|c| c.clamp(0.0, 1.0)),
    })
}

/// What a call cost, in dollars, as `OpenRouter` reports it; 0 when it doesn't say.
fn cost_of(body: &Value) -> f64 {
    body.pointer("/usage/cost")
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .unwrap_or(0.0)
}

/// Why a reading was not had, as the app reads it: `code` says which, `error` says it in words.
#[derive(Debug)]
pub(crate) struct Refusal {
    status: StatusCode,
    code: &'static str,
    error: String,
}

impl Refusal {
    fn new(status: StatusCode, code: &'static str, error: impl Into<String>) -> Self {
        Self {
            status,
            code,
            error: error.into(),
        }
    }

    fn off() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "off",
            "Let AI choose is off. Turn it on under an agent’s suggestion in its model list.",
        )
    }

    fn limit() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "limit",
            format!(
                "LoomWatch has read {DAILY_LIMIT} setups today, the most it reads in a day. It reads again tomorrow."
            ),
        )
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": self.error, "code": self.code})),
        )
            .into_response()
    }
}

impl Reader {
    /// Reading for `state_dir`, asking the Decisions API at `url`.
    #[must_use]
    pub fn new(state_dir: &Path, url: &str) -> Self {
        Self {
            inner: Arc::new(ReaderInner {
                url: url.to_owned(),
                settings_file: state_dir.join(SETTINGS_FILE),
                kept_file: state_dir.join(KEPT_FILE),
                turn: tokio::sync::Mutex::new(()),
                settings: std::sync::Mutex::new(()),
                resting_until: std::sync::Mutex::new(None),
                archive: std::sync::OnceLock::new(),
            }),
        }
    }

    fn saved(&self) -> Saved {
        let mut saved: Saved = std::fs::read(&self.inner.settings_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        if saved.day != today() {
            saved.day = today();
            saved.today = 0;
        }
        saved
    }

    fn save(&self, saved: &Saved) {
        let written = serde_json::to_vec_pretty(saved)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::approvals::write_private(&self.inner.settings_file, &text));
        if let Err(error) = written {
            eprintln!("warning: could not keep the model reading setting: {error}");
        }
    }

    /// Changes the settings, one change at a time, so two never undo each other. Nothing is written
    /// when `change` says false.
    fn update(&self, change: impl FnOnce(&mut Saved) -> bool) {
        let _settings = self
            .inner
            .settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut saved = self.saved();
        if change(&mut saved) {
            self.save(&saved);
        }
    }

    fn kept(&self) -> KeptFile {
        std::fs::read(&self.inner.kept_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn keep(&self, key: String, reading: &Reading) {
        let mut kept = self.kept();
        kept.readings.insert(
            key,
            Kept {
                reading: reading.clone(),
                at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            },
        );
        while kept.readings.len() > MAX_KEPT {
            let Some(oldest) = kept
                .readings
                .iter()
                .min_by(|a, b| a.1.at.cmp(&b.1.at))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            kept.readings.remove(&oldest);
        }
        let written = serde_json::to_vec(&kept)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::approvals::write_private(&self.inner.kept_file, &text));
        if let Err(error) = written {
            eprintln!("warning: could not keep a model reading: {error}");
        }
    }

    #[must_use]
    pub fn status(&self) -> ReadingStatus {
        let saved = self.saved();
        ReadingStatus {
            enabled: saved.enabled,
            readings: saved.readings,
            spent: saved.spent,
            today: saved.today,
            daily_limit: DAILY_LIMIT,
        }
    }

    /// Turns reading on or off. What was read stays kept either way.
    pub fn set_enabled(&self, enabled: bool) -> ReadingStatus {
        self.update(|saved| {
            saved.enabled = enabled;
            true
        });
        self.status()
    }

    fn resting(&self) -> bool {
        let mut until = self
            .inner
            .resting_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match *until {
            Some(at) if Instant::now() < at => true,
            Some(_) => {
                *until = None;
                false
            }
            None => false,
        }
    }

    fn rest(&self) {
        *self
            .inner
            .resting_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(Instant::now() + REST_AFTER_FAILURE);
    }

    /// Reads `setup`: the kept answer when there is one, else one call. Whether it came from what
    /// was kept is the second value.
    pub(crate) async fn read(
        &self,
        client: Option<&reqwest::Client>,
        key: impl AsyncFnOnce() -> anyhow::Result<Option<ApiKey>>,
        setup: &Setup,
    ) -> Result<(Reading, bool), Refusal> {
        if !self.saved().enabled {
            return Err(Refusal::off());
        }
        if setup.instructions.trim().is_empty() {
            return Err(Refusal::new(
                StatusCode::BAD_REQUEST,
                "empty",
                "This agent has no instructions to read yet.",
            ));
        }
        let state = state_of(setup);
        let key_of_state = key_for(&state);
        let _turn = self.inner.turn.lock().await;
        if let Some(kept) = self.kept().readings.get(&key_of_state) {
            return Ok((kept.reading.clone(), true));
        }
        if self.resting() {
            return Err(Refusal::new(
                StatusCode::CONFLICT,
                "resting",
                "Reading failed a moment ago, so LoomWatch is waiting a few minutes before it tries again.",
            ));
        }
        if self.saved().today >= DAILY_LIMIT {
            return Err(Refusal::limit());
        }
        let key = key().await.map_err(|error| {
            Refusal::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "no_key",
                format!("{error:#}"),
            )
        })?;
        let Some(key) = key else {
            return Err(Refusal::new(
                StatusCode::CONFLICT,
                "no_key",
                "Add your OpenRouter key in Connections first.",
            ));
        };
        let Some(client) = client else {
            return Err(Refusal::new(
                StatusCode::BAD_GATEWAY,
                "failed",
                "This computer can't make HTTPS requests.",
            ));
        };
        // The call is counted before it is made, so one that fails counts too. Reading may have been
        // turned off while the key was looked up: then nothing is called.
        let mut refused = None;
        self.update(|saved| {
            if !saved.enabled {
                refused = Some(Refusal::off());
                return false;
            }
            if saved.today >= DAILY_LIMIT {
                refused = Some(Refusal::limit());
                return false;
            }
            saved.today += 1;
            true
        });
        if let Some(refused) = refused {
            return Err(refused);
        }
        let answer = self.ask(client, &key, &state).await;
        // A call OpenRouter answered was paid for, whether or not its answer can be read.
        let cost = answer.as_ref().map_or(0.0, cost_of);
        if let Ok(body) = &answer {
            self.count(body, cost).await;
        }
        let reading = answer.and_then(|body| {
            read_answer(&body)
                .ok_or_else(|| "OpenRouter's answer didn't say what the agent does.".to_owned())
        });
        self.update(|saved| {
            saved.spent += cost;
            saved.readings += u64::from(reading.is_ok());
            true
        });
        match reading {
            Ok(reading) => {
                self.keep(key_of_state, &reading);
                Ok((reading, false))
            }
            Err(error) => {
                self.rest();
                Err(Refusal::new(StatusCode::BAD_GATEWAY, "failed", error))
            }
        }
    }

    /// Count each call from now on with every other model call, in `archive`, so the Usage page
    /// shows what choosing models cost among `LoomWatch`'s own help.
    pub(crate) fn count_in(&self, archive: crate::archive::EventArchive) {
        let _ = self.inner.archive.set(archive);
    }

    /// Count one answered call, at what `OpenRouter` said it cost.
    async fn count(&self, body: &Value, cost: f64) {
        let Some(archive) = self.inner.archive.get() else {
            return;
        };
        let tokens = |name: &str| {
            body.pointer(&format!("/usage/{name}"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        let usage = crate::agent::Usage {
            input_tokens: tokens("input_tokens"),
            output_tokens: tokens("output_tokens"),
            cost_usd: cost,
            ..crate::agent::Usage::default()
        };
        let counted = archive
            .count_call(&crate::archive::OwnCall {
                session: crate::archive::CHOOSING_MODELS,
                agent: crate::archive::CHOOSING_MODELS,
                kind: crate::archive::CHOOSING_MODELS,
                source: crate::ai::Source::OpenRouter.as_str(),
                model: READING_MODEL,
                usage: &usage,
            })
            .await;
        if let Err(error) = counted {
            eprintln!("warning: the call that chose a model was not counted: {error:#}");
        }
    }

    /// One call: the answer's body, or why there is none in words.
    async fn ask(
        &self,
        client: &reqwest::Client,
        key: &ApiKey,
        state: &str,
    ) -> Result<Value, String> {
        let response = client
            .post(&self.inner.url)
            .bearer_auth(key.expose())
            .header("HTTP-Referer", OPENROUTER_REFERER)
            .header("X-OpenRouter-Title", OPENROUTER_TITLE)
            .timeout(READ_TIMEOUT)
            .json(&request_body(state))
            .send()
            .await
            .map_err(|_| {
                "LoomWatch couldn't reach OpenRouter to read the setup. Check this computer's internet connection.".to_owned()
            })?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err("OpenRouter refused the key. Check it in Connections.".to_owned());
        }
        if status == StatusCode::PAYMENT_REQUIRED {
            return Err(
                "Your OpenRouter credit has run out, so the setup wasn't read. Add credit at openrouter.ai."
                    .to_owned(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "OpenRouter couldn't read the setup just now (HTTP {}).",
                status.as_u16()
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "OpenRouter's answer was cut off.".to_owned())?;
        if bytes.len() > MAX_ANSWER_BYTES {
            return Err("OpenRouter's answer was too long to be a reading.".to_owned());
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| "OpenRouter's answer couldn't be read.".to_owned())
    }
}

pub(super) async fn status(State(ai): State<Ai>) -> Json<ReadingStatus> {
    Json(ai.inner.reader.status())
}

#[derive(Deserialize)]
pub(super) struct Change {
    enabled: bool,
}

pub(super) async fn change(
    State(ai): State<Ai>,
    Json(change): Json<Change>,
) -> Json<ReadingStatus> {
    Json(ai.inner.reader.set_enabled(change.enabled))
}

#[derive(Deserialize)]
pub(super) struct ReadRequest {
    setup: Setup,
}

pub(super) async fn read(
    State(ai): State<Ai>,
    Json(request): Json<ReadRequest>,
) -> Result<Json<Value>, Refusal> {
    let (reading, kept) = ai
        .inner
        .reader
        .read(
            ai.inner.client.as_ref(),
            async || ai.openrouter_key().await,
            &request.setup,
        )
        .await?;
    Ok(Json(json!({"reading": reading, "kept": kept})))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::routing::post;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::super::{Keys, Models, router};
    use super::*;

    struct Folder(PathBuf);
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn folder() -> Folder {
        let path = std::env::temp_dir().join(format!("loomwatch-reading-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Folder(path)
    }

    /// A stand-in Decisions API: answers `answer` with `status`, counts calls and keeps the last body.
    async fn fake_decisions(
        status: StatusCode,
        answer: Value,
    ) -> (String, Arc<AtomicUsize>, Arc<std::sync::Mutex<Value>>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let last = Arc::new(std::sync::Mutex::new(Value::Null));
        let (seen, kept) = (calls.clone(), last.clone());
        let app = Router::new().route(
            "/api/alpha/decisions",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let (seen, kept, answer) = (seen.clone(), kept.clone(), answer.clone());
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        let auth = headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        *kept.lock().unwrap() = json!({"auth": auth, "body": body});
                        (status, Json(answer)).into_response()
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/api/v1/key"), calls, last)
    }

    fn gathers() -> Value {
        json!({
            "id": "dec-1", "model": READING_MODEL, "provider": "TypeSafe",
            "answers": {"job": {"type": "choice", "choice": "gather", "probabilities": {"gather": 0.86, "produce": 0.11, "check": 0.03}, "confidence": 0.9}},
            "usage": {"input_tokens": 420, "output_tokens": 0, "cost": 0.000_017_6},
        })
    }

    async fn app_with(key_url: &str, state: &Path, key: Option<&str>) -> Router {
        let keys = Keys::in_memory();
        if let Some(key) = key {
            keys.set_openrouter(key).await.unwrap();
        }
        router(Ai::with(
            keys,
            Models::with_url("http://127.0.0.1:9/models", None),
            state,
            key_url,
        ))
    }

    async fn send(app: &Router, method: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = HttpRequest::builder()
            .method(method)
            .uri("/api/models/reading")
            .header("x-loomwatch-request", "1")
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn gatherer() -> Value {
        json!({"setup": {
            "name": "Gatherer",
            "instructions": "Find what happened in tech today.\n\n\n\nDo not judge the stories or write them: the Writer does.",
            "doneWhen": ["Every story has a link"],
            "skills": ["web-research"], "tools": [], "reads": ["Trusted sources"],
            "allow": ["web"], "recruits": false,
        }})
    }

    #[tokio::test]
    async fn nothing_is_read_or_paid_for_while_reading_is_off() {
        let state = folder();
        let (url, calls, _) = fake_decisions(StatusCode::OK, gathers()).await;
        let app = app_with(&url, &state.0, Some("sk-or-v1-good")).await;

        let (status, body) = send(&app, "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({"enabled": false, "readings": 0, "spent": 0.0, "today": 0, "dailyLimit": DAILY_LIMIT})
        );
        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "off");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_setup_is_read_once_and_its_cost_counted() {
        let state = folder();
        let (url, calls, last) = fake_decisions(StatusCode::OK, gathers()).await;
        let app = app_with(&url, &state.0, Some("sk-or-v1-good")).await;
        let (_, body) = send(&app, "PUT", Some(json!({"enabled": true}))).await;
        assert_eq!(body["enabled"], true);

        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["kept"], false);
        assert_eq!(body["reading"]["kind"], "gather");
        assert_eq!(body["reading"]["probabilities"]["gather"], 0.86);
        assert_eq!(body["reading"]["confidence"], 0.9);

        // What was sent: the pinned model, one choice question over the three kinds, the setup by
        // name only, and the operator's key in the one header that carries it.
        let sent = last.lock().unwrap().clone();
        assert_eq!(sent["auth"], "Bearer sk-or-v1-good");
        assert_eq!(sent["body"]["model"], READING_MODEL);
        assert_eq!(sent["body"]["questions"]["job"]["type"], "choice");
        let criteria = sent["body"]["questions"]["job"]["criteria"]
            .as_object()
            .unwrap();
        let mut kinds: Vec<&String> = criteria.keys().collect();
        kinds.sort();
        assert_eq!(kinds, ["check", "gather", "produce"]);
        let said = sent["body"]["state"].as_str().unwrap();
        assert!(
            said.starts_with(
                "Name: Gatherer\nInstructions:\nFind what happened in tech today.\n\nDo not judge"
            ),
            "{said}"
        );
        assert!(
            said.contains("Skills it is given: web-research\n"),
            "{said}"
        );
        assert!(
            said.contains("It may, without asking: search the web and read pages\n"),
            "{said}"
        );
        assert!(!said.contains("\n\n\n"), "{said}");

        // The same setup again, from another picker or another team: kept, not paid for.
        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["kept"], true);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let (_, body) = send(&app, "GET", None).await;
        assert_eq!(body["readings"], 1);
        assert_eq!(body["today"], 1);
        assert!((body["spent"].as_f64().unwrap() - 0.000_017_6).abs() < 1e-12);

        // Turning it off keeps what was read, but reads nothing, kept or not.
        send(&app, "PUT", Some(json!({"enabled": false}))).await;
        let (status, _) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(state.0.join(KEPT_FILE).exists());
    }

    #[tokio::test]
    async fn a_failed_call_rests_reading_and_the_daily_limit_holds() {
        let state = folder();
        let (url, calls, _) = fake_decisions(
            StatusCode::PAYMENT_REQUIRED,
            json!({"error": {"code": 402, "message": "Insufficient credits"}}),
        )
        .await;
        let app = app_with(&url, &state.0, Some("sk-or-v1-good")).await;
        send(&app, "PUT", Some(json!({"enabled": true}))).await;

        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body["code"], "failed");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("credit has run out")
        );
        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "resting");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // A new day's limit, reached: nothing more is called.
        let other = folder();
        let (url, calls, _) = fake_decisions(StatusCode::OK, gathers()).await;
        let app = app_with(&url, &other.0, Some("sk-or-v1-good")).await;
        let full = json!({"enabled": true, "day": today(), "today": DAILY_LIMIT});
        std::fs::write(other.0.join(SETTINGS_FILE), full.to_string()).unwrap();
        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "limit");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // Yesterday's count is not today's.
        let yesterday = json!({"enabled": true, "day": "2000-01-01", "today": DAILY_LIMIT});
        std::fs::write(other.0.join(SETTINGS_FILE), yesterday.to_string()).unwrap();
        let (status, _) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn turning_reading_off_while_a_reading_starts_calls_nothing_and_stays_off() {
        let state = folder();
        let (url, calls, _) = fake_decisions(StatusCode::OK, gathers()).await;
        let reader = Reader::new(&state.0, &decisions_url(url.trim_end_matches("/key")));
        reader.set_enabled(true);
        let setup: Setup = serde_json::from_value(gatherer()["setup"].clone()).unwrap();
        let client = reqwest::Client::new();
        let refused = reader
            .read(
                Some(&client),
                async || {
                    // The operator turns it off in a model list while the key is looked up.
                    reader.set_enabled(false);
                    Ok(ApiKey::new("sk-or-v1-good"))
                },
                &setup,
            )
            .await
            .unwrap_err();
        assert_eq!(refused.code, "off");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let status = reader.status();
        assert!(!status.enabled);
        assert_eq!(status.today, 0);
    }

    #[tokio::test]
    async fn a_paid_answer_that_names_no_kind_still_counts_what_it_cost() {
        let state = folder();
        let (url, calls, _) = fake_decisions(
            StatusCode::OK,
            json!({
                "answers": {"job": {"type": "choice", "choice": "write"}},
                "usage": {"input_tokens": 476, "output_tokens": 0, "cost": 0.000_02},
            }),
        )
        .await;
        let app = app_with(&url, &state.0, Some("sk-or-v1-good")).await;
        send(&app, "PUT", Some(json!({"enabled": true}))).await;
        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body["code"], "failed");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let (_, body) = send(&app, "GET", None).await;
        assert_eq!(body["readings"], 0);
        assert_eq!(body["today"], 1);
        assert!((body["spent"].as_f64().unwrap() - 0.000_02).abs() < 1e-12);
    }

    /// Choosing a model is counted with every other model call, so the Usage page shows it among
    /// `LoomWatch`'s own help, at what `OpenRouter` said it cost.
    #[tokio::test]
    async fn a_reading_is_counted_with_every_other_model_call() {
        let state = folder();
        let (url, _, _) = fake_decisions(StatusCode::OK, gathers()).await;
        let reader = Reader::new(&state.0, &decisions_url(url.trim_end_matches("/key")));
        let archive = crate::archive::EventArchive::new(crate::db::Db::temp().await);
        reader.count_in(archive.clone());
        reader.set_enabled(true);
        let setup: Setup = serde_json::from_value(gatherer()["setup"].clone()).unwrap();
        let client = reqwest::Client::new();
        reader
            .read(
                Some(&client),
                async || Ok(ApiKey::new("sk-or-v1-good")),
                &setup,
            )
            .await
            .expect("read");
        let report = archive
            .model_usage(chrono::Utc::now() + chrono::Duration::minutes(1), 30)
            .await
            .unwrap();
        assert_eq!(report.features.len(), 1);
        let choosing = &report.features[0];
        assert_eq!(
            (choosing.feature.as_str(), choosing.source.as_str()),
            ("choosing_models", "openrouter")
        );
        assert_eq!(
            (choosing.tally.calls, choosing.tally.input_tokens),
            (1, 420)
        );
        assert!((choosing.tally.cost_usd - 0.000_017_6).abs() < 1e-12);
        // LoomWatch's own help, not an agent's work.
        assert!(report.agents.is_empty());
        assert_eq!(report.sources[0].loomwatch, report.sources[0].total);
    }

    #[tokio::test]
    async fn without_a_key_or_instructions_nothing_is_called() {
        let state = folder();
        let (url, calls, _) = fake_decisions(StatusCode::OK, gathers()).await;
        let app = app_with(&url, &state.0, None).await;
        send(&app, "PUT", Some(json!({"enabled": true}))).await;
        let (status, body) = send(&app, "POST", Some(gatherer())).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "no_key");
        let (status, body) = send(
            &app,
            "POST",
            Some(json!({"setup": {"name": "Empty", "instructions": "  "}})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "empty");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn another_site_cannot_turn_reading_on() {
        let state = folder();
        let app = app_with("http://127.0.0.1:9/api/v1/key", &state.0, None).await;
        let request = HttpRequest::builder()
            .method("PUT")
            .uri("/api/models/reading")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"enabled":true}"#))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!Reader::new(&state.0, "").status().enabled);
    }

    #[test]
    fn answers_are_read_leniently_and_only_when_they_say_a_kind() {
        let wrapped = json!({"data": {"answers": {"job": {"choice": "check", "probabilities": {"check": 0.7, "produce": 0.3, "other": 1.0}}}}});
        assert_eq!(
            read_answer(&wrapped),
            Some(Reading {
                kind: "check".into(),
                probabilities: BTreeMap::from([("check".into(), 0.7), ("produce".into(), 0.3)]),
                confidence: None,
            })
        );
        let unknown =
            json!({"answers": {"job": {"choice": "write", "probabilities": {"write": 1.0}}}});
        assert_eq!(read_answer(&unknown), None);
        // Probabilities and confidence are optional in the Decisions API: the choice alone is an
        // answer, which the app then trusts only as far as it says it is sure.
        let bare = json!({"answers": {"job": {"type": "choice", "choice": "gather"}}});
        assert_eq!(
            read_answer(&bare),
            Some(Reading {
                kind: "gather".into(),
                probabilities: BTreeMap::new(),
                confidence: None,
            })
        );
        assert_eq!(read_answer(&json!({"choices": []})), None);
    }

    #[test]
    fn the_decisions_api_sits_beside_openrouters_v1() {
        assert_eq!(
            decisions_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/alpha/decisions"
        );
        assert_eq!(
            decisions_url("http://127.0.0.1:4100/api/v1/"),
            "http://127.0.0.1:4100/api/alpha/decisions"
        );
    }

    #[test]
    fn the_same_setup_is_kept_under_the_same_key_and_a_changed_one_is_not() {
        let setup = Setup {
            name: "Scout".into(),
            instructions: "Find sources.  \n\n\n\nHand them on.".into(),
            ..Setup::default()
        };
        let tidier = Setup {
            instructions: "Find sources.\n\nHand them on.".into(),
            ..setup.clone()
        };
        let changed = Setup {
            instructions: "Find sources and write the report.".into(),
            ..setup.clone()
        };
        assert_eq!(key_for(&state_of(&setup)), key_for(&state_of(&tidier)));
        assert_ne!(key_for(&state_of(&setup)), key_for(&state_of(&changed)));
        let long = Setup {
            instructions: "word ".repeat(5000),
            ..Setup::default()
        };
        assert!(state_of(&long).chars().count() < MAX_INSTRUCTIONS_CHARS + 200);
    }
}
