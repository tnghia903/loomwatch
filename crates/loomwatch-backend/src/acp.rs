use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
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

#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
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
        })
    }

    #[cfg(test)]
    fn with_request_timeout(mut self, request_timeout: Duration) -> Self {
        self.request_timeout = request_timeout;
        self
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
        let failure_session_id = self
            .event_log
            .as_ref()
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
                self.event_log.as_ref(),
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
            (Ok((session_id, _event_count)), Ok(exit)) => {
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

        let supports_http_mcp = initialized
            .result
            .pointer("/agentCapabilities/mcpCapabilities/http")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mcp_servers = if supports_http_mcp {
            context
                .bus
                .map(TeamBusConnection::server_definition)
                .into_iter()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
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
        Ok(recorder)
    }

    async fn configure_model(
        &mut self,
        model: &str,
        negotiated: &NegotiatedSession,
        recorder: &mut Recorder,
    ) -> Result<()> {
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
                    &json!({"sessionId": negotiated.session_id, "configId": "model", "value": model}),
                    Some(recorder),
                )
                .await
                .with_context(|| format!("ACP harness rejected configured model {model:?}"))?;
            recorder
                .append(
                    EventKind::SessionMeta,
                    json!({
                        "phase": "set_config_option",
                        "configId": "model",
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
    ) -> Result<(String, usize)> {
        let mut recorder = self
            .negotiate_session(agent_id, model, process_id, context)
            .await?;
        let session_id = recorder.acp_session_id.clone();
        let archive_session_id = recorder.event_log.session_id().to_owned();

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
        self.send(&prompt_request).await?;
        let prompted = self
            .read_response(prompt_id, "session/prompt", Some(&mut recorder))
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

        self.request(
            "session/close",
            &json!({"sessionId": session_id}),
            Some(&mut recorder),
        )
        .await
        .context("ACP session/close failed")?;

        let events = context.archive.verify_session(&archive_session_id).await?;
        Ok((archive_session_id, events.len()))
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
    execution: &Result<(String, usize)>,
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

    pub(crate) async fn next_seq(&self) -> u64 {
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
}

struct Recorder {
    event_log: EventLog,
    acp_session_id: String,
    agent_id: String,
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
        }
    }

    async fn record_frame(&mut self, message: &Value) -> Result<()> {
        if message.get("method").and_then(Value::as_str) == Some("session/request_permission") {
            let payload = message.get("params").cloned().unwrap_or_else(|| json!({}));
            return self
                .append(EventKind::Permission, payload, Some(message.clone()))
                .await;
        }

        // LoomWatch's own reply to a session/request_permission: no "method", carries the
        // RequestPermissionOutcome we chose. Archive it so the archive shows what was decided,
        // not just what was asked.
        if message.get("method").is_none()
            && message.get("id").is_some()
            && message.pointer("/result/outcome").is_some()
        {
            let payload = message.get("result").cloned().unwrap_or_else(|| json!({}));
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
        self.append(kind, payload, Some(message.clone())).await
    }

    async fn append(&mut self, kind: EventKind, payload: Value, raw: Option<Value>) -> Result<()> {
        self.event_log
            .append(&self.agent_id, kind, payload, raw)
            .await
    }
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
