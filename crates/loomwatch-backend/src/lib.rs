//! Single-agent ACP execution and durable event archiving for `LoomWatch`.

#![forbid(unsafe_code)]

pub mod acp;
pub mod api;
pub mod archive;
pub mod config;
mod team_bus;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::{AcpProcess, EventLog, ProcessSpec, TeamSessionContext};
use crate::archive::EventArchive;
use crate::config::TeamConfig;
use crate::team_bus::{TeamBus, TeamBusMode};

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

/// Load a team and run it: team mode (empty `edges`) lets the entrypoint self-organize
/// through the fully exposed Team Bus; pipeline mode (non-empty `edges`) has the backend
/// drive each node's turn in topological order instead — see ARCHITECTURE.md §4.
///
/// # Errors
///
/// Returns an error when configuration, process, protocol, or archive handling fails.
pub async fn run_team_session(
    team_path: &Path,
    database_url: &str,
    prompt: &str,
    exit_timeout: Duration,
) -> Result<SessionOutcome> {
    let team = Arc::new(TeamConfig::load(team_path)?);
    let archive = EventArchive::connect(database_url).await?;
    if team.edges.is_empty() {
        run_team_mode(&team, team_path, archive, prompt, exit_timeout).await
    } else {
        run_pipeline_mode(&team, team_path, archive, prompt, exit_timeout).await
    }
}

/// Team mode: the entrypoint agent self-organizes through the fully exposed Team Bus.
async fn run_team_mode(
    team: &Arc<TeamConfig>,
    team_path: &Path,
    archive: EventArchive,
    prompt: &str,
    exit_timeout: Duration,
) -> Result<SessionOutcome> {
    let agent = team.entrypoint_agent()?;
    let cwd = resolve_cwd(team_path, &agent.spawn.cwd)?;
    let spec = ProcessSpec {
        cmd: agent.spawn.cmd.clone(),
        args: agent.spawn.args.clone(),
        env: agent.spawn.env.clone(),
        cwd,
    };

    let mut process = AcpProcess::spawn(&spec)
        .with_context(|| format!("failed to spawn ACP harness for agent {}", agent.id))?;
    let bus = TeamBus::start(
        team.clone(),
        team_path,
        archive.clone(),
        exit_timeout,
        TeamBusMode::Team,
    )
    .await?;
    let connection = bus.connection(&agent.id).await?;
    let root = process
        .run_session_with_bus(
            &agent.id,
            &agent.model,
            prompt,
            TeamSessionContext {
                archive: &archive,
                exit_timeout,
                bus: Some(&connection),
                event_log: None,
            },
        )
        .await;
    let delegated = bus.wait_for_tasks().await;
    let shutdown = bus.shutdown().await;
    let mut outcome = root?;
    delegated?;
    shutdown?;
    outcome.event_count = archive.verify_session(&outcome.session_id).await?.len();
    Ok(outcome)
}

/// Pipeline mode: the backend drives each node's turn in the declared topological order.
/// Every node's events land in one dense, ordered archive session — the first node mints
/// it, and each later node reuses the same [`EventLog`] so replay stays continuous across
/// the whole pipeline. The Team Bus is started in [`TeamBusMode::Pipeline`], which
/// withdraws `dispatch`/`handoff` (sequencing isn't the agent's call here) and gates `ask`
/// on the node agent's `allowRecruiting` lock.
async fn run_pipeline_mode(
    team: &Arc<TeamConfig>,
    team_path: &Path,
    archive: EventArchive,
    prompt: &str,
    exit_timeout: Duration,
) -> Result<SessionOutcome> {
    let order = team.pipeline_order()?;
    let bus = TeamBus::start(
        team.clone(),
        team_path,
        archive.clone(),
        exit_timeout,
        TeamBusMode::Pipeline,
    )
    .await?;

    let run = run_pipeline_nodes(
        team,
        team_path,
        &archive,
        &bus,
        &order,
        prompt,
        exit_timeout,
    )
    .await;
    let delegated = bus.wait_for_tasks().await;
    let shutdown = bus.shutdown().await;
    let mut outcome = run?;
    delegated?;
    shutdown?;
    outcome.event_count = archive.verify_session(&outcome.session_id).await?.len();
    Ok(outcome)
}

