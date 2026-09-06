//! Authenticated HTTP MCP Team Bus used by ACP harnesses for structured delegation.

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::extract::State;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock, oneshot};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::acp::{AcpProcess, EventLog, ProcessSpec, TeamSessionContext};
use crate::archive::EventArchive;
use crate::config::{AgentConfig, TeamConfig};
use crate::{EventKind, resolve_cwd};

const SERVER_NAME: &str = "loomwatch-team-bus";
const MCP_PROTOCOL_VERSION: &str = "2025-03-26";

/// Which execution mode is driving this run — see ARCHITECTURE.md §4.
///
/// Pipeline mode restricts the tool surface because the backend, not the agent, owns
/// macro sequencing: `dispatch`/`handoff` are withdrawn outright, and `ask` (recruiting a
/// helper within one node's own step) is refused for an agent configured with
/// `allowRecruiting: false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TeamBusMode {
    Team,
    Pipeline,
}

#[derive(Clone)]
pub(crate) struct TeamBus {
    state: Arc<TeamBusState>,
}

struct TeamBusState {
    team: Arc<TeamConfig>,
    team_path: PathBuf,
    archive: EventArchive,
    exit_timeout: Duration,
    mode: TeamBusMode,
    address: SocketAddr,
    tokens: RwLock<BTreeMap<String, AgentSession>>,
    statuses: RwLock<BTreeMap<String, String>>,
    budget_warnings: Mutex<BTreeSet<String>>,
    tasks: Mutex<Vec<JoinHandle<Result<()>>>>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    server: Mutex<Option<JoinHandle<std::io::Result<()>>>>,
}

#[derive(Clone)]
struct AgentSession {
    agent_id: String,
    event_log: Option<EventLog>,
    delegation_path: Vec<String>,
    dispatch_depth: u32,
}

struct DelegationContext {
    path: Vec<String>,
    depth: u32,
}

/// Per-agent credentials and endpoint details injected into ACP `session/new`.
#[derive(Clone)]
pub(crate) struct TeamBusConnection {
    bus: TeamBus,
    token: String,
}

