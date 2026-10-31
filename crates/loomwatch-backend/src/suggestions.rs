//! What the person may want to ask the agent pinned to the notch next: buttons under the island's
//! box (ADR 0105). Pressing one only puts its words in the box, to change or send.
//!
//! Two kinds, each from what happened in the agent's own chat:
//!
//! - **Next steps** from its newest answer, written once for that answer by a small model on the
//!   source the agent already runs on, so the answer goes nowhere it has not been. Only while that
//!   answer is the newest thing in the chat and younger than [`NEXT_STEPS_FOR`]: once the person
//!   has written again, or the day has moved on, they are no longer next.
//! - **Again**: what the person has asked it more than once ([`AGAIN_AT_LEAST`]), most often and
//!   most recent first. A request sent with files is left out: the files would not go again.
//!
//! People mostly follow an answer up within the hour, with something they have not asked before;
//! few requests repeat. So next steps come first, and what was asked before fills the rest.
//!
//! `GET /api/pinned-agent/suggestions` answers at once with what is known. Next steps not yet
//! written are started then, and `writing` tells the island to ask again in a moment.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::State;
use axum::middleware;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::agent::OFFLINE_MODEL;
use crate::ai::{ModelRef, Source};
use crate::archive::EventArchive;
use crate::pinned::Pinned;
use crate::watch_api::local_evidence;

/// Whether next steps are written after each answer. Off, the island suggests only what was asked
/// before, and no model is called.
pub const WRITE_NEXT_STEPS: bool = true;
/// How long after an answer its next steps are still offered.
pub const NEXT_STEPS_FOR: Duration = Duration::from_hours(12);
/// How far back what was asked before is looked for, and how many times it must have been asked.
const AGAIN_WITHIN: Duration = Duration::from_hours(60 * 24);
pub const AGAIN_AT_LEAST: usize = 2;
/// A request worth asking again says what to do and to what: shorter ones ("try again") answered
/// the moment they were sent.
const AGAIN_LEAST_WORDS: usize = 3;
/// Suggestions under the box, at most.
pub const MOST: usize = 3;
/// What the writer reads of the request and the answer: an answer says its point near the top, and
/// every word is paid for.
const REQUEST_CHARS: usize = 2_000;
const ANSWER_CHARS: usize = 8_000;
/// A suggestion longer than this isn't a button: it is dropped, not cut.
const STEP_CHARS: usize = 90;
const WRITE_TOKENS: u32 = 300;
const WRITE_TIMEOUT: Duration = Duration::from_secs(40);
/// Answers whose next steps are kept, newest last.
const KEPT: usize = 64;
const TALLY_FILE: &str = "next-steps.json";

/// The writer's instructions. Measured on real follow-ups before it went in (ADR 0105); a change
/// is measured again.
const WRITE: &str = "You guess what a person will ask their AI assistant next, right after reading its latest answer. \
Write exactly three short requests the person might send next, in their own voice, each at most 8 words. \
Make them different kinds of next step: a question about something in the answer they may not understand, \
a change to the answer (shorter, a table, figures, another angle), or the obvious next action. \
Use names and terms from the answer. Do not suggest what the answer already did. \
Reply only with JSON: {\"next\": [\"...\", \"...\", \"...\"]}";

/// One thing to ask.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub text: String,
    pub kind: Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// A next step from the newest answer.
    Next,
    /// Something asked before, more than once.
    Again,
}

/// What `GET /api/pinned-agent/suggestions` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggested {
    pub suggestions: Vec<Suggestion>,
    /// Next steps from the newest answer are being written: ask again in a moment.
    pub writing: bool,
}

/// What has been written and spent, kept in the state folder: facts, from the providers' own counts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Tally {
    /// Answers next steps were written for.
    written: u64,
    /// Dollars those calls cost, as their providers reported; a plan's calls cost none.
    spent: f64,
}

/// Suggestions for the pinned agent. Cheap to clone.
#[derive(Clone)]
pub struct Suggestions {
    inner: Arc<Inner>,
}

struct Inner {
    pinned: Pinned,
    teams_root: PathBuf,
    archive: Option<EventArchive>,
    tally_file: Option<PathBuf>,
    written: Mutex<Written>,
}

/// Next steps by the run whose answer they follow, and the answers being written for now.
#[derive(Default)]
struct Written {
    steps: HashMap<String, Vec<String>>,
    order: VecDeque<String>,
    writing: HashSet<String>,
}

