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

/// Says the model's message `message_id` asked for tool calls, so its words were said on the way
/// ("I'll read the notes first."), not the answer. Sent once the message is whole: its words stream
/// before its calls do. A part of a message the provider's own search ended ("Let me check the
/// prices.", `provider::Parts`) is marked the same way, as the words after the search begin. The
/// run's record keeps them; the reply leaves them out (`engine::ReplyText`).
pub(crate) fn commentary(message_id: &str) -> Value {
    json!({
        "sessionUpdate": "agent_message_phase",
        "messageId": message_id,
        "phase": "commentary",
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
/// One model call, as its usage record names it.
pub(crate) struct CallRecord<'a> {
    /// `work`, `carry_on`, `summary` or `bare_summary`.
    pub call: &'a str,
    /// What the turn is for: `work`, `handover`, `checkpoint`, `check`, `ask_answer`, `helper`,
    /// `revision`.
    pub turn: &'a str,
    pub model: &'a str,
    pub usage: &'a super::provider::Usage,
}

/// How full the context is and what the session has cost, after one model call, with that call's
/// own record in `_meta.loomwatch.call`: what it was for, its tokens by kind, its cost and the web
/// searches and reads the provider ran. A provider that leaves a figure out gets a zero.
pub(crate) fn usage_update(
    used: u64,
    size: Option<u64>,
    cost_usd: f64,
    call: &CallRecord<'_>,
) -> Value {
    let usage = call.usage;
    let mut update = json!({
        "sessionUpdate": "usage_update",
        "used": used,
        "cost": {"amount": cost_usd, "currency": "USD"},
        "_meta": {"loomwatch": {"call": {
            "kind": call.call,
            "turn": call.turn,
            "model": call.model,
            "inputTokens": usage.input_tokens,
            "cachedReadTokens": usage.cached_read_tokens,
            "cachedWriteTokens": usage.cached_write_tokens,
            "outputTokens": usage.output_tokens,
            "reasoningTokens": usage.reasoning_tokens,
            "costUsd": usage.cost_usd,
            "webSearches": usage.web_searches,
            "webFetches": usage.web_fetches,
        }}},
    });
    if let Some(size) = size {
        update["size"] = json!(size);
    }
    mark_payer(&mut update["_meta"]["loomwatch"]["call"], usage);
    update
}

/// Who paid for a usage that `OpenRouter` didn't, so the app says "`ChatGPT` plan" rather than $0,
/// and "≈" before a cost worked out from list prices. Nothing is added for `OpenRouter`, so records
/// from before other sources read as they always did.
pub(crate) fn mark_payer(record: &mut Value, usage: &super::provider::Usage) {
    if let Some(source) = usage.paid_by {
        record["paidBy"] = json!(source);
    }
    if usage.cost_estimated {
        record["costEstimated"] = json!(true);
    }
}

pub(crate) fn locations_json(locations: &[PathBuf]) -> Value {
    Value::Array(
        locations
            .iter()
            .map(|path| json!({"path": path.to_string_lossy()}))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::super::provider::Usage;
    use super::super::session::{StopReason, TurnEnd};
    use super::*;
    use crate::ai::Source;

    /// A plan's call says it was the plan's, a Claude cost says it was worked out, and an
    /// `OpenRouter` call reads as every record before other sources did.
    #[test]
    fn a_cost_says_who_paid_it() {
        let plan = Usage {
            output_tokens: 10,
            paid_by: Some(Source::ChatGpt),
            ..Usage::default()
        };
        let claude = Usage {
            cost_usd: 0.12,
            paid_by: Some(Source::Anthropic),
            cost_estimated: true,
            ..Usage::default()
        };
        let record = |usage: &Usage| {
            usage_update(
                1,
                None,
                usage.cost_usd,
                &CallRecord {
                    call: "work",
                    turn: "work",
                    model: "m",
                    usage,
                },
            )["_meta"]["loomwatch"]["call"]
                .clone()
        };
        assert_eq!(record(&plan)["paidBy"], "chatgpt");
        assert_eq!(record(&plan)["costUsd"], 0.0);
        assert_eq!(record(&claude)["paidBy"], "anthropic");
        assert_eq!(record(&claude)["costEstimated"], true);
        let openrouter = record(&Usage::default());
        assert!(openrouter.get("paidBy").is_none() && openrouter.get("costEstimated").is_none());

        let end = TurnEnd {
            stop_reason: StopReason::EndTurn,
            usage: plan,
            reply: String::new(),
        };
        assert_eq!(end.as_result()["_meta"]["loomwatch"]["paidBy"], "chatgpt");
        // A record written before the field existed still reads.
        let old: Usage = serde_json::from_value(json!({
            "inputTokens": 1, "cachedReadTokens": 0, "cachedWriteTokens": 0, "outputTokens": 2,
            "reasoningTokens": 0, "costUsd": 0.5
        }))
        .unwrap();
        assert_eq!((old.paid_by, old.cost_estimated), (None, false));
    }
}
