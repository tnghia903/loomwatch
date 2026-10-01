//! Authenticated bridge from the container daemon to ACP harnesses running on the host.
//!
//! Docker Desktop containers cannot execute macOS binaries.  The host runner keeps provider
//! credentials and native executables on the host, while a tiny `harness-client` process in the
//! container preserves the stdio contract expected by [`crate::acp::AcpProcess`].

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

use crate::api::{DetectedHarness, HarnessReport, HarnessSpawn};

pub const RUNNER_ADDR_ENV: &str = "LOOMWATCH_HOST_RUNNER_ADDR";
pub const RUNNER_TOKEN_ENV: &str = "LOOMWATCH_HOST_RUNNER_TOKEN";
const PROXY_COMMAND: &str = "loomwatchd";

#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub addr: String,
    pub token: String,
}

#[derive(Debug, Clone)]
pub struct PathMapping {
    pub container: PathBuf,
    pub host: PathBuf,
}

impl PathMapping {
    /// Parse one `CONTAINER=HOST` mapping supplied by the operator.
    ///
    /// # Errors
    ///
    /// Returns an error when either side is not absolute or the host root cannot be resolved.
    pub fn parse(value: &str) -> Result<Self> {
        let (container, host) = value
            .split_once('=')
            .with_context(|| format!("invalid path mapping {value:?}; expected CONTAINER=HOST"))?;
        let container = PathBuf::from(container);
        let host = PathBuf::from(host);
        if !container.is_absolute() || !host.is_absolute() {
            bail!("path mapping must use absolute paths: {value:?}");
        }
        let host = host
            .canonicalize()
            .with_context(|| format!("failed to resolve host path {}", host.display()))?;
        Ok(Self { container, host })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum RunnerRequest {
    List {
        token: String,
    },
    Spawn {
        token: String,
        harness: String,
        cwd: PathBuf,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Stdin {
        data: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RunnerResponse {
    Report { report: HarnessReport },
    Ready,
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: i32 },
    Error { message: String },
}

#[must_use]
pub fn configured_client() -> Option<ClientConfig> {
    let addr = std::env::var(RUNNER_ADDR_ENV).ok()?;
    let token = std::env::var(RUNNER_TOKEN_ENV).ok()?;
    if addr.trim().is_empty() || token.is_empty() {
        return None;
    }
    Some(ClientConfig { addr, token })
}

async fn write_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    frame: &RunnerResponse,
) -> Result<()> {
    let mut encoded = serde_json::to_vec(frame)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    writer.flush().await?;
    Ok(())
}

async fn write_request<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    request: &RunnerRequest,
) -> Result<()> {
    let mut encoded = serde_json::to_vec(request)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    writer.flush().await?;
    Ok(())
}

/// Ask the host runner what its native `PATH` contains and rewrite runnable entries through the
/// container-side stdio proxy.
///
/// # Errors
///
/// Returns an error when the runner is unreachable, rejects authentication, or returns an invalid
/// protocol frame.
pub async fn list_harnesses(config: &ClientConfig) -> Result<HarnessReport> {
    let stream = TcpStream::connect(&config.addr)
        .await
        .with_context(|| format!("could not connect to host runner at {}", config.addr))?;
    let (reader, mut writer) = stream.into_split();
    write_request(
        &mut writer,
        &RunnerRequest::List {
            token: config.token.clone(),
        },
    )
    .await?;
    let mut lines = BufReader::new(reader).lines();
    let line = lines
        .next_line()
        .await?
        .context("host runner closed before returning its harness inventory")?;
    match serde_json::from_str::<RunnerResponse>(&line)? {
        RunnerResponse::Report { report } => Ok(proxied_report(report)),
        RunnerResponse::Error { message } => bail!("host runner refused discovery: {message}"),
        other => bail!("unexpected host runner discovery response: {other:?}"),
    }
}

fn proxied_report(mut report: HarnessReport) -> HarnessReport {
    for harness in &mut report.harnesses {
        harness.executable_path = format!("host:{}", harness.executable_path);
        if harness.acp_available {
            harness.spawn = HarnessSpawn {
                cmd: PROXY_COMMAND.to_owned(),
                args: vec![
                    "harness-client".to_owned(),
                    "--harness".to_owned(),
                    harness.id.clone(),
                ],
            };
        }
    }
    report.searched_path = report
        .searched_path
        .into_iter()
        .map(|path| format!("host:{path}"))
        .collect();
    report
}

/// Run the host half of the bridge. Every spawn is selected from the fixed harness catalog; the
/// client cannot supply an arbitrary host command.
///
/// # Errors
///
/// Returns an error for an unsafe configuration or when the listener cannot be started.
pub async fn serve(listen: SocketAddr, token: String, mappings: Vec<PathMapping>) -> Result<()> {
    if token.len() < 16 {
        bail!("host runner token must contain at least 16 characters");
    }
    if mappings.is_empty() {
        bail!("host runner requires at least one --map CONTAINER=HOST mapping");
    }
    let listener = TcpListener::bind(listen).await?;
    println!("LoomWatch host runner listening on {listen}");
    loop {
        let (stream, peer) = listener.accept().await?;
        let token = token.clone();
        let mappings = mappings.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_connection(stream, &token, &mappings).await {
                eprintln!("host runner connection from {peer} failed: {error:#}");
            }
        });
    }
}

