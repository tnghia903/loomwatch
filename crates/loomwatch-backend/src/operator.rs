//! The operator as a node: review stops, parked questions, and the answers that release them.
//!
//! Two things park a run on the person at the keyboard, and they are the same fact with different
//! authors — a **review stop** the operator designed (`kind: operator` in the team file, reached in
//! topological order with no harness to spawn) and an **`ask_user`** an agent made mid-turn. Both
//! record a row in `operator_questions`, both stamp the run record's `waiting_on`, both archive a
//! `session_meta` with `phase: "awaiting_operator"`, and both are released by
//! `POST /api/runs/{id}/answers`.
//!
//! The one thing neither may do is **block**. A tool call that waited for a person would trip the
//! ten-minute ACP request timeout in [`crate::acp`]'s `read_response` and cancel the turn, so
//! nothing is ever in flight while the operator thinks: the question is recorded, the turn ends,
//! the session is parked (decision 7), and the answer arrives as the *next* turn.
//!
//! This module owns the rendezvous between the HTTP handler that accepts an answer and the run
//! task waiting for one. The waiting room itself lives in [`crate::runs::RunRegistry`] — the
//! authority on a run record, and `waiting_on` is a field of that record — and [`OperatorDesk`] is
//! the narrow handle onto it that the pipeline and the Team Bus are given, so neither of them ends
//! up holding something that can mark a run failed.

use std::fmt;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row, postgres::PgRow};
use tokio::sync::oneshot;

use crate::runs::{RunRecord, RunRegistry};

/// Why an answer could not be accepted, or a question could not be recorded.
///
/// Every variant is something the caller can act on, so each one says what is true rather than
/// what failed: "nothing is waiting", "a different node is", "that session is gone, here is the
/// checkpoint to continue from".
#[derive(Debug)]
pub struct OperatorError {
    pub message: String,
    /// Whether this is a conflict (409) rather than a not-found (404) or a server fault (500).
    pub conflict: bool,
}

impl fmt::Display for OperatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for OperatorError {}

impl OperatorError {
    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            conflict: true,
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            conflict: false,
        }
    }
}

/// Which of the two kinds of stop a run is parked on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopKind {
    /// An `agents[]` entry with `kind: operator`, reached in topological order.
    ReviewStop,
    /// An agent called `ask_user` mid-turn.
    Question,
}

/// How the session behind a stop is waiting, which is what the card says out loud.
///
/// Decision 7's two tiers, and the third state the second tier decays into. The operator is told
/// which one they are in because the three cost different things and offer different actions: a
/// parked session can take a note for as long as you like, a kept-alive one cannot be left
/// overnight, and a released one can only be continued from its checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParkTier {
    /// The harness advertised `agentCapabilities.loadSession`: the session was closed, the process
    /// reaped, and the ACP session id kept. Answering reopens it with `session/load`.
    Reloadable,
    /// The harness did not: the session idles, bounded by `conversation.stop.keepAliveMinutes`.
    KeptAlive,
    /// The window expired: a coordinator checkpoint was written and the session released.
    Released,
    /// Nothing is holding a session — the stop is the first thing after a replayed stage, or the
    /// predecessor had already finished.
    None,
}

impl ParkTier {
    /// The phrase the waiting card shows under the question.
    #[must_use]
    pub fn sentence(self, predecessor: Option<&str>, keep_alive_minutes: u32) -> String {
        let who = predecessor.unwrap_or("The stage before this");
        match self {
            Self::Reloadable => {
                format!("{who} is parked · resumes with session/load · no process running")
            }
            Self::KeptAlive => format!(
                "{who} is kept alive · checkpoints and releases after {keep_alive_minutes} minutes"
            ),
            Self::Released => format!(
                "{who} was released after {keep_alive_minutes} minutes · its checkpoint is where \
                 the work stopped"
            ),
            Self::None => "No session is being held for this stop.".to_owned(),
        }
    }
}

/// What the run record's `waiting_on` holds while a run is parked on the operator.
///
/// Serialized straight into the record's JSON column, so the UI reads it from
/// `GET /api/runs/{id}` without a second endpoint, and it survives a daemon restart with the rest
/// of the record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingOn {
    /// The operator node of a review stop, or the agent that called `ask_user`.
    pub node: String,
    /// The node's display name — "You" for a stop, the agent's name for a question.
    pub name: String,
    pub kind: StopKind,
    /// RFC 3339. "Waiting since 14:38" is read from this.
    pub since: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// The stage whose handover the stop is reviewing, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handover_from: Option<String>,
    pub park: ParkTier,
    /// The parking fact in plain words, so the card never has to reconstruct it.
    pub park_note: String,
    /// Whether `sendBack` can still reach the predecessor. False once a kept-alive session has
    /// been released: a note cannot be delivered to a session that is gone, and saying so at the
    /// moment the operator presses the button is better than accepting it and dropping it.
    pub send_back_available: bool,
    /// The id of the row in `operator_questions` this is the open half of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
}

