//! A team's chat (ADR 0051): its runs and what the operator wrote to it, read as one conversation.
//!
//! There is no second store of what happened. A piece of work in the chat *is* a run: its request
//! is the run's prompt, the talk between its agents is the run's archive, and its answer is the
//! run's reply. What the chat adds is what the operator typed that did not start a run — a note to
//! an agent at work, a note to the team — and, for every message, the route it took. Those live in
//! `chat_messages`.
//!
//! Routing is a fixed rule, decided here and never guessed from the words (ADR 0051):
//!
//! * `@team` starts the whole team from its first step;
//! * `@<agent>` starts that agent alone — or, while it is working, becomes a note for its next turn;
//! * no @ is a note: to the agent at work when one is, otherwise to the whole team, read as
//!   conversation the next time work starts.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path as RoutePath, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Row as _};
use uuid::Uuid;

use crate::api::{ApiError, normalized_relative_path, resolve_existing_team_path};
use crate::archive::EventArchive;
use crate::config::TeamConfig;
use crate::runs::{
    self, LaunchError, QueuedNote, RunRecord, RunRegistry, RunStatus, RunTrigger, StartRunOutcome,
    StartRunRequest,
};
use crate::watch_api::local_evidence;

/// The most of one message the chat accepts, the same bound as a run's prompt.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Pieces of work per page when the client does not say.
const DEFAULT_PAGE: i64 = 20;
const MAX_PAGE: i64 = 50;

/// The conversation section's budget (ADR 0051, "How much conversation each message carries").
///
/// The newest answer in full, then the newest entries up to [`DETAIL_BUDGET`] characters and
/// [`DETAIL_ENTRIES`] entries, then one line per older piece. A fixed rule, so the same chat always
/// gives the same section, and a starting point the evaluation in the ADR tunes.
const DETAIL_ENTRIES: usize = 20;
const DETAIL_BUDGET: usize = 10_500;
const EARLIER_BUDGET: usize = 1_500;
const EARLIER_PIECES: usize = 10;
/// The newest answer, cut in the middle past this; older answers are cut to their opening.
const NEWEST_ANSWER_CHARS: usize = 8_000;
const OLDER_ANSWER_CHARS: usize = 600;
/// How far back the section looks for entries before the budget decides.
const LOOKBACK: i64 = 40;

/// How a chat message was routed, decided by the daemon the moment it arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    /// `@team`: the whole team started on it.
    Team,
    /// `@<agent>` while it was idle: a one-agent turn.
    Agent,
    /// To an agent at work: queued for its next turn in the run it was working in.
    Note,
    /// No @ and nobody working: it starts nothing and is read as conversation next time.
    TeamNote,
}

impl Route {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Team => "team",
            Self::Agent => "agent",
            Self::Note => "note",
            Self::TeamNote => "team_note",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "team" => Self::Team,
            "agent" => Self::Agent,
            "note" => Self::Note,
            _ => Self::TeamNote,
        }
    }
}

/// One thing the operator typed into a team's chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub team_key: String,
    pub team_path: String,
    pub text: String,
    pub created_at: String,
    pub route: Route,
    /// The run it started, or the run it joined as a note.
    pub run_id: Option<String>,
    /// The agent it was addressed to, for a one-agent turn or a note.
    pub agent_id: Option<String>,
    /// When the agent's next turn took this note.
    pub delivered_at: Option<String>,
    /// "Send now": the note asked to stop the agent's turn rather than wait for it.
    pub now: bool,
}

/// `chat_messages`, on the archive's pool.
#[derive(Clone)]
pub struct ChatStore {
    pool: PgPool,
}

impl ChatStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// # Errors
    ///
    /// Returns an error when Postgres fails.
    pub async fn insert(&self, message: &ChatMessage) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO chat_messages
             (id, team_key, team_path, text, created_at, route, run_id, agent_id, delivered_at, now)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(&message.id)
        .bind(&message.team_key)
        .bind(&message.team_path)
        .bind(&message.text)
        .bind(&message.created_at)
        .bind(message.route.as_str())
        .bind(&message.run_id)
        .bind(&message.agent_id)
        .bind(&message.delivered_at)
        .bind(message.now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Stamp notes as taken by their agent's turn. A failure is logged, never raised: the note is
    /// already in the run's archive, which is the record that matters.
    pub async fn mark_delivered(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        if let Err(error) = sqlx::query(
            "UPDATE chat_messages SET delivered_at = $2 WHERE id = ANY($1) AND delivered_at IS NULL",
        )
        .bind(ids)
        .bind(now())
        .execute(&self.pool)
        .await
        {
            eprintln!("loomwatchd: could not mark chat notes delivered: {error}");
        }
    }

    /// # Errors
    ///
    /// Returns an error when Postgres fails.
    pub async fn get(&self, id: &str) -> Result<Option<ChatMessage>, sqlx::Error> {
        let row = sqlx::query("SELECT * FROM chat_messages WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(decode_message).transpose()
    }

    /// Turn a team note into the request of the run it started ("Start the team on this"). `false`
    /// when it is not a team note any more: it already started something.
    async fn claim_team_note(&self, id: &str) -> Result<bool, sqlx::Error> {
        let claimed = sqlx::query(
            "UPDATE chat_messages SET route = 'team'
             WHERE id = $1 AND route = 'team_note' AND run_id IS NULL",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(claimed.rows_affected() == 1)
    }

    async fn set_run(&self, id: &str, run_id: Option<&str>) -> Result<(), sqlx::Error> {
        let route = if run_id.is_some() {
            "team"
        } else {
            "team_note"
        };
        sqlx::query("UPDATE chat_messages SET route = $2, run_id = $3 WHERE id = $1")
            .bind(id)
            .bind(route)
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Team notes before `before`, newest first.
    async fn team_notes(
        &self,
        team: &TeamRef,
        before: Option<&str>,
        search: Option<&str>,
        limit: i64,
    ) -> Result<Vec<ChatMessage>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT * FROM chat_messages
             WHERE (team_key = $1 OR team_path = $2) AND route = 'team_note'
               AND ($3::TEXT IS NULL OR created_at < $3)
               AND ($5::TEXT IS NULL OR text ILIKE $5 ESCAPE '\\')
             ORDER BY created_at DESC, id DESC LIMIT $4",
        )
        .bind(&team.key)
        .bind(&team.path)
        .bind(before)
        .bind(limit)
        .bind(search)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_message).collect()
    }

    /// Every note and team note before `before`, newest first: what the conversation reads.
    async fn notes(
        &self,
        team: &TeamRef,
        before: &str,
        limit: i64,
    ) -> Result<Vec<ChatMessage>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT * FROM chat_messages
             WHERE (team_key = $1 OR team_path = $2) AND route IN ('note', 'team_note')
               AND created_at < $3
             ORDER BY created_at DESC, id DESC LIMIT $4",
        )
        .bind(&team.key)
        .bind(&team.path)
        .bind(before)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_message).collect()
    }

    /// The messages that started or joined these runs.
    async fn of_runs(&self, run_ids: &[String]) -> Result<Vec<ChatMessage>, sqlx::Error> {
        if run_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            "SELECT * FROM chat_messages WHERE run_id = ANY($1) ORDER BY created_at ASC, id ASC",
        )
        .bind(run_ids)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_message).collect()
    }

    /// This team's runs created before `before`, newest first.
    async fn runs(
        &self,
        team: &TeamRef,
        before: Option<&str>,
        search: Option<&str>,
        limit: i64,
    ) -> Result<Vec<RunRecord>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT * FROM runs
             WHERE (team_key = $1 OR team_key = 'path:' || $2 OR (team_key IS NULL AND team_path = $2))
               AND ($3::TEXT IS NULL OR created_at < $3)
               AND ($5::TEXT IS NULL OR prompt ILIKE $5 ESCAPE '\\' OR reply ILIKE $5 ESCAPE '\\'
                    OR run_id IN (SELECT run_id FROM chat_messages
                                  WHERE run_id IS NOT NULL AND text ILIKE $5 ESCAPE '\\'))
             ORDER BY created_at DESC, run_id DESC LIMIT $4",
        )
        .bind(&team.key)
        .bind(&team.path)
        .bind(before)
        .bind(limit)
        .bind(search)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| runs::decode_run(row).map(|stored| stored.record))
            .collect()
    }

    /// One run of this team by the start of its id, as the conversation shows it.
    async fn run_by_prefix(
        &self,
        team: &TeamRef,
        prefix: &str,
    ) -> Result<Vec<RunRecord>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT * FROM runs
             WHERE (team_key = $1 OR team_key = 'path:' || $2 OR (team_key IS NULL AND team_path = $2))
               AND run_id LIKE $3 || '%'
             ORDER BY created_at DESC LIMIT 2",
        )
        .bind(&team.key)
        .bind(&team.path)
        .bind(prefix)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| runs::decode_run(row).map(|stored| stored.record))
            .collect()
    }

    /// The operator's answers to review stops and questions in these runs, with what was asked.
    async fn decisions(&self, run_ids: &[String]) -> Result<Vec<Decision>, sqlx::Error> {
        if run_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            "SELECT q.run_id, q.agent_id, q.question, q.answered_at, e.payload, e.raw
             FROM operator_questions q
             JOIN run_events e ON e.id = q.answer_event_id
             WHERE q.run_id = ANY($1) AND q.answered_at IS NOT NULL",
        )
        .bind(run_ids)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                let payload: Value = row.try_get("payload")?;
                let raw: Option<Value> = row.try_get("raw")?;
                Ok(Decision {
                    run_id: row.try_get("run_id")?,
                    asked_of: row.try_get("agent_id")?,
                    question: row.try_get("question")?,
                    at: row.try_get("answered_at")?,
                    answer: payload["content"]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    sent_back_to: raw
                        .as_ref()
                        .and_then(|raw| raw["sendBack"].as_str())
                        .map(str::to_owned),
                })
            })
            .collect()
    }
}