impl TeamBus {
    pub(crate) async fn start(
        team: Arc<TeamConfig>,
        team_path: &Path,
        archive: EventArchive,
        exit_timeout: Duration,
        mode: TeamBusMode,
    ) -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .context("failed to bind Team Bus HTTP listener")?;
        let address = listener.local_addr()?;
        let statuses = team
            .agents
            .iter()
            .map(|agent| (agent.id.clone(), "idle".to_owned()))
            .collect();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let state = Arc::new(TeamBusState {
            team,
            team_path: team_path.to_path_buf(),
            archive,
            exit_timeout,
            mode,
            address,
            tokens: RwLock::new(BTreeMap::new()),
            statuses: RwLock::new(statuses),
            budget_warnings: Mutex::new(BTreeSet::new()),
            tasks: Mutex::new(Vec::new()),
            shutdown: Mutex::new(Some(shutdown_tx)),
            server: Mutex::new(None),
        });
        let bus = Self { state };
        let app = mcp_router(bus.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
        });
        *bus.state.server.lock().await = Some(server);
        Ok(bus)
    }

    pub(crate) async fn connection(&self, agent_id: &str) -> Result<TeamBusConnection> {
        self.agent(agent_id)?;
        let token = Uuid::new_v4().to_string();
        self.state.tokens.write().await.insert(
            token.clone(),
            AgentSession {
                agent_id: agent_id.to_owned(),
                event_log: None,
                delegation_path: vec![agent_id.to_owned()],
                dispatch_depth: 0,
            },
        );
        Ok(TeamBusConnection {
            bus: self.clone(),
            token,
        })
    }

    pub(crate) async fn wait_for_tasks(&self) -> Result<()> {
        let mut first_error = None;
        loop {
            let tasks = {
                let mut pending = self.state.tasks.lock().await;
                if pending.is_empty() {
                    return first_error.map_or(Ok(()), Err);
                }
                std::mem::take(&mut *pending)
            };
            for task in tasks {
                let result = task
                    .await
                    .context("delegated agent task panicked")
                    .and_then(|result| result);
                if first_error.is_none() {
                    first_error = result.err();
                }
            }
        }
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        if let Some(shutdown) = self.state.shutdown.lock().await.take() {
            let _ = shutdown.send(());
        }
        if let Some(server) = self.state.server.lock().await.take() {
            server.await.context("Team Bus server task panicked")??;
        }
        Ok(())
    }

    fn agent(&self, agent_id: &str) -> Result<AgentConfig> {
        self.state
            .team
            .agents
            .iter()
            .find(|agent| agent.id == agent_id)
            .cloned()
            .with_context(|| format!("agent {agent_id:?} is not on this team"))
    }

    async fn invoke(&self, token: &str, request: &Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str);
        match method {
            Some("initialize") => rpc_result(
                &id,
                &json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")}
                }),
            ),
            Some("ping") => rpc_result(&id, &json!({})),
            Some("tools/list") => {
                rpc_result(&id, &json!({"tools": tool_definitions(self.state.mode)}))
            }
            Some("tools/call") => match self.call_tool(token, request).await {
                Ok(result) => rpc_result(&id, &result),
                Err(error) => rpc_result(&id, &tool_error(&format!("{error:#}"))),
            },
            Some(other) => rpc_error(&id, -32601, &format!("method {other:?} not found")),
            None => rpc_error(&id, -32600, "request omitted method"),
        }
    }

    async fn call_tool(&self, token: &str, request: &Value) -> Result<Value> {
        let session = self
            .state
            .tokens
            .read()
            .await
            .get(token)
            .cloned()
            .context("Team Bus session is unknown")?;
        let event_log = session
            .event_log
            .clone()
            .context("Team Bus session is not attached to an ACP run")?;
        let name = request
            .pointer("/params/name")
            .and_then(Value::as_str)
            .context("tools/call omitted params.name")?;
        let arguments = request
            .pointer("/params/arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let call_id = Uuid::new_v4().to_string();
        event_log
            .append(
                &session.agent_id,
                EventKind::ToolCall,
                json!({
                    "callId": call_id,
                    "title": format!("Team Bus: {name}"),
                    "name": name,
                    "toolKind": "other",
                    "status": "in_progress",
                    "rawInput": arguments
                }),
                Some(request.clone()),
            )
            .await?;

        let execution = self
            .execute_tool(&session, &event_log, name, &arguments)
            .await;
        let (status, raw_output, result) = match execution {
            Ok(output) => ("completed", output.clone(), tool_success(&output)),
            Err(error) => {
                let message = format!("{error:#}");
                ("failed", json!({"error": message}), tool_error(&message))
            }
        };
        event_log
            .append(
                &session.agent_id,
                EventKind::ToolUpdate,
                json!({
                    "callId": call_id,
                    "status": status,
                    "rawOutput": raw_output
                }),
                Some(rpc_result(
                    request.get("id").unwrap_or(&Value::Null),
                    &result,
                )),
            )
            .await?;
        Ok(result)
    }

    async fn execute_tool(
        &self,
        session: &AgentSession,
        event_log: &EventLog,
        name: &str,
        arguments: &Value,
    ) -> Result<Value> {
        if self.state.mode == TeamBusMode::Pipeline {
            match name {
                "dispatch" | "handoff" => bail!(
                    "{name} is not available in pipeline mode; the backend drives node sequencing"
                ),
                "ask" if !self.agent(&session.agent_id)?.allow_recruiting => bail!(
                    "agent {:?} may not recruit helpers within its own pipeline step (allowRecruiting: false)",
                    session.agent_id
                ),
                _ => {}
            }
        }
        match name {
            "roster" => {
                let statuses = self.state.statuses.read().await;
                Ok(Value::Array(
                    self.state
                        .team
                        .agents
                        .iter()
                        .map(|agent| {
                            json!({
                                "id": agent.id,
                                "name": agent.name,
                                "role": agent.role,
                                "model": agent.model,
                                "allowRecruiting": agent.allow_recruiting,
                                "capabilities": {"canRecruit": agent.allow_recruiting},
                                "status": statuses.get(&agent.id).map_or("idle", String::as_str)
                            })
                        })
                        .collect(),
                ))
            }
            "dispatch" => {
                let target = required_string(arguments, "agent")?;
                let task = required_string(arguments, "task")?;
                let context = self.guard_delegation(session, &target, event_log).await?;
                self.spawn_background(&target, &task, event_log.clone(), context)
                    .await?;
                Ok(json!({"accepted": true, "agent": target, "mode": "dispatch"}))
            }
            "ask" => {
                let target = required_string(arguments, "agent")?;
                let question = required_string(arguments, "question")?;
                let context = self.guard_delegation(session, &target, event_log).await?;
                let start_seq = event_log.next_seq().await;
                let outcome = self
                    .run_agent(&target, &question, event_log.clone(), context)
                    .await?;
                let reply = self.last_reply(&target, event_log, start_seq).await?;
                Ok(json!({
                    "agent": target,
                    "reply": reply,
                    "sessionId": outcome.session_id
                }))
            }
            "handoff" => {
                let target = required_string(arguments, "agent")?;
                let task = required_string(arguments, "task")?;
                let context = self.guard_delegation(session, &target, event_log).await?;
                self.spawn_background(&target, &task, event_log.clone(), context)
                    .await?;
                self.state
                    .statuses
                    .write()
                    .await
                    .insert(session.agent_id.clone(), "stopped".to_owned());
                Ok(json!({
                    "accepted": true,
                    "agent": target,
                    "mode": "handoff",
                    "callerStatus": "stopped"
                }))
            }
            "report" => {
                let status = required_string(arguments, "status")?;
                self.state
                    .statuses
                    .write()
                    .await
                    .insert(session.agent_id.clone(), status.clone());
                Ok(json!({"accepted": true, "agent": session.agent_id, "status": status}))
            }
            "escalate" => {
                let reason = required_string(arguments, "reason")?;
                self.state
                    .statuses
                    .write()
                    .await
                    .insert(session.agent_id.clone(), "waiting".to_owned());
                Ok(json!({"accepted": true, "notify": "user", "reason": reason}))
            }
            other => bail!("unknown Team Bus tool {other:?}"),
        }
    }

    async fn spawn_background(
        &self,
        agent_id: &str,
        prompt: &str,
        event_log: EventLog,
        context: DelegationContext,
    ) -> Result<()> {
        self.agent(agent_id)?;
        let bus = self.clone();
        let agent_id = agent_id.to_owned();
        let prompt = prompt.to_owned();
        let task = tokio::spawn(async move {
            bus.run_agent(&agent_id, &prompt, event_log, context)
                .await
                .map(|_| ())
        });
        self.state.tasks.lock().await.push(task);
        Ok(())
    }

    async fn run_agent(
        &self,
        agent_id: &str,
        prompt: &str,
        event_log: EventLog,
        context: DelegationContext,
    ) -> Result<crate::SessionOutcome> {
        let agent = self.agent(agent_id)?;
        self.state
            .statuses
            .write()
            .await
            .insert(agent.id.clone(), "starting".to_owned());
        let result = self
            .run_agent_inner(&agent, prompt, event_log, context)
            .await
            .with_context(|| format!("delegated agent {:?} failed", agent.id));
        self.state.statuses.write().await.insert(
            agent.id,
            if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            }
            .to_owned(),
        );
        result
    }

    async fn run_agent_inner(
        &self,
        agent: &AgentConfig,
        prompt: &str,
        event_log: EventLog,
        context: DelegationContext,
    ) -> Result<crate::SessionOutcome> {
        let cwd = resolve_cwd(&self.state.team_path, &agent.spawn.cwd)?;
        let spec = ProcessSpec {
            cmd: agent.spawn.cmd.clone(),
            args: agent.spawn.args.clone(),
            env: agent.spawn.env.clone(),
            cwd,
        };
        let connection = self.connection_with_context(&agent.id, context).await?;
        let mut process = AcpProcess::spawn(&spec)
            .with_context(|| format!("failed to spawn ACP harness for agent {}", agent.id))?;
        process
            .run_session_with_bus(
                &agent.id,
                &agent.model,
                prompt,
                TeamSessionContext {
                    archive: &self.state.archive,
                    exit_timeout: self.state.exit_timeout,
                    bus: Some(&connection),
                    event_log: Some(event_log),
                },
            )
            .await
    }

    async fn connection_with_context(
        &self,
        agent_id: &str,
        context: DelegationContext,
    ) -> Result<TeamBusConnection> {
        self.agent(agent_id)?;
        let token = Uuid::new_v4().to_string();
        self.state.tokens.write().await.insert(
            token.clone(),
            AgentSession {
                agent_id: agent_id.to_owned(),
                event_log: None,
                delegation_path: context.path,
                dispatch_depth: context.depth,
            },
        );
        Ok(TeamBusConnection {
            bus: self.clone(),
            token,
        })
    }

    async fn guard_delegation(
        &self,
        session: &AgentSession,
        target: &str,
        event_log: &EventLog,
    ) -> Result<DelegationContext> {
        let target_agent = self.agent(target)?;
        let next_depth = session
            .dispatch_depth
            .checked_add(1)
            .context("Team Bus dispatch depth overflowed")?;
        let max_depth = self.state.team.guards.max_dispatch_depth;
        if next_depth > max_depth {
            bail!("delegation depth {next_depth} exceeds guards.maxDispatchDepth {max_depth}");
        }
        if session.delegation_path.iter().any(|agent| agent == target) {
            let mut cycle = session.delegation_path.clone();
            cycle.push(target.to_owned());
            bail!("delegation cycle rejected: {}", cycle.join(" -> "));
        }

        let events = self
            .state
            .archive
            .load_session(event_log.session_id())
            .await?;
        let agent_spend = spent_usd(&events, Some(target));
        let agent_scope = format!("agent:{target}");
        let agent_exhausted = self
            .observe_budget(
                event_log,
                target,
                &agent_scope,
                agent_spend,
                &target_agent.budget,
            )
            .await?;
        let team_budget_state = if let Some(team_budget) = &self.state.team.budget {
            let team_spend = spent_usd(&events, None);
            let exhausted = self
                .observe_budget(
                    event_log,
                    &session.agent_id,
                    "team",
                    team_spend,
                    team_budget,
                )
                .await?;
            Some((team_spend, team_budget.limit_usd, exhausted))
        } else {
            None
        };
        if agent_exhausted {
            bail!(
                "{agent_scope} budget exhausted: spent ${agent_spend:.6} of ${:.6}",
                target_agent.budget.limit_usd
            );
        }
        if let Some((team_spend, team_limit, true)) = team_budget_state {
            bail!("team budget exhausted: spent ${team_spend:.6} of ${team_limit:.6}");
        }

        let mut path = session.delegation_path.clone();
        path.push(target.to_owned());
        Ok(DelegationContext {
            path,
            depth: next_depth,
        })
    }

    async fn observe_budget(
        &self,
        event_log: &EventLog,
        event_agent_id: &str,
        scope: &str,
        spent_usd: f64,
        budget: &crate::config::BudgetConfig,
    ) -> Result<bool> {
        let warning_at_usd = budget.limit_usd * f64::from(budget.warn_at_percent) / 100.0;
        if spent_usd >= warning_at_usd {
            let should_emit = self
                .state
                .budget_warnings
                .lock()
                .await
                .insert(scope.to_owned());
            if should_emit {
                event_log
                    .append(
                        event_agent_id,
                        EventKind::Usage,
                        json!({
                            "phase": "budget_warning",
                            "scope": scope,
                            "spentUsd": spent_usd,
                            "limitUsd": budget.limit_usd,
                            "warnAtPercent": budget.warn_at_percent
                        }),
                        Some(json!({
                            "source": SERVER_NAME,
                            "event": "budget_warning",
                            "scope": scope
                        })),
                    )
                    .await?;
            }
        }
        Ok(spent_usd >= budget.limit_usd)
    }

    async fn last_reply(
        &self,
        agent_id: &str,
        event_log: &EventLog,
        start_seq: u64,
    ) -> Result<String> {
        crate::last_agent_reply(
            &self.state.archive,
            event_log.session_id(),
            agent_id,
            start_seq,
        )
        .await
    }
}