impl WaitingOn {
    /// The JSON the run record carries. Infallible by construction — every field is a string, a
    /// bool or a plain enum.
    #[must_use]
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// Read one back off a record, tolerating a shape this build does not understand.
    #[must_use]
    pub fn from_value(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// What the operator answered, on its way to the run task that is waiting for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorAnswer {
    pub text: String,
    /// "Send back to <predecessor>": re-prompt the still-warm (or reloaded) stage before the stop
    /// with this note as a new turn, take its new reply, and run the stop again.
    pub send_back: Option<String>,
    /// The `run_events.id` of the archived user `message` carrying [`Self::text`], stamped onto
    /// the `operator_questions` row so the question and the evidence it produced read as one
    /// thing.
    pub answer_event_id: String,
}

/// The run task's end of the rendezvous. Dropping it is how a cancelled run stops waiting.
pub struct OperatorWait {
    run_id: String,
    node: String,
    receiver: oneshot::Receiver<OperatorAnswer>,
}

impl OperatorWait {
    /// Block this run's loop — and nothing else — until an answer arrives.
    ///
    /// There is no timeout here on purpose. Nothing is in flight: the harness process is parked or
    /// released, the ACP request timeout is not racing anybody, and a stop that waits an hour
    /// costs exactly what a stop that waits a minute costs. The only thing that ends this wait
    /// other than an answer is the run being cancelled, which drops the whole task.
    ///
    /// # Errors
    ///
    /// Returns an error only when the waiting room dropped the sender without an answer, which is
    /// a daemon-side fault rather than anything the operator did.
    pub async fn answer(self) -> Result<OperatorAnswer, OperatorError> {
        self.receiver.await.map_err(|_| {
            OperatorError::not_found(format!(
                "the wait for {} on run {} was discarded before an answer arrived",
                self.node, self.run_id
            ))
        })
    }
}

/// One open or answered question, as `GET /api/runs/{id}/questions` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorQuestion {
    pub id: String,
    pub run_id: String,
    pub agent_id: String,
    pub question: String,
    pub context: Option<String>,
    pub asked_at: String,
    pub answered_at: Option<String>,
    pub answer_event_id: Option<String>,
}

/// The `operator_questions` table.
///
/// Its own type for the same reason [`crate::runs::RunStore`] is: `run_events` is append-only
/// evidence and a question is mutable state with an `answered_at` that gets stamped.
#[derive(Clone)]
pub struct OperatorQuestions {
    pool: PgPool,
}