/// A request the person sent the agent in its chat.
#[derive(Debug, Clone, PartialEq)]
struct Asked {
    text: String,
    at: DateTime<Utc>,
    /// Files went with it.
    files: bool,
}

/// The agent's newest run in its chat.
#[derive(Debug, Clone, PartialEq)]
struct Answer {
    run_id: String,
    prompt: String,
    /// Its answer, when it finished with one.
    reply: Option<String>,
    finished: Option<DateTime<Utc>>,
    /// The session of the newest run in the chat, which the Usage page names the chat and agent by.
    session: Option<String>,
}

/// One call that wrote next steps: where it was paid, on which model, and what it used.
struct Call {
    source: Source,
    model: String,
    usage: crate::agent::Usage,
}

impl Suggestions {
    /// Suggestions for the agent pinned in `pinned`, from the chats in `archive`; the tally is kept
    /// in `state_dir` when there is one.
    #[must_use]
    pub fn new(
        pinned: Pinned,
        teams_root: &Path,
        archive: Option<EventArchive>,
        state_dir: Option<&Path>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                pinned,
                teams_root: teams_root.to_owned(),
                archive,
                tally_file: state_dir.map(|state| state.join(TALLY_FILE)),
                written: Mutex::default(),
            }),
        }
    }

    /// What to suggest now, starting the newest answer's next steps if they aren't written yet.
    pub async fn now(&self) -> Suggested {
        let Some(id) = self.inner.pinned.get().agent else {
            return Suggested::default();
        };
        let Some(archive) = &self.inner.archive else {
            return Suggested::default();
        };
        let chat = format!(
            "{}/{}/{id}.yaml",
            crate::jobs::JOBS_DIR,
            crate::jobs::BENCH_DIR
        );
        let db = archive.db().reader();
        let now = Utc::now();
        let asked = asked_before(db, &chat, now).await.unwrap_or_else(|error| {
            eprintln!("warning: suggestions could not read the chat: {error}");
            Vec::new()
        });
        let answer = newest_answer(db, &chat).await.unwrap_or_else(|error| {
            eprintln!("warning: suggestions could not read the newest answer: {error}");
            None
        });
        let mut next = Vec::new();
        let mut writing = false;
        if WRITE_NEXT_STEPS && let Some(answer) = answer.filter(|answer| fresh(answer, &asked, now))
        {
            match self.written(&answer.run_id) {
                Some(steps) => next = steps,
                None => writing = self.write(&id, answer),
            }
        }
        Suggested {
            suggestions: together(next, again(&asked)),
            writing,
        }
    }

    fn written(&self, run_id: &str) -> Option<Vec<String>> {
        let written = self
            .inner
            .written
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        written.steps.get(run_id).cloned()
    }

    /// Start writing the next steps from `answer`, once: whether they are being written now.
    fn write(&self, agent: &str, answer: Answer) -> bool {
        {
            let mut written = self
                .inner
                .written
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if !written.writing.insert(answer.run_id.clone()) {
                return true;
            }
        }
        let Some(job) = crate::jobs::read_job(&self.inner.teams_root, agent) else {
            self.keep(&answer.run_id, Vec::new());
            return false;
        };
        let suggestions = self.clone();
        let agent = agent.to_owned();
        tokio::spawn(async move {
            let steps = match tokio::time::timeout(WRITE_TIMEOUT, next_steps(&job, &answer)).await {
                Ok(Ok((steps, call))) => {
                    suggestions.count(call.usage.cost_usd);
                    suggestions.record(&agent, &answer, &call).await;
                    steps
                }
                Ok(Err(error)) => {
                    eprintln!("warning: the next steps after an answer were not written: {error}");
                    Vec::new()
                }
                Err(_) => {
                    eprintln!("warning: the next steps after an answer took too long to write");
                    Vec::new()
                }
            };
            suggestions.keep(&answer.run_id, steps);
        });
        true
    }

    /// Count the call among the model calls the Usage page shows, as the agent's, in its chat: what
    /// it cost is never out of sight (ADR 0073).
    async fn record(&self, agent: &str, answer: &Answer, call: &Call) {
        let Some(archive) = &self.inner.archive else {
            return;
        };
        let usage = &call.usage;
        let recorded = sqlx::query(
            "INSERT OR IGNORE INTO model_calls (
                 event_id, session_id, agent_id, ts, source, model, call_kind, input_tokens,
                 cached_read_tokens, cached_write_tokens, output_tokens, reasoning_tokens, cost_usd,
                 cost_estimated)
             VALUES ($1, $2, $3, $4, $5, $6, 'next_steps', $7, $8, $9, $10, $11, $12, $13)",
        )
        .bind(format!("next-steps-{}", uuid::Uuid::new_v4()))
        .bind(answer.session.as_deref().unwrap_or("next-steps"))
        .bind(agent)
        .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(call.source.as_str())
        .bind(&call.model)
        .bind(i64::try_from(usage.input_tokens).unwrap_or(i64::MAX))
        .bind(i64::try_from(usage.cached_read_tokens).unwrap_or(i64::MAX))
        .bind(i64::try_from(usage.cached_write_tokens).unwrap_or(i64::MAX))
        .bind(i64::try_from(usage.output_tokens).unwrap_or(i64::MAX))
        .bind(i64::try_from(usage.reasoning_tokens).unwrap_or(i64::MAX))
        .bind(usage.cost_usd.max(0.0))
        .bind(usage.cost_estimated)
        .execute(archive.db().writer())
        .await;
        if let Err(error) = recorded {
            eprintln!("warning: the call that wrote next steps was not counted: {error}");
        }
    }

    /// Keep what was written for `run_id`, even nothing, so it is written once.
    fn keep(&self, run_id: &str, steps: Vec<String>) {
        let mut written = self
            .inner
            .written
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        written.writing.remove(run_id);
        if written.steps.insert(run_id.to_owned(), steps).is_none() {
            written.order.push_back(run_id.to_owned());
        }
        while written.order.len() > KEPT {
            if let Some(oldest) = written.order.pop_front() {
                written.steps.remove(&oldest);
            }
        }
    }

    /// Add one written answer, and what its call cost, to the tally.
    fn count(&self, spent: f64) {
        let Some(file) = &self.inner.tally_file else {
            return;
        };
        let mut tally: Tally = std::fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        tally.written += 1;
        tally.spent += spent.max(0.0);
        let saved = serde_json::to_vec_pretty(&tally)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::approvals::write_private(file, &text));
        if let Err(error) = saved {
            eprintln!("warning: could not keep what next steps have cost: {error}");
        }
    }
}