async fn serve_connection(stream: TcpStream, token: &str, mappings: &[PathMapping]) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut opening = String::new();
    if reader.read_line(&mut opening).await? == 0 {
        bail!("client closed before authentication");
    }
    let request: RunnerRequest = serde_json::from_str(opening.trim_end())?;
    let authenticated = match &request {
        RunnerRequest::List { token: supplied }
        | RunnerRequest::Spawn {
            token: supplied, ..
        } => supplied == token,
        RunnerRequest::Stdin { .. } => false,
    };
    if !authenticated {
        write_frame(
            reader.get_mut(),
            &RunnerResponse::Error {
                message: "authentication failed".to_owned(),
            },
        )
        .await?;
        return Ok(());
    }

    match request {
        RunnerRequest::List { .. } => {
            write_frame(
                reader.get_mut(),
                &RunnerResponse::Report {
                    report: crate::api::system_harness_report(),
                },
            )
            .await
        }
        RunnerRequest::Spawn {
            harness, cwd, env, ..
        } => {
            let stream = reader.into_inner();
            serve_spawn(stream, &harness, &cwd, env, mappings).await
        }
        RunnerRequest::Stdin { .. } => unreachable!("unauthenticated stream frame"),
    }
}

fn mapped_cwd(cwd: &Path, mappings: &[PathMapping]) -> Result<PathBuf> {
    let mut candidates = mappings
        .iter()
        .filter_map(|mapping| {
            cwd.strip_prefix(&mapping.container)
                .ok()
                .map(|suffix| (mapping, suffix))
        })
        .collect::<Vec<_>>();
    candidates
        .sort_by_key(|(mapping, _)| std::cmp::Reverse(mapping.container.components().count()));
    let (mapping, suffix) = candidates.into_iter().next().with_context(|| {
        format!(
            "container cwd {} is outside the allowed mapped roots",
            cwd.display()
        )
    })?;
    let resolved = mapping
        .host
        .join(suffix)
        .canonicalize()
        .with_context(|| format!("failed to resolve mapped host cwd for {}", cwd.display()))?;
    if !resolved.starts_with(&mapping.host) {
        bail!("mapped cwd escaped the allowed host root");
    }
    Ok(resolved)
}

