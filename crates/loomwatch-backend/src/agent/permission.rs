//! Asking before acting.
//!
//! Every read, edit, command and fetch a built-in agent makes goes through [`Permissions`] first.
//! The daemon answers with the same policy it applied to apps: the agent's `allow` switches, its
//! folders, Auto mode and, when those don't decide, the operator's card. Most reads inside the
//! agent's folder are approved on the spot, without a card.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::BoxFuture;
use super::events::{ToolKind, locations_json};

/// One thing an agent wants to do.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    pub session_id: String,
    pub tool_call_id: String,
    /// What the card says, such as "Run: npm test".
    pub title: String,
    pub kind: ToolKind,
    /// The tool's arguments. For a command, `command` is the command line.
    pub input: Value,
    /// Every file or folder it touches.
    pub locations: Vec<PathBuf>,
}

impl PermissionRequest {
    /// The request as the daemon's permission policy and Auto mode read one: a
    /// `session/request_permission` message offering "allow once" and "reject once", and the
    /// operator's answer in the agent's place, which runs nothing either.
    #[must_use]
    pub fn as_message(&self) -> Value {
        json!({
            "jsonrpc": "2.0",
            "method": "session/request_permission",
            "params": {
                "sessionId": self.session_id,
                "toolCall": {
                    "toolCallId": self.tool_call_id,
                    "title": self.title,
                    "kind": self.kind.as_str(),
                    "rawInput": self.input,
                    "locations": locations_json(&self.locations),
                },
                "options": [
                    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "deny", "name": "Decline", "kind": "reject_once"},
                    {"optionId": "answer", "name": "Answered instead", "kind": "reject_once"},
                ],
            },
        })
    }
}

/// The answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Allow,
    /// Allowed after the operator changed the arguments, such as a corrected command.
    AllowEdited(Value),
    Deny,
    /// The operator answered in words instead; the agent reads this as the tool's result.
    Answer(String),
}

/// Who answers. The daemon's implementation applies its policy and shows cards.
pub trait Permissions: Send + Sync {
    fn request<'a>(&'a self, request: &'a PermissionRequest) -> BoxFuture<'a, Decision>;
}

/// Approves everything. For tests, and for nothing else.
#[derive(Debug, Clone, Copy, Default)]
pub struct AllowAll;

impl Permissions for AllowAll {
    fn request<'a>(&'a self, _request: &'a PermissionRequest) -> BoxFuture<'a, Decision> {
        Box::pin(async { Decision::Allow })
    }
}

/// Declines everything: an agent that may only talk and use the daemon's own tools.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyAll;

impl Permissions for DenyAll {
    fn request<'a>(&'a self, _request: &'a PermissionRequest) -> BoxFuture<'a, Decision> {
        Box::pin(async { Decision::Deny })
    }
}
