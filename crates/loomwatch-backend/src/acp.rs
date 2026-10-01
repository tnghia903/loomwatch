use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use uuid::Uuid;

use crate::archive::EventArchive;
use crate::team_bus::TeamBusConnection;
use crate::{EventKind, RunEvent, SessionOutcome};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const DISCOVERY_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVERY_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

/// One reasoning-effort value exposed by an ACP harness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredThinkingEffort {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One model exposed by an ACP harness. The id is sent back to ACP; the name is for people.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub thinking_efforts: Vec<DiscoveredThinkingEffort>,
}

/// The live model/configuration state reported by a newly-created ACP session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModelCatalog {
    pub models: Vec<DiscoveredModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_thinking_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    /// MCP servers the operator wired to this agent (ADR 0029), handed over in `session/new` and
    /// again in `session/load` beside the Team Bus. Part of the spec rather than the prompt so a
    /// respawned stage reopens with exactly the tools it started with.
    pub tools: Vec<crate::delivery::DeliveredTool>,
}

struct RpcResult {
    result: Value,
    response: Value,
}

struct NegotiatedSession {
    initialized: RpcResult,
    created: RpcResult,
    session_id: String,
    supports_http_mcp: bool,
}

pub(crate) struct TeamSessionContext<'a> {
    pub(crate) archive: &'a EventArchive,
    pub(crate) exit_timeout: Duration,
    pub(crate) bus: Option<&'a TeamBusConnection>,
    pub(crate) event_log: Option<EventLog>,
    /// What team memory this session was supplied, already rendered and measured.
    ///
    /// Archived as a `session_meta` event before the opening prompt so replay can split the
    /// prompt into its sections by *record*, not by re-parsing the prose back out of it. The
    /// WebSocket schema stays frozen: `session_meta` is an existing kind and this is one more
    /// documented subtype beside `team_bus_unavailable`.
    pub(crate) packet: Option<&'a crate::memory::ContextPacket>,
    /// What the opening prompt is made of, archived beside it for the same reason.
    pub(crate) composed: Option<&'a crate::memory::ComposedPrompt>,
    /// One more turn to take on this session before it closes, and where its answer goes.
    ///
    /// Team mode's entrypoint is one long turn with **no stage boundary to ask at**, which is why
    /// a team-mode run used to leave nothing to continue from. Its last turn is the only boundary
    /// it has, so this is where the checkpoint request goes. Kept as a hook on the one-shot path
    /// rather than restructuring team mode around `open_live`, because the one-shot path is also
    /// what writes the crash marker that makes a harness dying before `initialize` recoverable.
    pub(crate) boundary: Option<&'a BoundaryTurn<'a>>,
}

/// An extra turn a one-shot session takes before closing, and the answer it produced.
///
/// The answer travels back through a `Mutex` because the driver owns the session and the caller
/// owns what to do with the answer; returning it would mean changing [`SessionOutcome`], which is
/// the shape every existing caller destructures.
pub(crate) struct BoundaryTurn<'a> {
    pub(crate) prompt: &'a str,
    pub(crate) answer: std::sync::Mutex<String>,
}

impl<'a> BoundaryTurn<'a> {
    pub(crate) fn new(prompt: &'a str) -> Self {
        Self {
            prompt,
            answer: std::sync::Mutex::new(String::new()),
        }
    }