async fn serve_spawn(
    stream: TcpStream,
    harness_id: &str,
    cwd: &Path,
    env: BTreeMap<String, String>,
    mappings: &[PathMapping],
) -> Result<()> {
    let harness = crate::api::system_harness_report()
        .harnesses
        .into_iter()
        .find(|candidate| candidate.id == harness_id)
        .with_context(|| format!("host harness {harness_id:?} was not found"))?;
    if !harness.acp_available {
        bail!(
            "host harness {} is unavailable: {}",
            harness.name,
            harness
                .unavailable_reason
                .unwrap_or_else(|| "no ACP adapter".to_owned())
        );
    }
    let cwd = mapped_cwd(cwd, mappings)?;
    let mut child = Command::new(&harness.spawn.cmd)
        .args(&harness.spawn.args)
        .envs(env)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("failed to spawn host ACP adapter for {}", harness.name))?;
    let mut child_stdin = child
        .stdin
        .take()
        .context("host harness stdin unavailable")?;
    let child_stdout = child
        .stdout
        .take()
        .context("host harness stdout unavailable")?;
    let child_stderr = child
        .stderr
        .take()
        .context("host harness stderr unavailable")?;
    let (reader, mut writer) = stream.into_split();
    write_frame(&mut writer, &RunnerResponse::Ready).await?;

    let mut network = BufReader::new(reader).lines();
    let mut stdout = BufReader::new(child_stdout).lines();
    let mut stderr = BufReader::new(child_stderr).lines();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut disconnected = false;
    let status = {
        let wait = child.wait();
        tokio::pin!(wait);
        loop {
            tokio::select! {
                result = &mut wait => break Some(result?),
                line = network.next_line() => {
                    let Some(line) = line? else { disconnected = true; break None };
                    match serde_json::from_str::<RunnerRequest>(&line)? {
                        RunnerRequest::Stdin { data } => {
                            child_stdin.write_all(data.as_bytes()).await?;
                            child_stdin.write_all(b"\n").await?;
                            child_stdin.flush().await?;
                        }
                        _ => bail!("unexpected control frame after host harness started"),
                    }
                }
                line = stdout.next_line(), if stdout_open => match line? {
                    Some(data) => write_frame(&mut writer, &RunnerResponse::Stdout { data }).await?,
                    None => stdout_open = false,
                },
                line = stderr.next_line(), if stderr_open => match line? {
                    Some(data) => write_frame(&mut writer, &RunnerResponse::Stderr { data }).await?,
                    None => stderr_open = false,
                },
            }
        }
    };

    let status = if let Some(status) = status {
        status
    } else {
        child.kill().await.ok();
        child.wait().await?
    };
    if disconnected {
        return Ok(());
    }
    while let Some(data) = stdout.next_line().await? {
        write_frame(&mut writer, &RunnerResponse::Stdout { data }).await?;
    }
    while let Some(data) = stderr.next_line().await? {
        write_frame(&mut writer, &RunnerResponse::Stderr { data }).await?;
    }
    write_frame(
        &mut writer,
        &RunnerResponse::Exit {
            code: status.code().unwrap_or(-1),
        },
    )
    .await
}

/// Container-side stdio proxy used as the persisted agent spawn command.
///
/// # Errors
///
/// Returns an error when configuration is missing, the runner cannot be reached, or the stream
/// protocol fails.
pub async fn client(harness: String) -> Result<i32> {
    let config = configured_client().context(
        "host harness client is not configured; set LOOMWATCH_HOST_RUNNER_ADDR and LOOMWATCH_HOST_RUNNER_TOKEN",
    )?;
    let cwd = std::env::current_dir()?;
    let stream = TcpStream::connect(&config.addr)
        .await
        .with_context(|| format!("could not connect to host runner at {}", config.addr))?;
    let (reader, mut writer) = stream.into_split();
    write_request(
        &mut writer,
        &RunnerRequest::Spawn {
            token: config.token,
            harness,
            cwd,
            env: BTreeMap::new(),
        },
    )
    .await?;

    let mut network = BufReader::new(reader).lines();
    let opening = network
        .next_line()
        .await?
        .context("host runner closed before starting the harness")?;
    match serde_json::from_str::<RunnerResponse>(&opening)? {
        RunnerResponse::Ready => {}
        RunnerResponse::Error { message } => bail!("host runner refused spawn: {message}"),
        other => bail!("unexpected host runner spawn response: {other:?}"),
    }

    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    let mut stderr = tokio::io::stderr();
    loop {
        tokio::select! {
            line = stdin.next_line() => {
                let Some(data) = line? else { bail!("ACP client stdin closed before host harness exited") };
                write_request(&mut writer, &RunnerRequest::Stdin { data }).await?;
            }
            line = network.next_line() => {
                let line = line?.context("host runner disconnected before the harness exited")?;
                match serde_json::from_str::<RunnerResponse>(&line)? {
                    RunnerResponse::Stdout { data } => {
                        stdout.write_all(data.as_bytes()).await?;
                        stdout.write_all(b"\n").await?;
                        stdout.flush().await?;
                    }
                    RunnerResponse::Stderr { data } => {
                        stderr.write_all(data.as_bytes()).await?;
                        stderr.write_all(b"\n").await?;
                        stderr.flush().await?;
                    }
                    RunnerResponse::Exit { code } => return Ok(code),
                    RunnerResponse::Error { message } => bail!("host runner error: {message}"),
                    other => bail!("unexpected host runner stream response: {other:?}"),
                }
            }
        }
    }
}

