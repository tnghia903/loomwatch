//! An agent in its own chat messages the person at a time they asked (ADR 0108).
//!
//! The agent's `message_me_at` call (on the Team Bus, only for an agent in its own chat with a
//! person) keeps the message here, in the archive's `messages_at` table, and returns at once. A
//! waiter ([`spawn`]) watches the wall clock, so a computer that slept through the time sends it
//! within one check of waking. At the time, the agent takes one turn in its own chat, started
//! through the chat's own send path (`chat::send_message_at`), and writes the message: its reply is
//! what the person reads, in the chat and, through the push watcher, on their phone. The run keeps
//! [`MessageAt`], which is how the chat, the push and the phone know it.
//!
//! `GET /api/messages-at` lists the messages waiting, and `DELETE /api/messages-at/{id}` cancels
//! one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::{DateTime, Local, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row as _;
use tokio::sync::Notify;
use uuid::Uuid;

use crate::archive::EventArchive;
use crate::db::Db;
use crate::deadline;
use crate::prompt_blocks::Block;
use crate::runs::RunRegistry;
use crate::watch_api::local_evidence;

/// How far ahead a message may be set.
pub(crate) const MAX_AHEAD: chrono::Duration = chrono::Duration::days(400);
/// Messages one chat may have waiting at once.
pub(crate) const MAX_WAITING_PER_CHAT: i64 = 50;
/// The most a message's words may be.
pub(crate) const MAX_TEXT_CHARS: usize = 1_000;
/// How long a message waits for its agent's turn in that chat to end before trying again.
const BUSY_AGAIN: Duration = Duration::from_secs(5);
/// How long after a turn that could not start it is tried again, and how many times.
const FAILED_AGAIN: Duration = Duration::from_mins(1);
const TRIES: u32 = 30;
/// After this long past its time, a message says it comes late.
const LATE_AFTER: chrono::Duration = chrono::Duration::minutes(2);

/// Woken whenever a message is set or cancelled, so the waiter looks at the next one again.
static CHANGED: Notify = Notify::const_new();

/// The message a run was started for, as the run keeps it: the chat draws the run's start as a
/// reminder of these words, and the phone shows them when the turn fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAt {
    pub id: String,
    /// When it was set for, as the run record writes its times.
    pub at: String,
    /// The words the agent set.
    pub text: String,
}

/// One message waiting for its time, as `GET /api/messages-at` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Waiting {
    pub(crate) id: String,
    /// The agent's own chat, relative to the teams root (`.jobs/.bench/<id>.yaml`).
    pub(crate) chat_path: String,
    pub(crate) agent: String,
    pub(crate) at: String,
    pub(crate) text: String,
    pub(crate) set_at: String,
}

impl Waiting {
    fn message_at(&self) -> MessageAt {
        MessageAt {
            id: self.id.clone(),
            at: self.at.clone(),
            text: self.text.clone(),
        }
    }
}

/// How a message ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    Sent,
    /// Its chat is gone, or its turn could not start after every try.
    Failed,
}

impl Ended {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::Failed => "failed",
        }
    }
}

/// The messages, in the archive's database.
#[derive(Clone)]
pub(crate) struct Store {
    db: Db,
}

impl Store {
    pub(crate) fn new(db: Db) -> Self {
        Self { db }
    }

    /// Keep a message for `agent` to write in `chat_path` at `at`. Refused when the chat already
    /// has as many waiting as it may.
    pub(crate) async fn set(
        &self,
        chat_path: &str,
        agent: &str,
        at: DateTime<Utc>,
        text: &str,
        set_in_run: Option<&str>,
    ) -> Result<Waiting, String> {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages_at WHERE chat_path = $1 AND status = 'waiting'",
        )
        .bind(chat_path)
        .fetch_one(self.db.reader())
        .await
        .map_err(|error| format!("the messages couldn't be read: {error}"))?;
        if waiting >= MAX_WAITING_PER_CHAT {
            return Err(format!(
                "this chat already has {waiting} messages waiting, the most it may: cancel one first"
            ));
        }
        let message = Waiting {
            id: Uuid::new_v4().to_string(),
            chat_path: chat_path.to_owned(),
            agent: agent.to_owned(),
            at: deadline::stamp(at),
            text: text.to_owned(),
            set_at: deadline::stamp(Utc::now()),
        };
        sqlx::query(
            "INSERT INTO messages_at (id, chat_path, agent_id, at, text, set_at, set_in_run)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&message.id)
        .bind(&message.chat_path)
        .bind(&message.agent)
        .bind(&message.at)
        .bind(&message.text)
        .bind(&message.set_at)
        .bind(set_in_run)
        .execute(self.db.writer())
        .await
        .map_err(|error| format!("the message couldn't be kept: {error}"))?;
        CHANGED.notify_waiters();
        Ok(message)
    }