async fn run_pipeline_nodes(
    team: &Arc<TeamConfig>,
    team_path: &Path,
    archive: &EventArchive,
    bus: &TeamBus,
    order: &[String],
    prompt: &str,
    exit_timeout: Duration,
) -> Result<SessionOutcome> {
    let mut shared_log: Option<EventLog> = None;
    let mut replies: BTreeMap<String, String> = BTreeMap::new();
    let mut outcome: Option<SessionOutcome> = None;

    for (index, agent_id) in order.iter().enumerate() {
        let agent = team
            .agents
            .iter()
            .find(|agent| &agent.id == agent_id)
            .with_context(|| format!("pipeline node {agent_id:?} is not a configured agent"))?;
        let cwd = resolve_cwd(team_path, &agent.spawn.cwd)?;
        let spec = ProcessSpec {
            cmd: agent.spawn.cmd.clone(),
            args: agent.spawn.args.clone(),
            env: agent.spawn.env.clone(),
            cwd,
        };
        let node_prompt = if index == 0 {
            prompt.to_owned()
        } else {
            pipeline_node_prompt(team, agent_id, &replies)
        };
        let start_seq = match &shared_log {
            Some(log) => log.next_seq().await,
            None => 0,
        };
        let mut process = AcpProcess::spawn(&spec).with_context(|| {
            format!("failed to spawn ACP harness for pipeline node {}", agent.id)
        })?;
        let connection = bus.connection(&agent.id).await?;
        let node_outcome = process
            .run_session_with_bus(
                &agent.id,
                &agent.model,
                &node_prompt,
                TeamSessionContext {
                    archive,
                    exit_timeout,
                    bus: Some(&connection),
                    event_log: shared_log.clone(),
                },
            )
            .await
            .with_context(|| format!("pipeline node {} failed", agent.id))?;
        if shared_log.is_none() {
            shared_log = process.event_log();
        }
        if index + 1 < order.len() {
            let reply =
                last_agent_reply(archive, &node_outcome.session_id, &agent.id, start_seq).await?;
            replies.insert(agent_id.clone(), reply);
        }
        outcome = Some(node_outcome);
    }
    outcome.context("pipeline has no nodes to run")
}

