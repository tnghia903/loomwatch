//! Running a command an agent was allowed to run.
//!
//! - It runs in the agent's work folder, through the system shell.
//! - Its environment has every provider key and `LoomWatch` secret removed ([`scrubbed`]), so a
//!   script cannot read the operator's key or the daemon's database address.
//! - On a Mac it runs in a sandbox ([`super::super::sandbox`]): it can change files only in the
//!   work folder and temporary folders, and reach the network only when the agent may use the web.
//! - It stops at its timeout, or when the turn is cancelled, and its whole process group goes with
//!   it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::{Context, Output};
use crate::agent::sandbox;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TIMEOUT: Duration = Duration::from_mins(10);
/// What a command may print before the rest is cut. The session sets long outputs aside, so
/// this only stops a runaway command from filling the daemon's memory.
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

/// How commands run for one agent.
#[derive(Debug, Clone, Default)]
pub(crate) struct CommandSettings {
    /// Whether a command may reach the network (the agent's `allow.web`).
    pub network: bool,
    /// Extra folders a command may write to, such as a granted output folder.
    pub writable: Vec<PathBuf>,
}

pub(super) async fn run(input: &Value, context: &Context<'_>) -> Output {
    let Some(command) = input.get("command").and_then(Value::as_str) else {
        return Output::failed("`command` is required.");
    };
    let timeout = input
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_TIMEOUT, Duration::from_secs)
        .min(MAX_TIMEOUT);
    let mut process = shell(command, context.cwd, context.command);
    process
        .current_dir(context.cwd)
        .env_clear()
        .envs(scrubbed(std::env::vars_os()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return Output::failed(format!("The command couldn't start: {error}")),
    };
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let reading = async {
        let (out, err) = tokio::join!(read_all(stdout), read_all(stderr));
        (out, err)
    };
    // On the heap: the read buffers would otherwise make every future that awaits a command large.
    let waited = Box::pin(async {
        let ((out, err), status) = tokio::join!(reading, child.wait());
        (out, err, status)
    });
    let outcome = tokio::select! {
        finished = tokio::time::timeout(timeout, waited) => finished.ok(),
        () = context.cancel.cancelled() => {
            stop_group(pid).await;
            return Output::failed("The command was stopped: the turn was cancelled.");
        }
    };
    let Some((out, err, status)) = outcome else {
        stop_group(pid).await;
        return Output::failed(format!(
            "The command was stopped after {} seconds without finishing.",
            timeout.as_secs()
        ));
    };
    let mut text = String::from_utf8_lossy(&out).into_owned();
    let err = String::from_utf8_lossy(&err);
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    if out.len() >= MAX_OUTPUT_BYTES || err.len() >= MAX_OUTPUT_BYTES {
        text.push_str("\n… the command printed more than 2 MB; the rest was cut.");
    }
    match status {
        Ok(status) if status.success() => {
            if text.trim().is_empty() {
                "The command finished with no output.".clone_into(&mut text);
            }
            Output::ok(text)
        }
        Ok(status) => {
            let code = status
                .code()
                .map_or_else(|| "a signal".to_owned(), |code| format!("exit code {code}"));
            if sandbox::denied(&text) {
                text.push_str(
                    "\n(The sandbox blocked this: commands may change files only in the work \
                     folder, and reach the network only when this agent may use the web.)",
                );
            }
            Output::failed(format!("The command failed with {code}.\n{text}"))
        }
        Err(error) => Output::failed(format!("The command's result couldn't be read: {error}")),
    }
}

/// The command as the shell runs it, inside the sandbox where there is one.
fn shell(command: &str, cwd: &Path, settings: &CommandSettings) -> Command {
    if let Some(sandboxed) = sandbox::wrap(command, cwd, settings) {
        return sandboxed;
    }
    if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(command);
        process
    } else {
        let mut process = Command::new("/bin/sh");
        process.arg("-c").arg(command);
        process
    }
}

async fn read_all(stream: Option<impl AsyncRead + Unpin>) -> Vec<u8> {
    let Some(mut stream) = stream else {
        return Vec::new();
    };
    let mut kept = Vec::new();
    let mut buffer = vec![0u8; 8192];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        }
    }
    kept
}

/// Stops the command and everything it started. `kill_on_drop` alone stops only the shell.
async fn stop_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// The daemon's environment without anything secret.
///
/// Provider keys go: every `*_API_KEY` and `*_API_TOKEN`, and everything named for a model
/// provider. So do `LoomWatch`'s own settings and the database address, as the daemon has always
/// withheld them from agents.
pub(crate) fn scrubbed(
    vars: impl Iterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    vars.filter(|(name, _)| {
        let name = name.to_string_lossy().to_ascii_uppercase();
        !(name.ends_with("_API_KEY")
            || name.ends_with("_API_TOKEN")
            || name.ends_with("_AUTH_TOKEN")
            || [
                "OPENROUTER_",
                "ANTHROPIC_",
                "OPENAI_",
                "GEMINI_",
                "GOOGLE_API",
                "LOOMWATCH_",
                "POSTGRES_",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
            || matches!(name.as_str(), "DATABASE_URL" | "PGPASSWORD"))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::provider::Cancel;

    #[test]
    fn keys_and_daemon_settings_never_reach_a_command() {
        let vars = [
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/me"),
            ("OPENROUTER_API_KEY", "sk-or-1"),
            ("ANTHROPIC_AUTH_TOKEN", "t"),
            ("SOME_SERVICE_API_KEY", "k"),
            ("LOOMWATCH_STATE_DIR", "/s"),
            ("DATABASE_URL", "postgres://"),
            ("LANG", "en_US.UTF-8"),
        ]
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));
        let kept: Vec<String> = scrubbed(vars.into_iter())
            .into_iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept, ["PATH", "HOME", "LANG"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_runs_in_its_folder_and_reports_failure_and_timeouts() {
        let folder =
            std::env::temp_dir().join(format!("loomwatch-agent-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let cwd = folder.canonicalize().unwrap();
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let cancel = Cancel::new(cancel_rx);
        let settings = CommandSettings::default();
        let context = Context {
            cwd: &cwd,
            cancel: &cancel,
            command: &settings,
        };
        let done = run(
            &serde_json::json!({"command": "pwd && echo $OPENROUTER_API_KEY"}),
            &context,
        )
        .await;
        assert!(!done.failed, "{}", done.text);
        assert_eq!(
            done.text.lines().next(),
            Some(cwd.to_string_lossy().as_ref())
        );
        assert!(!done.text.contains("sk-"));

        let failed = run(
            &serde_json::json!({"command": "echo oops >&2; exit 3"}),
            &context,
        )
        .await;
        assert!(failed.failed);
        assert!(failed.text.contains("exit code 3") && failed.text.contains("oops"));

        let slow = run(
            &serde_json::json!({"command": "sleep 5", "timeout_seconds": 1}),
            &context,
        )
        .await;
        assert!(slow.failed && slow.text.contains("after 1 seconds"));
        let _ = std::fs::remove_dir_all(&folder);
    }
}