    /// What the session answered, or an empty string when the turn never ran.
    pub(crate) fn answer(&self) -> String {
        self.answer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// The wired tools as ACP `McpServer` objects, or why this harness cannot take one of them.
///
/// ACP requires every agent to accept stdio servers; HTTP and SSE only when `initialize`
/// advertised them. A tool the harness cannot take fails the run here, before `session/new`, naming
/// the tool and the transport — never a session that silently lacks it (ADR 0029 decision 5).
fn wired_tool_servers(
    agent_id: &str,
    tools: &[crate::delivery::DeliveredTool],
    initialized: &Value,
) -> Result<Vec<Value>> {
    use crate::delivery::Transport;

    let advertises = |transport: &str| {
        initialized
            .pointer(&format!("/agentCapabilities/mcpCapabilities/{transport}"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    tools
        .iter()
        .map(|tool| {
            let accepted = match tool.transport {
                Transport::Stdio => true,
                Transport::Http => advertises("http"),
                Transport::Sse => advertises("sse"),
            };
            if !accepted {
                bail!(
                    "cannot deliver the tool {} to {agent_id}: its server {} uses {} and this \
                     harness did not advertise {} MCP support. Disconnect the tool from this \
                     agent, or configure a stdio version of the server.",
                    tool.name,
                    tool.server,
                    tool.transport.label(),
                    tool.transport.label()
                );
            }
            Ok(tool.server_definition.clone())
        })
        .collect()
}

/// Owns one ACP child and both sides of its line-delimited JSON-RPC stream.
pub struct AcpProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Lines<BufReader<ChildStdout>>,
    stderr: JoinHandle<std::io::Result<String>>,
    next_request_id: u64,
    cwd: PathBuf,
    has_run: bool,
    /// Set as soon as `session/new` responds, so a mid-turn failure can still
    /// mark and recover the partial session.
    session_id: Option<String>,
    /// Shared archive writer. Delegated agents receive the root writer so all agents in one
    /// team run share a single dense replay sequence.
    event_log: Option<EventLog>,
    /// How long to wait for any one JSON-RPC response before abandoning the turn.
    /// Defaults to [`REQUEST_TIMEOUT`]; overridable in tests.
    request_timeout: Duration,
    /// Whether the harness advertised `agentCapabilities.loadSession` in its `initialize`
    /// response — decision 7's tier selector, read from the response this process already
    /// archives as `session_meta`. `false` until `initialize` has answered.
    supports_load_session: bool,
    /// Wired MCP servers, from [`ProcessSpec::tools`].
    tools: Vec<crate::delivery::DeliveredTool>,
}

impl AcpProcess {
    /// Spawn the configured harness with piped standard streams.
    ///
    /// # Errors
    ///
    /// Returns an error when the process cannot be spawned or its streams are unavailable.
    pub fn spawn(spec: &ProcessSpec) -> Result<Self> {
        let mut command = Command::new(&spec.cmd);
        command
            .args(&spec.args)
            .envs(&spec.env)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .context("ACP child did not expose stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("ACP child did not expose stdout")?;
        let child_stderr = child
            .stderr
            .take()
            .context("ACP child did not expose stderr")?;
        let stderr = tokio::spawn(async move {
            let mut text = String::new();
            BufReader::new(child_stderr)
                .read_to_string(&mut text)
                .await?;
            Ok(text)
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout).lines(),
            stderr,
            next_request_id: 1,
            cwd: spec.cwd.clone(),
            has_run: false,
            session_id: None,
            event_log: None,
            request_timeout: REQUEST_TIMEOUT,
            supports_load_session: false,
            tools: spec.tools.clone(),
        })
    }

    #[cfg(test)]
    fn with_request_timeout(mut self, request_timeout: Duration) -> Self {
        self.request_timeout = request_timeout;
        self
    }

    /// The shared archive event log this process ended up writing to, once negotiated.
    ///
    /// Lets a multi-node caller (the pipeline orchestrator) hand the same log to the next
    /// node's process so every node's events land in one dense, ordered archive session.
    pub(crate) fn event_log(&self) -> Option<EventLog> {
        self.event_log.clone()
    }

    /// Drive one complete ACP turn and wait for the harness to exit.
    ///
    /// # Errors
    ///
    /// Returns an error for protocol failures, archive failures, or an unsuccessful child exit.
    pub async fn run_session(
        &mut self,
        agent_id: &str,
        model: &str,
        prompt: &str,
        archive: &EventArchive,
        exit_timeout: Duration,
    ) -> Result<SessionOutcome> {
        self.run_session_with_context(
            agent_id,
            model,
            prompt,
            TeamSessionContext {
                archive,
                exit_timeout,
                bus: None,
                event_log: None,
                packet: None,
                composed: None,
                boundary: None,
            },
        )
        .await
    }

    /// Drive a turn with access to the shared Team Bus and, for delegated agents, the root
    /// run's ordered event log.
    pub(crate) async fn run_session_with_bus(
        &mut self,
        agent_id: &str,
        model: &str,
        prompt: &str,
        context: TeamSessionContext<'_>,
    ) -> Result<SessionOutcome> {
        self.run_session_with_context(agent_id, model, prompt, context)
            .await
    }

    /// Negotiate a session and keep it open for more than one turn.
    ///
    /// `run_session_with_context` is the one-shot path: it prompts once and tears the process
    /// down. A pipeline stage that must stay answerable to the stage after it needs the opposite —
    /// the session it already built, still holding its own context, ready to take another prompt.
    /// The caller owns the returned [`Recorder`] and must finish with [`Self::finish_live`], which
    /// closes the session and reaps the child.
    pub(crate) async fn open_live(
        &mut self,
        agent_id: &str,
        model: &str,
        context: &mut TeamSessionContext<'_>,
    ) -> Result<Recorder> {
        if self.has_run {
            bail!("this ACP process has already run a session");
        }
        self.has_run = true;
        let process_id = self.child.id().context("ACP child has no process id")?;
        self.negotiate_session(agent_id, model, process_id, context)
            .await
    }

    /// Whether this harness said it can reopen a session it already had (`session/load`).
    ///
    /// Decision 7's tier selector, and it is read from the harness's own `initialize` response —
    /// the one this process already archives as `session_meta` — never from a table of harness
    /// names. A harness that gains or loses the capability between versions therefore changes tier
    /// without `LoomWatch` being edited, and one `LoomWatch` has never heard of is tiered correctly
    /// the first time it runs.
    pub(crate) fn supports_load_session(&self) -> bool {
        self.supports_load_session
    }

    /// The ACP session id this process negotiated, once it has one. Kept across a park so
    /// [`Self::load_live`] can reopen the same conversation rather than a fresh one.
    pub(crate) fn acp_session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Close the session and reap the child **without** producing a run outcome.
    ///
    /// What parking a `loadSession` harness is: the conversation is left on the harness's side,
    /// this end lets go of the process, and the ACP session id is what reopens it. Deliberately
    /// not `finish_live`: that verifies the archive session and returns the run's answer, and a
    /// park is not the end of anything.
    ///
    /// # Errors
    ///
    /// Returns an error when `session/close` fails or the child cannot be reaped.
    pub(crate) async fn park_session(
        &mut self,
        recorder: &mut Recorder,
        exit_timeout: Duration,
    ) -> Result<()> {
        self.close_session(recorder).await?;
        let exit = self.shutdown(exit_timeout).await?;
        recorder
            .append(
                EventKind::Process,
                json!({
                    "phase": if exit.success { "exited" } else { "crashed" },
                    "exitCode": exit.code, "signal": exit.signal, "message": exit.stderr,
                    "parked": true
                }),
                None,
            )
            .await?;
        if !exit.success {
            bail!("ACP child failed while parking: {}", exit.stderr);
        }
        Ok(())
    }

    /// Reopen a parked session on a **fresh process** with `session/load`.
    ///
    /// The harness replays the conversation as `session/update` notifications while the request is
    /// in flight, which is exactly what makes this cheap — and exactly what would double-count
    /// every piece of evidence if the archive treated them as new. So the replay is bracketed:
    /// a `session_meta` with `phase: "session_loaded"` is appended **before** the request goes out
    /// and one with `phase: "session_replayed"` after it answers, and the projection ignores
    /// everything between them. Both are additive subtypes beside `team_bus_unavailable`; no event
    /// kind was added and the WebSocket envelope is untouched.
    ///
    /// # Errors
    ///
    /// Returns an error when the handshake fails or the harness refuses the session id — which is
    /// the case that matters: a harness that answered `session/load` with a *different* session
    /// would be a different conversation wearing the same name.
    #[allow(clippy::too_many_lines)]
    pub(crate) async fn load_live(
        &mut self,
        agent_id: &str,
        acp_session_id: &str,
        context: &mut TeamSessionContext<'_>,
    ) -> Result<Recorder> {
        if self.has_run {
            bail!("this ACP process has already run a session");
        }
        self.has_run = true;
        let process_id = self.child.id().context("ACP child has no process id")?;
        let initialized = self
            .request(
                "initialize",
                &json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": false, "writeTextFile": false},
                        "terminal": false
                    },
                    "clientInfo": {"name": "loomwatch", "version": env!("CARGO_PKG_VERSION")}
                }),
                None,
            )
            .await
            .context("ACP initialize failed while reloading a parked session")?;
        self.supports_load_session = advertises_load_session(&initialized.result);
        if !self.supports_load_session {
            bail!(
                "the harness for {agent_id} no longer advertises agentCapabilities.loadSession, so \
                 the session parked as {acp_session_id} cannot be reopened"
            );
        }
        let supports_http_mcp = initialized
            .result
            .pointer("/agentCapabilities/mcpCapabilities/http")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // The same Team Bus definition the session was created with. A reloaded session that was
        // handed a *different* bus would be a session whose tools moved under it mid-conversation.
        let mut mcp_servers = if supports_http_mcp {
            context
                .bus
                .map(TeamBusConnection::server_definition)
                .into_iter()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        // And the same wired tools, for the same reason.
        mcp_servers.extend(wired_tool_servers(
            agent_id,
            &self.tools,
            &initialized.result,
        )?);
        self.session_id = Some(acp_session_id.to_owned());

        let event_log = context
            .event_log
            .take()
            .context("reloading a parked session needs the run's archive log")?;
        self.event_log = Some(event_log.clone());
        if let Some(bus) = context.bus {
            bus.register(event_log.clone()).await;
        }
        let mut recorder = Recorder::with_log(event_log, acp_session_id.to_owned(), agent_id);
        recorder
            .append(
                EventKind::Process,
                json!({"phase": "spawned", "pid": process_id}),
                None,
            )
            .await?;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase": "initialize", "result": initialized.result}),
                Some(initialized.response.clone()),
            )
            .await?;
        // Before the request, never after: the frames it provokes arrive *during* it.
        recorder
            .append(
                EventKind::SessionMeta,
                json!({
                    "phase": "session_loaded",
                    "sessionId": acp_session_id,
                    "reason": "the operator answered; the parked session is being reopened"
                }),
                Some(json!({"source": "loomwatch", "phase": "session_loaded"})),
            )
            .await?;
        let before = recorder.event_log.events_appended().await;
        let cwd = self.cwd.to_string_lossy().into_owned();
        let loaded = self
            .request(
                "session/load",
                &json!({"sessionId": acp_session_id, "cwd": cwd, "mcpServers": mcp_servers}),
                Some(&mut recorder),
            )
            .await
            .with_context(|| format!("ACP session/load failed for session {acp_session_id}"))?;
        let replayed = recorder
            .event_log
            .events_appended()
            .await
            .saturating_sub(before);
        // The reply the replay streamed is the *old* conversation's, not a new turn's. Clearing it
        // is what stops a reloaded stage answering with what it already said.
        recorder.reply.clear();
        recorder
            .append(
                EventKind::SessionMeta,
                json!({
                    "phase": "session_replayed",
                    "sessionId": acp_session_id,
                    "frames": replayed,
                    "result": loaded.result
                }),
                Some(loaded.response),
            )
            .await?;
        Ok(recorder)
    }

    /// Close a live session and reap the child, returning the same shape a one-shot run returns.
    pub(crate) async fn finish_live(
        &mut self,
        recorder: &mut Recorder,
        last_reply: String,
        context: &TeamSessionContext<'_>,
    ) -> Result<SessionOutcome> {
        let archive_session_id = recorder.event_log.session_id().to_owned();
        self.close_session(recorder).await?;
        let exit = self.shutdown(context.exit_timeout).await?;
        recorder
            .append(
                EventKind::Process,
                json!({
                    "phase": if exit.success { "exited" } else { "crashed" },
                    "exitCode": exit.code,
                    "signal": exit.signal,
                    "message": exit.stderr
                }),
                None,
            )
            .await?;
        if !exit.success {
            bail!(
                "ACP session {archive_session_id} child exited with code {}; stderr: {}",
                exit.code,
                exit.stderr
            );
        }
        let events = context.archive.verify_session(&archive_session_id).await?;
        Ok(SessionOutcome {
            session_id: archive_session_id,
            event_count: events.len(),
            exit_code: exit.code,
            reply: last_reply,
        })
    }

    async fn run_session_with_context(
        &mut self,
        agent_id: &str,
        model: &str,
        prompt: &str,
        mut context: TeamSessionContext<'_>,
    ) -> Result<SessionOutcome> {
        if self.has_run {
            bail!("this ACP process has already run a session");
        }
        self.has_run = true;
        let process_id = self.child.id().context("ACP child has no process id")?;
        let execution = self
            .run_session_inner(agent_id, model, prompt, process_id, &mut context)
            .await;
        let exit = self.shutdown(context.exit_timeout).await;
        // A failure before `session/new` never reached `start_recorder`, so this process has
        // no log of its own; a pre-minted or shared (pipeline / delegated) log still names the
        // archive session the crash belongs to.
        let failure_log = self.event_log.as_ref().or(context.event_log.as_ref());
        let failure_session_id = failure_log
            .map(|log| log.session_id().to_owned())
            .or_else(|| self.session_id.clone());

        // A protocol or shutdown failure still needs a terminal marker and a recoverable session,
        // otherwise the partial run sits in Postgres with no `crashed` marker and `show` has no
        // session ID to look it up by.
        let crash_marker_error = if (execution.is_err() || exit.is_err())
            && let Some(session_id) = failure_session_id.as_deref()
        {
            append_crash_marker(
                context.archive,
                failure_log,
                session_id,
                agent_id,
                &execution,
                &exit,
            )
            .await
            .err()
        } else {
            None
        };

        match (execution, exit) {
            (Ok((session_id, _event_count, reply)), Ok(exit)) => {
                self.event_log
                    .as_ref()
                    .context("ACP session completed without an event log")?
                    .append(
                        agent_id,
                        EventKind::Process,
                        json!({
                            "phase": if exit.success { "exited" } else { "crashed" },
                            "exitCode": exit.code,
                            "signal": exit.signal,
                            "message": exit.stderr
                        }),
                        None,
                    )
                    .await?;
                let events = context.archive.verify_session(&session_id).await?;
                if !exit.success {
                    bail!(
                        "ACP session {session_id} child exited with code {}; stderr: {}",
                        exit.code,
                        exit.stderr
                    );
                }
                Ok(SessionOutcome {
                    session_id,
                    event_count: events.len(),
                    exit_code: exit.code,
                    reply,
                })
            }
            (Err(error), Ok(_)) | (Ok(_), Err(error)) => Err(with_archive_failure_context(
                with_recovery_context(error, failure_session_id.as_deref()),
                crash_marker_error.as_ref(),
            )),
            (Err(protocol), Err(shutdown)) => Err(with_archive_failure_context(
                with_recovery_context(
                    protocol.context(format!(
                        "the ACP child also failed during shutdown: {shutdown:#}"
                    )),
                    failure_session_id.as_deref(),
                ),
                crash_marker_error.as_ref(),
            )),
        }
    }

    /// Run the `initialize` / `session/new` / `session/set_config_option` handshake and
    /// archive each negotiated response as `session_meta`, so the archive can later say which
    /// model and capabilities actually produced a transcript.
    async fn negotiate_session(
        &mut self,
        agent_id: &str,
        model: &str,
        process_id: u32,
        context: &mut TeamSessionContext<'_>,
    ) -> Result<Recorder> {
        let initialized = self
            .request(
                "initialize",
                &json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": false, "writeTextFile": false},
                        "terminal": false
                    },
                    "clientInfo": {"name": "loomwatch", "version": env!("CARGO_PKG_VERSION")}
                }),
                None,
            )
            .await
            .context("ACP initialize failed")?;

        // Decision 7's tier, read off the response this call is about to archive. Stored before
        // anything else uses it so a park never has to re-derive it from the archive.
        self.supports_load_session = advertises_load_session(&initialized.result);
        let supports_http_mcp = initialized
            .result
            .pointer("/agentCapabilities/mcpCapabilities/http")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut mcp_servers = if supports_http_mcp {
            context
                .bus
                .map(TeamBusConnection::server_definition)
                .into_iter()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        // Checked before `session/new`, so a transport this harness cannot take fails the run
        // before anything is created rather than leaving a session without its tools.
        mcp_servers.extend(wired_tool_servers(
            agent_id,
            &self.tools,
            &initialized.result,
        )?);
        let cwd = self.cwd.to_string_lossy().into_owned();
        let created = self
            .request(
                "session/new",
                &json!({"cwd": cwd, "mcpServers": mcp_servers}),
                None,
            )
            .await
            .context("ACP session/new failed")?;
        let session_id = created
            .result
            .get("sessionId")
            .and_then(Value::as_str)
            .context("ACP session/new response omitted sessionId")?
            .to_owned();
        let negotiated = NegotiatedSession {
            initialized,
            created,
            session_id,
            supports_http_mcp,
        };
        self.session_id = Some(negotiated.session_id.clone());
        let mut recorder = self
            .start_recorder(agent_id, process_id, context, &negotiated)
            .await?;
        self.configure_model(model, &negotiated, &mut recorder)
            .await?;
        Ok(recorder)
    }

    async fn start_recorder(
        &mut self,
        agent_id: &str,
        process_id: u32,
        context: &mut TeamSessionContext<'_>,
        negotiated: &NegotiatedSession,
    ) -> Result<Recorder> {
        let event_log = context.event_log.take().unwrap_or_else(|| {
            EventLog::new(context.archive.clone(), negotiated.session_id.clone())
        });
        self.event_log = Some(event_log.clone());
        if let Some(bus) = context.bus {
            bus.register(event_log.clone()).await;
        }
        let mut recorder = Recorder::with_log(event_log, negotiated.session_id.clone(), agent_id);
        recorder
            .append(
                EventKind::Process,
                json!({"phase": "spawned", "pid": process_id}),
                None,
            )
            .await?;
        if context.bus.is_some() && !negotiated.supports_http_mcp {
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "team_bus_unavailable",
                        "reason": "harness did not advertise HTTP MCP support"
                    }),
                    Some(json!({
                        "source": "loomwatch",
                        "phase": "team_bus_unavailable"
                    })),
                )
                .await?;
        }
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase": "initialize", "result": negotiated.initialized.result}),
                Some(negotiated.initialized.response.clone()),
            )
            .await?;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase": "session_new", "result": negotiated.created.result}),
                Some(negotiated.created.response.clone()),
            )
            .await?;
        // Before the prompt, never after: a crash between the two must leave a record of what was
        // *about* to be supplied rather than a prompt nothing explains.
        if let Some(packet) = context.packet.filter(|packet| !packet.is_empty()) {
            context
                .archive
                .store_context_packet(recorder.event_log.session_id(), packet)
                .await?;
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "context_packet",
                        "heading": crate::memory::TEAM_KNOWLEDGE_HEADING,
                        "chars": packet.used_chars,
                        "budgetChars": packet.budget_chars,
                        "sections": packet.sections,
                    }),
                    Some(json!({"source": "loomwatch", "phase": "context_packet"})),
                )
                .await?;
        }
        // What the opening prompt is made of. Archived for every LoomWatch-composed prompt, not
        // only when memory supplied something, so replay never has to fall back to splitting the
        // prompt on literal headings.
        if let Some(composed) = context.composed {
            recorder.note_delivery(&composed.required_skills);
            recorder
                .append(
                    EventKind::SessionMeta,
                    composed.meta(),
                    Some(json!({"source": "loomwatch", "phase": "prompt_sections"})),
                )
                .await?;
        }
        Ok(recorder)
    }

    /// Apply the reasoning effort as its own config option, or archive why it was skipped.
    ///
    /// Split out of `configure_model` only to keep that function readable; the two halves are one
    /// negotiation and must stay in this order — the effort option's id can appear for the first
    /// time in the *response* to setting the model, which is why `updated_options` is consulted
    /// before the `session/new` result.
    async fn configure_thinking_effort(
        &mut self,
        effort: &str,
        updated_options: Option<&Value>,
        negotiated: &NegotiatedSession,
        recorder: &mut Recorder,
    ) -> Result<()> {
        let effort_config_id = updated_options
            .and_then(find_effort_config_id)
            .or_else(|| find_effort_config_id(&negotiated.created.result));
        let Some(config_id) = effort_config_id else {
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "set_thinking_effort_skipped",
                        "value": effort,
                        "reason": "harness did not advertise a reasoning-effort config option"
                    }),
                    Some(json!({
                        "source": "loomwatch",
                        "phase": "set_thinking_effort_skipped"
                    })),
                )
                .await?;
            return Ok(());
        };
        let effort_response = self
            .request(
                "session/set_config_option",
                &json!({"sessionId": negotiated.session_id, "configId": config_id, "value": effort}),
                Some(recorder),
            )
            .await
            .with_context(|| format!("ACP harness rejected thinking effort {effort:?}"))?;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({
                    "phase": "set_thinking_effort",
                    "configId": config_id,
                    "value": effort,
                    "result": effort_response.result
                }),
                Some(effort_response.response),
            )
            .await?;
        Ok(())
    }

    async fn configure_model(
        &mut self,
        model: &str,
        negotiated: &NegotiatedSession,
        recorder: &mut Recorder,
    ) -> Result<()> {
        // Current ACP adapters expose model and reasoning effort as separate config options.
        // Older team files may still carry Codex's combined `model[effort]` selector, so split
        // only suffixes that are known reasoning levels (Claude's `model[1m]` remains intact).
        let (model_id, thinking_effort) = split_reasoning_selector(model);
        let supports_model_config = negotiated
            .created
            .result
            .get("configOptions")
            .and_then(Value::as_array)
            .is_some_and(|options| {
                options
                    .iter()
                    .any(|option| option.get("id").and_then(Value::as_str) == Some("model"))
            });
        if supports_model_config {
            let config_response = self
                .request(
                    "session/set_config_option",
                    &json!({"sessionId": negotiated.session_id, "configId": "model", "value": model_id}),
                    Some(recorder),
                )
                .await
                .with_context(|| format!("ACP harness rejected configured model {model_id:?}"))?;
            let updated_options = config_response.result.get("configOptions").cloned();
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "set_config_option",
                        "configId": "model",
                        "value": model_id,
                        "result": config_response.result
                    }),
                    Some(config_response.response),
                )
                .await?;

            if let Some(effort) = thinking_effort {
                self.configure_thinking_effort(
                    effort,
                    updated_options.as_ref(),
                    negotiated,
                    recorder,
                )
                .await?;
            }
        } else if negotiated
            .created
            .result
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .is_some()
        {
            let config_response = self
                .request(
                    "session/set_model",
                    &json!({"sessionId": negotiated.session_id, "modelId": model}),
                    Some(recorder),
                )
                .await
                .with_context(|| format!("ACP harness rejected configured model {model:?}"))?;
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "set_model",
                        "value": model,
                        "result": config_response.result
                    }),
                    Some(config_response.response),
                )
                .await?;
        } else {
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "set_config_option_skipped",
                        "configId": "model",
                        "value": model,
                        "reason": "harness did not advertise a model config option"
                    }),
                    Some(json!({
                        "source": "loomwatch",
                        "phase": "set_config_option_skipped"
                    })),
                )
                .await?;
        }
        Ok(())
    }

    async fn run_session_inner(
        &mut self,
        agent_id: &str,
        model: &str,
        prompt: &str,
        process_id: u32,
        context: &mut TeamSessionContext<'_>,
    ) -> Result<(String, usize, String)> {
        let mut recorder = self
            .negotiate_session(agent_id, model, process_id, context)
            .await?;
        let archive_session_id = recorder.event_log.session_id().to_owned();
        let reply = self.prompt_turn(&mut recorder, prompt).await?;
        // The boundary turn, before the close and after the work: a session that has already been
        // closed cannot say where it stopped, and a session that is asked before it works has
        // nothing to say.
        if let Some(boundary) = context.boundary {
            let answer = self
                .bookkeeping_turn(&mut recorder, boundary.prompt, "checkpoint")
                .await?;
            *boundary
                .answer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = answer;
        }
        self.close_session(&mut recorder).await?;
        let events = context.archive.verify_session(&archive_session_id).await?;
        Ok((archive_session_id, events.len(), reply))
    }

    /// One `session/prompt` round trip on an already-negotiated session, archived exactly as a
    /// single-turn run archives it. Split out of `run_session_inner` so a session can take more
    /// than one turn: a pipeline stage that stays alive answers its successor's questions here,
    /// with the context it already built, rather than being respawned cold.
    pub(crate) async fn prompt_turn(
        &mut self,
        recorder: &mut Recorder,
        prompt: &str,
    ) -> Result<String> {
        let session_id = recorder.acp_session_id.clone();
        let prompt_params = json!({
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": prompt}]
        });
        let (prompt_id, prompt_request) = self.next_request("session/prompt", &prompt_params);
        recorder
            .append(
                EventKind::Message,
                json!({
                    "role": "user",
                    "messageId": null,
                    "content": {"type": "text", "text": prompt}
                }),
                Some(prompt_request.clone()),
            )
            .await?;
        recorder.reply.clear();
        recorder.reply_phase_known = false;
        self.send(&prompt_request).await?;
        if !recorder.required_skills.is_empty() {
            let skills = std::mem::take(&mut recorder.required_skills);
            recorder.append(EventKind::SessionMeta, json!({
                "phase": "required_skills_supplied", "skills": skills, "promptId": prompt_id,
                "method": "session/prompt"
            }), Some(json!({"source": "loomwatch", "phase": "required_skills_supplied"}))).await?;
        }
        let prompted = self
            .read_response(prompt_id, "session/prompt", Some(recorder))
            .await
            .context("ACP session/prompt failed")?;
        let stop_reason = prompted
            .result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn");
        let mut turn_end = serde_json::Map::from_iter([(
            "stopReason".to_owned(),
            Value::String(stop_reason.to_owned()),
        )]);
        if let Some(usage) = prompted.result.get("usage") {
            turn_end.insert("usage".to_owned(), usage.clone());
        }
        recorder
            .append(
                EventKind::TurnEnd,
                Value::Object(turn_end),
                Some(prompted.response),
            )
            .await?;
        // Read from the reply before it is taken. A self-report is the agent's own account, so it
        // is archived under its own phase and never becomes provenance (CONTRACT §8.2).
        recorder.note_self_report().await?;

        Ok(std::mem::take(&mut recorder.reply))
    }

    /// Record why a coordinator-requested turn exists. Its text and cost remain evidence, but
    /// a checkpoint or handover must never replace the agent's answer in the Output card.
    pub(crate) async fn bookkeeping_turn(
        &mut self,
        recorder: &mut Recorder,
        prompt: &str,
        purpose: &str,
    ) -> Result<String> {
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase":"turn_purpose", "purpose":purpose}),
                None,
            )
            .await?;
        let answer = self.prompt_turn(recorder, prompt).await;
        recorder
            .append(
                EventKind::SessionMeta,
                json!({"phase":"turn_purpose", "purpose":"work"}),
                None,
            )
            .await?;
        answer
    }

    /// End the ACP session. The process is still running afterwards; `shutdown` reaps it.
    pub(crate) async fn close_session(&mut self, recorder: &mut Recorder) -> Result<()> {
        let session_id = recorder.acp_session_id.clone();
        self.request(
            "session/close",
            &json!({"sessionId": session_id}),
            Some(recorder),
        )
        .await
        .context("ACP session/close failed")?;
        Ok(())
    }

    async fn request(
        &mut self,
        method: &str,
        params: &Value,
        recorder: Option<&mut Recorder>,
    ) -> Result<RpcResult> {
        let (id, request) = self.next_request(method, params);
        self.send(&request).await?;
        self.read_response(id, method, recorder).await
    }

    fn next_request(&mut self, method: &str, params: &Value) -> (u64, Value) {
        let id = self.next_request_id;
        self.next_request_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        (id, request)
    }

    async fn read_response(
        &mut self,
        id: u64,
        method: &str,
        mut recorder: Option<&mut Recorder>,
    ) -> Result<RpcResult> {
        loop {
            let Ok(read) = timeout(self.request_timeout, self.stdout.next_line()).await else {
                self.cancel_current_turn().await;
                bail!(
                    "timed out after {:?} waiting for ACP response to {method}",
                    self.request_timeout
                );
            };
            let line = read
                .with_context(|| format!("ACP child stream error waiting for {method}"))?
                .with_context(|| format!("ACP child exited before responding to {method}"))?;
            let message: Value = serde_json::from_str(&line)
                .with_context(|| format!("ACP child emitted invalid JSON: {line:?}"))?;
            if let Some(recorder) = recorder.as_deref_mut() {
                recorder.record_frame(&message).await?;
            }
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && (message.get("result").is_some() || message.get("error").is_some())
            {
                if let Some(error) = message.get("error") {
                    bail!("ACP error response: {error}");
                }
                return Ok(RpcResult {
                    result: message.get("result").cloned().unwrap_or(Value::Null),
                    response: message,
                });
            }

            if message.get("method").is_some() && message.get("id").is_some() {
                let response = build_client_response(&message)?;
                if let Some(recorder) = recorder.as_deref_mut() {
                    recorder.record_frame(&response).await?;
                }
                self.send(&response).await?;
            }
        }
    }

    async fn send(&mut self, message: &Value) -> Result<()> {
        let stdin = self.stdin.as_mut().context("ACP child stdin is closed")?;
        let mut encoded = serde_json::to_vec(message)?;
        encoded.push(b'\n');
        stdin.write_all(&encoded).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Best-effort `session/cancel` once `LoomWatch` has already abandoned the turn, so a
    /// well-behaved harness can stop working — and stop spending — before the transport is
    /// torn down and the child killed in [`shutdown`](Self::shutdown). The harness may be
    /// wedged and never see this; the failure is expected and deliberately ignored.
    async fn cancel_current_turn(&mut self) {
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {"sessionId": session_id}
        });
        let _ = self.send(&notification).await;
    }

    async fn shutdown(&mut self, exit_timeout: Duration) -> Result<ExitReport> {
        drop(self.stdin.take());
        let status = if let Ok(status) = timeout(exit_timeout, self.child.wait()).await {
            status?
        } else {
            self.child
                .kill()
                .await
                .context("failed to kill hung ACP child")?;
            self.child
                .wait()
                .await
                .context("failed to reap killed ACP child")?
        };
        let stderr = (&mut self.stderr)
            .await
            .context("ACP stderr drain task failed")??;
        let code = status.code().unwrap_or(-1);
        Ok(ExitReport {
            code,
            signal: signal_death(status),
            success: status.success(),
            stderr: stderr.trim().to_owned(),
        })
    }
}