fn decode_message(row: &sqlx::postgres::PgRow) -> Result<ChatMessage, sqlx::Error> {
    let route: String = row.try_get("route")?;
    Ok(ChatMessage {
        id: row.try_get("id")?,
        team_key: row.try_get("team_key")?,
        team_path: row.try_get("team_path")?,
        text: row.try_get("text")?,
        created_at: row.try_get("created_at")?,
        route: Route::parse(&route),
        run_id: row.try_get("run_id")?,
        agent_id: row.try_get("agent_id")?,
        delivered_at: row.try_get("delivered_at")?,
        now: row.try_get("now")?,
    })
}

/// An answer the operator gave inside a run.
#[derive(Debug, Clone)]
struct Decision {
    run_id: String,
    /// The review stop, or the agent that asked.
    asked_of: String,
    question: String,
    at: String,
    answer: String,
    sent_back_to: Option<String>,
}

/// One team, as its chat is filed: by key, with the path as the fallback for older rows.
#[derive(Debug, Clone)]
struct TeamRef {
    key: String,
    path: String,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------------------------
// The conversation section
// ---------------------------------------------------------------------------------------------

/// `## Conversation so far` for the run `run_id` is about to start (ADR 0051).
///
/// Read from the team's chat as it stood when the run was created: its earlier pieces of work
/// (request, answer, the operator's decisions inside them) and the operator's notes. `None` when
/// the team has no history, or when nothing durable is configured to read it from. A failure to
/// read it is logged and the run goes on without it: a missing section costs context, a refused
/// run costs the work.
pub(crate) async fn conversation(
    registry: &RunRegistry,
    archive: &EventArchive,
    team_path: &Path,
    run_id: &str,
) -> Option<String> {
    let _ = archive;
    let record = registry.get(run_id)?;
    let store = registry.chat_store()?;
    let team = TeamConfig::load(team_path).ok()?;
    let team_ref = TeamRef {
        key: record.team_key.clone(),
        path: record.team_path.clone(),
    };
    match gather(&store, registry, &team_ref, &record).await {
        Ok(history) => render(&team, &history, &record),
        Err(error) => {
            eprintln!("loomwatchd: could not read the team's chat for run {run_id}: {error}");
            None
        }
    }
}

/// What the conversation is made from, newest first.
struct History {
    runs: Vec<RunRecord>,
    notes: Vec<ChatMessage>,
    decisions: Vec<Decision>,
}

async fn gather(
    store: &ChatStore,
    registry: &RunRegistry,
    team: &TeamRef,
    record: &RunRecord,
) -> Result<History, sqlx::Error> {
    let runs = store
        .runs(team, Some(&record.created_at), None, LOOKBACK)
        .await?
        .into_iter()
        .filter(|run| run.run_id != record.run_id)
        // The registry's copy is the authority for a run it still holds.
        .map(|run| registry.get(&run.run_id).unwrap_or(run))
        .collect::<Vec<_>>();
    let notes = store
        .notes(team, &record.created_at, LOOKBACK)
        .await?
        .into_iter()
        .filter(|note| note.run_id.as_deref() != Some(&record.run_id))
        .collect();
    let ids = runs
        .iter()
        .map(|run| run.run_id.clone())
        .collect::<Vec<_>>();
    let decisions = store.decisions(&ids).await?;
    Ok(History {
        runs,
        notes,
        decisions,
    })
}

/// One entry of the section: when it happened, and what to say about it.
struct Entry {
    at: String,
    run_id: Option<String>,
    kind: EntryKind,
}

enum EntryKind {
    Request {
        by: String,
        to: String,
        text: String,
    },
    Answer {
        by: String,
        text: String,
    },
    Stopped {
        why: String,
    },
    Note {
        to: Option<String>,
        text: String,
    },
    Decision {
        line: String,
    },
}

/// Every entry the section could hold, newest first.
fn entries(team: &TeamConfig, history: &History) -> Vec<Entry> {
    let name = |id: &str| {
        team.agents
            .iter()
            .find(|agent| agent.id == id)
            .map_or_else(|| id.to_owned(), |agent| display(&agent.name, id))
    };
    let mut entries = Vec::new();
    for run in &history.runs {
        let (by, to) = match (run.trigger, run.only_agent.as_deref()) {
            (RunTrigger::Schedule, _) => ("The schedule".to_owned(), "the team".to_owned()),
            (RunTrigger::Manual, Some(only)) => ("You".to_owned(), name(only)),
            (RunTrigger::Manual, None) => ("You".to_owned(), "the team".to_owned()),
        };
        let continued = run.follows_run_id.is_some()
            && run.only_agent.is_none()
            && run.start_at.is_some()
            && history.runs.iter().any(|other| {
                Some(&other.run_id) == run.follows_run_id.as_ref() && other.only_agent.is_some()
            });
        entries.push(Entry {
            at: run.created_at.clone(),
            run_id: Some(run.run_id.clone()),
            kind: if continued {
                EntryKind::Decision {
                    line: format!(
                        "You pressed Continue with the team, from {}.",
                        name(run.start_at.as_deref().unwrap_or_default())
                    ),
                }
            } else {
                EntryKind::Request {
                    by,
                    to,
                    text: run.prompt.clone(),
                }
            },
        });
        let finished = run
            .finished_at
            .clone()
            .unwrap_or_else(|| run.created_at.clone());
        match run.status {
            RunStatus::Succeeded => entries.push(Entry {
                at: finished,
                run_id: Some(run.run_id.clone()),
                kind: EntryKind::Answer {
                    by: name(&run.responder),
                    text: run.reply.clone().unwrap_or_default(),
                },
            }),
            RunStatus::Failed | RunStatus::Cancelled => entries.push(Entry {
                at: finished,
                run_id: Some(run.run_id.clone()),
                kind: EntryKind::Stopped {
                    why: if run.status == RunStatus::Cancelled {
                        "you stopped it".to_owned()
                    } else {
                        run.error
                            .as_deref()
                            .and_then(|error| error.lines().next())
                            .unwrap_or("it failed")
                            .to_owned()
                    },
                },
            }),
            // Still running beside this one: its answer is not in yet.
            RunStatus::Queued | RunStatus::Starting | RunStatus::Running => {}
        }
    }
    for note in &history.notes {
        entries.push(Entry {
            at: note.created_at.clone(),
            run_id: None,
            kind: EntryKind::Note {
                to: note.agent_id.as_deref().map(name),
                text: note.text.clone(),
            },
        });
    }
    entries.extend(
        history
            .decisions
            .iter()
            .map(|decision| decision_entry(team, decision)),
    );
    // Newest first, with a stable order for entries stamped the same millisecond.
    entries.sort_by(|left, right| right.at.cmp(&left.at));
    entries
}

/// An answer the operator gave inside a run, said the way they gave it.
fn decision_entry(team: &TeamConfig, decision: &Decision) -> Entry {
    let name = |id: &str| {
        team.agents
            .iter()
            .find(|agent| agent.id == id)
            .map_or_else(|| id.to_owned(), |agent| display(&agent.name, id))
    };
    let stop = team
        .agents
        .iter()
        .any(|agent| agent.id == decision.asked_of && agent.is_operator());
    let line = match (&decision.sent_back_to, stop) {
        (Some(to), _) => format!(
            "You sent the work back to {}: {}",
            name(to),
            decision.answer
        ),
        (None, true) => format!("You, at the review step: {}", decision.answer),
        (None, false) => format!(
            "{} asked you: {}\nYou answered: {}",
            name(&decision.asked_of),
            decision.question,
            decision.answer
        ),
    };
    Entry {
        at: decision.at.clone(),
        run_id: Some(decision.run_id.clone()),
        kind: EntryKind::Decision { line },
    }
}

fn render(team: &TeamConfig, history: &History, record: &RunRecord) -> Option<String> {
    let entries = entries(team, history);
    if entries.is_empty() {
        return None;
    }
    let (mut detailed, cutoff) = detail(&entries, record.follows_run_id.as_deref());
    let mut earlier = earlier(&entries, cutoff);
    let mut section = String::new();
    if !earlier.is_empty() {
        earlier.reverse();
        section.push_str("Earlier work, one line each. Read any of it in full with the Team Bus `earlier_work` tool and its work id.\n");
        section.push_str(&earlier.join("\n"));
        section.push_str("\n\n");
    }
    detailed.reverse();
    section.push_str(&detailed.join("\n\n"));
    Some(section)
}

/// The newest entries in full, within the detail budget, and where they stopped.
///
/// The followed run's answer is already in `## Previous output`, so it is pointed to rather than
/// repeated: saying it twice would spend the budget on a copy.
fn detail(entries: &[Entry], followed: Option<&str>) -> (Vec<String>, usize) {
    let mut newest_answer_done = false;
    let mut detailed = Vec::new();
    let mut used = 0;
    let mut cutoff = entries.len();
    for (index, entry) in entries.iter().enumerate() {
        let text = match &entry.kind {
            EntryKind::Answer { by, text } => {
                let short = short_id(entry.run_id.as_deref().unwrap_or_default());
                if entry.run_id.as_deref() == followed {
                    newest_answer_done = true;
                    format!("{by} answered (work {short}); the answer is under Previous output.")
                } else if newest_answer_done {
                    format!(
                        "{by} answered (work {short}):\n{}",
                        opening(text, OLDER_ANSWER_CHARS, short)
                    )
                } else {
                    newest_answer_done = true;
                    format!(
                        "{by} answered (work {short}):\n{}",
                        crate::cap_middle_text(text, NEWEST_ANSWER_CHARS)
                    )
                }
            }
            EntryKind::Request { by, to, text } => format!("{by} to {to}: {}", text.trim()),
            EntryKind::Stopped { why } => format!(
                "The work stopped (work {}): {why}",
                short_id(entry.run_id.as_deref().unwrap_or_default())
            ),
            EntryKind::Note { to: Some(to), text } => {
                format!("You, in a note to {to} while it worked: {}", text.trim())
            }
            EntryKind::Note { to: None, text } => {
                format!("You, in a note to the team: {}", text.trim())
            }
            EntryKind::Decision { line } => line.clone(),
        };
        let block = format!("[{}] {text}", when(&entry.at));
        let size = block.chars().count() + 2;
        if index >= DETAIL_ENTRIES || (used + size > DETAIL_BUDGET && !detailed.is_empty()) {
            cutoff = index;
            break;
        }
        used += size;
        detailed.push(block);
    }

    (detailed, cutoff)
}

/// Older pieces: one line each, by the request that started them, newest first until the smaller
/// budget runs out.
fn earlier(entries: &[Entry], cutoff: usize) -> Vec<String> {
    let mut earlier = Vec::new();
    let mut earlier_used = 0;
    let shown: BTreeSet<&str> = entries[..cutoff]
        .iter()
        .filter_map(|entry| entry.run_id.as_deref())
        .collect();
    let mut listed = BTreeSet::new();
    for entry in &entries[cutoff..] {
        let (Some(run_id), EntryKind::Request { text, .. }) =
            (entry.run_id.as_deref(), &entry.kind)
        else {
            continue;
        };
        if shown.contains(run_id) || !listed.insert(run_id) || earlier.len() >= EARLIER_PIECES {
            continue;
        }
        let line = format!(
            "- [{}] work {}: {}",
            when(&entry.at),
            short_id(run_id),
            first_line(text, 100)
        );
        if earlier_used + line.chars().count() > EARLIER_BUDGET {
            break;
        }
        earlier_used += line.chars().count() + 1;
        earlier.push(line);
    }

    earlier
}

fn display(name: &str, id: &str) -> String {
    if name.trim().is_empty() {
        id.to_owned()
    } else {
        name.trim().to_owned()
    }
}

/// The first eight characters of a run id: what the conversation and `earlier_work` call it.
fn short_id(run_id: &str) -> &str {
    run_id.get(..8).unwrap_or(run_id)
}

/// A timestamp as the operator reads it in their chat: local time, minutes.
fn when(at: &str) -> String {
    DateTime::parse_from_rfc3339(at).map_or_else(
        |_| at.to_owned(),
        |time| {
            time.with_timezone(&Local)
                .format("%a %-d %b %H:%M")
                .to_string()
        },
    )
}

fn opening(text: &str, chars: usize, short: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= chars {
        return text.to_owned();
    }
    let head: String = text.chars().take(chars).collect();
    format!("{head} … [cut; the whole answer is work {short}]")
}

fn first_line(text: &str, chars: usize) -> String {
    let line = text.trim().lines().next().unwrap_or_default();
    if line.chars().count() <= chars {
        line.to_owned()
    } else {
        format!("{}…", line.chars().take(chars).collect::<String>())
    }
}

/// `earlier_work`: one earlier piece of this team's work in full (ADR 0051), for an agent that
/// needs more of it than the conversation's one line. Scoped to the team of the run asking.
///
/// # Errors
///
/// A message the agent can act on when nothing, or more than one piece, matches.
pub(crate) async fn earlier_work(
    registry: &RunRegistry,
    asking_run: &str,
    work: &str,
) -> anyhow::Result<Value> {
    let work = work.trim();
    anyhow::ensure!(
        work.len() >= 4 && work.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
        "work ids look like 3f2a9c1e: use one from `## Conversation so far`"
    );
    let asking = registry
        .get(asking_run)
        .ok_or_else(|| anyhow::anyhow!("this run's record is not available"))?;
    let team = TeamRef {
        key: asking.team_key.clone(),
        path: asking.team_path.clone(),
    };
    let mut found: Vec<RunRecord> = registry
        .list()
        .into_iter()
        .filter(|run| {
            run.run_id.starts_with(work) && (run.team_key == team.key || run.team_path == team.path)
        })
        .collect();
    if found.is_empty()
        && let Some(store) = registry.chat_store()
    {
        found = store.run_by_prefix(&team, work).await?;
    }
    match found.as_slice() {
        [] => anyhow::bail!("no work {work} in this team's chat"),
        [run] => Ok(json!({
            "work": short_id(&run.run_id),
            "asked": run.prompt,
            "askedAt": run.created_at,
            "status": run.status,
            "answer": run.reply.as_deref().map(|reply| crate::cap_middle_text(reply, 24_000)),
            "error": run.error,
        })),
        _ => anyhow::bail!("more than one piece of work starts with {work}: give more of its id"),
    }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
struct ChatState {
    archive: Option<EventArchive>,
    teams_root: PathBuf,
    registry: RunRegistry,
}

/// The chat's routes. Loopback-only and never cached, like run control.
pub fn router(archive: Option<EventArchive>, teams_root: PathBuf, registry: RunRegistry) -> Router {
    let teams_root = std::fs::canonicalize(&teams_root).unwrap_or(teams_root);
    Router::new()
        .route("/api/chat", get(chat_page))
        .route("/api/chat/messages", post(send_message))
        .route("/api/chat/messages/{id}/start", post(start_from_note))
        .route("/api/chat/continue", post(continue_team))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(ChatState {
            archive,
            teams_root,
            registry,
        })
}

/// A team file the chat may act on: its normalised path and its parsed config.
fn open_team(teams_root: &Path, team_path: &str) -> Result<(String, TeamConfig), ApiError> {
    let resolved = resolve_existing_team_path(teams_root, Path::new(team_path))?;
    let relative = normalized_relative_path(teams_root, &resolved).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("team path {team_path} is not a UTF-8 path below the teams root"),
        )
    })?;
    let team = TeamConfig::load(&resolved)
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}")))?;
    Ok((relative, team))
}