fn spent_usd(events: &[crate::RunEvent], agent_id: Option<&str>) -> f64 {
    events
        .iter()
        .filter(|event| agent_id.is_none_or(|agent_id| event.agent_id == agent_id))
        .filter_map(event_cost_usd)
        .sum()
}

fn event_cost_usd(event: &crate::RunEvent) -> Option<f64> {
    let value = match event.kind {
        EventKind::Usage => event
            .payload
            .get("costUsd")
            .or_else(|| event.payload.get("cost_usd")),
        EventKind::TurnEnd => event
            .payload
            .pointer("/usage/costUsd")
            .or_else(|| event.payload.pointer("/usage/cost_usd")),
        _ => None,
    }?;
    value
        .as_f64()
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
}

impl TeamBusConnection {
    pub(crate) fn server_definition(&self) -> Value {
        json!({
            "type": "http",
            "name": SERVER_NAME,
            "url": format!("http://{}/mcp", self.bus.state.address),
            "headers": [{
                "name": "Authorization",
                "value": format!("Bearer {}", self.token)
            }]
        })
    }

    pub(crate) async fn register(&self, event_log: EventLog) {
        let agent_id = {
            let mut tokens = self.bus.state.tokens.write().await;
            tokens.get_mut(&self.token).map(|session| {
                session.event_log = Some(event_log);
                session.agent_id.clone()
            })
        };
        if let Some(agent_id) = agent_id {
            self.bus
                .state
                .statuses
                .write()
                .await
                .insert(agent_id, "running".to_owned());
        }
    }
}