/// Whether an `initialize` result advertises `agentCapabilities.loadSession`.
///
/// The archived responses in `docs/research/acp-mcp-injection.md` put this flag at
/// `agentCapabilities.loadSession`; some adapters spell the same fact under a nested
/// `sessionCapabilities`, so both are read. Anything absent or non-boolean is `false` —
/// "unconfirmed" tiers to keep-alive, which costs a process and is recoverable, where guessing the
/// other way would close a session that could never be reopened.
fn advertises_load_session(result: &Value) -> bool {
    [
        "/agentCapabilities/loadSession",
        "/sessionCapabilities/load",
    ]
    .iter()
    .any(|pointer| {
        result
            .pointer(pointer)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

/// Ask an ACP harness for the models it exposes to this local account.
///
/// Model availability belongs to the harness: it may depend on authentication, provider
/// configuration, feature flags, or locally installed extensions. `LoomWatch` therefore performs
/// the standard initialize/session-new handshake instead of maintaining a vendor model list.
///
/// # Errors
///
/// Returns an error when the harness cannot be spawned or does not complete the ACP handshake.
pub async fn discover_models(spec: &ProcessSpec) -> Result<DiscoveredModelCatalog> {
    let mut process = AcpProcess::spawn(spec)?;
    process.request_timeout = DISCOVERY_REQUEST_TIMEOUT;

    let discovery = async {
        process
            .request(
                "initialize",
                &json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": false, "writeTextFile": false},
                        "terminal": false
                    },
                    "clientInfo": {"name": "loomwatch", "version": env!("CARGO_PKG_VERSION")}
                }),
                None,
            )
            .await
            .context("ACP initialize failed during model discovery")?;

        let cwd = process.cwd.to_string_lossy().into_owned();
        let created = process
            .request("session/new", &json!({"cwd": cwd, "mcpServers": []}), None)
            .await
            .context("ACP session/new failed during model discovery")?;
        let session_id = created
            .result
            .get("sessionId")
            .and_then(Value::as_str)
            .context("ACP session/new response omitted sessionId")?
            .to_owned();
        process.session_id = Some(session_id.clone());
        let models = model_catalog_from_session(&created.result);

        // Closing is best effort. Some early ACP adapters omit session/close, and discovery has
        // already succeeded once session/new returned its model state.
        process.request_timeout = DISCOVERY_EXIT_TIMEOUT;
        let _ = process
            .request("session/close", &json!({"sessionId": session_id}), None)
            .await;
        Ok(models)
    }
    .await;

    let shutdown = process.shutdown(DISCOVERY_EXIT_TIMEOUT).await;
    match (discovery, shutdown) {
        (Ok(models), _) => Ok(models),
        (Err(error), Ok(_)) => Err(error),
        (Err(error), Err(shutdown)) => Err(error.context(format!(
            "the ACP child also failed during discovery shutdown: {shutdown:#}"
        ))),
    }
}