/// `words` as an `ILIKE` pattern that matches them anywhere, with `%`, `_` and `\` taken literally.
fn like_pattern(words: &str) -> String {
    let escaped = words
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn no_store() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        crate::watch_api::ARCHIVE_DISABLED_MESSAGE.to_owned(),
    )
}

fn database(error: &sqlx::Error) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("could not read the team's chat: {error}"),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageQuery {
    team_path: String,
    /// Only items created before this instant: the `createdAt` of the oldest item already shown.
    before: Option<String>,
    limit: Option<i64>,
    /// Only work and notes whose words contain this: search within the team's chat.
    #[serde(default)]
    q: Option<String>,
}

/// One item of a chat page, newest first.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum Item {
    /// A piece of work: a run, the message that started it (absent for a run started any other
    /// way), and the notes the operator sent into it.
    Work {
        run: Box<RunRecord>,
        request: Option<ChatMessage>,
        notes: Vec<ChatMessage>,
    },
    /// A team note.
    Note { message: ChatMessage },
}

impl Item {
    fn at(&self) -> &str {
        match self {
            Self::Work { run, .. } => &run.created_at,
            Self::Note { message } => &message.created_at,
        }
    }
}

/// `GET /api/chat?teamPath=…&before=…&limit=…`: one page of a team's chat, newest first.
async fn chat_page(
    State(state): State<ChatState>,
    Query(query): Query<PageQuery>,
) -> Result<Response, ApiError> {
    let (relative, team) = open_team(&state.teams_root, &query.team_path)?;
    let team_ref = TeamRef {
        key: team.chat_key(&relative),
        path: relative.clone(),
    };
    let limit = query.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let before = query.before.as_deref().filter(|value| !value.is_empty());
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(like_pattern);
    let Some(store) = state.registry.chat_store() else {
        return Err(no_store());
    };
    let runs = store
        .runs(&team_ref, before, search.as_deref(), limit + 1)
        .await
        .map_err(|error| database(&error))?;
    let notes = store
        .team_notes(&team_ref, before, search.as_deref(), limit + 1)
        .await
        .map_err(|error| database(&error))?;
    let ids = runs
        .iter()
        .map(|run| run.run_id.clone())
        .collect::<Vec<_>>();
    let mut joined: BTreeMap<String, Vec<ChatMessage>> = BTreeMap::new();
    for message in store
        .of_runs(&ids)
        .await
        .map_err(|error| database(&error))?
    {
        if let Some(run_id) = message.run_id.clone() {
            joined.entry(run_id).or_default().push(message);
        }
    }
    let mut items: Vec<Item> = runs
        .into_iter()
        .map(|stored| {
            // The registry's copy carries what only a live run has: who is working, what waits.
            let run = state.registry.get(&stored.run_id).unwrap_or(stored);
            let messages = joined.remove(&run.run_id).unwrap_or_default();
            let (requests, notes): (Vec<ChatMessage>, Vec<ChatMessage>) = messages
                .into_iter()
                .partition(|message| matches!(message.route, Route::Team | Route::Agent));
            Item::Work {
                run: Box::new(run),
                request: requests.into_iter().next(),
                notes,
            }
        })
        .chain(notes.into_iter().map(|message| Item::Note { message }))
        .collect();
    items.sort_by(|left, right| right.at().cmp(left.at()));
    let limit = usize::try_from(limit).unwrap_or(20);
    let more = items.len() > limit;
    items.truncate(limit);
    Ok(Json(json!({
        "teamKey": team_ref.key,
        "teamPath": relative,
        "items": items,
        "more": more,
    }))
    .into_response())
}