async fn mcp_post(
    State(bus): State<TeamBus>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let Some(token) = bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, "missing bearer token").into_response();
    };
    if !bus.state.tokens.read().await.contains_key(token) {
        return (StatusCode::UNAUTHORIZED, "invalid bearer token").into_response();
    }
    if request.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let response = bus.invoke(token, &request).await;
    (
        StatusCode::OK,
        [(CONTENT_TYPE, "application/json")],
        Json(response),
    )
        .into_response()
}

fn mcp_router(bus: TeamBus) -> Router {
    Router::new().route("/mcp", post(mcp_post)).with_state(bus)
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn required_string(arguments: &Value, name: &str) -> Result<String> {
    let value = arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("argument {name:?} must be a non-empty string"))?;
    Ok(value.to_owned())
}

fn rpc_result(id: &Value, result: &Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

fn tool_success(value: &Value) -> Value {
    let text = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned());
    json!({
        "content": [{"type": "text", "text": text}],
        "structuredContent": value,
        "isError": false
    })
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{"type": "text", "text": message}],
        "isError": true
    })
}

fn tool_definitions(mode: TeamBusMode) -> Vec<Value> {
    let mut tools = vec![tool(
        "roster",
        "List the team, capabilities, and live status",
        &json!({"type": "object", "additionalProperties": false}),
    )];
    if mode == TeamBusMode::Team {
        tools.push(tool(
            "dispatch",
            "Assign work without blocking for the result",
            &two_strings("agent", "Target agent ID", "task", "Task to perform"),
        ));
    }
    tools.push(tool(
        "ask",
        "Ask another agent and block for its reply",
        &two_strings("agent", "Target agent ID", "question", "Question to answer"),
    ));
    if mode == TeamBusMode::Team {
        tools.push(tool(
            "handoff",
            "Transfer full ownership of work to another agent",
            &two_strings("agent", "Target agent ID", "task", "Task being transferred"),
        ));
    }
    tools.push(tool(
        "report",
        "Publish this agent's current status",
        &one_string("status", "Progress status"),
    ));
    tools.push(tool(
        "escalate",
        "Signal that this run needs a human",
        &one_string("reason", "Reason human attention is needed"),
    ));
    tools
}

