//! Authenticated HTTP MCP Team Bus used by ACP harnesses for structured delegation.

use std::collections::BTreeMap;
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

#[derive(Clone)]
pub(crate) struct TeamBus {
    state: Arc<TeamBusState>,
}

struct TeamBusState {
    team: Arc<TeamConfig>,
    team_path: PathBuf,
    archive: EventArchive,
    exit_timeout: Duration,
    address: SocketAddr,
    tokens: RwLock<BTreeMap<String, AgentSession>>,
    statuses: RwLock<BTreeMap<String, String>>,
    tasks: Mutex<Vec<JoinHandle<Result<()>>>>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    server: Mutex<Option<JoinHandle<std::io::Result<()>>>>,
}

#[derive(Clone)]
struct AgentSession {
    agent_id: String,
    event_log: Option<EventLog>,
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
            address,
            tokens: RwLock::new(BTreeMap::new()),
            statuses: RwLock::new(statuses),
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
            Some("tools/list") => rpc_result(&id, &json!({"tools": tool_definitions()})),
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
            .execute_tool(&session.agent_id, &event_log, name, &arguments)
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
        caller: &str,
        event_log: &EventLog,
        name: &str,
        arguments: &Value,
    ) -> Result<Value> {
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
                self.spawn_background(&target, &task, event_log.clone())
                    .await?;
                Ok(json!({"accepted": true, "agent": target, "mode": "dispatch"}))
            }
            "ask" => {
                let target = required_string(arguments, "agent")?;
                let question = required_string(arguments, "question")?;
                let start_seq = event_log.next_seq().await;
                let outcome = self
                    .run_agent(&target, &question, event_log.clone())
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
                self.spawn_background(&target, &task, event_log.clone())
                    .await?;
                self.state
                    .statuses
                    .write()
                    .await
                    .insert(caller.to_owned(), "stopped".to_owned());
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
                    .insert(caller.to_owned(), status.clone());
                Ok(json!({"accepted": true, "agent": caller, "status": status}))
            }
            "escalate" => {
                let reason = required_string(arguments, "reason")?;
                self.state
                    .statuses
                    .write()
                    .await
                    .insert(caller.to_owned(), "waiting".to_owned());
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
    ) -> Result<()> {
        self.agent(agent_id)?;
        let bus = self.clone();
        let agent_id = agent_id.to_owned();
        let prompt = prompt.to_owned();
        let task = tokio::spawn(async move {
            bus.run_agent(&agent_id, &prompt, event_log)
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
    ) -> Result<crate::SessionOutcome> {
        let agent = self.agent(agent_id)?;
        self.state
            .statuses
            .write()
            .await
            .insert(agent.id.clone(), "starting".to_owned());
        let result = self
            .run_agent_inner(&agent, prompt, event_log)
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
    ) -> Result<crate::SessionOutcome> {
        let cwd = resolve_cwd(&self.state.team_path, &agent.spawn.cwd)?;
        let spec = ProcessSpec {
            cmd: agent.spawn.cmd.clone(),
            args: agent.spawn.args.clone(),
            env: agent.spawn.env.clone(),
            cwd,
        };
        let connection = self.connection(&agent.id).await?;
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

    async fn last_reply(
        &self,
        agent_id: &str,
        event_log: &EventLog,
        start_seq: u64,
    ) -> Result<String> {
        let events = self
            .state
            .archive
            .load_session(event_log.session_id())
            .await?;
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

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "roster",
            "List the team, capabilities, and live status",
            &json!({"type": "object", "additionalProperties": false}),
        ),
        tool(
            "dispatch",
            "Assign work without blocking for the result",
            &two_strings("agent", "Target agent ID", "task", "Task to perform"),
        ),
        tool(
            "ask",
            "Ask another agent and block for its reply",
            &two_strings("agent", "Target agent ID", "question", "Question to answer"),
        ),
        tool(
            "handoff",
            "Transfer full ownership of work to another agent",
            &two_strings("agent", "Target agent ID", "task", "Task being transferred"),
        ),
        tool(
            "report",
            "Publish this agent's current status",
            &one_string("status", "Progress status"),
        ),
        tool(
            "escalate",
            "Signal that this run needs a human",
            &one_string("reason", "Reason human attention is needed"),
        ),
    ]
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
    use crate::config::{BudgetConfig, SpawnConfig};
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
            agents: vec![
                test_agent("lead", "true", Vec::new()),
                test_agent("worker", "/bin/sh", vec!["-c".into(), script.into()]),
            ],
            edges: Vec::new(),
        });
        let archive = EventArchive::from_pool(pool);
        let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
        let bus = TeamBus::start(team, &team_path, archive.clone(), Duration::from_secs(2)).await?;
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