/// Build a downstream node's prompt from the replies of its actual configured predecessors,
/// not from whichever node happens to precede it in the linearized run order. A single
/// predecessor's reply is passed through verbatim (this keeps every shipped linear-chain team
/// byte-for-byte compatible); a node with more than one configured predecessor — a DAG join —
/// gets each predecessor's reply labeled and concatenated, in the order their edges are
/// declared in the team file, so no branch is silently dropped.
fn pipeline_node_prompt(
    team: &TeamConfig,
    node_id: &str,
    replies: &BTreeMap<String, String>,
) -> String {
    let predecessors: Vec<&str> = team
        .edges
        .iter()
        .filter(|edge| edge.to == node_id)
        .map(|edge| edge.from.as_str())
        .collect();
    match predecessors.as_slice() {
        [only] => replies.get(*only).cloned().unwrap_or_default(),
        many => many
            .iter()
            .map(|pred| {
                format!(
                    "### From {pred}\n\n{}",
                    replies.get(*pred).map_or("", String::as_str)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}

/// The last `agent`-role message text a given agent produced at or after `start_seq` in one
/// archived session. Used to feed one pipeline node's reply forward as the next node's
/// prompt, and shared with the Team Bus's `ask` tool, which needs the same lookup for a
/// blocking reply.
pub(crate) async fn last_agent_reply(
    archive: &EventArchive,
    session_id: &str,
    agent_id: &str,
    start_seq: u64,
) -> Result<String> {
    let events = archive.load_session(session_id).await?;
    Ok(events
        .iter()
        .rev()
        .find(|event| {
            event.seq >= start_seq
                && event.agent_id == agent_id
                && event.kind == EventKind::Message
                && event.payload.get("role").and_then(Value::as_str) == Some("agent")
        })
        .and_then(|event| event.payload.pointer("/content/text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned())
}

pub(crate) fn resolve_cwd(team_path: &Path, cwd: &Path) -> Result<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AgentConfig, BudgetConfig, EdgeConfig, GuardsConfig, SpawnConfig};
    use std::collections::BTreeMap;

    #[sqlx::test(migrations = "../../migrations")]
    async fn pipeline_mode_runs_two_nodes_in_declared_order(pool: sqlx::PgPool) -> Result<()> {
        let first_script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"pipeline-node-a","configOptions":[]}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"pipeline-node-a","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"node a done"}}}}'
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
        "#;
        let second_script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"pipeline-node-b","configOptions":[]}}'
            IFS= read -r prompt
            case "$prompt" in
              *'"text":"node a done"'*) ;;
              *) printf 'expected first node reply in prompt: %s\n' "$prompt" >&2; exit 13 ;;
            esac
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"pipeline-node-b","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"node b done"}}}}'
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
        "#;

        let team = Arc::new(TeamConfig {
            schema_version: 1,
            id: "pipeline-test-team".into(),
            name: "Pipeline test team".into(),
            entrypoint: "a".into(),
            budget: None,
            guards: GuardsConfig::default(),
            agents: vec![
                pipeline_agent("a", vec!["-c".into(), first_script.into()]),
                pipeline_agent("b", vec!["-c".into(), second_script.into()]),
            ],
            edges: vec![EdgeConfig {
                from: "a".into(),
                to: "b".into(),
                layer: "configured".into(),
                kind: "sequence".into(),
                ts: "2026-09-06T00:00:00Z".into(),
            }],
        });
        assert_eq!(
            team.pipeline_order().expect("acyclic two-node pipeline"),
            vec!["a".to_owned(), "b".to_owned()]
        );

        let archive = EventArchive::from_pool(pool);
        let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
        let outcome = run_pipeline_mode(
            &team,
            &team_path,
            archive.clone(),
            "start the pipeline",
            Duration::from_secs(2),
        )
        .await?;

        let events = archive.verify_session(&outcome.session_id).await?;
        assert!(
            events.windows(2).all(|pair| pair[1].seq == pair[0].seq + 1),
            "both nodes must archive into one dense, ordered sequence"
        );
        let spawn_order: Vec<&str> = events
            .iter()
            .filter(|event| event.kind == EventKind::Process && event.payload["phase"] == "spawned")
            .map(|event| event.agent_id.as_str())
            .collect();
        assert_eq!(
            spawn_order,
            ["a", "b"],
            "nodes must run in declared topological order"
        );
        assert!(events.iter().any(|event| {
            event.agent_id == "b"
                && event.kind == EventKind::Message
                && event
                    .payload
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    == Some("node b done")
        }));
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn pipeline_mode_joins_diamond_predecessor_outputs(pool: sqlx::PgPool) -> Result<()> {
        let node_script = |session_id: &str, own_reply: &str, checks: &str| {
            format!(
                r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1}}}}'
            IFS= read -r _
            printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"{session_id}","configOptions":[]}}}}'
            IFS= read -r prompt
            {checks}
            printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"{session_id}","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{own_reply}"}}}}}}}}'
            printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn"}}}}'
            IFS= read -r _
            printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{}}}}'
        "#
            )
        };

        let a_script = node_script("pipeline-node-a", "node a done", "");
        let b_script = node_script(
            "pipeline-node-b",
            "node b done",
            r#"case "$prompt" in
              *'node a done'*) ;;
              *) printf 'expected node a reply in prompt: %s\n' "$prompt" >&2; exit 13 ;;
            esac"#,
        );
        let c_script = node_script(
            "pipeline-node-c",
            "node c done",
            r#"case "$prompt" in
              *'node a done'*) ;;
              *) printf 'expected node a reply in prompt: %s\n' "$prompt" >&2; exit 13 ;;
            esac
            case "$prompt" in
              *'node b done'*) printf 'must not leak node b reply into node c prompt: %s\n' "$prompt" >&2; exit 14 ;;
              *) ;;
            esac"#,
        );
        let d_script = node_script(
            "pipeline-node-d",
            "node d done",
            r#"case "$prompt" in
              *'node b done'*) ;;
              *) printf 'expected node b reply in joined prompt: %s\n' "$prompt" >&2; exit 15 ;;
            esac
            case "$prompt" in
              *'node c done'*) ;;
              *) printf 'expected node c reply in joined prompt: %s\n' "$prompt" >&2; exit 16 ;;
            esac"#,
        );

        let edge = |from: &str, to: &str| EdgeConfig {
            from: from.into(),
            to: to.into(),
            layer: "configured".into(),
            kind: "sequence".into(),
            ts: "2026-09-06T00:00:00Z".into(),
        };

        let team = Arc::new(TeamConfig {
            schema_version: 1,
            id: "pipeline-diamond-team".into(),
            name: "Pipeline diamond team".into(),
            entrypoint: "a".into(),
            budget: None,
            guards: GuardsConfig::default(),
            agents: vec![
                pipeline_agent("a", vec!["-c".into(), a_script]),
                pipeline_agent("b", vec!["-c".into(), b_script]),
                pipeline_agent("c", vec!["-c".into(), c_script]),
                pipeline_agent("d", vec!["-c".into(), d_script]),
            ],
            edges: vec![
                edge("a", "b"),
                edge("a", "c"),
                edge("b", "d"),
                edge("c", "d"),
            ],
        });
        assert_eq!(
            team.pipeline_order().expect("acyclic diamond pipeline"),
            vec![
                "a".to_owned(),
                "b".to_owned(),
                "c".to_owned(),
                "d".to_owned()
            ]
        );

        let archive = EventArchive::from_pool(pool);
        let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
        let outcome = run_pipeline_mode(
            &team,
            &team_path,
            archive.clone(),
            "start the pipeline",
            Duration::from_secs(2),
        )
        .await?;

        let events = archive.verify_session(&outcome.session_id).await?;
        let spawn_order: Vec<&str> = events
            .iter()
            .filter(|event| event.kind == EventKind::Process && event.payload["phase"] == "spawned")
            .map(|event| event.agent_id.as_str())
            .collect();
        assert_eq!(
            spawn_order,
            ["a", "b", "c", "d"],
            "diamond must run in topological order"
        );
        assert!(events.iter().any(|event| {
            event.agent_id == "d"
                && event.kind == EventKind::Message
                && event
                    .payload
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    == Some("node d done")
        }));
        Ok(())
    }

    fn pipeline_agent(id: &str, args: Vec<String>) -> AgentConfig {
        AgentConfig {
            id: id.into(),
            name: format!("{id} name"),
            role: format!("{id} role"),
            spawn: SpawnConfig {
                cmd: "/bin/sh".into(),
                args,
                env: BTreeMap::new(),
                cwd: PathBuf::from("."),
            },
            model: "test/model".into(),
            budget: BudgetConfig {
                limit_usd: 1.0,
                warn_at_percent: 80,
            },
            allow_recruiting: true,
        }
    }
}