    /// The messages waiting, soonest first: every chat's, or `chat_path`'s alone.
    pub(crate) async fn waiting(&self, chat_path: Option<&str>) -> Result<Vec<Waiting>, String> {
        let rows = sqlx::query(
            "SELECT id, chat_path, agent_id, at, text, set_at FROM messages_at
             WHERE status = 'waiting' AND ($1 IS NULL OR chat_path = $1)
             ORDER BY at, set_at",
        )
        .bind(chat_path)
        .fetch_all(self.db.reader())
        .await
        .map_err(|error| format!("the messages couldn't be read: {error}"))?;
        rows.iter()
            .map(|row| {
                Ok(Waiting {
                    id: row.try_get("id")?,
                    chat_path: row.try_get("chat_path")?,
                    agent: row.try_get("agent_id")?,
                    at: row.try_get("at")?,
                    text: row.try_get("text")?,
                    set_at: row.try_get("set_at")?,
                })
            })
            .collect::<Result<_, sqlx::Error>>()
            .map_err(|error| format!("the messages couldn't be read: {error}"))
    }

    /// Cancel a waiting message: any chat's, or only one in `chat_path`. `false` when there is no
    /// such message waiting.
    pub(crate) async fn cancel(&self, id: &str, chat_path: Option<&str>) -> Result<bool, String> {
        let done = sqlx::query(
            "UPDATE messages_at SET status = 'cancelled'
             WHERE id = $1 AND status = 'waiting' AND ($2 IS NULL OR chat_path = $2)",
        )
        .bind(id)
        .bind(chat_path)
        .execute(self.db.writer())
        .await
        .map_err(|error| format!("the message couldn't be cancelled: {error}"))?;
        CHANGED.notify_waiters();
        Ok(done.rows_affected() > 0)
    }

    async fn next(&self) -> Result<Option<Waiting>, String> {
        Ok(self.waiting(None).await?.into_iter().next())
    }

    async fn end(&self, id: &str, ended: Ended, run_id: Option<&str>) {
        if let Err(error) = sqlx::query(
            "UPDATE messages_at SET status = $2, run_id = $3 WHERE id = $1 AND status = 'waiting'",
        )
        .bind(id)
        .bind(ended.as_str())
        .bind(run_id)
        .execute(self.db.writer())
        .await
        {
            eprintln!("warning: a message's end wasn't kept: {error}");
        }
    }
}