/// `GET /api/pinned-agent/suggestions`, on this computer's own address.
pub fn router(suggestions: Suggestions) -> Router {
    Router::new()
        .route("/api/pinned-agent/suggestions", get(suggested))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(suggestions)
}

async fn suggested(State(suggestions): State<Suggestions>) -> Json<Suggested> {
    Json(suggestions.now().await)
}

/// The person's requests in the chat at `chat` since [`AGAIN_WITHIN`], newest first. A team's work
/// handed back to the agent is not the person's.
async fn asked_before(
    db: &SqlitePool,
    chat: &str,
    now: DateTime<Utc>,
) -> Result<Vec<Asked>, sqlx::Error> {
    let since = now
        - chrono::Duration::from_std(AGAIN_WITHIN).unwrap_or_else(|_| chrono::Duration::days(60));
    let rows = sqlx::query(
        "SELECT text, created_at, files FROM chat_messages
         WHERE team_path = $1 AND handed_back IS NULL AND created_at >= $2
         ORDER BY created_at DESC, id DESC LIMIT 500",
    )
    .bind(chat)
    .bind(since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let at = when(&row.get::<String, _>("created_at"))?;
            let files = row
                .get::<Option<String>, _>("files")
                .and_then(|files| serde_json::from_str::<Vec<Value>>(&files).ok())
                .is_some_and(|files| !files.is_empty());
            Some(Asked {
                text: row.get("text"),
                at,
                files,
            })
        })
        .collect())
}