fn model_catalog_from_session(session: &Value) -> DiscoveredModelCatalog {
    let config_options = session.get("configOptions").and_then(Value::as_array);
    let model_config = config_options.and_then(|options| {
        options
            .iter()
            .find(|option| option.get("id").and_then(Value::as_str) == Some("model"))
    });
    let effort_config = config_options.and_then(|options| {
        options.iter().find(|option| {
            matches!(
                option.get("id").and_then(Value::as_str),
                Some("reasoning_effort" | "effort")
            )
        })
    });

    let global_efforts = effort_config
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array)
        .map(|options| select_choices(options, "value"))
        .unwrap_or_default()
        .into_iter()
        .map(|choice| DiscoveredThinkingEffort {
            id: choice.id,
            name: choice.name,
            description: choice.description,
        })
        .collect::<Vec<_>>();
    let effort_by_id = global_efforts
        .iter()
        .cloned()
        .map(|effort| (effort.id.clone(), effort))
        .collect::<HashMap<_, _>>();

    let available = session
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let supported_efforts = supported_efforts_by_model(&available);

    let mut models = Vec::new();
    let mut seen = HashSet::new();
    if let Some(options) = model_config
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array)
    {
        for choice in select_choices(options, "value") {
            if seen.insert(choice.id.clone()) {
                models.push(DiscoveredModel {
                    thinking_efforts: efforts_for_model(
                        &choice.id,
                        &supported_efforts,
                        &global_efforts,
                        &effort_by_id,
                    ),
                    id: choice.id,
                    name: choice.name,
                    description: choice.description,
                });
            }
        }
    }

    // Fall back to (or supplement sparse legacy config with) the modern model state. Combined
    // selectors collapse to one human-facing model entry; only the display name is shown in UI.
    for model in &available {
        let Some(selector) = model
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let (model_id, _) = split_reasoning_selector(selector);
        if !seen.insert(model_id.to_owned()) {
            continue;
        }
        let raw_name = model
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(model_id);
        models.push(DiscoveredModel {
            id: model_id.to_owned(),
            name: strip_effort_name(raw_name).to_owned(),
            description: model
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
            thinking_efforts: efforts_for_model(
                model_id,
                &supported_efforts,
                &global_efforts,
                &effort_by_id,
            ),
        });
    }

    let (current_model_id, current_thinking_effort) =
        current_selection(session, model_config, effort_config);

    DiscoveredModelCatalog {
        models,
        current_model_id,
        current_thinking_effort,
    }
}

/// Modern model state may enumerate one id per model/effort pair. Keep that information so the
/// slider never offers an effort the selected model cannot run.
fn supported_efforts_by_model(available: &[Value]) -> HashMap<String, Vec<String>> {
    let mut supported: HashMap<String, Vec<String>> = HashMap::new();
    for model in available {
        let Some(selector) = model.get("modelId").and_then(Value::as_str) else {
            continue;
        };
        let (model_id, effort) = split_reasoning_selector(selector);
        if let Some(effort) = effort {
            let values = supported.entry(model_id.to_owned()).or_default();
            if !values.iter().any(|value| value == effort) {
                values.push(effort.to_owned());
            }
        }
    }
    supported
}