impl OperatorQuestions {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Record a question and return its id.
    ///
    /// Refuses a second open question from the same agent in the same run. The refusal is a
    /// database rule (a partial unique index), not a read-then-write: two `ask_user` calls racing
    /// from one agent must not both be recorded, and "one open question per agent at a time" is
    /// only true if the storage says so.
    ///
    /// # Errors
    ///
    /// Returns a conflict when that agent already has an open question, and a server fault when
    /// Postgres fails.
    pub async fn open(
        &self,
        run_id: &str,
        agent_id: &str,
        question: &str,
        context: Option<&str>,
    ) -> Result<String, OperatorError> {
        let id = uuid::Uuid::new_v4().to_string();
        let result = sqlx::query(
            "INSERT INTO operator_questions (id, run_id, agent_id, question, context, asked_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&id)
        .bind(run_id)
        .bind(agent_id)
        .bind(question.trim())
        .bind(context.map(str::trim).filter(|value| !value.is_empty()))
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await;
        match result {
            Ok(_) => Ok(id),
            Err(error) if is_unique_violation(&error) => Err(OperatorError::conflict(format!(
                "{agent_id} already has a question waiting for you in this run. Answer that one \
                 before asking another."
            ))),
            Err(error) => Err(OperatorError {
                message: format!("cannot record the question: {error}"),
                conflict: false,
            }),
        }
    }

    /// Stamp a question answered. A question that is already answered, or that never existed, is
    /// left alone and reported as `false` rather than raising: the answer itself is already
    /// archived, and failing the operator's request over bookkeeping would be the wrong trade.
    ///
    /// # Errors
    ///
    /// Returns an error when Postgres fails.
    pub async fn close(
        &self,
        run_id: &str,
        agent_id: &str,
        answer_event_id: &str,
    ) -> Result<bool, OperatorError> {
        let result = sqlx::query(
            "UPDATE operator_questions SET answered_at = $1, answer_event_id = $2
             WHERE run_id = $3 AND agent_id = $4 AND answered_at IS NULL",
        )
        .bind(now_rfc3339())
        .bind(answer_event_id)
        .bind(run_id)
        .bind(agent_id)
        .execute(&self.pool)
        .await
        .map_err(|error| OperatorError {
            message: format!("cannot close the question: {error}"),
            conflict: false,
        })?;
        Ok(result.rows_affected() > 0)
    }

    /// Every question of one run, oldest first.
    ///
    /// # Errors
    ///
    /// Returns an error when Postgres fails.
    pub async fn list(&self, run_id: &str) -> Result<Vec<OperatorQuestion>, OperatorError> {
        let rows = sqlx::query(
            "SELECT id, run_id, agent_id, question, context, asked_at, answered_at, answer_event_id
             FROM operator_questions WHERE run_id = $1 ORDER BY asked_at ASC, id ASC",
        )
        .bind(run_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| OperatorError {
            message: format!("cannot read the questions for run {run_id}: {error}"),
            conflict: false,
        })?;
        rows.iter().map(decode_question).collect()
    }
}

fn decode_question(row: &PgRow) -> Result<OperatorQuestion, OperatorError> {
    let decode = |error: sqlx::Error| OperatorError {
        message: format!("cannot decode a question row: {error}"),
        conflict: false,
    };
    Ok(OperatorQuestion {
        id: row.try_get("id").map_err(decode)?,
        run_id: row.try_get("run_id").map_err(decode)?,
        agent_id: row.try_get("agent_id").map_err(decode)?,
        question: row.try_get("question").map_err(decode)?,
        context: row.try_get("context").map_err(decode)?,
        asked_at: row.try_get("asked_at").map_err(decode)?,
        answered_at: row.try_get("answered_at").map_err(decode)?,
        answer_event_id: row.try_get("answer_event_id").map_err(decode)?,
    })
}

/// Postgres SQLSTATE 23505 — the partial unique index that enforces one open question per agent.
fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "23505")
}

/// One clock for everything this module stamps, so "waiting since" and `asked_at` cannot disagree.
#[must_use]
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// One turn asked of a session that is being kept answerable, and somewhere to put the reply.
///
/// Shared between the Team Bus's `ask` (one stage asking the stage before it) and the operator's
/// own follow-up (`POST /api/runs/{id}/agents/{agent}/ask`), because they are the same operation
/// with a different caller — and a second channel would be a second place for a session to be
/// prompted twice at once.
pub(crate) struct LiveTurn {
    pub(crate) prompt: String,
    pub(crate) from_operator: bool,
    pub(crate) answer: oneshot::Sender<anyhow::Result<String>>,
}

/// The narrow handle onto the waiting room that the pipeline and the Team Bus are given.
///
/// Deliberately not the whole [`RunRegistry`]: a stage that can park a run must not also be able
/// to mark it failed. Everything here is about one field of one record — `waiting_on` — plus the
/// rendezvous channel behind it.
#[derive(Clone)]
pub struct OperatorDesk {
    registry: RunRegistry,
    questions: Option<OperatorQuestions>,
}

impl fmt::Debug for OperatorDesk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OperatorDesk")
            .field("durable", &self.questions.is_some())
            .finish_non_exhaustive()
    }
}

impl OperatorDesk {
    #[must_use]
    pub fn new(registry: RunRegistry, questions: Option<OperatorQuestions>) -> Self {
        Self {
            registry,
            questions,
        }
    }

    /// The `operator_questions` table, when this daemon has one.
    #[must_use]
    pub fn questions(&self) -> Option<&OperatorQuestions> {
        self.questions.as_ref()
    }