/// The answer to the newest thing asked in the chat at `chat`: the agent's newest run, finished or
/// not, or a question it answered in the chat with no run, whichever was asked last.
async fn newest_answer(db: &SqlitePool, chat: &str) -> Result<Option<Answer>, sqlx::Error> {
    let run = sqlx::query(
        "SELECT run_id, session_id, prompt, status, reply, created_at, finished_at FROM runs
         WHERE team_path = $1 ORDER BY created_at DESC, run_id DESC LIMIT 1",
    )
    .bind(chat)
    .fetch_optional(db)
    .await?
    .and_then(|row| {
        let succeeded = row.get::<String, _>("status") == "succeeded";
        let asked = when(&row.get::<String, _>("created_at"))?;
        Some((
            asked,
            Answer {
                run_id: row.get("run_id"),
                prompt: row.get("prompt"),
                reply: row
                    .get::<Option<String>, _>("reply")
                    .filter(|reply| succeeded && !reply.trim().is_empty()),
                finished: row
                    .get::<Option<String>, _>("finished_at")
                    .as_deref()
                    .and_then(when),
                session: Some(row.get("session_id")),
            },
        ))
    });
    let session = run.as_ref().and_then(|(_, run)| run.session.clone());
    let talk = sqlx::query(
        "SELECT id, text, created_at, answers FROM chat_messages
         WHERE team_path = $1 AND answers IS NOT NULL
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(chat)
    .fetch_optional(db)
    .await?
    .and_then(|row| {
        let asked = when(&row.get::<String, _>("created_at"))?;
        let answers: crate::chat::NoteAnswers =
            serde_json::from_str(&row.get::<String, _>("answers")).ok()?;
        let said = answers.said.last();
        Some((
            asked,
            Answer {
                run_id: format!("note:{}", row.get::<String, _>("id")),
                prompt: row.get("text"),
                reply: said.map(|said| said.text.clone()),
                finished: said.and_then(|said| when(&said.at)),
                session,
            },
        ))
    });
    Ok([run, talk]
        .into_iter()
        .flatten()
        .max_by_key(|(asked, _)| *asked)
        .map(|(_, answer)| answer))
}

fn when(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// Whether `answer`'s next steps are still next: it answered, not long ago, and the person has not
/// written since.
fn fresh(answer: &Answer, asked: &[Asked], now: DateTime<Utc>) -> bool {
    let (Some(_), Some(finished)) = (&answer.reply, answer.finished) else {
        return false;
    };
    let young = (now - finished)
        .to_std()
        .is_ok_and(|age| age <= NEXT_STEPS_FOR);
    young && asked.first().is_none_or(|newest| newest.at <= finished)
}

/// A request as it is compared with others: its words, without `@` names or punctuation.
fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|word| !word.starts_with('@'))
        .map(|word| {
            word.chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

/// What was asked more than once, most often first and then most recent, in its newest wording.
fn again(asked: &[Asked]) -> Vec<Suggestion> {
    let mut seen: Vec<(Vec<String>, usize, &Asked)> = Vec::new();
    for each in asked.iter().filter(|each| !each.files) {
        let said = words(&each.text);
        if said.len() < AGAIN_LEAST_WORDS {
            continue;
        }
        match seen.iter_mut().find(|(known, _, _)| *known == said) {
            Some((_, count, _)) => *count += 1,
            None => seen.push((said, 1, each)),
        }
    }
    seen.retain(|(_, count, _)| *count >= AGAIN_AT_LEAST);
    // Newest first already; a stable sort keeps that among equal counts.
    seen.sort_by_key(|(_, count, _)| std::cmp::Reverse(*count));
    seen.into_iter()
        .filter_map(|(_, _, each)| {
            let text = each.text.split_whitespace().collect::<Vec<_>>().join(" ");
            (text.chars().count() <= STEP_CHARS).then_some(Suggestion {
                text,
                kind: Kind::Again,
            })
        })
        .collect()
}

/// Next steps first, then what was asked before, each once, at most [`MOST`].
fn together(next: Vec<String>, again: Vec<Suggestion>) -> Vec<Suggestion> {
    let mut seen = HashSet::new();
    next.into_iter()
        .map(|text| Suggestion {
            text,
            kind: Kind::Next,
        })
        .chain(again)
        .filter(|suggestion| seen.insert(words(&suggestion.text)))
        .take(MOST)
        .collect()
}

/// The small model that writes next steps for an agent on `model`: on the same source, so the
/// answer goes nowhere it has not been. On a `ChatGPT` plan, the agent's own model: a call costs the
/// plan's allowance, not dollars, and the plan has that model. An agent on a model that costs
/// nothing (`free`) writes with it, so choosing a free model never brings a charge. The offline
/// demo and test stand-ins write with themselves.
fn writer_for(model: &ModelRef, free: bool) -> ModelRef {
    match model.source {
        Source::ChatGpt => model.clone(),
        Source::OpenRouter if free => model.clone(),
        Source::Anthropic => ModelRef {
            source: Source::Anthropic,
            id: "claude-haiku-5-5".to_owned(),
        },
        Source::OpenRouter if model.id == OFFLINE_MODEL || model.id.starts_with("demo/") => {
            model.clone()
        }
        Source::OpenRouter => ModelRef {
            source: Source::OpenRouter,
            id: "anthropic/claude-haiku-5.5".to_owned(),
        },
    }
}

/// Whether `model` costs nothing: an `OpenRouter` model the catalog lists as free, or named so.
async fn costs_nothing(model: &ModelRef) -> bool {
    if model.source != Source::OpenRouter {
        return false;
    }
    if model.id.ends_with(":free") {
        return true;
    }
    let Some(ai) = crate::ai::installed() else {
        return false;
    };
    ai.models()
        .catalog()
        .await
        .ok()
        .and_then(|catalog| catalog.find(&model.id).map(|listed| listed.free))
        .unwrap_or(false)
}

/// Write the next steps from `answer` for the agent `job`, and the call that wrote them.
async fn next_steps(
    job: &crate::jobs::JobSpec,
    answer: &Answer,
) -> Result<(Vec<String>, Call), String> {
    let reply = answer.reply.as_deref().unwrap_or_default();
    let model = ModelRef::parse(job.model.as_deref().unwrap_or(crate::ai::DEFAULT_MODEL));
    let writer = writer_for(&model, costs_nothing(&model).await);
    let provider = crate::engine::provider_for(&writer)
        .await
        .map_err(|error| error.to_string())?;
    let who = if job.does.trim().is_empty() {
        job.name.trim().to_owned()
    } else {
        format!("{}, {}", job.name.trim(), job.does.trim())
    };
    let about = format!(
        "Assistant: {who}\nThe person asked: {}\nThe assistant answered:\n{}",
        cut(&answer.prompt, REQUEST_CHARS),
        cut(reply, ANSWER_CHARS),
    );
    let completion = provider
        .once(&writer.id, WRITE, &about, WRITE_TOKENS)
        .await?;
    Ok((
        read_steps(&completion.content),
        Call {
            source: writer.source,
            model: writer.id,
            usage: completion.usage,
        },
    ))
}

fn cut(text: &str, limit: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(limit) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

/// The steps in the writer's reply: `{"next": [...]}` anywhere in it, each a short request, each
/// once, at most [`MOST`]. Anything else is no steps.
fn read_steps(reply: &str) -> Vec<String> {
    let (Some(start), Some(end)) = (reply.find('{'), reply.rfind('}')) else {
        return Vec::new();
    };
    let Some(Value::Array(steps)) = reply
        .get(start..=end)
        .and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|value| value.get("next").cloned())
    else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    steps
        .iter()
        .filter_map(Value::as_str)
        .map(|step| {
            step.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .trim_matches(|c: char| c == '"' || c == '“' || c == '”')
                .to_owned()
        })
        .filter(|step| !step.is_empty() && step.chars().count() <= STEP_CHARS)
        .filter(|step| seen.insert(words(step)))
        .take(MOST)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{Completion, Demo, Message};
    use crate::db::Db;
    use axum::body::Body;
    use axum::http::{Request, header};
    use tower::ServiceExt as _;

    struct TempDirectory(PathBuf);

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn folder() -> TempDirectory {
        let path = std::env::temp_dir().join(format!("loomwatch-suggest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).expect("create temporary directory");
        TempDirectory(path)
    }

    fn asked(text: &str, minutes_ago: i64, files: bool) -> Asked {
        Asked {
            text: text.to_owned(),
            at: Utc::now() - chrono::Duration::minutes(minutes_ago),
            files,
        }
    }

    fn texts(suggestions: &[Suggestion]) -> Vec<(&str, Kind)> {
        suggestions
            .iter()
            .map(|suggestion| (suggestion.text.as_str(), suggestion.kind))
            .collect()
    }

    #[test]
    fn reads_up_to_three_short_steps_from_the_writers_reply_and_nothing_from_anything_else() {
        let reply = "Here you go:\n{\"next\": [\" Draft a reply to  Ana \", \"draft a reply to Ana!\", \"What is an S-1 filing?\", 7, \"\", \"Add a chart\", \"One more\"]}\nDone.";
        assert_eq!(
            read_steps(reply),
            [
                "Draft a reply to Ana",
                "What is an S-1 filing?",
                "Add a chart"
            ]
        );
        // A step too long for a button is dropped, not cut.
        let long = format!("{{\"next\": [\"{}\", \"Shorter\"]}}", "word ".repeat(30));
        assert_eq!(read_steps(&long), ["Shorter"]);
        for nothing in [
            "",
            "Sure!",
            "{\"next\": \"one\"}",
            "{\"steps\": [\"a\"]}",
            "{not json}",
        ] {
            assert!(read_steps(nothing).is_empty(), "{nothing:?}");
        }
    }

    #[test]
    fn offers_what_was_asked_more_than_once_without_files_most_often_then_newest_first() {
        let asked = [
            asked("check my availability", 1, false),
            asked("Summarize this report", 2, true),
            asked("Summarize this report", 3, true),
            asked("Summarize this report", 4, true),
            asked("try again", 4, false),
            asked("try again", 5, false),
            asked("What's due this week?", 6, false),
            asked("Check my  availability.", 7, false),
            asked("what's due this week", 8, false),
            asked("@Cole what's due this week?", 9, false),
            asked("Plan my trip to Kyoto", 10, false),
        ];
        assert_eq!(
            texts(&again(&asked)),
            [
                ("What's due this week?", Kind::Again),
                ("check my availability", Kind::Again),
            ]
        );
    }

    #[test]
    fn puts_next_steps_first_each_once_and_at_most_three() {
        let again = vec![
            Suggestion {
                text: "Make it shorter".to_owned(),
                kind: Kind::Again,
            },
            Suggestion {
                text: "Check my availability".to_owned(),
                kind: Kind::Again,
            },
        ];
        assert_eq!(
            texts(&together(
                vec![
                    "Make it shorter.".to_owned(),
                    "What is H1 revenue?".to_owned()
                ],
                again.clone()
            )),
            [
                ("Make it shorter.", Kind::Next),
                ("What is H1 revenue?", Kind::Next),
                ("Check my availability", Kind::Again),
            ]
        );
        assert_eq!(texts(&together(Vec::new(), again)).len(), 2);
    }

    #[test]
    fn next_steps_follow_only_a_recent_answer_the_person_has_not_written_after() {
        let now = Utc::now();
        let answered = |minutes_ago: i64, reply: Option<&str>| Answer {
            run_id: "r1".to_owned(),
            prompt: "Research the IPO".to_owned(),
            reply: reply.map(str::to_owned),
            finished: Some(now - chrono::Duration::minutes(minutes_ago)),
            session: None,
        };
        assert!(fresh(
            &answered(5, Some("The brief.")),
            &[asked("Research the IPO", 9, false)],
            now
        ));
        // The person has written since: these are no longer next.
        assert!(!fresh(
            &answered(5, Some("The brief.")),
            &[asked("Thanks", 1, false)],
            now
        ));
        // Too long ago, or no answer at all.
        let old = i64::try_from(NEXT_STEPS_FOR.as_secs() / 60).expect("minutes") + 1;
        assert!(!fresh(&answered(old, Some("The brief.")), &[], now));
        assert!(!fresh(&answered(5, None), &[], now));
        let unfinished = Answer {
            finished: None,
            ..answered(5, Some("The brief."))
        };
        assert!(!fresh(&unfinished, &[], now));
    }

    #[test]
    fn writes_on_the_agents_own_source_with_a_small_model_and_keeps_a_plan_agent_on_its_plan() {
        let writer = |model: &str| {
            let writer = writer_for(&ModelRef::parse(model), false);
            (writer.source, writer.id)
        };
        assert_eq!(
            writer("chatgpt:gpt-5.6-terra"),
            (Source::ChatGpt, "gpt-5.6-terra".to_owned())
        );
        assert_eq!(
            writer("anthropic:claude-opus-5-5"),
            (Source::Anthropic, "claude-haiku-5-5".to_owned())
        );
        assert_eq!(
            writer("anthropic/claude-opus-5.5"),
            (Source::OpenRouter, "anthropic/claude-haiku-5.5".to_owned())
        );
        assert_eq!(
            writer(OFFLINE_MODEL),
            (Source::OpenRouter, OFFLINE_MODEL.to_owned())
        );
        // An agent on a free model writes with it, never with one that charges.
        let free = writer_for(&ModelRef::parse("google/gemma-4:free"), true);
        assert_eq!(
            (free.source, free.id.as_str()),
            (Source::OpenRouter, "google/gemma-4:free")
        );
        // A plan or a key's own source is never moved for it.
        assert_eq!(
            writer_for(&ModelRef::parse("chatgpt:gpt-5.6-terra"), true).source,
            Source::ChatGpt
        );
    }

    async fn insert_message(db: &Db, text: &str, at: DateTime<Utc>, files: Option<&str>) {
        sqlx::query(
            "INSERT INTO chat_messages (id, team_key, team_path, text, created_at, route, files)
             VALUES ($1, 'path:.jobs/.bench/cole.yaml', '.jobs/.bench/cole.yaml', $2, $3, 'agent', $4)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(text)
        .bind(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(files)
        .execute(db.writer())
        .await
        .expect("message");
    }

    async fn insert_run(db: &Db, run: &str, reply: &str, at: DateTime<Utc>) {
        let at = at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query(
            "INSERT INTO runs (run_id, session_id, team_path, team_key, prompt, status, mode,
                               entrypoint, responder, created_at, finished_at, reply, trigger)
             VALUES ($1, $1, '.jobs/.bench/cole.yaml', 'path:.jobs/.bench/cole.yaml',
                     'Research the IPO', 'succeeded', 'team', 'cole', 'cole', $2, $2, $3, 'manual')",
        )
        .bind(run)
        .bind(&at)
        .bind(reply)
        .execute(db.writer())
        .await
        .expect("run");
    }

    fn get() -> Request<Body> {
        Request::builder()
            .uri("/api/pinned-agent/suggestions")
            .header(header::HOST, "localhost")
            .body(Body::empty())
            .expect("request")
    }

    async fn ask(app: &Router) -> Value {
        let response = app.clone().oneshot(get()).await.expect("get");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    /// Asks until the next steps are written, for at most a few seconds.
    async fn written(app: &Router) -> Value {
        for _ in 0..100 {
            let now = ask(app).await;
            if now["writing"] == false {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the next steps were never written");
    }

    // One test on purpose: each step reads what the one before wrote, kept or counted.
    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn suggests_the_next_steps_from_the_newest_answer_written_once_then_what_was_asked_again()
    {
        let teams = folder();
        let state = folder();
        let demo = Demo::scripted(vec![Completion::text(
            "{\"next\": [\"Add a chart of the losses\", \"What is an S-1?\"]}",
        )]);
        let model = crate::engine::demo_model(demo);
        let jobs = teams.0.join(".jobs");
        std::fs::create_dir_all(jobs.join(".bench")).expect("jobs folder");
        std::fs::write(
            jobs.join("cole.yaml"),
            format!(
                "name: Cole\ndoes: Colin's secretary\ninstructions: Help me.\nmodel: {model}\n"
            ),
        )
        .expect("job");
        let pinned = Pinned::open(state.0.as_path(), teams.0.as_path());
        pinned
            .set(crate::pinned::PinnedAgent {
                agent: Some("cole".to_owned()),
            })
            .expect("pin");
        let db = Db::temp().await;
        let now = Utc::now();
        insert_message(
            &db,
            "check my availability",
            now - chrono::Duration::days(2),
            None,
        )
        .await;
        insert_message(
            &db,
            "Check my availability",
            now - chrono::Duration::days(1),
            None,
        )
        .await;
        insert_message(
            &db,
            "Summarize this report",
            now - chrono::Duration::hours(3),
            Some("[{\"name\":\"a.pdf\"}]"),
        )
        .await;
        insert_message(
            &db,
            "Summarize this report",
            now - chrono::Duration::hours(2),
            Some("[{\"name\":\"b.pdf\"}]"),
        )
        .await;
        insert_message(
            &db,
            "Research the IPO",
            now - chrono::Duration::minutes(30),
            None,
        )
        .await;
        insert_run(
            &db,
            "ipo",
            "Anthropic filed its S-1; the first half lost $80.7B.",
            now - chrono::Duration::minutes(10),
        )
        .await;
        let app = router(Suggestions::new(
            pinned,
            teams.0.as_path(),
            Some(EventArchive::new(db.clone())),
            Some(state.0.as_path()),
        ));

        // At first only what was asked before, while the next steps are written.
        let first = ask(&app).await;
        assert_eq!(first["writing"], true);
        assert_eq!(
            first["suggestions"],
            serde_json::json!([{"text": "Check my availability", "kind": "again"}])
        );
        let now_written = written(&app).await;
        assert_eq!(
            now_written["suggestions"],
            serde_json::json!([
                {"text": "Add a chart of the losses", "kind": "next"},
                {"text": "What is an S-1?", "kind": "next"},
                {"text": "Check my availability", "kind": "again"},
            ])
        );
        // Written once, from who the agent is, what was asked and the answer, with no tools.
        let demo = crate::engine::demo_for(&model).expect("demo");
        let seen = demo.requests();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].tools.is_empty());
        let Message::User { content, .. } = &seen[0].messages[1] else {
            panic!("the answer goes as the person's message");
        };
        assert!(content.starts_with(
            "Assistant: Cole, Colin's secretary\nThe person asked: Research the IPO\n"
        ));
        assert!(content.ends_with("the first half lost $80.7B."));
        assert_eq!(ask(&app).await["suggestions"], now_written["suggestions"]);
        assert_eq!(demo.requests().len(), 1);
        let tally: Tally =
            serde_json::from_slice(&std::fs::read(state.0.join(TALLY_FILE)).expect("tally"))
                .expect("tally json");
        assert_eq!(tally.written, 1);
        // And it is counted among the model calls the Usage page shows, as Cole's, in its chat.
        let counted: Vec<(String, String, String, String)> =
            sqlx::query_as("SELECT session_id, agent_id, source, call_kind FROM model_calls")
                .fetch_all(db.reader())
                .await
                .expect("model calls");
        assert_eq!(
            counted,
            [(
                "ipo".to_owned(),
                "cole".to_owned(),
                "openrouter".to_owned(),
                "next_steps".to_owned()
            )]
        );

        // Once the person writes again, the next steps from that answer are no longer next.
        insert_message(&db, "Thanks", Utc::now(), None).await;
        assert_eq!(
            ask(&app).await,
            serde_json::json!({
                "suggestions": [{"text": "Check my availability", "kind": "again"}],
                "writing": false,
            })
        );
    }

    /// A question the agent answered in the chat, with no run, is the newest answer once it was
    /// asked after the newest run's request.
    #[tokio::test]
    async fn a_question_answered_in_the_chat_has_next_steps_too() {
        let teams = folder();
        let state = folder();
        let model = crate::engine::demo_model(Demo::scripted(vec![Completion::text(
            "{\"next\": [\"Explain the S-1 in plain words\"]}",
        )]));
        let jobs = teams.0.join(".jobs");
        std::fs::create_dir_all(&jobs).expect("jobs folder");
        std::fs::write(
            jobs.join("cole.yaml"),
            format!("name: Cole\ninstructions: Help me.\nmodel: {model}\n"),
        )
        .expect("job");
        let pinned = Pinned::open(state.0.as_path(), teams.0.as_path());
        pinned
            .set(crate::pinned::PinnedAgent {
                agent: Some("cole".to_owned()),
            })
            .expect("pin");
        let db = Db::temp().await;
        let now = Utc::now();
        insert_run(
            &db,
            "older",
            "An older brief.",
            now - chrono::Duration::hours(2),
        )
        .await;
        let answers = serde_json::json!({"said": [{
            "from": "cole",
            "text": "An S-1 is the filing a company makes before it sells shares.",
            "at": (now - chrono::Duration::minutes(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }], "waiting": []});
        sqlx::query(
            "INSERT INTO chat_messages (id, team_key, team_path, text, created_at, route, answers)
             VALUES ('q1', 'path:.jobs/.bench/cole.yaml', '.jobs/.bench/cole.yaml', 'what is S-1?', $1,
                     'team_note', $2)",
        )
        .bind((now - chrono::Duration::minutes(2)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(answers.to_string())
        .execute(db.writer())
        .await
        .expect("question");
        let app = router(Suggestions::new(
            pinned,
            teams.0.as_path(),
            Some(EventArchive::new(db)),
            None,
        ));
        assert_eq!(
            written(&app).await["suggestions"],
            serde_json::json!([{"text": "Explain the S-1 in plain words", "kind": "next"}])
        );
        let seen = crate::engine::demo_for(&model).expect("demo").requests();
        let Message::User { content, .. } = &seen[0].messages[1] else {
            panic!("the answer goes as the person's message");
        };
        assert!(content.contains("The person asked: what is S-1?\n"));
        assert!(content.ends_with("before it sells shares."));
    }

    #[tokio::test]
    async fn suggests_nothing_with_no_agent_pinned() {
        let teams = folder();
        let state = folder();
        let app = router(Suggestions::new(
            Pinned::open(state.0.as_path(), teams.0.as_path()),
            teams.0.as_path(),
            Some(EventArchive::new(Db::temp().await)),
            None,
        ));
        assert_eq!(
            ask(&app).await,
            serde_json::json!({"suggestions": [], "writing": false})
        );
    }
}
