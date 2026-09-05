//! Single-agent ACP execution and durable event archiving for `LoomWatch`.

#![forbid(unsafe_code)]

pub mod acp;
pub mod archive;
pub mod config;

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::{AcpProcess, ProcessSpec};
use crate::archive::EventArchive;
use crate::config::TeamConfig;

/// One durable event in replay order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub id: String,
    pub session_id: String,
    pub agent_id: String,
    pub seq: u64,
    pub ts: String,
    pub kind: EventKind,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

/// Stable Phase-02 event categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Message,
    Thought,
    ToolCall,
    ToolUpdate,
    Plan,
    Permission,
    SessionMeta,
    Usage,
    TurnEnd,
    Process,
}

impl EventKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Thought => "thought",
            Self::ToolCall => "tool_call",
            Self::ToolUpdate => "tool_update",
            Self::Plan => "plan",
            Self::Permission => "permission",
            Self::SessionMeta => "session_meta",
            Self::Usage => "usage",
            Self::TurnEnd => "turn_end",
            Self::Process => "process",
        }
    }
}

/// Result returned after the harness exits and the archive is flushed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionOutcome {
    pub session_id: String,
    pub event_count: usize,
    pub exit_code: i32,
}

/// Load a team, run its entrypoint through ACP, and archive the session.
///
/// # Errors
///
/// Returns an error when configuration, process, protocol, or archive handling fails.
pub async fn run_team_session(
    team_path: &Path,
    database_path: &Path,
    prompt: &str,
    exit_timeout: Duration,
) -> Result<SessionOutcome> {
    let team = TeamConfig::load(team_path)?;
    let agent = team.entrypoint_agent()?;
    let cwd = resolve_cwd(team_path, &agent.spawn.cwd)?;
    let spec = ProcessSpec {
        cmd: agent.spawn.cmd.clone(),
        args: agent.spawn.args.clone(),
        env: agent.spawn.env.clone(),
        cwd,
    };

    let archive = EventArchive::open(database_path)?;
    let mut process = AcpProcess::spawn(&spec)
        .with_context(|| format!("failed to spawn ACP harness for agent {}", agent.id))?;
    process
        .run_session(&agent.id, &agent.model, prompt, &archive, exit_timeout)
        .await
}

fn resolve_cwd(team_path: &Path, cwd: &Path) -> Result<PathBuf> {
    let resolved = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        team_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(cwd)
    };
    resolved
        .canonicalize()
        .with_context(|| format!("failed to resolve harness cwd {}", resolved.display()))
}