    /// Park a run on the operator: record the question, stamp `waiting_on`, and hand back the end
    /// of the rendezvous the answer will arrive on.
    ///
    /// The run's status is untouched and stays `running` — it has not failed, nothing is queued,
    /// and a status that said otherwise would make the history lie about what happened.
    ///
    /// # Errors
    ///
    /// Returns a conflict when this run is already waiting on the same node, or when the agent
    /// already has an open question.
    pub async fn park(
        &self,
        run_id: &str,
        mut waiting: WaitingOn,
    ) -> Result<OperatorWait, OperatorError> {
        if let Some(questions) = &self.questions {
            let id = questions
                .open(
                    run_id,
                    &waiting.node,
                    &waiting.question,
                    waiting.context.as_deref(),
                )
                .await?;
            waiting.question_id = Some(id);
        }
        let (sender, receiver) = oneshot::channel();
        if !self
            .registry
            .register_wait(run_id, &waiting.node, sender, waiting.to_value())
        {
            return Err(OperatorError::conflict(format!(
                "run {run_id} is already waiting on {}.",
                waiting.node
            )));
        }
        self.registry.persist_quietly(run_id).await;
        Ok(OperatorWait {
            run_id: run_id.to_owned(),
            node: waiting.node,
            receiver,
        })
    }

    /// Rewrite the parking fact of a stop that is still open — the one thing about a stop that
    /// changes while nobody is touching it, when a kept-alive window expires under it.
    pub async fn repark(&self, run_id: &str, waiting: &WaitingOn) {
        self.registry
            .set_waiting_on(run_id, Some(waiting.to_value()));
        self.registry.persist_quietly(run_id).await;
    }

    /// What this run is waiting for, if anything.
    #[must_use]
    pub fn waiting(&self, run_id: &str) -> Option<WaitingOn> {
        self.registry
            .get(run_id)
            .and_then(|record| record.waiting_on)
            .as_ref()
            .and_then(WaitingOn::from_value)
    }

    /// Read the waiting fact for an individual agent, including one behind the visible question.
    #[must_use]
    pub fn waiting_for(&self, run_id: &str, node: &str) -> Option<WaitingOn> {
        self.registry
            .waiting_for(run_id, node)
            .as_ref()
            .and_then(WaitingOn::from_value)
    }

    /// Deliver an answer to whatever is waiting for it, and clear `waiting_on`.
    ///
    /// # Errors
    ///
    /// Returns a conflict when nothing is waiting, when a different node is, when the run task has
    /// gone away, or when `sendBack` names a session that has already been released.
    pub async fn deliver(
        &self,
        run_id: &str,
        node: &str,
        answer: OperatorAnswer,
    ) -> Result<RunRecord, OperatorError> {
        let sender = self.registry.take_wait(run_id, node)?;
        sender.send(answer).map_err(|_| {
            OperatorError::conflict(format!(
                "run {run_id} stopped waiting for {node} before the answer arrived."
            ))
        })?;
        self.registry.persist_quietly(run_id).await;
        self.registry
            .get(run_id)
            .ok_or_else(|| OperatorError::not_found(format!("run {run_id} does not exist")))
    }

    /// Put a question to a session this run is keeping answerable.
    ///
    /// The operator's own follow-up to an agent that did **not** ask: the same `ask_live` a stage
    /// uses, with the operator as the caller.
    ///
    /// # Errors
    ///
    /// Returns a conflict when the session has been released, carrying the checkpoint to continue
    /// from when the caller supplies one.
    pub async fn ask_live(
        &self,
        run_id: &str,
        agent_id: &str,
        prompt: &str,
    ) -> Result<String, OperatorError> {
        let sender = self.registry.live_agent(run_id, agent_id).ok_or_else(|| {
            OperatorError::conflict(format!(
                "{agent_id} is not holding a session in run {run_id} any more, so it cannot take a \
                 follow-up. Start a new run from its checkpoint instead."
            ))
        })?;
        let (answer, answered) = oneshot::channel();
        sender
            .send(LiveTurn {
                prompt: prompt.to_owned(),
                from_operator: true,
                answer,
            })
            .await
            .map_err(|_| {
                OperatorError::conflict(format!(
                    "{agent_id}'s session in run {run_id} closed before the follow-up reached it."
                ))
            })?;
        answered
            .await
            .map_err(|_| {
                OperatorError::conflict(format!("{agent_id} dropped the follow-up unanswered."))
            })?
            .map_err(|error| OperatorError {
                message: format!("{agent_id} failed to answer the follow-up: {error:#}"),
                conflict: false,
            })
    }

    /// Remember that `agent_id` of `run_id` is answerable, so the operator's follow-up can reach
    /// it. Called by the Team Bus when it takes a finished stage's still-open session.
    pub(crate) fn attach_live(
        &self,
        run_id: &str,
        agent_id: &str,
        sender: tokio::sync::mpsc::Sender<LiveTurn>,
    ) {
        self.registry.attach_live(run_id, agent_id, sender);
    }

    /// Forget it again, when the session is released.
    pub(crate) fn detach_live(&self, run_id: &str, agent_id: &str) {
        self.registry.detach_live(run_id, agent_id);
    }
}