/// What the harness says it is currently set to, from either the config option or the typed model
/// state — and, when only a combined `model[effort]` selector is available, split back out of it.
fn current_selection(
    session: &Value,
    model_config: Option<&Value>,
    effort_config: Option<&Value>,
) -> (Option<String>, Option<String>) {
    let current_selector = model_config
        .and_then(|option| option.get("currentValue"))
        .and_then(Value::as_str)
        .or_else(|| {
            session
                .pointer("/models/currentModelId")
                .and_then(Value::as_str)
        });
    let (current_model_id, selector_effort) = current_selector
        .map(split_reasoning_selector)
        .map_or((None, None), |(model, effort)| {
            (Some(model.to_owned()), effort.map(str::to_owned))
        });
    let current_thinking_effort = effort_config
        .and_then(|option| option.get("currentValue"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(selector_effort);
    (current_model_id, current_thinking_effort)
}

#[derive(Debug)]
struct SelectChoice {
    id: String,
    name: String,
    description: Option<String>,
}

fn select_choices(options: &[Value], value_key: &str) -> Vec<SelectChoice> {
    let mut choices = Vec::new();
    for option in options {
        if let Some(id) = option
            .get(value_key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            choices.push(SelectChoice {
                id: id.to_owned(),
                name: option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_owned(),
                description: option
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        } else if let Some(group) = option.get("options").and_then(Value::as_array) {
            choices.extend(select_choices(group, value_key));
        }
    }
    choices
}

fn efforts_for_model(
    model_id: &str,
    supported: &HashMap<String, Vec<String>>,
    global: &[DiscoveredThinkingEffort],
    by_id: &HashMap<String, DiscoveredThinkingEffort>,
) -> Vec<DiscoveredThinkingEffort> {
    let Some(ids) = supported.get(model_id) else {
        return global.to_vec();
    };
    ids.iter()
        .map(|id| {
            by_id
                .get(id)
                .cloned()
                .unwrap_or_else(|| DiscoveredThinkingEffort {
                    id: id.clone(),
                    name: humanize_effort(id),
                    description: None,
                })
        })
        .collect()
}

fn humanize_effort(value: &str) -> String {
    match value {
        "xhigh" => "Extra high".to_owned(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

fn strip_effort_name(name: &str) -> &str {
    for effort in REASONING_EFFORTS {
        if let Some(base) = name.strip_suffix(&format!(" ({effort})")) {
            return base;
        }
    }
    name
}

const REASONING_EFFORTS: &[&str] = &[
    "default", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

fn split_reasoning_selector(selector: &str) -> (&str, Option<&str>) {
    let Some((base, suffix)) = selector.rsplit_once('[') else {
        return (selector, None);
    };
    let Some(effort) = suffix.strip_suffix(']') else {
        return (selector, None);
    };
    if REASONING_EFFORTS.contains(&effort) {
        (base, Some(effort))
    } else {
        (selector, None)
    }
}

fn find_effort_config_id(value: &Value) -> Option<&str> {
    let options = value
        .as_array()
        .or_else(|| value.get("configOptions").and_then(Value::as_array))?;
    options.iter().find_map(|option| {
        let id = option.get("id").and_then(Value::as_str)?;
        matches!(id, "reasoning_effort" | "effort").then_some(id)
    })
}

struct ExitReport {
    code: i32,
    /// Populated when the child was terminated by a signal — `status.code()` is `None` in
    /// that case, so a bare `-1` exit code cannot otherwise be told apart from a real one.
    signal: Option<String>,
    success: bool,
    stderr: String,
}

/// Name the signal that killed the child, if one did. `SIGKILL` for the common
/// timeout/OOM path; unrecognized numbers fall back to `SIG<n>`.
fn signal_death(status: std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|number| {
        let name = match number {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            4 => "SIGILL",
            6 => "SIGABRT",
            8 => "SIGFPE",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            15 => "SIGTERM",
            _ => return format!("SIG{number}"),
        };
        name.to_owned()
    })
}

/// Write the terminal `process: crashed` marker for a run that failed before it could record
/// its own, so the partial session still ends with a marker `show` can locate. Carries the
/// exit code and, for a signal death, the signal name.
async fn append_crash_marker(
    archive: &EventArchive,
    event_log: Option<&EventLog>,
    session_id: &str,
    agent_id: &str,
    execution: &Result<(String, usize, String)>,
    exit: &Result<ExitReport>,
) -> Result<()> {
    let mut failures = Vec::new();
    if let Err(error) = execution {
        failures.push(format!("session execution failed: {error:#}"));
    }
    match exit {
        Ok(report) if !report.stderr.is_empty() => {
            failures.push(format!("stderr: {}", report.stderr));
        }
        Err(error) => failures.push(format!("shutdown failed: {error:#}")),
        Ok(_) => {}
    }
    let payload = json!({
        "phase": "crashed",
        "exitCode": exit.as_ref().map_or(-1, |report| report.code),
        "signal": exit.as_ref().ok().and_then(|report| report.signal.clone()),
        "message": failures.join("; ")
    });
    if let Some(event_log) = event_log {
        event_log
            .append(agent_id, EventKind::Process, payload, None)
            .await
    } else {
        let seq = archive
            .load_session(session_id)
            .await
            .with_context(|| format!("failed to recover partial ACP session {session_id}"))?
            .len() as u64;
        append_archive_event(
            archive,
            session_id,
            agent_id,
            seq,
            EventKind::Process,
            payload,
            None,
        )
        .await
    }
}

fn with_recovery_context(error: anyhow::Error, session_id: Option<&str>) -> anyhow::Error {
    match session_id {
        Some(session_id) => error.context(format!(
            "partial ACP session is recoverable with session_id={session_id}"
        )),
        None => error,
    }
}

fn with_archive_failure_context(
    error: anyhow::Error,
    archive_error: Option<&anyhow::Error>,
) -> anyhow::Error {
    match archive_error {
        Some(archive_error) => {
            error.context(format!("failed to archive crash marker: {archive_error:#}"))
        }
        None => error,
    }
}

/// Build `LoomWatch`'s reply to an agent-initiated client request.
///
/// For `session/request_permission`, ACP's `cancelled` outcome tells the agent the whole
/// prompt turn was cancelled, which is wrong for an observer merely declining one tool call.
/// Prefer an advertised `reject_once` option so the agent denies that call and keeps going,
/// then `reject_always`, falling back to `cancelled` only when the harness offered neither.
fn build_client_response(request: &Value) -> Result<Value> {
    let id = request
        .get("id")
        .cloned()
        .context("client request omitted id")?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .context("client request omitted method")?;
    let response = if method == "session/request_permission" {
        let rejection = request
            .pointer("/params/options")
            .and_then(Value::as_array)
            .and_then(|options| {
                options
                    .iter()
                    .find(|option| {
                        option.get("kind").and_then(Value::as_str) == Some("reject_once")
                    })
                    .or_else(|| {
                        options.iter().find(|option| {
                            option.get("kind").and_then(Value::as_str) == Some("reject_always")
                        })
                    })
            })
            .and_then(|option| option.get("optionId").cloned());
        let outcome = match rejection {
            Some(option_id) => json!({"outcome": "selected", "optionId": option_id}),
            None => json!({"outcome": "cancelled"}),
        };
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {"outcome": outcome}
        })
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32601, "message": format!("unsupported client method {method}")}
        })
    };
    Ok(response)
}

/// One dense, serialized event stream shared by every ACP process in a team run.
#[derive(Clone)]
pub(crate) struct EventLog {
    inner: Arc<EventLogInner>,
}

struct EventLogInner {
    archive: EventArchive,
    session_id: String,
    next_seq: Mutex<u64>,
}

impl EventLog {
    pub(crate) fn new(archive: EventArchive, session_id: String) -> Self {
        Self {
            inner: Arc::new(EventLogInner {
                archive,
                session_id,
                next_seq: Mutex::new(0),
            }),
        }
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    /// How many events this log has appended, i.e. the archive `seq` high-water mark for the run.
    ///
    /// A checkpoint records it so a continuation can say exactly how much evidence the checkpoint
    /// covers, rather than implying it covers everything.
    pub(crate) async fn events_appended(&self) -> u64 {
        *self.inner.next_seq.lock().await
    }

    pub(crate) async fn append(
        &self,
        agent_id: &str,
        kind: EventKind,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<()> {
        let mut next_seq = self.inner.next_seq.lock().await;
        append_archive_event(
            &self.inner.archive,
            &self.inner.session_id,
            agent_id,
            *next_seq,
            kind,
            payload,
            raw,
        )
        .await?;
        *next_seq += 1;
        Ok(())
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
        let mut next_seq = self.inner.next_seq.lock().await;
        self.inner
            .archive
            .append(&RunEvent {
                id: id.to_owned(),
                session_id: self.inner.session_id.clone(),
                agent_id: agent_id.to_owned(),
                seq: *next_seq,
                ts: Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true),
                kind,
                payload,
                raw,
            })
            .await?;
        *next_seq += 1;
        Ok(())
    }
}

pub(crate) struct Recorder {
    required_skills: Vec<crate::workspace::PreparedSkill>,
    /// What was delivered to this agent, kept for the whole session so an open can be recognised
    /// on any turn. `required_skills` is taken by the first `session/prompt` — it is the *send*
    /// receipt — so it cannot also be the table an open is matched against.
    delivered_skills: Vec<DeliveredSkill>,
    reply: String,
    reply_phase_known: bool,
    event_log: EventLog,
    acp_session_id: String,
    agent_id: String,
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
    #[cfg(test)]
    fn new(archive: &EventArchive, session_id: String, agent_id: &str) -> Self {
        Self::with_log(
            EventLog::new(archive.clone(), session_id.clone()),
            session_id,
            agent_id,
        )
    }

    fn with_log(event_log: EventLog, acp_session_id: String, agent_id: &str) -> Self {
        Self {
            event_log,
            acp_session_id,
            agent_id: agent_id.to_owned(),
            reply: String::new(),
            reply_phase_known: false,
            required_skills: Vec::new(),
            delivered_skills: Vec::new(),
        }
    }

    /// Record what was delivered, so an open of one of these files can be recognised later.
    fn note_delivery(&mut self, skills: &[crate::workspace::PreparedSkill]) {
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
    async fn note_self_report(&mut self) -> Result<()> {
        if !self.delivered_skills.iter().any(|skill| skill.translated) {
            return Ok(());
        }
        let Some(text) = crate::skill_routing::self_report(&self.reply) else {
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

    /// Which delivered skill, if any, this tool event opened.
    ///
    /// Two shapes count, and nothing else does: a read whose path is one of the delivered files,
    /// and Claude Code's own `Skill` tool naming a delivered skill. A title that merely mentions
    /// a skill, a directory listing, or a read of the operator's *source* copy outside the managed
    /// workspace are all rejected — the contract's rule is that presence is not use.
    fn opened_skill(&self, update: &Value) -> Option<usize> {
        let paths = tool_paths(update);
        if let Some(index) = self.delivered_skills.iter().position(|skill| {
            paths
                .iter()
                .any(|path| path == &skill.path || managed_skill_path_matches(path, &skill.name))
        }) {
            return Some(index);
        }
        let named = invoked_skill_name(update)?;
        self.delivered_skills
            .iter()
            .position(|skill| skill.name.eq_ignore_ascii_case(&named))
    }

    async fn record_frame(&mut self, message: &Value) -> Result<()> {
        if let Some(payload) = permission_payload(message) {
            return self
                .append(EventKind::Permission, payload, Some(message.clone()))
                .await;
        }

        if message.get("method").and_then(Value::as_str) != Some("session/update") {
            return Ok(());
        }
        if let Some(session_id) = message.pointer("/params/sessionId").and_then(Value::as_str)
            && session_id != self.acp_session_id
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
                            unprojected_update(Some(update), "ACP content chunk omitted content"),
                            Some(message.clone()),
                        )
                        .await;
                };
                if role == "agent"
                    && let Some(text) = content.get("text").and_then(Value::as_str)
                {
                    let phase = update.pointer("/_meta/codex/phase").and_then(Value::as_str);
                    if matches!(phase, Some("commentary" | "final_answer")) {
                        // A harness's explicit phase is authoritative. Keep every chunk in the
                        // archive, while excluding progress and preamble from the delivered reply.
                        if !self.reply_phase_known {
                            self.reply.clear();
                            self.reply_phase_known = true;
                        }
                        payload.insert("phase".into(), json!(phase));
                        if phase == Some("final_answer") {
                            self.reply.push_str(text);
                        }
                    } else if !self.reply_phase_known {
                        self.reply.push_str(text);
                    }
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
            Some("usage_update") => (EventKind::Usage, update.clone()),
            Some(_) | None => (EventKind::SessionMeta, update.clone()),
        };
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

    async fn append(&mut self, kind: EventKind, payload: Value, raw: Option<Value>) -> Result<()> {
        self.event_log
            .append(&self.agent_id, kind, payload, raw)
            .await
    }
}

/// The payload to archive when a frame is about a permission decision, or `None`.
///
/// Two shapes, one meaning: the agent's `session/request_permission` (what was asked), and
/// `LoomWatch`'s own reply to it — no `method`, carrying the `RequestPermissionOutcome` chosen
/// (what was decided). Both are archived so the record shows the decision, not only the question.
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

/// Every file path a tool event names, normalized to forward slashes.
///
/// ACP's own `locations` first, then the input keys the harnesses in `docs/ARCHITECTURE.md`'s
/// table actually send (`path`, `file_path`, `filePath`, `abs_path`, `absolute_path`, `target`).
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
        for key in [
            "path",
            "file_path",
            "filePath",
            "abs_path",
            "absolute_path",
            "target",
        ] {
            if let Some(path) = input.get(key).and_then(Value::as_str) {
                paths.push(path.replace('\\', "/"));
            }
        }
    }
    paths
}

/// Whether a path is `<something>/<managed root>/<name>/SKILL.md` for one of the two roots
/// `workspace::materialise` builds.
///
/// Needed beside the exact-path test because a harness may report a path that is relative to the
/// working directory it was given, or canonicalised through a symlinked temporary directory, and
/// a string comparison against the absolute delivered path would then miss a real open. Only the
/// managed roots count: the operator's installed copy under `$HOME` is not what this run
/// delivered, and reading it proves nothing about the bytes the receipt fingerprints.
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

/// The skill a Claude Code `Skill` tool call invoked, if this event is one.
///
/// Claude Code surfaces skill invocation as a tool call rather than as a file read, so a
/// path-only detector would report "never opened" for the one harness that has first-class skill
/// support. The name is taken from the structured input where the harness sends one, and from the
/// `Skill(name)` title only as a fallback — a title is presentation, so it is the last resort
/// rather than the first.
fn invoked_skill_name(update: &Value) -> Option<String> {
    let is_skill_tool = ["name", "title"].iter().any(|key| {
        update
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| value == "Skill" || value.starts_with("Skill("))
    });
    if !is_skill_tool {
        return None;
    }
    if let Some(input) = update.get("rawInput").and_then(Value::as_object) {
        for key in ["skill", "name", "command", "skill_name", "skillName"] {
            if let Some(value) = input.get(key).and_then(Value::as_str) {
                return Some(value.trim().to_owned());
            }
        }
    }
    update
        .get("title")
        .and_then(Value::as_str)
        .and_then(|title| title.strip_prefix("Skill("))
        .and_then(|rest| rest.strip_suffix(')'))
        .map(|name| name.trim().to_owned())
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
            .context("ACP tool event omitted toolCallId")?,
    );
    if initial {
        payload.insert(
            "title".into(),
            update
                .get("title")
                .cloned()
                .context("ACP tool_call omitted title")?,
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

async fn append_archive_event(
    archive: &EventArchive,
    session_id: &str,
    agent_id: &str,
    seq: u64,
    kind: EventKind,
    payload: Value,
    raw: Option<Value>,
) -> Result<()> {
    archive
        .append(&RunEvent {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_owned(),
            agent_id: agent_id.to_owned(),
            seq,
            ts: Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true),
            kind,
            payload,
            raw,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::PgPool;

    #[test]
    fn reads_model_names_and_reasoning_efforts_from_acp_session_state() {
        let session = json!({
            "configOptions": [
                {
                    "id": "model",
                    "currentValue": "vendor/fast",
                    "type": "select",
                    "options": [
                        {"name": "Fast model", "value": "vendor/fast"},
                        {"group": "Reasoning", "options": [
                            {"name": "Deep model", "value": "vendor/deep"},
                            {"name": "Duplicate", "value": "vendor/fast"}
                        ]}
                    ]
                },
                {
                    "id": "reasoning_effort",
                    "currentValue": "high",
                    "options": [
                        {"name": "Low", "value": "low"},
                        {"name": "High", "value": "high", "description": "More reasoning"}
                    ]
                }
            ],
            "models": {
                "availableModels": [
                    {"modelId": "vendor/fast[low]", "name": "Fast model (low)"},
                    {"modelId": "vendor/fast[high]", "name": "Fast model (high)"},
                    {"modelId": "vendor/deep[high]", "name": "Deep model (high)"}
                ],
                "currentModelId": "vendor/fast[high]"
            }
        });

        let catalog = model_catalog_from_session(&session);
        assert_eq!(catalog.current_model_id.as_deref(), Some("vendor/fast"));
        assert_eq!(catalog.current_thinking_effort.as_deref(), Some("high"));
        assert_eq!(
            catalog
                .models
                .iter()
                .map(|model| (&*model.id, &*model.name))
                .collect::<Vec<_>>(),
            [("vendor/fast", "Fast model"), ("vendor/deep", "Deep model")]
        );
        assert_eq!(
            catalog.models[0]
                .thinking_efforts
                .iter()
                .map(|effort| effort.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "high"]
        );
        assert_eq!(
            catalog.models[1]
                .thinking_efforts
                .iter()
                .map(|effort| effort.id.as_str())
                .collect::<Vec<_>>(),
            ["high"]
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn final_reply_excludes_explicit_progress_but_archives_every_chunk(pool: PgPool) {
        let archive = EventArchive::from_pool(pool);
        let mut recorder = Recorder::new(&archive, "phase-test".to_owned(), "agent");
        for (text, phase) in [
            ("Harness warning", None),
            ("Working", Some("commentary")),
            ("Final ", Some("final_answer")),
            ("report", Some("final_answer")),
            ("Progress", Some("commentary")),
            ("Trailing notice", None),
        ] {
            recorder.record_frame(&json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "phase-test", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}, "_meta": {"codex": {"phase": phase}}}}})).await.unwrap();
        }
        assert_eq!(recorder.reply, "Final report");
        assert_eq!(archive.verify_session("phase-test").await.unwrap().len(), 6);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn maps_real_acp_updates_without_losing_the_raw_payload(pool: PgPool) {
        let archive = EventArchive::from_pool(pool);
        let mut recorder = Recorder::new(&archive, "session".to_owned(), "agent");
        recorder
            .record_frame(&json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "session",
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "call-1",
                        "title": "read README",
                        "kind": "read",
                        "status": "pending",
                        "rawInput": {"filePath": "README.md"}
                    }
                }
            }))
            .await
            .expect("record call");
        recorder
            .record_frame(&json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "session",
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "call-1",
                        "status": "completed",
                        "rawOutput": {"bytes": 12}
                    }
                }
            }))
            .await
            .expect("record result");
        let events = archive.load_session("session").await.expect("events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, EventKind::ToolCall);
        assert_eq!(
            events[0].raw.as_ref().unwrap()["params"]["update"]["kind"],
            "read"
        );
        assert_eq!(events[1].kind, EventKind::ToolUpdate);
        assert_eq!(
            events[1].raw.as_ref().unwrap()["params"]["update"]["rawOutput"]["bytes"],
            12
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn archives_unprojectable_updates_instead_of_failing_the_session(pool: PgPool) {
        let archive = EventArchive::from_pool(pool);
        let mut recorder = Recorder::new(&archive, "session".to_owned(), "agent");
        let frames = [
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "session",
                    "update": {"sessionUpdate": "agent_message_chunk"}
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "session",
                    "update": {"sessionUpdate": "tool_call", "title": "missing id"}
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"sessionId": "session"}
            }),
        ];

        for frame in &frames {
            recorder
                .record_frame(frame)
                .await
                .expect("unexpected frame must remain archivable");
        }

        let events = archive.load_session("session").await.expect("events");
        assert_eq!(events.len(), frames.len());
        assert!(
            events
                .iter()
                .all(|event| event.kind == EventKind::SessionMeta)
        );
        for (event, frame) in events.iter().zip(frames) {
            assert_eq!(event.payload["phase"], "unprojected_session_update");
            assert_eq!(event.raw.as_ref(), Some(&frame));
        }
    }

    #[test]
    fn permission_response_uses_each_supported_rejection_fallback() {
        let response = build_client_response(&json!({
            "jsonrpc": "2.0",
            "id": "permission-1",
            "method": "session/request_permission",
            "params": {"options": [
                {"optionId": "always", "kind": "reject_always"},
                {"optionId": "once", "kind": "reject_once"}
            ]}
        }))
        .expect("response");
        assert_eq!(response["result"]["outcome"]["optionId"], "once");

        let response = build_client_response(&json!({
            "jsonrpc": "2.0",
            "id": "permission-2",
            "method": "session/request_permission",
            "params": {"options": [
                {"optionId": "always", "kind": "reject_always"}
            ]}
        }))
        .expect("response");
        assert_eq!(response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(response["result"]["outcome"]["optionId"], "always");
    }

    #[test]
    fn archive_failure_context_retains_the_execution_error() {
        let execution = anyhow::anyhow!("protocol exploded");
        let archive = anyhow::anyhow!("Postgres unavailable");
        let combined = with_archive_failure_context(execution, Some(&archive));
        let rendered = format!("{combined:#}");
        assert!(rendered.contains("protocol exploded"));
        assert!(rendered.contains("Postgres unavailable"));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn completes_a_turn_and_recovers_the_full_session_after_exit(pool: PgPool) {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"session-1","configOptions":[{"id":"model"}]}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","messageId":"message-1","content":{"type":"text","text":"done"}}}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_thought_chunk","messageId":"thought-1","content":{"type":"text","text":"thinking"}}}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"inspect","kind":"read","status":"pending"}}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"in_progress"}}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","rawOutput":{"ok":true}}}}'
            printf '%s\n' '{"jsonrpc":"2.0","id":"permission-1","method":"session/request_permission","params":{"sessionId":"session-1","toolCall":{"toolCallId":"call-1"},"options":[{"optionId":"deny-once","name":"Deny","kind":"reject_once"}]}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"plan","entries":[]}}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"current_mode_update","currentModeId":"build"}}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"usage_update","used":10,"size":100}}}'
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}'
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool.clone());
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        let outcome = process
            .run_session(
                "agent",
                "test/model",
                "hello",
                &archive,
                Duration::from_secs(2),
            )
            .await
            .expect("session");
        drop(archive);
        let reopened = EventArchive::from_pool(pool);
        let events = reopened
            .verify_session(&outcome.session_id)
            .await
            .expect("recover session");
        assert_eq!(outcome.exit_code, 0);
        assert_eq!(outcome.event_count, 17);
        assert_eq!(events.len(), 17);
        assert_eq!(events.first().unwrap().kind, EventKind::Process);
        assert_eq!(events.last().unwrap().payload["phase"], "exited");
        assert!(
            events.last().unwrap().payload["signal"].is_null(),
            "a clean exit carries no signal"
        );
        let kinds: Vec<EventKind> = events.iter().map(|event| event.kind).collect();
        assert_eq!(
            kinds,
            vec![
                EventKind::Process,     // spawned
                EventKind::SessionMeta, // initialize
                EventKind::SessionMeta, // session/new
                EventKind::SessionMeta, // session/set_config_option
                EventKind::Message,     // queued user prompt
                EventKind::Message,     // agent_message_chunk
                EventKind::Thought,     // agent_thought_chunk
                EventKind::ToolCall,
                EventKind::ToolUpdate, // in_progress
                EventKind::ToolUpdate, // completed
                EventKind::Permission, // request
                EventKind::Permission, // our response
                EventKind::Plan,
                EventKind::SessionMeta, // current_mode_update
                EventKind::Usage,
                EventKind::TurnEnd,
                EventKind::Process, // exited
            ]
        );
        assert_eq!(
            events[10].payload["options"][0]["kind"], "reject_once",
            "harness offered a reject_once option"
        );
        assert_eq!(
            events[11].payload["outcome"]["outcome"], "selected",
            "an advertised reject_once option must be selected instead of cancelling the turn"
        );
        assert_eq!(events[11].payload["outcome"]["optionId"], "deny-once");
        assert_eq!(events[1].payload["phase"], "initialize");
        assert_eq!(events[2].payload["phase"], "session_new");
        assert_eq!(events[3].payload["phase"], "set_config_option");

        assert_events_match_schema(&events);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn configures_models_advertised_through_current_acp_model_state(pool: PgPool) {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"model-state","models":{"availableModels":[{"modelId":"vendor/deep","name":"Deep"}],"currentModelId":"vendor/fast"}}}'
            IFS= read -r request
            case "$request" in
              *'"method":"session/set_model"'*'"modelId":"vendor/deep"'*) ;;
              *) exit 9 ;;
            esac
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":5,"result":{}}'
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        process
            .run_session(
                "agent",
                "vendor/deep",
                "hello",
                &archive,
                Duration::from_secs(2),
            )
            .await
            .expect("session");

        let events = archive.load_session("model-state").await.expect("events");
        let configured = events
            .iter()
            .find(|event| event.payload["phase"] == "set_model")
            .expect("set_model metadata");
        assert_eq!(configured.payload["value"], "vendor/deep");
        assert_eq!(configured.raw.as_ref().unwrap()["id"], 3);
    }

    fn wired_tool(definition: serde_json::Value) -> crate::delivery::DeliveredTool {
        crate::delivery::prepare(
            "Agent Memory",
            &crate::capabilities::ToolDefinition {
                provider: "Claude Code".into(),
                config_path: "/home/operator/.claude.json".into(),
                server: "agentmemory".into(),
                format: crate::capabilities::ToolFormat::Claude,
                value: definition,
            },
            &|_| None,
        )
        .expect("deliverable")
    }

    /// ADR 0029's tool contract, enforced by the harness rather than by reading our own request
    /// back: the fake exits 9 unless `session/new` hands it the wired server beside nothing else.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_wired_tool_is_handed_to_the_harness_in_session_new(pool: PgPool) {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r request
            case "$request" in
              *'"method":"session/new"'*'"mcpServers":[{"args":["-y","@agentmemory/mcp"],"command":"npx","env":[],"name":"agentmemory"}]'*) ;;
              *) exit 9 ;;
            esac
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"wired-tool"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: vec![wired_tool(
                serde_json::json!({"command": "npx", "args": ["-y", "@agentmemory/mcp"]}),
            )],
        };
        let archive = EventArchive::from_pool(pool);
        AcpProcess::spawn(&spec)
            .expect("spawn")
            .run_session("agent", "", "hello", &archive, Duration::from_secs(2))
            .await
            .expect("the harness received the wired server");
    }

    /// A transport the harness did not advertise fails before `session/new`, naming the tool.
    #[test]
    fn a_remote_tool_needs_the_harness_to_advertise_its_transport() {
        let remote =
            wired_tool(serde_json::json!({"type": "http", "url": "https://example.test/mcp"}));
        let tools = [remote];
        let error =
            wired_tool_servers("writer", &tools, &serde_json::json!({"protocolVersion": 1}))
                .expect_err("refused");
        let message = format!("{error:#}");
        assert!(
            message.contains("Agent Memory") && message.contains("HTTP"),
            "{message}"
        );
        let advertised =
            serde_json::json!({"agentCapabilities": {"mcpCapabilities": {"http": true}}});
        let servers = wired_tool_servers("writer", &tools, &advertised).expect("accepted");
        assert_eq!(servers[0]["type"], "http");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn required_skills_are_in_the_prompt_and_receipted_after_send(pool: PgPool) {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"required-skill","configOptions":[]}}'
            IFS= read -r request
            case "$request" in
              *'"method":"session/prompt"'*'FULL_SKILL_INSTRUCTIONS'*'Make a report'*) ;;
              *) exit 9 ;;
            esac
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let skill = crate::workspace::PreparedSkill::fixture(
            "claude-design",
            "/work/.agents/skills/claude-design/SKILL.md",
            "---\nname: claude-design\ndescription: d\n---\nFULL_SKILL_INSTRUCTIONS",
            crate::skill_routing::SkillRoute::Inline,
        );
        let composed = crate::memory::ComposedPrompt {
            text: "## Role\nDesigner\n\n## Task\nMake a report".into(),
            required_skills: vec![],
            delivery: crate::delivery::Delivery::default(),
            sections: vec![
                crate::memory::PromptSection {
                    kind: crate::memory::PromptSectionKind::Role,
                    heading: "## Role".into(),
                    text: "Designer".into(),
                },
                crate::memory::PromptSection {
                    kind: crate::memory::PromptSectionKind::Task,
                    heading: "## Task".into(),
                    text: "Make a report".into(),
                },
            ],
        }
        .with_required_skills(&[skill]);
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        process
            .run_session_with_context(
                "agent",
                "test/model",
                &composed.text,
                TeamSessionContext {
                    archive: &archive,
                    exit_timeout: Duration::from_secs(2),
                    bus: None,
                    event_log: None,
                    packet: None,
                    composed: Some(&composed),
                    boundary: None,
                },
            )
            .await
            .expect("harness received full skill instructions");
        let events = archive
            .load_session("required-skill")
            .await
            .expect("events");
        let prompt = events
            .iter()
            .find(|event| event.payload["role"] == "user")
            .expect("prompt");
        let receipt = events
            .iter()
            .find(|event| event.payload["phase"] == "required_skills_supplied")
            .expect("receipt");
        assert!(receipt.seq > prompt.seq);
        assert_eq!(receipt.payload["skills"][0]["name"], "claude-design");
        assert_eq!(
            receipt.payload["promptId"],
            prompt.raw.as_ref().unwrap()["id"]
        );
        assert_eq!(receipt.raw.as_ref().unwrap()["source"], "loomwatch");
        assert_events_match_schema(&events);
    }

    /// What counts as opening a delivered skill, and what must not.
    ///
    /// A free-function test because the rule is the whole of the evidence claim: a detector that
    /// accepted the operator's installed copy, or a directory listing, would report "opened" for a
    /// run in which the agent never touched the bytes this run's receipt fingerprints.
    #[test]
    fn only_a_managed_copy_of_this_skill_counts_as_opening_it() {
        for path in [
            "/w/.agents/skills/claude-design/SKILL.md",
            "/w/.claude/skills/claude-design/SKILL.md",
            "relative/.claude/skills/claude-design/SKILL.md",
        ] {
            assert!(
                managed_skill_path_matches(path, "claude-design"),
                "{path} is a managed delivery"
            );
        }
        for path in [
            // The operator's own installation: real bytes, but not this run's.
            "/Users/someone/.claude/skills/claude-design/SKILL.md",
            // A different skill, the directory itself, and a reference inside the bundle.
            "/w/.agents/skills/other-skill/SKILL.md",
            "/w/.agents/skills/claude-design",
            "/w/.agents/skills/claude-design/references/style.md",
            "/w/skills/claude-design/SKILL.md",
        ] {
            let managed = managed_skill_path_matches(path, "claude-design");
            let is_operator_copy = path.starts_with("/Users/someone");
            assert_eq!(
                managed, is_operator_copy,
                "{path}: only the operator's home copy shares the managed shape"
            );
        }
    }

    /// Claude Code invokes a skill as a tool rather than reading a file, so a path-only detector
    /// would report "never opened" for the one harness with first-class skill support.
    #[test]
    fn claude_codes_skill_tool_names_the_skill_it_invoked() {
        assert_eq!(
            invoked_skill_name(&json!({"name": "Skill", "rawInput": {"command": "claude-design"}}))
                .as_deref(),
            Some("claude-design"),
        );
        assert_eq!(
            invoked_skill_name(&json!({"title": "Skill(claude-design)"})).as_deref(),
            Some("claude-design"),
        );
        assert_eq!(
            invoked_skill_name(&json!({"title": "Read", "rawInput": {"command": "claude-design"}})),
            None,
            "an ordinary tool that happens to mention a skill is not an invocation",
        );
    }

    /// A harness that reads the file `LoomWatch` delivered, then says what it skipped.
    ///
    /// The tool call carries ACP `locations`, which is the shape every harness in
    /// `docs/ARCHITECTURE.md`'s table reports a read with.
    const OPENS_THE_SKILL: &str = r#"
        set -eu
        IFS= read -r _
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
        IFS= read -r _
        printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"opened","configOptions":[]}}'
        IFS= read -r _
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"opened","update":{"sessionUpdate":"tool_call","toolCallId":"call-7","title":"Read SKILL.md","kind":"read","status":"pending","locations":[{"path":"/work/.agents/skills/claude-design/SKILL.md"}]}}}'
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"opened","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-7","status":"completed","locations":[{"path":"/work/.agents/skills/claude-design/SKILL.md"}]}}}'
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"opened","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Here is the deck.\n\n## What I could not follow\n- scripts/render.py: the permission request was refused, so I wrote the HTML by hand.\n"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
        IFS= read -r _
        printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
    "#;

    /// Deliver one inlined skill to a scripted harness and return everything it archived.
    async fn run_with_delivered_skill(
        pool: PgPool,
        script: &str,
        session: &str,
    ) -> Vec<crate::RunEvent> {
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.to_owned()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let skill = crate::workspace::PreparedSkill::fixture(
            "claude-design",
            "/work/.agents/skills/claude-design/SKILL.md",
            "---\nname: claude-design\ndescription: Design a deck\n---\nUse the Task tool. Run `python3 scripts/render.py`.",
            crate::skill_routing::SkillRoute::Inline,
        );
        let composed = crate::memory::ComposedPrompt {
            text: "## Task\nMake a report".into(),
            required_skills: vec![],
            delivery: crate::delivery::Delivery::default(),
            sections: vec![crate::memory::PromptSection {
                kind: crate::memory::PromptSectionKind::Task,
                heading: "## Task".into(),
                text: "Make a report".into(),
            }],
        }
        .with_required_skills(&[skill]);
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        process
            .run_session_with_context(
                "agent",
                "test/model",
                &composed.text,
                TeamSessionContext {
                    archive: &archive,
                    exit_timeout: Duration::from_secs(2),
                    bus: None,
                    event_log: None,
                    packet: None,
                    composed: Some(&composed),
                    boundary: None,
                },
            )
            .await
            .expect("session");
        archive.load_session(session).await.expect("events")
    }

    /// `docs/RUN_PROVENANCE_CONTRACT.md` §12: "prompt/filesystem presence is not use". Delivery
    /// was already receipted; this is the open event that makes the other half sayable.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_read_of_the_delivered_skill_is_archived_as_an_open(pool: PgPool) {
        let events = run_with_delivered_skill(pool, OPENS_THE_SKILL, "opened").await;
        let opens = events
            .iter()
            .filter(|event| event.payload["phase"] == "skill_opened")
            .collect::<Vec<_>>();
        assert_eq!(
            opens.len(),
            1,
            "a call and its update are one open, not two: {:?}",
            opens.iter().map(|event| &event.payload).collect::<Vec<_>>()
        );
        let open = opens[0];
        assert_eq!(open.kind, EventKind::SessionMeta);
        assert_eq!(open.payload["skill"], "claude-design");
        assert_eq!(
            open.payload["path"],
            "/work/.agents/skills/claude-design/SKILL.md"
        );
        assert_eq!(open.payload["toolCallId"], "call-7");
        assert_eq!(open.raw.as_ref().expect("raw")["source"], "loomwatch");
        // The open follows the tool call it was concluded from, so the archive reads in order.
        let call = events
            .iter()
            .find(|event| event.kind == EventKind::ToolCall)
            .expect("the tool call");
        assert!(open.seq > call.seq);
        // The fingerprint on the open is the delivered one, so it can be matched to the receipt.
        let receipt = events
            .iter()
            .find(|event| event.payload["phase"] == "required_skills_supplied")
            .expect("receipt");
        assert_eq!(
            open.payload["sha256"],
            receipt.payload["skills"][0]["sha256"]
        );
        assert_events_match_schema(&events);
    }

    /// The agent's own account is archived apart from the evidence, under its own phase, because
    /// CONTRACT §8.2 forbids prose from labelling anything as used.
    #[sqlx::test(migrations = "../../migrations")]
    async fn the_agents_account_of_what_it_skipped_is_archived_as_a_self_report(pool: PgPool) {
        let events = run_with_delivered_skill(pool, OPENS_THE_SKILL, "opened").await;
        let report = events
            .iter()
            .find(|event| event.payload["phase"] == "skill_self_report")
            .expect("a self-report");
        let text = report.payload["text"].as_str().expect("text");
        assert!(text.starts_with("## What I could not follow"), "{text}");
        assert!(text.contains("scripts/render.py"), "{text}");
        assert!(
            !text.contains("Here is the deck"),
            "the extract starts at the list, not at the answer: {text}"
        );
        assert_eq!(report.raw.as_ref().expect("raw")["source"], "loomwatch");
        assert_ne!(
            report.kind,
            EventKind::ToolCall,
            "a self-report is not a tool call and must never enter the evidence graph as one"
        );
    }

    /// The counterfactual for both lanes: the same run without the read and without the phrase
    /// archives neither record. A detector that fired on delivery alone would pass the two tests
    /// above and still prove nothing.
    #[sqlx::test(migrations = "../../migrations")]
    async fn a_delivered_skill_the_agent_never_opened_archives_no_open_and_no_self_report(
        pool: PgPool,
    ) {
        let silent = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"opened","configOptions":[]}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"opened","update":{"sessionUpdate":"tool_call","toolCallId":"call-9","title":"Read a file","kind":"read","status":"completed","locations":[{"path":"/work/notes.md"}]}}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"opened","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done."}}}}'
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
        "#;
        let events = run_with_delivered_skill(pool, silent, "opened").await;
        assert!(
            events
                .iter()
                .any(|event| event.payload["phase"] == "required_skills_supplied"),
            "the skill was still delivered and receipted",
        );
        for phase in ["skill_opened", "skill_self_report"] {
            assert!(
                !events.iter().any(|event| event.payload["phase"] == phase),
                "{phase} must need its own evidence",
            );
        }
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn skips_model_configuration_when_the_harness_does_not_advertise_it(pool: PgPool) {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"no-model-option","configOptions":[]}}'
            IFS= read -r request
            case "$request" in
              *'"method":"session/prompt"'*) ;;
              *) exit 9 ;;
            esac
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{}}'
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        process
            .run_session(
                "agent",
                "test/model",
                "hello",
                &archive,
                Duration::from_secs(2),
            )
            .await
            .expect("session without model option");

        let events = archive
            .load_session("no-model-option")
            .await
            .expect("events");
        let skipped = events
            .iter()
            .find(|event| event.payload["phase"] == "set_config_option_skipped")
            .expect("skip metadata");
        assert_eq!(skipped.payload["configId"], "model");
        let prompt = events
            .iter()
            .find(|event| event.payload["role"] == "user")
            .expect("user prompt");
        assert_eq!(prompt.raw.as_ref().unwrap()["id"], 3);
        assert_eq!(prompt.raw.as_ref().unwrap()["method"], "session/prompt");
    }

    /// Validate every generated event against the frozen `RunEvent` contract in
    /// `schemas/team.schema.yaml`.
    fn assert_events_match_schema(events: &[RunEvent]) {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let schema_source = std::fs::read_to_string(workspace.join("schemas/team.schema.yaml"))
            .expect("read schema");
        let schema: Value = serde_yaml::from_str(&schema_source).expect("parse schema");
        let event_schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": schema["$defs"].clone(),
            "$ref": "#/$defs/RunEvent"
        });
        let validator = jsonschema::draft202012::new(&event_schema).expect("compile schema");
        for event in events {
            let value = serde_json::to_value(event).expect("serialize event");
            let errors: Vec<String> = validator
                .iter_errors(&value)
                .map(|error| error.to_string())
                .collect();
            assert!(
                errors.is_empty(),
                "generated event failed schema validation: {errors:?}\n{value}"
            );
        }
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn mid_turn_failure_is_marked_and_returns_the_recoverable_session_id(pool: PgPool) {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"partial-session","configOptions":[{"id":"model"}]}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{}}'
            IFS= read -r _
            printf '%s\n' 'not-json'
            exit 7
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");

        let error = process
            .run_session(
                "agent",
                "test/model",
                "hello",
                &archive,
                Duration::from_secs(2),
            )
            .await
            .expect_err("invalid JSON must fail the turn");
        let error = format!("{error:#}");
        assert!(
            error.contains("session_id=partial-session"),
            "failure must identify the recoverable session: {error}"
        );

        let events = archive
            .verify_session("partial-session")
            .await
            .expect("recover partial session");
        assert_eq!(events.len(), 6);
        assert_eq!(events.last().unwrap().kind, EventKind::Process);
        assert_eq!(events.last().unwrap().payload["phase"], "crashed");
        assert_eq!(events.last().unwrap().payload["exitCode"], 7);
        assert!(
            events.last().unwrap().payload["message"]
                .as_str()
                .unwrap()
                .contains("invalid JSON")
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn child_exit_is_reported_without_hanging(pool: PgPool) {
        let spec = ProcessSpec {
            cmd: "false".into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        let result = timeout(
            Duration::from_secs(2),
            process.run_session(
                "agent",
                "test/model",
                "hello",
                &archive,
                Duration::from_secs(1),
            ),
        )
        .await
        .expect("supervisor hung");
        assert!(result.is_err());

        let second = process
            .run_session(
                "agent",
                "test/model",
                "hello again",
                &archive,
                Duration::from_secs(1),
            )
            .await
            .expect_err("a process cannot run a second session");
        assert_eq!(
            second.to_string(),
            "this ACP process has already run a session"
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn mid_turn_failure_still_marks_and_recovers_the_partial_session(pool: PgPool) {
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"session-1","configOptions":[{"id":"model"}]}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"model rejected"}}'
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        let result = process
            .run_session(
                "agent",
                "test/model",
                "hello",
                &archive,
                Duration::from_secs(2),
            )
            .await;
        assert!(
            result.is_err(),
            "a rejected session/set_config_option must fail the session"
        );

        let events = archive
            .verify_session("session-1")
            .await
            .expect("the partial session must still be reachable via show");
        assert_eq!(
            events.last().unwrap().kind,
            EventKind::Process,
            "a mid-turn failure must still write a terminal process event"
        );
        assert_eq!(events.last().unwrap().payload["phase"], "crashed");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn signal_death_is_recorded_distinctly_from_a_negative_exit_code(pool: PgPool) {
        // Answer the handshake so a session id exists, then die by SIGKILL mid-turn. Without
        // the signal field this is indistinguishable from a genuine exit code of -1.
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"signal-session","configOptions":[]}}'
            IFS= read -r _
            kill -KILL $$
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec).expect("spawn");
        let error = process
            .run_session(
                "agent",
                "test/model",
                "hello",
                &archive,
                Duration::from_secs(2),
            )
            .await
            .expect_err("a signal-killed child must fail the turn");
        assert!(format!("{error:#}").contains("session_id=signal-session"));

        let events = archive
            .verify_session("signal-session")
            .await
            .expect("recover partial session");
        let last = events.last().unwrap();
        assert_eq!(last.kind, EventKind::Process);
        assert_eq!(last.payload["phase"], "crashed");
        assert_eq!(last.payload["exitCode"], -1);
        assert_eq!(last.payload["signal"], "SIGKILL");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn request_timeout_sends_session_cancel_before_teardown(pool: PgPool) {
        // Complete the handshake, then stall the prompt turn. On timeout LoomWatch should
        // deliver session/cancel; this child echoes whatever it receives to stderr, which
        // the crash marker then captures.
        let script = r#"
            set -eu
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            IFS= read -r _
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"cancel-session","configOptions":[]}}'
            IFS= read -r _
            IFS= read -r cancel
            printf 'cancel-frame: %s\n' "$cancel" >&2
        "#;
        let spec = ProcessSpec {
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: BTreeMap::new(),
            cwd: std::env::current_dir().expect("cwd"),
            tools: Vec::new(),
        };
        let archive = EventArchive::from_pool(pool);
        let mut process = AcpProcess::spawn(&spec)
            .expect("spawn")
            .with_request_timeout(Duration::from_millis(200));
        let error = process
            .run_session(
                "agent",
                "test/model",
                "hello",
                &archive,
                Duration::from_secs(3),
            )
            .await
            .expect_err("a stalled turn must fail");
        assert!(
            format!("{error:#}").contains("timed out after"),
            "unexpected error: {error:#}"
        );

        let events = archive
            .verify_session("cancel-session")
            .await
            .expect("recover stalled session");
        let last = events.last().unwrap();
        assert_eq!(last.payload["phase"], "crashed");
        let message = last.payload["message"].as_str().expect("crash message");
        assert!(
            message.contains(r#""method":"session/cancel""#),
            "crash marker must show the session/cancel LoomWatch sent: {message}"
        );
    }
}
