//! The run record of one agent: every event it produces, projected into the archive.
//!
//! Moved here from the ACP client when `LoomWatch` stopped driving third-party apps. The update
//! shapes it reads (`agent_message_chunk`, `tool_call`, `plan`, `usage_update`, …) are what the
//! built-in agent emits and what the archive has always stored, so a run recorded before the move
//! reads the same as one recorded after.

use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::archive::{EventArchive, WriteFailure};
use crate::team_bus::TeamBusConnection;
use crate::{EventKind, RunEvent};

/// One dense, serialized event stream shared by every agent in a team run.
#[derive(Clone)]
pub(crate) struct EventLog {
    inner: Arc<EventLogInner>,
}

struct EventLogInner {
    archive: EventArchive,
    session_id: String,
    next_seq: Mutex<u64>,
    /// A write the archive's writer could not make, reported by the next append. Appends hand
    /// events to the writer without waiting for the row, so this is where a failure surfaces.
    failure: Arc<WriteFailure>,
}

impl EventLog {
    pub(crate) fn new(archive: EventArchive, session_id: String) -> Self {
        Self {
            inner: Arc::new(EventLogInner {
                archive,
                session_id,
                next_seq: Mutex::new(0),
                failure: Arc::default(),
            }),
        }
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    /// The archive this log writes to.
    pub(crate) fn archive(&self) -> &EventArchive {
        &self.inner.archive
    }

    /// How many events this log has appended, i.e. the archive `seq` high-water mark for the run.
    ///
    /// A checkpoint records it so a continuation can say exactly how much evidence the checkpoint
    /// covers, rather than implying it covers everything.
    pub(crate) async fn events_appended(&self) -> u64 {
        *self.inner.next_seq.lock().await
    }

    /// Append the run's next event.
    ///
    /// The event gets the next `seq` and is handed to the archive's writer under the same lock,
    /// so events are written in `seq` order. It returns before the row is written: every read of
    /// the archive flushes first, and a live stream is woken when the row commits, so nothing
    /// reads around it, and a write that fails is returned by the next append.
    ///
    /// The id is a time-ordered UUID (v7), so each new row lands at the end of the archive's
    /// primary key instead of on a random page of it, which is most of what an insert costs once
    /// the history is large.
    pub(crate) async fn append(
        &self,
        agent_id: &str,
        kind: EventKind,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<()> {
        self.append_event(new_event_id(), agent_id, kind, payload, raw)
            .await
    }

    /// Append an event under an id the caller already minted.
    ///
    /// The operator's answer needs this: `POST /api/runs/{id}/answers` has to be able to stamp
    /// `operator_questions.answer_event_id` with the id of the `message` event the run task is
    /// about to write, and the run task is the only thing that may write it — the archive `seq` is
    /// this log's counter, and a second log over the same session would restart it at zero.
    pub(crate) async fn append_with_id(
        &self,
        id: &str,
        agent_id: &str,
        kind: EventKind,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<()> {
        self.append_event(id.to_owned(), agent_id, kind, payload, raw)
            .await
    }

    async fn append_event(
        &self,
        id: String,
        agent_id: &str,
        kind: EventKind,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<()> {
        let mut next_seq = self.inner.next_seq.lock().await;
        self.inner.failure.check()?;
        self.inner
            .archive
            .enqueue(
                RunEvent {
                    id,
                    session_id: self.inner.session_id.clone(),
                    agent_id: agent_id.to_owned(),
                    seq: *next_seq,
                    ts: Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true),
                    kind,
                    payload,
                    raw,
                },
                &self.inner.failure,
            )
            .await?;
        *next_seq += 1;
        Ok(())
    }
}

/// A new run event id: a UUID whose leading bits are the time it was made (v7).
///
/// `run_events.id` is the table's primary key, so where a new id sorts is where its row goes. A
/// random (v4) id put every insert on a random page of a key that grows with the whole history;
/// measured on 1.5 million rows, batches were about 19 times slower and wrote about 12 times
/// more to the write-ahead log than with time-ordered ids. Ids already archived as v4 stay valid:
/// nothing reads meaning into an id beyond equality.
pub(crate) fn new_event_id() -> String {
    Uuid::now_v7().to_string()
}

/// An agent's reply, assembled from the message chunks it streamed.
///
/// Chunks of one message are joined verbatim: they are tokens of the same sentence. Separate
/// messages are a paragraph apart. An agent that narrates between tool calls ("Reading the
/// template…", then "Draft builds…") sends each note as its own message, and joining those
/// verbatim ran them into one line of the team's output. `messageId` says which message a chunk
/// belongs to and is authoritative when both sides carry one; without it, tool, plan and
/// permission activity is the boundary.
///
/// A message the harness marks as commentary ([`commentary`]) asked for tool calls, so its words
/// were said on the way ("Paths are relative to the work folder; I'll use the full paths."), not
/// the answer. The reply leaves those out, unless they are all the agent said.
///
/// `ui/src/lib/watch/replyText.ts` applies the same rule to the archive. The two must agree, or a
/// saved reply stops matching the archived turn it came from.
#[derive(Debug, Default)]
pub(crate) struct ReplyText {
    /// Everything the agent said.
    text: String,
    /// The finished messages not said on the way, a paragraph apart.
    answer: String,
    /// The message being written, until the next one shows it wasn't said on the way.
    current: String,
    /// A message was said on the way, so the reply is [`Self::answer`].
    set_aside: bool,
    message_id: Option<String>,
    boundary: bool,
}

impl ReplyText {
    pub(crate) fn push(&mut self, chunk: &str, message_id: Option<&str>) {
        if chunk.is_empty() {
            return;
        }
        let new_message = match (self.message_id.as_deref(), message_id) {
            (Some(previous), Some(current)) => previous != current,
            _ => self.boundary,
        };
        if new_message && !self.text.is_empty() {
            let have = trailing_newlines(&self.text) + leading_newlines(chunk);
            for _ in have..2 {
                self.text.push('\n');
            }
            let finished = std::mem::take(&mut self.current);
            paragraph(&mut self.answer, &finished);
        }
        self.text.push_str(chunk);
        self.current.push_str(chunk);
        self.message_id = message_id.map(str::to_owned);
        self.boundary = false;
    }

    /// The agent did something other than talk, so whatever it says next is a new message.
    pub(crate) fn note_activity(&mut self) {
        self.boundary = true;
    }

    /// The message `message_id` asked for tool calls: its words were said on the way.
    pub(crate) fn set_aside(&mut self, message_id: &str) {
        if self.message_id.as_deref() == Some(message_id) {
            self.current.clear();
            self.set_aside = true;
        }
    }

    /// A turn ended: the next chunk starts a new message even if it reuses the id.
    pub(crate) fn end_message(&mut self) {
        self.message_id = None;
        self.boundary = true;
    }

    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    /// Everything the agent said, the words on the way included.
    pub(crate) fn said(&self) -> &str {
        &self.text
    }

    /// The reply: what the agent said but its words on the way, or those too when they are all.
    pub(crate) fn reply(&self) -> String {
        if !self.set_aside {
            return self.text.clone();
        }
        let mut answer = self.answer.clone();
        paragraph(&mut answer, &self.current);
        if answer.trim().is_empty() {
            self.text.clone()
        } else {
            answer
        }
    }

    pub(crate) fn take(&mut self) -> String {
        let reply = self.reply();
        self.clear();
        reply
    }
}

/// The message a `commentary` note names: one the agent wrote alongside tool calls
/// (`agent::events::commentary`), as it arrives and as it is archived.
pub(crate) fn commentary(update: &Value) -> Option<&str> {
    (update["sessionUpdate"] == "agent_message_phase" && update["phase"] == "commentary")
        .then(|| update["messageId"].as_str())
        .flatten()
}

/// `next` after `text`, a paragraph apart.
fn paragraph(text: &mut String, next: &str) {
    if next.is_empty() {
        return;
    }
    if !text.is_empty() {
        let have = trailing_newlines(text) + leading_newlines(next);
        for _ in have..2 {
            text.push('\n');
        }
    }
    text.push_str(next);
}

fn trailing_newlines(text: &str) -> usize {
    text.bytes().rev().take_while(|byte| *byte == b'\n').count()
}

fn leading_newlines(text: &str) -> usize {
    text.bytes().take_while(|byte| *byte == b'\n').count()
}

/// What is recorded about one agent's session: its events, the reply it is writing, and the skills
/// it was given, so an open of one of them can be recognised.
pub(crate) struct Recorder {
    pub(crate) required_skills: Vec<crate::workspace::PreparedSkill>,
    /// What was delivered to this agent, kept for the whole session so an open can be recognised
    /// on any turn. `required_skills` is taken by the first prompt — it is the *send* receipt — so
    /// it cannot also be the table an open is matched against.
    delivered_skills: Vec<DeliveredSkill>,
    pub(crate) reply: ReplyText,
    pub(crate) event_log: EventLog,
    pub(crate) session_id: String,
    agent_id: String,
    /// What "Send now" pulls while this agent works on the operator's task (ADR 0051). Listened to
    /// only during a work turn: a handover or checkpoint is the coordinator's turn, not the task,
    /// and cutting one short would lose what the next stage reads.
    pub(crate) interrupt: Option<Arc<crate::runs::Interrupt>>,
    /// This session's Team Bus connection, told when each turn ends so an `ask` the turn left in
    /// flight is withdrawn rather than answered for nobody.
    pub(crate) bus: Option<TeamBusConnection>,
}

/// One delivered skill, as the open-detector needs it.
///
/// `docs/RUN_PROVENANCE_CONTRACT.md` §12 is explicit that "prompt/filesystem presence is not use":
/// a skill observation needs an identity, a fingerprint and an *invocation or open event*. This
/// carries the first two so that when the third arrives it can be recorded as evidence rather
/// than inferred.
#[derive(Debug, Clone)]
struct DeliveredSkill {
    name: String,
    /// The delivered `SKILL.md`, normalized to forward slashes for comparison.
    path: String,
    sha256: String,
    /// Whether this agent was given a translation note, which is the only thing that asks it for
    /// a "could not follow" list. Without one, a phrase in the reply is ordinary prose.
    translated: bool,
    /// One `skill_opened` record per skill per session. The fact is "the agent opened it", and a
    /// tool call plus its update would otherwise archive that fact twice.
    opened: bool,
}

impl Recorder {
    pub(crate) fn with_log(event_log: EventLog, session_id: String, agent_id: &str) -> Self {
        Self {
            event_log,
            session_id,
            agent_id: agent_id.to_owned(),
            reply: ReplyText::default(),
            required_skills: Vec::new(),
            delivered_skills: Vec::new(),
            interrupt: None,
            bus: None,
        }
    }

    /// Record what was delivered, so an open of one of these files can be recognised later.
    pub(crate) fn note_delivery(&mut self, skills: &[crate::workspace::PreparedSkill]) {
        self.required_skills = skills.to_vec();
        self.delivered_skills = skills
            .iter()
            .map(|skill| DeliveredSkill {
                name: skill.name.clone(),
                path: skill.path.replace('\\', "/"),
                sha256: skill.sha256.clone(),
                translated: skill.translation.is_some(),
                opened: false,
            })
            .collect();
    }

    /// Archive the fact that the agent opened a delivered skill, once per skill.
    ///
    /// The record is `session_meta` with `raw.source: loomwatch`, exactly like
    /// `required_skills_supplied`: an additive phase on an existing event kind, so the frozen
    /// WebSocket schema is untouched (`docs/WEBSOCKET_SCHEMA.md` — `session_meta` phases are an
    /// open set by construction).
    async fn note_skill_opened(&mut self, index: usize, call_id: Option<&Value>) -> Result<()> {
        let Some(skill) = self
            .delivered_skills
            .get_mut(index)
            .filter(|skill| !skill.opened)
        else {
            return Ok(());
        };
        skill.opened = true;
        let payload = json!({
            "phase": "skill_opened",
            "skill": skill.name,
            "path": skill.path,
            "sha256": skill.sha256,
            "toolCallId": call_id.cloned().unwrap_or(Value::Null),
        });
        self.append(
            EventKind::SessionMeta,
            payload,
            Some(json!({"source": "loomwatch", "phase": "skill_opened"})),
        )
        .await
    }

    /// Archive the agent's own account of what it could not follow.
    ///
    /// **Never provenance.** It is the agent describing itself, which §8.2's "capture adapters
    /// MUST report explicit facts only" excludes from the evidence graph. It is archived under
    /// its own phase so the UI can show it as a self-report and nothing can mistake it for one.
    pub(crate) async fn note_self_report(&mut self) -> Result<()> {
        if !self.delivered_skills.iter().any(|skill| skill.translated) {
            return Ok(());
        }
        let Some(text) = crate::skill_routing::self_report(self.reply.said()) else {
            return Ok(());
        };
        self.append(
            EventKind::SessionMeta,
            json!({
                "phase": "skill_self_report",
                "text": text,
                "chars": text.chars().count(),
            }),
            Some(json!({"source": "loomwatch", "phase": "skill_self_report"})),
        )
        .await
    }

    /// Which delivered skill, if any, this tool event opened: a read whose path is one of the
    /// delivered files. A title that merely mentions a skill, a folder listing, or a read of the
    /// source copy outside the agent's workspace are all rejected — presence is not use.
    fn opened_skill(&self, update: &Value) -> Option<usize> {
        let paths = tool_paths(update);
        self.delivered_skills.iter().position(|skill| {
            paths
                .iter()
                .any(|path| path == &skill.path || managed_skill_path_matches(path, &skill.name))
        })
    }

    /// Record one message the agent produced: a `session/update` notification, or a permission
    /// request or its answer.
    pub(crate) async fn record_frame(&mut self, message: &Value) -> Result<()> {
        if let Some(payload) = permission_payload(message) {
            self.reply.note_activity();
            return self
                .append(EventKind::Permission, payload, Some(message.clone()))
                .await;
        }

        if message.get("method").and_then(Value::as_str) != Some("session/update") {
            return Ok(());
        }
        if let Some(session_id) = message.pointer("/params/sessionId").and_then(Value::as_str)
            && session_id != self.session_id
        {
            return Ok(());
        }
        let Some(update) = message.pointer("/params/update") else {
            return self
                .append(
                    EventKind::SessionMeta,
                    unprojected_update(None, "session/update omitted update"),
                    Some(message.clone()),
                )
                .await;
        };
        let update_type = update.get("sessionUpdate").and_then(Value::as_str);
        let (kind, payload) = match update_type {
            Some("user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk") => {
                let role = match update_type {
                    Some("user_message_chunk") => "user",
                    Some("agent_thought_chunk") => "thought",
                    _ => "agent",
                };
                let mut payload = serde_json::Map::new();
                payload.insert("role".into(), json!(role));
                let Some(content) = update.get("content").cloned() else {
                    return self
                        .append(
                            EventKind::SessionMeta,
                            unprojected_update(Some(update), "content chunk omitted content"),
                            Some(message.clone()),
                        )
                        .await;
                };
                if role == "agent"
                    && let Some(text) = content.get("text").and_then(Value::as_str)
                {
                    let message_id = update.get("messageId").and_then(Value::as_str);
                    self.reply.push(text, message_id);
                }
                payload.insert("content".into(), content);
                if let Some(message_id) = update.get("messageId") {
                    payload.insert("messageId".into(), message_id.clone());
                }
                let kind = if role == "thought" {
                    EventKind::Thought
                } else {
                    EventKind::Message
                };
                (kind, Value::Object(payload))
            }
            Some("tool_call") => match project_tool(update, true) {
                Ok(payload) => (EventKind::ToolCall, payload),
                Err(error) => (
                    EventKind::SessionMeta,
                    unprojected_update(Some(update), &format!("{error:#}")),
                ),
            },
            Some("tool_call_update") => match project_tool(update, false) {
                Ok(payload) => (EventKind::ToolUpdate, payload),
                Err(error) => (
                    EventKind::SessionMeta,
                    unprojected_update(Some(update), &format!("{error:#}")),
                ),
            },
            Some("plan" | "plan_update" | "plan_removed") => (EventKind::Plan, update.clone()),
            Some("agent_message_phase") => {
                if let Some(message_id) = commentary(update) {
                    self.reply.set_aside(message_id);
                }
                (EventKind::SessionMeta, update.clone())
            }
            Some("usage_update") => (EventKind::Usage, update.clone()),
            Some(_) | None => (EventKind::SessionMeta, update.clone()),
        };
        if matches!(
            kind,
            EventKind::ToolCall | EventKind::ToolUpdate | EventKind::Plan
        ) {
            self.reply.note_activity();
        }
        self.append(kind, payload, Some(message.clone())).await?;
        self.note_open_if_delivered(update_type, update).await
    }

    /// The delivery receipt says what `LoomWatch` supplied. This says whether the agent actually
    /// went and read it — the one thing the run record could not say before (ADR 0021).
    ///
    /// Called *after* the tool event is archived so the archive reads in the order it happened:
    /// the call, then what `LoomWatch` concluded from it.
    async fn note_open_if_delivered(
        &mut self,
        update_type: Option<&str>,
        update: &Value,
    ) -> Result<()> {
        if !matches!(update_type, Some("tool_call" | "tool_call_update")) {
            return Ok(());
        }
        if let Some(index) = self.opened_skill(update) {
            self.note_skill_opened(index, update.get("toolCallId"))
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn append(
        &mut self,
        kind: EventKind,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<()> {
        self.event_log
            .append(&self.agent_id, kind, payload, raw)
            .await
    }
}

/// The payload to archive when a frame is about a permission decision, or `None`.
///
/// Two shapes, one meaning: the agent's `session/request_permission` (what was asked), and
/// `LoomWatch`'s own reply to it — no `method`, carrying the outcome chosen (what was decided).
/// Both are archived so the record shows the decision, not only the question.
fn permission_payload(message: &Value) -> Option<Value> {
    if message.get("method").and_then(Value::as_str) == Some("session/request_permission") {
        return Some(message.get("params").cloned().unwrap_or_else(|| json!({})));
    }
    if message.get("method").is_none()
        && message.get("id").is_some()
        && message.pointer("/result/outcome").is_some()
    {
        return Some(message.get("result").cloned().unwrap_or_else(|| json!({})));
    }
    None
}

/// Every file path a tool event names, normalized to forward slashes: its `locations` first,
/// then the input keys a tool may name a file by.
fn tool_paths(update: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(locations) = update.get("locations").and_then(Value::as_array) {
        paths.extend(
            locations
                .iter()
                .filter_map(|location| location.get("path").and_then(Value::as_str))
                .map(|path| path.replace('\\', "/")),
        );
    }
    if let Some(input) = update.get("rawInput").and_then(Value::as_object) {
        for key in ["path", "file_path", "filePath", "target"] {
            if let Some(path) = input.get(key).and_then(Value::as_str) {
                paths.push(path.replace('\\', "/"));
            }
        }
    }
    paths
}

/// Whether a path is `<something>/<managed root>/<name>/SKILL.md` for one of the roots
/// `workspace::materialise` delivers to.
///
/// Needed beside the exact-path test because an agent may name a path relative to its work
/// folder, or canonicalised through a symlinked temporary folder, and a string comparison against
/// the absolute delivered path would then miss a real open. Only the managed roots count: the
/// copy in `LoomWatch`'s own skills folder is not what this run delivered, and reading it proves
/// nothing about the bytes the receipt fingerprints.
fn managed_skill_path_matches(path: &str, name: &str) -> bool {
    let parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let [root, skills, directory, file] = parts[parts.len().saturating_sub(4)..] else {
        return false;
    };
    (root == ".claude" || root == ".agents")
        && skills == "skills"
        && directory == name
        && file == "SKILL.md"
}

fn unprojected_update(update: Option<&Value>, warning: &str) -> Value {
    json!({
        "phase": "unprojected_session_update",
        "warning": warning,
        "update": update.cloned().unwrap_or(Value::Null)
    })
}

fn project_tool(update: &Value, initial: bool) -> Result<Value> {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "callId".into(),
        update
            .get("toolCallId")
            .cloned()
            .context("tool event omitted toolCallId")?,
    );
    if initial {
        payload.insert(
            "title".into(),
            update
                .get("title")
                .cloned()
                .context("tool_call omitted title")?,
        );
    }
    for (source, target) in [
        ("title", "title"),
        ("name", "name"),
        ("kind", "toolKind"),
        ("status", "status"),
        ("rawInput", "rawInput"),
        ("rawOutput", "rawOutput"),
        ("content", "content"),
        ("locations", "locations"),
    ] {
        if let Some(value) = update.get(source) {
            payload.insert(target.into(), value.clone());
        }
    }
    Ok(Value::Object(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Event ids sort in the order they were made, so new rows go at the end of the archive's
    /// primary key; and they are still UUIDs in the same text form as the v4 ids already stored.
    #[test]
    fn event_ids_are_time_ordered_uuids() {
        let ids: Vec<String> = (0..1000).map(|_| new_event_id()).collect();
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]), "{ids:?}");
        for id in &ids {
            let parsed = Uuid::parse_str(id).expect("an event id is a UUID");
            assert_eq!(parsed.get_version_num(), 7);
            assert_eq!(parsed.to_string(), *id, "the usual hyphenated form");
        }
    }

    #[test]
    fn separate_messages_are_a_paragraph_apart_and_chunks_of_one_join() {
        let mut reply = ReplyText::default();
        reply.push("Reading the ", Some("m1"));
        reply.push("template…", Some("m1"));
        reply.push("Draft builds.", Some("m2"));
        reply.note_activity();
        reply.push("Done.", None);
        assert_eq!(
            reply.take(),
            "Reading the template…\n\nDraft builds.\n\nDone."
        );
    }

    /// A message marked as said on the way to a tool call is left out of the reply, and the
    /// messages around it keep their paragraphs. A reply with nothing else keeps everything, and
    /// a mark for a message that isn't the latest changes nothing.
    #[test]
    fn words_said_on_the_way_to_a_tool_are_left_out_of_the_reply() {
        let mut reply = ReplyText::default();
        reply.push("Paths are relative to the work folder; ", Some("m1"));
        reply.push("I'll use the full paths.", Some("m1"));
        reply.set_aside("m1");
        reply.note_activity();
        reply.push("Basic costs ", Some("m2"));
        reply.push("139,000 VND.", Some("m2"));
        reply.set_aside("m1");
        reply.push("Team costs 349,000 VND.", Some("m3"));
        assert_eq!(
            reply.said(),
            "Paths are relative to the work folder; I'll use the full paths.\n\nBasic costs \
             139,000 VND.\n\nTeam costs 349,000 VND."
        );
        assert_eq!(
            reply.take(),
            "Basic costs 139,000 VND.\n\nTeam costs 349,000 VND."
        );

        reply.push("I'll read the notes first.", Some("m1"));
        reply.set_aside("m1");
        reply.push("Now the prices.", Some("m2"));
        reply.set_aside("m2");
        assert_eq!(
            reply.take(),
            "I'll read the notes first.\n\nNow the prices.",
            "words on the way are better than no reply"
        );
    }

    /// The harness's mark is archived with the run, every word stays in the record, and only the
    /// reply leaves out what was said on the way.
    #[tokio::test]
    async fn a_marked_message_stays_in_the_record_and_out_of_the_reply() {
        let archive = EventArchive::new(crate::db::Db::temp().await);
        let mut recorder = Recorder::with_log(
            EventLog::new(archive.clone(), "marked".to_owned()),
            "marked".to_owned(),
            "writer",
        );
        let frame = |update: Value| {
            json!({"jsonrpc": "2.0", "method": "session/update",
                   "params": {"sessionId": "marked", "update": update}})
        };
        let chunk = |text: &str, id: &str| {
            json!({"sessionUpdate": "agent_message_chunk", "messageId": id,
                   "content": {"type": "text", "text": text}})
        };
        for update in [
            chunk("Paths are probably absolute.", "marked-1"),
            json!({"sessionUpdate": "agent_message_phase", "messageId": "marked-1",
                   "phase": "commentary"}),
            json!({"sessionUpdate": "tool_call", "toolCallId": "r", "title": "Read prices.md",
                   "kind": "read", "status": "in_progress", "rawInput": {}, "locations": []}),
            chunk("Basic costs 139,000 VND.", "marked-2"),
        ] {
            recorder.record_frame(&frame(update)).await.unwrap();
        }
        assert_eq!(recorder.reply.take(), "Basic costs 139,000 VND.");
        let events = archive.load_verified_session("marked").await.unwrap();
        let kinds: Vec<_> = events.iter().map(|event| event.kind).collect();
        assert_eq!(
            kinds,
            [
                EventKind::Message,
                EventKind::SessionMeta,
                EventKind::ToolCall,
                EventKind::Message
            ]
        );
        assert_eq!(commentary(&events[1].payload), Some("marked-1"));
        assert_eq!(
            events[0].payload["content"]["text"],
            "Paths are probably absolute."
        );
    }

    #[test]
    fn only_a_managed_copy_of_a_skill_counts_as_opened() {
        assert!(managed_skill_path_matches(
            "/w/.agents/skills/writer/SKILL.md",
            "writer"
        ));
        assert!(managed_skill_path_matches(
            ".claude/skills/writer/SKILL.md",
            "writer"
        ));
        assert!(!managed_skill_path_matches(
            "/state/skills/writer/SKILL.md",
            "writer"
        ));
        assert!(!managed_skill_path_matches(
            "/w/.agents/skills/editor/SKILL.md",
            "writer"
        ));
    }
}