/// Who a message is addressed to, as the message box showed it before it was sent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum Target {
    Team,
    Agent { agent: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessage {
    team_path: String,
    text: String,
    /// `None`: no @ in the message.
    #[serde(default)]
    to: Option<Target>,
    /// "Send now": a note that stops the agent's turn rather than waiting for it.
    #[serde(default)]
    now: bool,
    #[serde(default)]
    expected_revision: Option<String>,
    #[serde(default)]
    start_key: Option<String>,
}

/// Where a message goes, decided from who it is addressed to and who is working right now.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Decided {
    Team,
    Agent(String),
    Note { run_id: String, agent: String },
    TeamNote,
}

/// The routing rule (ADR 0051), on its own so it can be tested without a daemon.
///
/// `live` is the team's unfinished runs, newest first. "The agent at work" is the one that most
/// recently began a turn in the newest run that has one working.
fn decide(to: Option<&Target>, live: &[RunRecord]) -> Decided {
    match to {
        Some(Target::Team) => Decided::Team,
        Some(Target::Agent { agent }) => live
            .iter()
            .find(|run| run.working.iter().any(|id| id == agent))
            .map_or_else(
                || Decided::Agent(agent.clone()),
                |run| Decided::Note {
                    run_id: run.run_id.clone(),
                    agent: agent.clone(),
                },
            ),
        None => live
            .iter()
            .find_map(|run| run.working.last().map(|agent| (run, agent)))
            .map_or(Decided::TeamNote, |(run, agent)| Decided::Note {
                run_id: run.run_id.clone(),
                agent: agent.clone(),
            }),
    }
}

/// Refuse a message the rule cannot route: empty, oversized, or addressed to someone who is not an
/// agent of this team.
fn check_message(text: &str, to: Option<&Target>, team: &TeamConfig) -> Result<(), ApiError> {
    let bad = |message: String| Err(ApiError::new(StatusCode::BAD_REQUEST, message));
    if text.is_empty() {
        return bad("A message needs some words.".to_owned());
    }
    if text.len() > MAX_MESSAGE_BYTES {
        return bad(format!(
            "A message can be at most {MAX_MESSAGE_BYTES} bytes."
        ));
    }
    if let Some(Target::Agent { agent }) = to {
        match team.agents.iter().find(|candidate| &candidate.id == agent) {
            None => return bad(format!("{agent} is not an agent of this team.")),
            Some(found) if found.is_operator() => {
                return bad(format!("{} is a review step, which is you.", found.name));
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// `POST /api/chat/messages`: route one message by the rule, and do what the route says.
async fn send_message(
    State(state): State<ChatState>,
    body: Result<Json<SendMessage>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid message: {}", rejection.body_text()),
        )
    })?;
    let text = request.text.trim();
    let (relative, team) = open_team(&state.teams_root, &request.team_path)?;
    check_message(text, request.to.as_ref(), &team)?;
    let store = state.registry.chat_store().ok_or_else(no_store)?;
    let key = team.chat_key(&relative);
    let live = state.registry.live_runs_of(&key, &relative);
    let mut message = ChatMessage {
        id: Uuid::new_v4().to_string(),
        team_key: key,
        team_path: relative.clone(),
        text: text.to_owned(),
        created_at: now(),
        route: Route::TeamNote,
        run_id: None,
        agent_id: None,
        delivered_at: None,
        now: false,
    };
    let mut decided = decide(request.to.as_ref(), &live);
    if let Decided::Note { run_id, agent } = &decided {
        let note = QueuedNote {
            id: message.id.clone(),
            agent: agent.clone(),
            text: text.to_owned(),
            sent_at: message.created_at.clone(),
            now: request.now,
        };
        match state.registry.queue_note(run_id, note) {
            Ok(record) => {
                message.route = Route::Note;
                message.run_id = Some(run_id.clone());
                message.agent_id = Some(agent.clone());
                message.now = request.now;
                store
                    .insert(&message)
                    .await
                    .map_err(|error| database(&error))?;
                return Ok(
                    Json(json!({"route": "note", "message": message, "run": record}))
                        .into_response(),
                );
            }
            // The agent finished between the box's label and the send: route again without it,
            // so an @agent message still reaches that agent and a plain one becomes a team note.
            Err(_) => {
                decided = match request.to.as_ref() {
                    Some(Target::Agent { agent }) => Decided::Agent(agent.clone()),
                    _ => Decided::TeamNote,
                };
            }
        }
    }
    match decided {
        Decided::TeamNote | Decided::Note { .. } => {
            store
                .insert(&message)
                .await
                .map_err(|error| database(&error))?;
            Ok(Json(json!({"route": "team_note", "message": message})).into_response())
        }
        Decided::Team | Decided::Agent(_) => {
            let mut start = StartRunRequest::from_chat(
                &relative,
                task_text(text, &team),
                request.expected_revision.clone(),
                request.start_key.clone(),
            );
            if let Decided::Agent(agent) = &decided {
                start = start.only(agent);
                message.route = Route::Agent;
                message.agent_id = Some(agent.clone());
            } else {
                message.route = Route::Team;
            }
            let outcome = runs::launch_manual(
                &state.registry,
                state.archive.clone(),
                &state.teams_root,
                &start,
            )
            .await;
            started(&state.registry, &store, message, outcome).await
        }
    }
}

/// The request a message hands the agents: without the @mention that addressed it, when that is
/// how it starts. "@team" and "@Writer" are the chat's routing words, not part of the job; the
/// chat keeps the message as typed.
fn task_text<'a>(text: &'a str, team: &TeamConfig) -> &'a str {
    let Some(rest) = text.strip_prefix('@') else {
        return text;
    };
    let mut words: Vec<&str> = std::iter::once("team")
        .chain(
            team.agents
                .iter()
                .filter(|agent| !agent.is_operator())
                .flat_map(|agent| [agent.name.trim(), agent.id.as_str()]),
        )
        .filter(|word| !word.is_empty())
        .collect();
    words.sort_by_key(|word| std::cmp::Reverse(word.len()));
    for word in words {
        let Some(head) = rest.get(..word.len()) else {
            continue;
        };
        let after = &rest[word.len()..];
        if head.to_lowercase() == word.to_lowercase()
            && after
                .chars()
                .next()
                .is_none_or(|next| next.is_whitespace() || next == ',' || next == ':')
        {
            let task = after.trim_start_matches([',', ':']).trim();
            return if task.is_empty() { text } else { task };
        }
    }
    text
}