fn tool(name: &str, description: &str, input_schema: &Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": input_schema})
}

fn one_string(name: &str, description: &str) -> Value {
    let mut properties = serde_json::Map::new();
    properties.insert(
        name.to_owned(),
        json!({"type": "string", "description": description, "minLength": 1}),
    );
    json!({
        "type": "object",
        "properties": properties,
        "required": [name],
        "additionalProperties": false
    })
}

fn two_strings(
    first: &str,
    first_description: &str,
    second: &str,
    second_description: &str,
) -> Value {
    let mut properties = serde_json::Map::new();
    properties.insert(
        first.to_owned(),
        json!({"type": "string", "description": first_description, "minLength": 1}),
    );
    properties.insert(
        second.to_owned(),
        json!({"type": "string", "description": second_description, "minLength": 1}),
    );
    json!({
        "type": "object",
        "properties": properties,
        "required": [first, second],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{BudgetConfig, GuardsConfig, SpawnConfig};
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tower::ServiceExt;

    #[sqlx::test(migrations = "../../migrations")]
    async fn all_tools_emit_events_and_dispatch_runs_a_second_agent(
        pool: sqlx::PgPool,
    ) -> Result<()> {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":true}}}}'
            IFS= read -r session_new
            case "$session_new" in
              *'"name":"loomwatch-team-bus"'* ) ;;
              *) printf 'missing Team Bus config: %s\n' "$session_new" >&2; exit 11 ;;
            esac
            case "$session_new" in
              *'"name":"Authorization"'*'"Bearer '* ) ;;
              *) printf 'missing Team Bus auth: %s\n' "$session_new" >&2; exit 12 ;;
            esac
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"worker-acp-session","configOptions":[]}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"worker-acp-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"worker reply"}}}}'
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
        "#;
        let team = Arc::new(TeamConfig {
            schema_version: 1,
            id: "test-team".into(),
            name: "Test Team".into(),
            entrypoint: "lead".into(),
            budget: Some(BudgetConfig {
                limit_usd: 10.0,
                warn_at_percent: 80,
            }),
            guards: GuardsConfig::default(),
            agents: vec![
                test_agent("lead", "true", Vec::new()),
                test_agent("worker", "/bin/sh", vec!["-c".into(), script.into()]),
            ],
            edges: Vec::new(),
        });
        let archive = EventArchive::from_pool(pool);
        let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
        let bus = TeamBus::start(
            team,
            &team_path,
            archive.clone(),
            Duration::from_secs(2),
            TeamBusMode::Team,
        )
        .await?;
        let connection = bus.connection("lead").await?;
        let event_log = EventLog::new(archive.clone(), "team-run".into());
        connection.register(event_log).await;

        let initialized = post_live_json(
            bus.state.address,
            &connection.token,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        )
        .await?;
        assert_eq!(initialized["result"]["serverInfo"]["name"], SERVER_NAME);

        let calls = [
            ("roster", json!({})),
            ("dispatch", json!({"agent": "worker", "task": "do work"})),
            (
                "ask",
                json!({"agent": "worker", "question": "what happened?"}),
            ),
            ("handoff", json!({"agent": "worker", "task": "take over"})),
            ("report", json!({"status": "reviewing"})),
            ("escalate", json!({"reason": "operator decision needed"})),
        ];
        for (index, (name, arguments)) in calls.iter().enumerate() {
            let response = post_json(
                &bus,
                &connection.token,
                &json!({
                    "jsonrpc": "2.0",
                    "id": index + 2,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments}
                }),
            )
            .await?;
            assert_eq!(response["result"]["isError"], false, "{name}: {response}");
            if *name == "ask" {
                assert_eq!(
                    response["result"]["structuredContent"]["reply"],
                    "worker reply"
                );
            }
        }

        bus.wait_for_tasks().await?;
        bus.shutdown().await?;
        let events = archive.verify_session("team-run").await?;
        let bus_calls: Vec<_> = events
            .iter()
            .filter(|event| event.agent_id == "lead" && event.kind == EventKind::ToolCall)
            .collect();
        let bus_updates: Vec<_> = events
            .iter()
            .filter(|event| event.agent_id == "lead" && event.kind == EventKind::ToolUpdate)
            .collect();
        assert_eq!(bus_calls.len(), 6);
        assert_eq!(bus_updates.len(), 6);
        assert_eq!(
            bus_calls
                .iter()
                .map(|event| event.payload["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["roster", "dispatch", "ask", "handoff", "report", "escalate"]
        );
        assert!(events.iter().any(|event| {
            event.agent_id == "worker"
                && event.kind == EventKind::Message
                && event
                    .payload
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    == Some("worker reply")
        }));
        assert!(events.windows(2).all(|pair| pair[1].seq == pair[0].seq + 1));
        assert_events_match_schema(&events);
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn delegation_guards_reject_before_spawning_and_archive_failures(
        pool: sqlx::PgPool,
    ) -> Result<()> {
        let team = Arc::new(TeamConfig {
            schema_version: 1,
            id: "guard-test-team".into(),
            name: "Guard test team".into(),
            entrypoint: "a".into(),
            budget: Some(BudgetConfig {
                limit_usd: 1.0,
                warn_at_percent: 80,
            }),
            guards: GuardsConfig {
                max_dispatch_depth: 2,
            },
            agents: ["a", "b", "c", "d"]
                .into_iter()
                .map(|id| test_agent(id, "/definitely/not/a/real/acp", Vec::new()))
                .collect(),
            edges: Vec::new(),
        });
        let archive = EventArchive::from_pool(pool);
        let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
        let bus = TeamBus::start(
            team,
            &team_path,
            archive.clone(),
            Duration::from_secs(1),
            TeamBusMode::Team,
        )
        .await?;
        let event_log = EventLog::new(archive.clone(), "guard-run".into());
        event_log
            .append(
                "c",
                EventKind::Usage,
                json!({"costUsd": 1.0}),
                Some(json!({"source": "test usage"})),
            )
            .await?;

        let cycle = bus
            .connection_with_context(
                "b",
                DelegationContext {
                    path: vec!["a".into(), "b".into()],
                    depth: 1,
                },
            )
            .await?;
        cycle.register(event_log.clone()).await;
        let response = call_dispatch(&bus, &cycle, "a").await?;
        assert_tool_error_contains(&response, "delegation cycle rejected: a -> b -> a");

        let too_deep = bus
            .connection_with_context(
                "c",
                DelegationContext {
                    path: vec!["a".into(), "b".into(), "c".into()],
                    depth: 2,
                },
            )
            .await?;
        too_deep.register(event_log.clone()).await;
        let response = call_dispatch(&bus, &too_deep, "d").await?;
        assert_tool_error_contains(
            &response,
            "delegation depth 3 exceeds guards.maxDispatchDepth 2",
        );

        let budget = bus.connection("b").await?;
        budget.register(event_log.clone()).await;
        let response = call_dispatch(&bus, &budget, "c").await?;
        assert_tool_error_contains(&response, "agent:c budget exhausted");
        let response = call_dispatch(&bus, &budget, "d").await?;
        assert_tool_error_contains(&response, "team budget exhausted");

        assert!(bus.state.tasks.lock().await.is_empty());
        assert!(
            bus.state
                .statuses
                .read()
                .await
                .values()
                .all(|status| status == "idle" || status == "running")
        );
        bus.shutdown().await?;

        let events = archive.verify_session("guard-run").await?;
        let failures: Vec<_> = events
            .iter()
            .filter(|event| {
                event.kind == EventKind::ToolUpdate
                    && event.payload["status"].as_str() == Some("failed")
            })
            .collect();
        assert_eq!(failures.len(), 4, "every guard refusal must be archived");
        let warning_scopes: BTreeSet<_> = events
            .iter()
            .filter(|event| {
                event.kind == EventKind::Usage
                    && event.payload["phase"].as_str() == Some("budget_warning")
            })
            .filter_map(|event| event.payload["scope"].as_str())
            .collect();
        assert_eq!(warning_scopes, BTreeSet::from(["agent:c", "team"]));
        assert_events_match_schema(&events);
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn pipeline_mode_withdraws_macro_sequencing_tools_and_enforces_the_recruiting_lock(
        pool: sqlx::PgPool,
    ) -> Result<()> {
        let mut locked = test_agent("locked", "true", Vec::new());
        locked.allow_recruiting = false;
        let team = Arc::new(TeamConfig {
            schema_version: 1,
            id: "pipeline-restriction-team".into(),
            name: "Pipeline restriction team".into(),
            entrypoint: "open".into(),
            budget: None,
            guards: GuardsConfig::default(),
            agents: vec![
                test_agent("open", "true", Vec::new()),
                locked,
                test_agent("helper", "true", Vec::new()),
            ],
            edges: Vec::new(),
        });
        let archive = EventArchive::from_pool(pool);
        let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
        let bus = TeamBus::start(
            team,
            &team_path,
            archive.clone(),
            Duration::from_secs(1),
            TeamBusMode::Pipeline,
        )
        .await?;
        let event_log = EventLog::new(archive.clone(), "pipeline-restriction-run".into());

        let open = bus.connection("open").await?;
        let listed = post_json(
            &bus,
            &open.token,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
        )
        .await?;
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool name"))
            .collect();
        assert_eq!(
            names,
            ["roster", "ask", "report", "escalate"],
            "dispatch and handoff must be withdrawn in pipeline mode"
        );

        open.register(event_log.clone()).await;
        let response = call_dispatch(&bus, &open, "helper").await?;
        assert_tool_error_contains(&response, "dispatch is not available in pipeline mode");
        let response = post_json(
            &bus,
            &open.token,
            &json!({
                "jsonrpc": "2.0",
                "id": Uuid::new_v4().to_string(),
                "method": "tools/call",
                "params": {"name": "handoff", "arguments": {"agent": "helper", "task": "take over"}}
            }),
        )
        .await?;
        assert_tool_error_contains(&response, "handoff is not available in pipeline mode");

        let locked_connection = bus.connection("locked").await?;
        locked_connection.register(event_log.clone()).await;
        let response = post_json(
            &bus,
            &locked_connection.token,
            &json!({
                "jsonrpc": "2.0",
                "id": Uuid::new_v4().to_string(),
                "method": "tools/call",
                "params": {"name": "ask", "arguments": {"agent": "helper", "question": "status?"}}
            }),
        )
        .await?;
        assert_tool_error_contains(
            &response,
            "may not recruit helpers within its own pipeline step",
        );

        bus.shutdown().await?;
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn budget_warnings_fire_once_at_agent_and_team_thresholds(
        pool: sqlx::PgPool,
    ) -> Result<()> {
        let team = Arc::new(TeamConfig {
            schema_version: 1,
            id: "warning-test-team".into(),
            name: "Warning test team".into(),
            entrypoint: "a".into(),
            budget: Some(BudgetConfig {
                limit_usd: 2.0,
                warn_at_percent: 80,
            }),
            guards: GuardsConfig::default(),
            agents: ["a", "b", "c", "d"]
                .into_iter()
                .map(|id| test_agent(id, "/definitely/not/a/real/acp", Vec::new()))
                .collect(),
            edges: Vec::new(),
        });
        let archive = EventArchive::from_pool(pool);
        let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
        let bus = TeamBus::start(
            team,
            &team_path,
            archive.clone(),
            Duration::from_secs(1),
            TeamBusMode::Team,
        )
        .await?;
        let event_log = EventLog::new(archive.clone(), "warning-run".into());
        for agent_id in ["c", "d"] {
            event_log
                .append(
                    agent_id,
                    EventKind::Usage,
                    json!({"costUsd": 0.8}),
                    Some(json!({"source": "test usage"})),
                )
                .await?;
        }
        let connection = bus.connection("b").await?;
        let session = bus.state.tokens.read().await[&connection.token].clone();

        bus.guard_delegation(&session, "d", &event_log).await?;
        bus.guard_delegation(&session, "d", &event_log).await?;
        bus.shutdown().await?;

        let events = archive.verify_session("warning-run").await?;
        let warning_scopes: Vec<_> = events
            .iter()
            .filter(|event| {
                event.kind == EventKind::Usage
                    && event.payload["phase"].as_str() == Some("budget_warning")
            })
            .filter_map(|event| event.payload["scope"].as_str())
            .collect();
        assert_eq!(warning_scopes, ["agent:d", "team"]);
        assert_events_match_schema(&events);
        Ok(())
    }

    async fn call_dispatch(
        bus: &TeamBus,
        connection: &TeamBusConnection,
        target: &str,
    ) -> Result<Value> {
        post_json(
            bus,
            &connection.token,
            &json!({
                "jsonrpc": "2.0",
                "id": Uuid::new_v4().to_string(),
                "method": "tools/call",
                "params": {
                    "name": "dispatch",
                    "arguments": {"agent": target, "task": "must not execute"}
                }
            }),
        )
        .await
    }

    fn assert_tool_error_contains(response: &Value, expected: &str) {
        assert_eq!(response["result"]["isError"], true, "{response}");
        let message = response["result"]["content"][0]["text"]
            .as_str()
            .expect("tool error text");
        assert!(message.contains(expected), "{message:?}");
    }

    fn test_agent(id: &str, command: &str, args: Vec<String>) -> AgentConfig {
        AgentConfig {
            id: id.into(),
            name: format!("{id} name"),
            role: format!("{id} role"),
            spawn: SpawnConfig {
                cmd: command.into(),
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

    async fn post_json(bus: &TeamBus, token: &str, request: &Value) -> Result<Value> {
        let body = serde_json::to_vec(request)?;
        let response = mcp_router(bus.clone())
            .oneshot(
                Request::post("/mcp")
                    .header(AUTHORIZATION, format!("Bearer {token}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body))?,
            )
            .await?;
        let status = response.status();
        let bytes = response.into_body().collect().await?.to_bytes();
        if status != StatusCode::OK {
            bail!(
                "Team Bus returned HTTP {status}: {}",
                String::from_utf8_lossy(&bytes)
            );
        }
        serde_json::from_slice(&bytes).context("invalid JSON HTTP response")
    }

    async fn post_live_json(address: SocketAddr, token: &str, request: &Value) -> Result<Value> {
        let body = serde_json::to_vec(request)?;
        let mut stream = tokio::net::TcpStream::connect(address).await?;
        let head = format!(
            "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(&body).await?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await?;
        let separator = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .context("HTTP response omitted header terminator")?;
        serde_json::from_slice(&response[separator + 4..]).context("invalid JSON HTTP response")
    }

    fn assert_events_match_schema(events: &[crate::RunEvent]) {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let source = std::fs::read_to_string(workspace.join("schemas/team.schema.yaml"))
            .expect("read schema");
        let schema: Value = serde_yaml::from_str(&source).expect("parse schema");
        let event_schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": schema["$defs"].clone(),
            "$ref": "#/$defs/RunEvent"
        });
        let validator = jsonschema::draft202012::new(&event_schema).expect("compile schema");
        for event in events {
            let value = serde_json::to_value(event).expect("serialize event");
            let errors: Vec<_> = validator
                .iter_errors(&value)
                .map(|error| error.to_string())
                .collect();
            assert!(errors.is_empty(), "invalid event: {errors:?}\n{value}");
        }
    }
}
