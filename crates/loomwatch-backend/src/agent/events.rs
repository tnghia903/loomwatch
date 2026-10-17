//! What a session reports, in the update shapes the run archive stores.
//!
//! The archive has always recorded an agent's work as `session/update` objects: a
//! `sessionUpdate` kind plus its fields (`schemas/team.schema.yaml` checks them, and the app reads
//! them). The built-in agent writes the same objects, so a run on it reads exactly like a run on
//! an app: the same message, thought, tool, plan and usage events.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::BoxFuture;

/// Where a session's events go. The daemon's implementation writes them to the run archive.
pub trait EventSink: Send + Sync {
    /// One update, such as `{"sessionUpdate": "agent_message_chunk", "content": {…}}`.
    ///
    /// # Errors
    ///
    /// When it cannot be recorded. The turn stops: a run must not go on unrecorded.
    fn update(&self, update: Value) -> BoxFuture<'_, anyhow::Result<()>>;
}

/// What a tool call does, as the archive's `toolKind` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Read,
    Edit,
    Search,
    Execute,
    Think,
    Fetch,
    Other,
}

impl ToolKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Edit => "edit",
            Self::Search => "search",
            Self::Execute => "execute",
            Self::Think => "think",
            Self::Fetch => "fetch",
            Self::Other => "other",
        }
    }
}

/// Where a tool call stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    InProgress,
    Completed,
    Failed,
}

impl ToolStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// A piece of the agent's reply. `message_id` marks which message it belongs to, so separate
/// messages stay separate paragraphs in the team's output.
pub(crate) fn message_chunk(text: &str, message_id: &str) -> Value {
    json!({
        "sessionUpdate": "agent_message_chunk",
        "messageId": message_id,
        "content": {"type": "text", "text": text},
    })
}

/// A piece of the model's visible reasoning.
pub(crate) fn thought_chunk(text: &str) -> Value {
    json!({
        "sessionUpdate": "agent_thought_chunk",
        "content": {"type": "text", "text": text},
    })
}

/// A tool call starting.
pub(crate) fn tool_call(
    id: &str,
    title: &str,
    kind: ToolKind,
    input: &Value,
    locations: &[PathBuf],
) -> Value {
    json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "title": title,
        "kind": kind.as_str(),
        "status": ToolStatus::InProgress.as_str(),
        "rawInput": input,
        "locations": locations_json(locations),
    })
}

/// A tool call ending, with what it gave back (shortened for the record by the caller).
pub(crate) fn tool_update(id: &str, status: ToolStatus, output: &str) -> Value {
    json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": id,
        "status": status.as_str(),
        "content": [{"type": "content", "content": {"type": "text", "text": output}}],
    })
}

/// The agent's todo list, whole, each time it changes.
pub(crate) fn plan(entries: &[(String, String)]) -> Value {
    json!({
        "sessionUpdate": "plan",
        "entries": entries
            .iter()
            .map(|(content, status)| json!({"content": content, "status": status, "priority": "medium"}))
            .collect::<Vec<_>>(),
    })
}

/// How full the model's context is and what the session has cost so far.
pub(crate) fn usage_update(used: u64, size: Option<u64>, cost_usd: f64) -> Value {
    let mut update = json!({
        "sessionUpdate": "usage_update",
        "used": used,
        "cost": {"amount": cost_usd, "currency": "USD"},
    });
    if let Some(size) = size {
        update["size"] = json!(size);
    }
    update
}

pub(crate) fn locations_json(locations: &[PathBuf]) -> Value {
    Value::Array(
        locations
            .iter()
            .map(|path| json!({"path": path.to_string_lossy()}))
            .collect(),
    )
}