/// When `at` or `in_minutes` says, from `now` in its own time zone: "17:20" is the next 17:20,
/// "2026-11-02 08:00" that time in this zone, and a time with an offset is that time. Refused
/// unless it is still to come and no further than [`MAX_AHEAD`].
pub(crate) fn when<Tz: TimeZone>(
    at: Option<&str>,
    in_minutes: Option<i64>,
    now: &DateTime<Tz>,
) -> Result<DateTime<Utc>, String>
where
    Tz::Offset: std::fmt::Display,
{
    let zone = now.timezone();
    let local = |naive: NaiveDateTime| {
        zone.from_local_datetime(&naive)
            .earliest()
            .map(|at| at.with_timezone(&Utc))
            .ok_or_else(|| format!("{naive} doesn't happen here: the clocks skip it"))
    };
    let at = match (at.map(str::trim).filter(|at| !at.is_empty()), in_minutes) {
        (Some(_), Some(_)) | (None, None) => {
            return Err("give either at or inMinutes".to_owned());
        }
        (None, Some(minutes)) => {
            if minutes < 1 {
                return Err("inMinutes must be at least 1".to_owned());
            }
            now.with_timezone(&Utc) + chrono::Duration::minutes(minutes)
        }
        (Some(at), None) => {
            if let Ok(at) = DateTime::parse_from_rfc3339(at) {
                at.with_timezone(&Utc)
            } else if let Some(naive) = ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S"]
                .iter()
                .find_map(|format| NaiveDateTime::parse_from_str(at, format).ok())
            {
                local(naive)?
            } else if let Ok(time) = NaiveTime::parse_from_str(at, "%H:%M") {
                let today = local(now.date_naive().and_time(time))?;
                if today > now.with_timezone(&Utc) {
                    today
                } else {
                    let tomorrow = now.date_naive().succ_opt().ok_or("there is no tomorrow")?;
                    local(tomorrow.and_time(time))?
                }
            } else {
                return Err(format!(
                    "{at:?} isn't a time this can read: write \"17:20\", \"2026-11-02 08:00\", or \
                     use inMinutes"
                ));
            }
        }
    };
    let from = now.with_timezone(&Utc);
    if at <= from {
        return Err(format!(
            "that time has gone by: it is now {}",
            in_words(from, now)
        ));
    }
    if at - from > MAX_AHEAD {
        return Err(format!(
            "that is more than {} days ahead",
            MAX_AHEAD.num_days()
        ));
    }
    Ok(at)
}

/// `at` as the person reads it, in `now`'s time zone: "today at 17:20 (UTC+07:00)", "tomorrow at
/// 08:00 (…)", "Tuesday 3 November at 08:00 (…)".
pub(crate) fn in_words<Tz: TimeZone>(at: DateTime<Utc>, now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let local = at.with_timezone(&now.timezone());
    let day = local.date_naive();
    let today = now.date_naive();
    let when = if day == today {
        "today".to_owned()
    } else if today.succ_opt() == Some(day) {
        "tomorrow".to_owned()
    } else {
        local.format("%A %-d %B %Y").to_string()
    };
    format!(
        "{when} at {} (UTC{})",
        local.format("%H:%M"),
        local.format("%:z")
    )
}

/// How long from `from` until `to`, roughly, as "in 25 minutes" or "in 2 days 3 hours".
pub(crate) fn how_long(from: DateTime<Utc>, to: DateTime<Utc>) -> String {
    // Up to the next whole minute: a message set for "in 25 minutes" says 25, not 24.
    let minutes = ((to - from).num_seconds().max(0) + 59) / 60;
    let (days, hours, minutes) = (minutes / (24 * 60), minutes / 60 % 24, minutes % 60);
    let unit = |count: i64, name: &str| match count {
        0 => None,
        1 => Some(format!("1 {name}")),
        _ => Some(format!("{count} {name}s")),
    };
    let parts: Vec<String> = if days > 0 {
        [unit(days, "day"), unit(hours, "hour")]
            .into_iter()
            .flatten()
            .collect()
    } else {
        [unit(hours, "hour"), unit(minutes, "minute")]
            .into_iter()
            .flatten()
            .collect()
    };
    if parts.is_empty() {
        "in under a minute".to_owned()
    } else {
        format!("in {}", parts.join(" "))
    }
}

/// What the agent is told when its message's time comes, after the words it set, which come first
/// so that wherever the run is named by its first line it reads as them.
pub(crate) const DUE: Block = Block::new(
    "message.due",
    "(From LoomWatch, not the person.) It is {now}. You set a message for the person for this \
     time, and the words above are what you set. Write them the message now: your reply is the \
     message they read. If it asks you to check or find something first, do that, then write it. \
     Keep to what they asked for.",
);

/// Added when the message comes late.
pub(crate) const DUE_LATE: Block = Block::new(
    "message.due.late",
    "It was due {due} and comes late, because this computer was asleep, LoomWatch was closed, or \
     you were busy in this chat then: say so in a few words.",
);