/// Merge host and container inventories. Host entries win because enabling the bridge explicitly
/// means the operator wants the authenticated host installation and account.
#[must_use]
pub fn merge_reports(mut local: HarnessReport, remote: HarnessReport) -> HarnessReport {
    let remote_ids = remote
        .harnesses
        .iter()
        .map(|harness| harness.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    local
        .harnesses
        .retain(|harness: &DetectedHarness| !remote_ids.contains(harness.id.as_str()));
    let mut harnesses = remote.harnesses;
    harnesses.extend(local.harnesses);
    harnesses.sort_by_key(|harness| {
        crate::api::known_harness_ids()
            .iter()
            .position(|id| id == &harness.id)
            .unwrap_or(usize::MAX)
    });
    let mut searched_path = remote.searched_path;
    searched_path.extend(local.searched_path);
    HarnessReport {
        harnesses,
        searched_path,
        known_ids: local.known_ids,
        runner_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn harness(id: &str, available: bool, command: &str) -> DetectedHarness {
        DetectedHarness {
            id: id.to_owned(),
            name: id.to_owned(),
            command: id.to_owned(),
            executable_path: format!("/host/bin/{id}"),
            acp_available: available,
            unavailable_reason: (!available).then(|| "no adapter".to_owned()),
            health: None,
            health_reason: None,
            health_detail: None,
            spawn: HarnessSpawn {
                cmd: command.to_owned(),
                args: vec!["acp".to_owned()],
            },
        }
    }

    fn report(harnesses: Vec<DetectedHarness>, path: &str) -> HarnessReport {
        HarnessReport {
            harnesses,
            searched_path: vec![path.to_owned()],
            known_ids: crate::api::known_harness_ids(),
            runner_error: None,
        }
    }

    #[test]
    fn remote_inventory_uses_the_proxy_only_for_runnable_harnesses() {
        let proxied = proxied_report(report(
            vec![
                harness("opencode", true, "opencode"),
                harness("pi", false, "pi"),
            ],
            "/host/bin",
        ));

        assert_eq!(proxied.searched_path, ["host:/host/bin"]);
        assert_eq!(
            proxied.harnesses[0].executable_path,
            "host:/host/bin/opencode"
        );
        assert_eq!(proxied.harnesses[0].spawn.cmd, "loomwatchd");
        assert_eq!(
            proxied.harnesses[0].spawn.args,
            ["harness-client", "--harness", "opencode"]
        );
        assert_eq!(proxied.harnesses[1].spawn.cmd, "pi");
    }

    #[test]
    fn merging_prefers_the_explicit_host_backend() {
        let local = report(
            vec![harness("opencode", true, "container-opencode")],
            "/bin",
        );
        let remote = report(
            vec![
                harness("opencode", true, "loomwatchd"),
                harness("codex", true, "loomwatchd"),
            ],
            "host:/host/bin",
        );

        let merged = merge_reports(local, remote);
        assert_eq!(
            merged
                .harnesses
                .iter()
                .map(|item| (item.id.as_str(), item.spawn.cmd.as_str()))
                .collect::<Vec<_>>(),
            [("codex", "loomwatchd"), ("opencode", "loomwatchd")]
        );
        assert_eq!(merged.searched_path, ["host:/host/bin", "/bin"]);
    }
}