/// Answer a message that started a run: record it against the run, or answer exactly as
/// `POST /api/runs` would have when the run did not start.
async fn started(
    registry: &RunRegistry,
    store: &ChatStore,
    mut message: ChatMessage,
    outcome: Result<StartRunOutcome, LaunchError>,
) -> Result<Response, ApiError> {
    let record = match &outcome {
        Ok(StartRunOutcome::Accepted(record) | StartRunOutcome::Duplicate(record)) => {
            record.clone()
        }
        _ => return runs::start_response(registry, outcome).await,
    };
    if matches!(outcome, Ok(StartRunOutcome::Accepted(_))) {
        registry.persist_quietly(&record.run_id).await;
        message.run_id = Some(record.run_id.clone());
        store
            .insert(&message)
            .await
            .map_err(|error| database(&error))?;
    } else if let Some(existing) = store
        .of_runs(std::slice::from_ref(&record.run_id))
        .await
        .map_err(|error| database(&error))?
        .into_iter()
        .find(|existing| matches!(existing.route, Route::Team | Route::Agent))
    {
        message = existing;
    }
    let route = message.route.as_str();
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"route": route, "message": message, "run": record})),
    )
        .into_response())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartNote {
    #[serde(default)]
    expected_revision: Option<String>,
}

/// `POST /api/chat/messages/{id}/start`: "Start the team on this" on a team note. The note
/// becomes the request of the run it starts, so a message sent without its @ never dead-ends.
async fn start_from_note(
    State(state): State<ChatState>,
    RoutePath(id): RoutePath<String>,
    body: Option<Json<StartNote>>,
) -> Result<Response, ApiError> {
    let store = state.registry.chat_store().ok_or_else(no_store)?;
    let message = store
        .get(&id)
        .await
        .map_err(|error| database(&error))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "That message is gone.".to_owned()))?;
    // Claimed before the run starts, so the conversation the run is handed does not also carry
    // this note as a note.
    if !store
        .claim_team_note(&id)
        .await
        .map_err(|error| database(&error))?
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "That note already started work.".to_owned(),
        ));
    }
    let expected = body.and_then(|Json(body)| body.expected_revision);
    let start = StartRunRequest::from_chat(&message.team_path, &message.text, expected, None);
    let outcome = runs::launch_manual(
        &state.registry,
        state.archive.clone(),
        &state.teams_root,
        &start,
    )
    .await;
    let run_id = match &outcome {
        Ok(StartRunOutcome::Accepted(record) | StartRunOutcome::Duplicate(record)) => {
            Some(record.run_id.clone())
        }
        _ => None,
    };
    store
        .set_run(&id, run_id.as_deref())
        .await
        .map_err(|error| database(&error))?;
    let Some(run_id) = run_id else {
        return runs::start_response(&state.registry, outcome).await;
    };
    state.registry.persist_quietly(&run_id).await;
    let record = state.registry.get(&run_id);
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "route": "team",
            "message": ChatMessage { route: Route::Team, run_id: Some(run_id), ..message },
            "run": record,
        })),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContinueRequest {
    run_id: String,
    #[serde(default)]
    expected_revision: Option<String>,
}