/// What `message` asks of its agent, sent at `now`.
pub(crate) fn task(message: &Waiting, now: DateTime<Utc>) -> String {
    let local = now.with_timezone(&Local);
    let mut task = format!(
        "{}\n\n{}",
        message.text,
        DUE.fill(&[("now", &in_words(now, &local))])
    );
    if let Some(due) = deadline::parse(&message.at).filter(|due| now - *due > LATE_AFTER) {
        task.push_str("\n\n");
        task.push_str(&DUE_LATE.fill(&[("due", &in_words(due, &local))]));
    }
    task
}

/// Waits for each message's time, by the wall clock, and starts its agent's turn then, for as long
/// as `LoomWatch` runs. A message whose time went by while `LoomWatch` was closed goes at once.
pub fn spawn(archive: EventArchive, teams_root: PathBuf, registry: RunRegistry) {
    let teams_root = crate::platform::canonicalize(&teams_root).unwrap_or(teams_root);
    tokio::spawn(async move {
        let store = Store::new(archive.db().clone());
        let mut tries: HashMap<String, u32> = HashMap::new();
        loop {
            let changed = CHANGED.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let next = match store.next().await {
                Ok(next) => next,
                Err(why) => {
                    eprintln!("warning: {why}");
                    tokio::time::sleep(FAILED_AGAIN).await;
                    continue;
                }
            };
            let Some(next) = next else {
                changed.await;
                continue;
            };
            let due = deadline::parse(&next.at).unwrap_or_else(Utc::now);
            // Only the waits race here: the database work comes after, never inside a branch.
            let came = tokio::select! {
                () = deadline::passed(due) => true,
                () = &mut changed => false,
            };
            if !came {
                continue;
            }
            send(&store, &archive, &teams_root, &registry, &next, &mut tries).await;
        }
    });
}

/// Start `message`'s turn, or say why not and when to try again.
async fn send(
    store: &Store,
    archive: &EventArchive,
    teams_root: &std::path::Path,
    registry: &RunRegistry,
    message: &Waiting,
    tries: &mut HashMap<String, u32>,
) {
    use crate::chat::MessageAtSent;
    if !teams_root.join(&message.chat_path).is_file() {
        eprintln!(
            "warning: a message for {} wasn't sent: its chat is gone",
            message.agent
        );
        store.end(&message.id, Ended::Failed, None).await;
        return;
    }
    let sent = crate::chat::send_message_at(
        registry,
        Some(archive.clone()),
        teams_root,
        &message.chat_path,
        &message.agent,
        &task(message, Utc::now()),
        message.message_at(),
    )
    .await;
    match sent {
        MessageAtSent::Started(run_id) => {
            tries.remove(&message.id);
            store.end(&message.id, Ended::Sent, Some(&run_id)).await;
        }
        MessageAtSent::Busy => tokio::time::sleep(BUSY_AGAIN).await,
        MessageAtSent::Refused(why) => {
            let count = tries.entry(message.id.clone()).or_default();
            *count += 1;
            eprintln!(
                "warning: a message for {} couldn't start (try {count} of {TRIES}): {why}",
                message.agent
            );
            if *count >= TRIES {
                tries.remove(&message.id);
                store.end(&message.id, Ended::Failed, None).await;
            } else {
                tokio::time::sleep(FAILED_AGAIN).await;
            }
        }
    }
}

/// `GET /api/messages-at` and `DELETE /api/messages-at/{id}`, on this computer's own address.
pub fn router(archive: Option<EventArchive>) -> Router {
    Router::new()
        .route("/api/messages-at", get(list_route))
        .route("/api/messages-at/{id}", delete(cancel_route))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(archive.map(|archive| Store::new(archive.db().clone())))
}

fn unavailable(why: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": why })),
    )
        .into_response()
}

async fn list_route(State(store): State<Option<Store>>) -> Response {
    let Some(store) = store else {
        return Json(Vec::<Waiting>::new()).into_response();
    };
    match store.waiting(None).await {
        Ok(waiting) => Json(waiting).into_response(),
        Err(why) => unavailable(&why),
    }
}

async fn cancel_route(
    State(store): State<Option<Store>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(store) = store else {
        return unavailable("Messages need LoomWatch's database.");
    };
    match store.cancel(&id, None).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "No message waiting has that id." })),
        )
            .into_response(),
        Err(why) => unavailable(&why),
    }
}

#[cfg(test)]
mod tests;