/// `POST /api/chat/continue`: "Continue with the team" under a one-agent turn's new version.
///
/// The team picks up after that agent, from its new handover. A review step straight after it is
/// passed — pressing the button was the review — and the request is the one the agent's earlier
/// work was answering, so the stages after it do the job they were doing.
async fn continue_team(
    State(state): State<ChatState>,
    body: Result<Json<ContinueRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid request: {}", rejection.body_text()),
        )
    })?;
    let bad = |message: &str| ApiError::new(StatusCode::BAD_REQUEST, message.to_owned());
    let turn = state.registry.get(&request.run_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "That work is not available.".to_owned(),
        )
    })?;
    let Some(only) = turn.only_agent.clone() else {
        return Err(bad("Continue is for work one agent did on its own."));
    };
    if turn.status != RunStatus::Succeeded {
        return Err(bad(
            "That turn did not finish, so there is nothing to continue from.",
        ));
    }
    let (_, team) = open_team(&state.teams_root, &turn.team_path)?;
    let order = team
        .pipeline_order()
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}")))?;
    let at = order
        .iter()
        .position(|stage| *stage == only)
        .ok_or_else(|| bad("That agent is no longer a step of this team."))?;
    let is_stop = |id: &str| {
        team.agents
            .iter()
            .any(|agent| agent.id == id && agent.is_operator())
    };
    let mut next = at + 1;
    if order.get(next).is_some_and(|id| is_stop(id)) {
        next += 1;
    }
    let Some(start_at) = order.get(next) else {
        return Err(bad(
            "Nothing comes after this step: its version is the team's answer.",
        ));
    };
    // The request the agent's earlier work was answering; the @message itself is in the
    // conversation every stage is handed.
    let prompt = turn
        .follows_run_id
        .as_deref()
        .and_then(|id| state.registry.get(id))
        .map_or_else(|| turn.prompt.clone(), |root| root.prompt);
    let start =
        StartRunRequest::from_chat(&turn.team_path, &prompt, request.expected_revision, None)
            .continuing(&turn.run_id, start_at);
    let outcome = runs::launch_manual(
        &state.registry,
        state.archive.clone(),
        &state.teams_root,
        &start,
    )
    .await;
    match outcome {
        Ok(StartRunOutcome::Accepted(record) | StartRunOutcome::Duplicate(record)) => {
            state.registry.persist_quietly(&record.run_id).await;
            Ok((
                StatusCode::ACCEPTED,
                Json(json!({"route": "team", "run": record})),
            )
                .into_response())
        }
        other => runs::start_response(&state.registry, other).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(run_id: &str, working: &[&str]) -> RunRecord {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nid: news\nname: News\nentrypoint: a\nagents:\n  - id: a\n    name: A\n    role: r\n    spawn: {cmd: x, cwd: .}\n    model: m\n  - id: b\n    name: B\n    role: r\n    spawn: {cmd: x, cwd: .}\n    model: m\nedges:\n  - {from: a, to: b, layer: configured, kind: sequence, ts: 2026-09-13T00:00:00Z}\n",
        )
        .unwrap();
        let mut record = RunRecord::queued(
            "news.yaml".to_owned(),
            "go".to_owned(),
            &team,
            RunTrigger::Manual,
        )
        .unwrap();
        record.run_id = run_id.to_owned();
        record.status = RunStatus::Running;
        record.working = working.iter().map(|id| (*id).to_owned()).collect();
        record
    }

    #[test]
    fn only_an_at_starts_work_and_anything_else_is_a_note() {
        let idle = [live("r1", &[])];
        let busy = [live("r2", &["b"]), live("r1", &["a"])];
        // @team always starts the whole team, busy or not.
        assert_eq!(decide(Some(&Target::Team), &[]), Decided::Team);
        assert_eq!(decide(Some(&Target::Team), &busy), Decided::Team);
        // @agent: alone when idle, a note for its next turn when it is working.
        let to_b = Target::Agent {
            agent: "b".to_owned(),
        };
        assert_eq!(decide(Some(&to_b), &idle), Decided::Agent("b".to_owned()));
        assert_eq!(
            decide(Some(&to_b), &busy),
            Decided::Note {
                run_id: "r2".to_owned(),
                agent: "b".to_owned()
            }
        );
        // No @: a note to the agent at work in the newest run that has one, else a team note.
        assert_eq!(decide(None, &idle), Decided::TeamNote);
        assert_eq!(decide(None, &[]), Decided::TeamNote);
        assert_eq!(
            decide(None, &busy),
            Decided::Note {
                run_id: "r2".to_owned(),
                agent: "b".to_owned()
            }
        );
    }

    fn team() -> TeamConfig {
        TeamConfig::parse(
            "schemaVersion: 1\nid: news\nname: News desk\nentrypoint: researcher\nagents:\n  - id: researcher\n    name: Researcher\n    role: r\n    spawn: {cmd: x, cwd: .}\n    model: m\n  - id: writer\n    name: Writer\n    role: w\n    spawn: {cmd: x, cwd: .}\n    model: m\nedges:\n  - {from: researcher, to: writer, layer: configured, kind: sequence, ts: 2026-09-13T00:00:00Z}\n",
        )
        .unwrap()
    }

    fn finished(run_id: &str, at: &str, prompt: &str, reply: &str) -> RunRecord {
        let mut record = RunRecord::queued(
            "news.yaml".to_owned(),
            prompt.to_owned(),
            &team(),
            RunTrigger::Manual,
        )
        .unwrap();
        record.run_id = run_id.to_owned();
        record.created_at = at.to_owned();
        record.finished_at = Some(at.replace(":00.000Z", ":30.000Z"));
        record.status = RunStatus::Succeeded;
        record.reply = Some(reply.to_owned());
        record
    }

    fn note(at: &str, text: &str, to: Option<&str>) -> ChatMessage {
        ChatMessage {
            id: format!("n-{at}"),
            team_key: "news".to_owned(),
            team_path: "news.yaml".to_owned(),
            text: text.to_owned(),
            created_at: at.to_owned(),
            route: if to.is_some() {
                Route::Note
            } else {
                Route::TeamNote
            },
            run_id: None,
            agent_id: to.map(str::to_owned),
            delivered_at: None,
            now: false,
        }
    }

    #[test]
    fn the_conversation_is_exact_text_oldest_first_with_the_newest_answer_whole() {
        let now = finished("ffffffff-now", "2026-10-06T03:00:00.000Z", "today", "");
        let older_answer = "A".repeat(2_000);
        let newest_answer = format!("B{}", "b".repeat(1_999));
        let history = History {
            runs: vec![
                finished(
                    "bbbbbbbb-2",
                    "2026-10-05T02:00:00.000Z",
                    "second digest",
                    &newest_answer,
                ),
                finished(
                    "aaaaaaaa-1",
                    "2026-10-04T02:00:00.000Z",
                    "first digest",
                    &older_answer,
                ),
            ],
            notes: vec![note(
                "2026-10-05T05:00:00.000Z",
                "we only cover listed companies",
                None,
            )],
            decisions: Vec::new(),
        };
        let section = render(&team(), &history, &now).unwrap();
        // Same input, same bytes.
        assert_eq!(render(&team(), &history, &now).unwrap(), section);
        // Oldest first.
        let first = section.find("first digest").unwrap();
        let second = section.find("second digest").unwrap();
        let team_note = section.find("we only cover listed companies").unwrap();
        assert!(first < second && second < team_note, "{section}");
        // The newest answer in full; the older one cut to its opening with its work id.
        assert!(section.contains(&newest_answer), "{section}");
        assert!(!section.contains(&older_answer));
        assert!(
            section.contains("[cut; the whole answer is work aaaaaaaa]"),
            "{section}"
        );
        assert!(section.contains("You, in a note to the team: we only cover listed companies"));
        assert!(
            section.contains("Writer answered (work bbbbbbbb)"),
            "{section}"
        );
    }

    #[test]
    fn past_the_budget_older_work_is_one_line_each_and_the_newest_survives() {
        let now = finished("ffffffff-now", "2026-10-06T03:00:00.000Z", "today", "");
        let runs = (0..30)
            .map(|day| {
                finished(
                    &format!("{day:08x}-run"),
                    &format!("2026-09-{:02}T02:00:00.000Z", day + 1),
                    &format!("digest number {day}"),
                    &"x".repeat(1_000),
                )
            })
            .rev()
            .collect();
        let history = History {
            runs,
            notes: Vec::new(),
            decisions: Vec::new(),
        };
        let section = render(&team(), &history, &now).unwrap();
        assert!(
            section.chars().count() <= DETAIL_BUDGET + EARLIER_BUDGET + 200,
            "{}",
            section.len()
        );
        assert!(
            section.contains("digest number 29"),
            "the newest piece must survive"
        );
        assert!(
            section.starts_with("Earlier work, one line each."),
            "{section}"
        );
        assert!(section.contains("earlier_work"));
    }

    #[test]
    fn a_followed_runs_answer_is_pointed_to_not_repeated() {
        let mut now = finished("ffffffff-now", "2026-10-06T03:00:00.000Z", "shorter", "");
        now.follows_run_id = Some("bbbbbbbb-2".to_owned());
        let history = History {
            runs: vec![finished(
                "bbbbbbbb-2",
                "2026-10-05T02:00:00.000Z",
                "digest",
                "THE ANSWER",
            )],
            notes: Vec::new(),
            decisions: Vec::new(),
        };
        let section = render(&team(), &history, &now).unwrap();
        assert!(!section.contains("THE ANSWER"), "{section}");
        assert!(section.contains("the answer is under Previous output"));
    }

    #[test]
    fn decisions_and_notes_to_agents_travel_with_the_results() {
        let now = finished("ffffffff-now", "2026-10-06T03:00:00.000Z", "today", "");
        let history = History {
            runs: vec![finished(
                "bbbbbbbb-2",
                "2026-10-05T02:00:00.000Z",
                "digest",
                "done",
            )],
            notes: vec![note(
                "2026-10-05T02:10:00.000Z",
                "keep it under 300 words",
                Some("writer"),
            )],
            decisions: vec![Decision {
                run_id: "bbbbbbbb-2".to_owned(),
                asked_of: "researcher".to_owned(),
                question: "Which region?".to_owned(),
                at: "2026-10-05T02:05:00.000Z".to_owned(),
                answer: "Asia".to_owned(),
                sent_back_to: None,
            }],
        };
        let section = render(&team(), &history, &now).unwrap();
        assert!(
            section.contains("Researcher asked you: Which region?\nYou answered: Asia"),
            "{section}"
        );
        assert!(
            section.contains("You, in a note to Writer while it worked: keep it under 300 words")
        );
    }

    // -----------------------------------------------------------------------------------------
    // End to end, on a scripted ACP agent
    // -----------------------------------------------------------------------------------------

    use std::time::Duration;

    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt as _;
    use tower::ServiceExt as _;

    use crate::runs::RunStore;
    use crate::runs::tests::TeamsDir;

    /// A fake ACP agent that answers every request for as many turns as it is given, so a test can
    /// drive handovers, checkpoints and notes without scripting each one.
    ///
    /// `gate`: the first work turn waits for this file, which keeps the agent working while the
    /// test sends it a note. `cancellable`: the first work turn waits for `session/cancel` and
    /// ends `cancelled`, which is how an app answers "Send now".
    fn agent_script(name: &str, gate: Option<&Path>, cancellable: bool) -> String {
        let hold = match (gate, cancellable) {
            (Some(gate), _) => format!(
                "if [ \"$work\" = 1 ]; then while [ ! -f '{}' ]; do sleep 0.05; done; fi\n",
                gate.display()
            ),
            (None, true) => "if [ \"$work\" = 1 ] && [ -z \"$held\" ]; then\n  held=1\n  printf '%s\\n' \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"session/update\\\",\\\"params\\\":{\\\"sessionId\\\":\\\"s\\\",\\\"update\\\":{\\\"sessionUpdate\\\":\\\"agent_message_chunk\\\",\\\"content\\\":{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"partial\\\"}}}}\"\n  while IFS= read -r stop; do case \"$stop\" in *session/cancel*) break ;; esac; done\n  printf '%s\\n' \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":$id,\\\"result\\\":{\\\"stopReason\\\":\\\"cancelled\\\"}}\"\n  continue\nfi\n".to_owned(),
            (None, false) => String::new(),
        };
        format!(
            r#"#!/bin/sh
work=0
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^[^{{]*{{[^{{]*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"protocolVersion\":1}}}}" ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"sessionId\":\"{name}-session\",\"configOptions\":[]}}}}" ;;
    *'"method":"session/close"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{}}}}" ;;
    *'"method":"session/prompt"'*)
      case "$line" in
        *'Write the handover'*) reply="{name} handover" ;;
        *'Record where this work stands'*) reply='## Done\nwork\n\n## Next\nnothing' ;;
        *'A note from you'*) reply="{name} revised after the note" ;;
        *) work=$((work+1)); reply="{name} work $work" ;;
      esac
{hold}      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"sessionId\":\"{name}-session\",\"update\":{{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{{\"type\":\"text\",\"text\":\"$reply\"}}}}}}}}"
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\"}}}}" ;;
  esac
done
"#
        )
    }

    /// A two-step News desk: Researcher hands over to Writer, and Writer answers.
    fn write_news_desk(dir: &TeamsDir, researcher: &str) -> PathBuf {
        let researcher = dir.write_harness("researcher.sh", researcher);
        let writer = dir.write_harness("writer.sh", &agent_script("writer", None, false));
        let yaml = format!(
            "schemaVersion: 1\nid: news-desk\nname: News desk\nentrypoint: researcher\nagents:\n  - id: researcher\n    name: Researcher\n    role: find the news\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\n  - id: writer\n    name: Writer\n    role: write the digest\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\nedges:\n  - from: researcher\n    to: writer\n    layer: configured\n    kind: sequence\n    ts: 2026-09-13T00:00:00Z\n",
            researcher.display(),
            writer.display()
        );
        let path = dir.0.join("news.yaml");
        std::fs::write(&path, yaml).unwrap();
        path
    }

    struct Rig {
        app: Router,
        registry: RunRegistry,
        archive: EventArchive,
    }

    fn rig(pool: PgPool, dir: &TeamsDir) -> Rig {
        let archive = EventArchive::from_pool(pool.clone());
        let registry = RunRegistry::durable(RunStore::new(pool));
        let app = router(Some(archive.clone()), dir.0.clone(), registry.clone());
        Rig {
            app,
            registry,
            archive,
        }
    }

    async fn send(app: &Router, body: Value) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/chat/messages")
                    .header("host", "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn post(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("host", "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn page(app: &Router) -> Value {
        page_at(app, "/api/chat?teamPath=news.yaml").await
    }

    async fn page_at(app: &Router, uri: &str) -> Value {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("host", "localhost")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn wait_for(
        registry: &RunRegistry,
        run_id: &str,
        done: impl Fn(&RunRecord) -> bool,
    ) -> RunRecord {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(record) = registry.get(run_id)
                    && done(&record)
                {
                    return record;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("run {run_id} never got there: {:?}", registry.get(run_id)))
    }

    /// Every prompt an agent was sent in a run, in order.
    async fn prompts(archive: &EventArchive, run_id: &str, agent: &str) -> Vec<String> {
        archive
            .load_session(run_id)
            .await
            .unwrap()
            .iter()
            .filter(|event| {
                event.agent_id == agent
                    && event.kind == crate::EventKind::Message
                    && event.payload["role"] == "user"
            })
            .filter_map(|event| event.payload["content"]["text"].as_str().map(str::to_owned))
            .collect()
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn a_team_note_waits_for_the_next_work_and_a_note_joins_the_working_agents_session(
        pool: PgPool,
    ) {
        let dir = TeamsDir::new();
        let gate = dir.0.join("gate");
        write_news_desk(&dir, &agent_script("researcher", Some(&gate), false));
        let rig = rig(pool, &dir);

        // No @ and nobody working: a team note, which starts nothing.
        let (status, noted) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "we only cover listed companies", "to": null}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{noted}");
        assert_eq!(noted["route"], "team_note");
        assert!(rig.registry.list().is_empty(), "a team note starts nothing");

        // @team: the whole team starts, given the note as conversation.
        let (status, started) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "today's digest", "to": {"kind": "team"}}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{started}");
        assert_eq!(started["route"], "team");
        let run_id = started["run"]["runId"].as_str().unwrap().to_owned();
        let working = wait_for(&rig.registry, &run_id, |run| {
            run.working.iter().any(|id| id == "researcher")
        })
        .await;
        assert_eq!(working.team_key, "news-desk");

        // No @ while Researcher works: a note for its next turn, shown on the run until then.
        let (status, queued) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "and keep it short", "to": null}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{queued}");
        assert_eq!(queued["route"], "note");
        assert_eq!(queued["message"]["agentId"], "researcher");
        assert_eq!(queued["run"]["queuedNotes"][0]["text"], "and keep it short");

        std::fs::write(&gate, "go").unwrap();
        let done = wait_for(&rig.registry, &run_id, |run| run.status.is_terminal()).await;
        assert_eq!(done.status, RunStatus::Succeeded, "{done:?}");
        assert!(done.working.is_empty() && done.queued_notes.is_empty());

        let researcher = prompts(&rig.archive, &run_id, "researcher").await;
        assert!(
            researcher[0].contains("## Conversation so far")
                && researcher[0]
                    .contains("You, in a note to the team: we only cover listed companies"),
            "{}",
            researcher[0]
        );
        // The conversation is above the task, and the task is the last thing it reads.
        let conversation = researcher[0].find("## Conversation so far").unwrap();
        let task = researcher[0].find("## Task\ntoday's digest").unwrap();
        assert!(conversation < task && researcher[0].ends_with("today's digest"));
        // The note went in as the next turn of the same session, before the handover.
        assert!(
            researcher[1].contains("## A note from you")
                && researcher[1].contains("and keep it short")
        );
        assert!(
            researcher[2].contains("Write the handover"),
            "{researcher:?}"
        );
        // Writer worked from the handover written after the note.
        let writer = prompts(&rig.archive, &run_id, "writer").await;
        assert!(writer[0].contains("researcher handover"), "{}", writer[0]);
        assert_eq!(done.reply.as_deref(), Some("writer work 1"));

        // The run view shows it as a note, paired with the turn that took it.
        let events = rig.archive.load_session(&run_id).await.unwrap();
        assert!(events.iter().any(|event| {
            event.agent_id == crate::config::RESERVED_OPERATOR_ID
                && event.raw.as_ref().is_some_and(|raw| {
                    raw["phase"] == "operator_answer"
                        && raw["to"] == "researcher"
                        && raw["noteId"] == queued["message"]["id"]
                })
        }));

        // The chat: the piece with its request and its note, newest first, then the team note.
        let chat = page(&rig.app).await;
        let items = chat["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "{chat}");
        assert_eq!(items[0]["kind"], "work");
        assert_eq!(items[0]["request"]["text"], "today's digest");
        assert_eq!(items[0]["notes"][0]["text"], "and keep it short");
        assert!(items[0]["notes"][0]["deliveredAt"].is_string());
        assert_eq!(items[1]["kind"], "note");
        assert_eq!(
            items[1]["message"]["text"],
            "we only cover listed companies"
        );

        // Search within the chat: by a team note's words, by a note sent into work, with `%` taken
        // as the character it is.
        let found = page_at(&rig.app, "/api/chat?teamPath=news.yaml&q=LISTED").await;
        assert_eq!(found["items"].as_array().unwrap().len(), 1, "{found}");
        assert_eq!(found["items"][0]["kind"], "note");
        let found = page_at(&rig.app, "/api/chat?teamPath=news.yaml&q=keep%20it%20short").await;
        assert_eq!(found["items"][0]["run"]["runId"], run_id, "{found}");
        let found = page_at(&rig.app, "/api/chat?teamPath=news.yaml&q=%25").await;
        assert!(found["items"].as_array().unwrap().is_empty(), "{found}");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn send_now_stops_the_agents_turn_and_hands_it_the_note_at_once(pool: PgPool) {
        let dir = TeamsDir::new();
        write_news_desk(&dir, &agent_script("researcher", None, true));
        let rig = rig(pool, &dir);
        let (_, started) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "today's digest", "to": {"kind": "team"}}),
        )
        .await;
        let run_id = started["run"]["runId"].as_str().unwrap().to_owned();
        wait_for(&rig.registry, &run_id, |run| {
            run.working.iter().any(|id| id == "researcher")
        })
        .await;
        let (status, queued) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "stop, only chips", "to": {"kind": "agent", "agent": "researcher"}, "now": true}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{queued}");
        assert_eq!(queued["route"], "note");
        assert_eq!(queued["message"]["now"], true);

        let done = wait_for(&rig.registry, &run_id, |run| run.status.is_terminal()).await;
        assert_eq!(done.status, RunStatus::Succeeded, "{done:?}");
        let events = rig.archive.load_session(&run_id).await.unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.payload["phase"] == "turn_interrupted"),
            "the interrupted turn is on the record"
        );
        let researcher = prompts(&rig.archive, &run_id, "researcher").await;
        assert!(researcher[1].contains("stop, only chips"), "{researcher:?}");
        let writer = prompts(&rig.archive, &run_id, "writer").await;
        assert!(writer[0].contains("researcher handover"));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn an_at_agent_runs_only_it_and_continue_hands_its_new_handover_on(pool: PgPool) {
        let dir = TeamsDir::new();
        write_news_desk(&dir, &agent_script("researcher", None, false));
        let rig = rig(pool, &dir);
        let (_, first) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "today's digest", "to": {"kind": "team"}}),
        )
        .await;
        let first_id = first["run"]["runId"].as_str().unwrap().to_owned();
        let first = wait_for(&rig.registry, &first_id, |run| run.status.is_terminal()).await;
        assert_eq!(first.status, RunStatus::Succeeded, "{first:?}");

        // @Researcher while nobody works: Researcher alone, given its own last output.
        let (status, turn) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "add a source", "to": {"kind": "agent", "agent": "researcher"}}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{turn}");
        assert_eq!(turn["route"], "agent");
        let turn_id = turn["run"]["runId"].as_str().unwrap().to_owned();
        let turn = wait_for(&rig.registry, &turn_id, |run| run.status.is_terminal()).await;
        assert_eq!(turn.status, RunStatus::Succeeded, "{turn:?}");
        assert_eq!(turn.only_agent.as_deref(), Some("researcher"));
        assert_eq!(turn.follows_run_id.as_deref(), Some(first_id.as_str()));
        // Its reply comes back to you; Writer never ran.
        assert_eq!(turn.reply.as_deref(), Some("researcher work 1"));
        assert!(prompts(&rig.archive, &turn_id, "writer").await.is_empty());
        let researcher = prompts(&rig.archive, &turn_id, "researcher").await;
        assert!(
            researcher[0].contains("The operator wrote to you directly"),
            "{}",
            researcher[0]
        );
        assert!(
            researcher[0].contains("## Your previous output\n")
                && researcher[0].contains("researcher handover"),
            "{}",
            researcher[0]
        );
        assert!(
            researcher[0].ends_with("## Task\nadd a source"),
            "{}",
            researcher[0]
        );
        // It still wrote a handover, for the team to continue from.
        let events = rig.archive.load_session(&turn_id).await.unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.payload["phase"] == "stage_handover")
        );

        // Continue with the team: Writer picks up from Researcher's new handover, on the request
        // the earlier work was answering.
        let (status, continued) =
            post(&rig.app, "/api/chat/continue", json!({"runId": turn_id})).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{continued}");
        let continued_id = continued["run"]["runId"].as_str().unwrap().to_owned();
        let continued =
            wait_for(&rig.registry, &continued_id, |run| run.status.is_terminal()).await;
        assert_eq!(continued.status, RunStatus::Succeeded, "{continued:?}");
        assert_eq!(continued.start_at.as_deref(), Some("writer"));
        assert_eq!(continued.prompt, "today's digest");
        assert!(
            prompts(&rig.archive, &continued_id, "researcher")
                .await
                .is_empty()
        );
        let writer = prompts(&rig.archive, &continued_id, "writer").await;
        assert!(
            writer[0].contains("## Results from preceding stages"),
            "{}",
            writer[0]
        );
        assert!(writer[0].contains("researcher handover"));
        // That handover was written in the turn before, so the record says it was handed on
        // rather than sent in this piece of work — the chat draws it as picked up, not as new.
        let events = rig.archive.load_session(&continued_id).await.unwrap();
        let record = events
            .iter()
            .find(|event| event.agent_id == "writer" && event.payload["phase"] == "prompt_sections")
            .expect("writer archives what its prompt was made of");
        assert_eq!(record.payload["replayed"], json!(true));
        // Writer is the last step, so there is nothing to continue after it.
        let (status, _) = post(
            &rig.app,
            "/api/chat/continue",
            json!({"runId": continued_id}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn a_team_with_no_fixed_order_carries_the_conversation_and_runs_an_at_agent_alone(
        pool: PgPool,
    ) {
        let dir = TeamsDir::new();
        let lead = dir.write_harness("lead.sh", &agent_script("lead", None, false));
        let helper = dir.write_harness("helper.sh", &agent_script("helper", None, false));
        let yaml = format!(
            "schemaVersion: 1\nid: studio\nname: Studio\nentrypoint: lead\nagents:\n  - id: lead\n    name: Lead\n    role: run the studio\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\n  - id: helper\n    name: Helper\n    role: help\n    spawn:\n      cmd: /bin/sh\n      args: [\"{}\"]\n      cwd: .\n    model: test/model\nedges: []\n",
            lead.display(),
            helper.display()
        );
        std::fs::write(dir.0.join("news.yaml"), yaml).unwrap();
        let rig = rig(pool, &dir);

        let (_, first) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "draft a plan", "to": {"kind": "team"}}),
        )
        .await;
        let first_id = first["run"]["runId"].as_str().unwrap().to_owned();
        let first = wait_for(&rig.registry, &first_id, |run| run.status.is_terminal()).await;
        assert_eq!(first.status, RunStatus::Succeeded, "{first:?}");

        let (_, second) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "make it shorter", "to": {"kind": "team"}}),
        )
        .await;
        let second_id = second["run"]["runId"].as_str().unwrap().to_owned();
        wait_for(&rig.registry, &second_id, |run| run.status.is_terminal()).await;
        // A follow-up in a team with no fixed order used to be handed nothing at all.
        let lead_prompt = &prompts(&rig.archive, &second_id, "lead").await[0];
        assert!(
            lead_prompt.contains("You to the team: draft a plan")
                && lead_prompt.contains("Lead answered (work"),
            "{lead_prompt}"
        );

        let (status, turn) = send(
            &rig.app,
            json!({"teamPath": "news.yaml", "text": "check the numbers", "to": {"kind": "agent", "agent": "helper"}}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{turn}");
        let turn_id = turn["run"]["runId"].as_str().unwrap().to_owned();
        let turn = wait_for(&rig.registry, &turn_id, |run| run.status.is_terminal()).await;
        assert_eq!(turn.status, RunStatus::Succeeded, "{turn:?}");
        assert_eq!(turn.reply.as_deref(), Some("helper work 1"));
        assert!(prompts(&rig.archive, &turn_id, "lead").await.is_empty());
        let helper_prompt = &prompts(&rig.archive, &turn_id, "helper").await[0];
        assert!(
            helper_prompt.contains("The operator wrote to you directly"),
            "{helper_prompt}"
        );
    }

    #[test]
    fn the_agents_are_given_the_request_without_the_mention_that_routed_it() {
        let team = team();
        assert_eq!(task_text("@team today's digest", &team), "today's digest");
        assert_eq!(
            task_text("@Writer, make the chip story the lead", &team),
            "make the chip story the lead"
        );
        assert_eq!(task_text("@writer shorter", &team), "shorter");
        // Only a leading mention is a routing word; one inside the request is part of it.
        assert_eq!(
            task_text("ask @Writer for a title", &team),
            "ask @Writer for a title"
        );
        // A mention and nothing else is still the request, rather than an empty one.
        assert_eq!(task_text("@team", &team), "@team");
        assert_eq!(task_text("@teamwork matters", &team), "@teamwork matters");
    }

    #[test]
    fn a_team_with_no_history_gets_no_section() {
        let now = finished("ffffffff-now", "2026-10-06T03:00:00.000Z", "today", "");
        let history = History {
            runs: Vec::new(),
            notes: Vec::new(),
            decisions: Vec::new(),
        };
        assert_eq!(render(&team(), &history, &now), None);
    }
}
