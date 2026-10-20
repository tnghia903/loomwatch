//! Running a command an agent was allowed to run.
//!
//! - It runs in the agent's work folder, through the system shell: `/bin/sh -c` on macOS and
//!   Linux, `cmd.exe /d /s /c` on Windows.
//! - Its environment has every provider key and `LoomWatch` secret removed ([`scrubbed`]), so a
//!   script cannot read the operator's key or the daemon's database address.
//! - On a Mac it runs in a sandbox ([`super::super::sandbox`]): it can change files only in the
//!   work folder and temporary folders, and reach the network only when the agent may use the web.
//! - When the agent may use the web, Python's own web requests name `LoomWatch` ([`USER_AGENT`])
//!   instead of Python, which some sites refuse ([`PythonName`]).
//! - It stops at its timeout, or when the turn is cancelled, and everything it started goes with
//!   it: its process group on macOS and Linux, its job ([`ProcessTree`]) on Windows. On Windows
//!   the job also closes when the command finishes, so nothing it started keeps running after.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::{Context, Output};
use crate::agent::sandbox;
use crate::platform::ProcessTree;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TIMEOUT: Duration = Duration::from_mins(10);
/// What a command may print before the rest is cut. The session sets long outputs aside, so
/// this only stops a runaway command from filling the daemon's memory.
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

/// The name a command's Python web requests go out under, in place of `Python-urllib/3.x`, which
/// Read the Docs and others refuse with 403. It names `LoomWatch` and where to read about it, as
/// those sites ask of tools, and never claims to be a browser.
pub(crate) const USER_AGENT: &str = concat!(
    "LoomWatch/",
    env!("CARGO_PKG_VERSION"),
    " (+https://loomwatch.github.io/)"
);

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
    // Kept until the command ends. A folder that can't be made leaves Python its own name.
    let python = if context.command.network {
        PythonName::new().ok()
    } else {
        None
    };
    if let Some(python) = &python {
        process.env("PYTHONPATH", python.path());
    }
    // Python on Windows writes to a pipe in the system's code page, which the output is not read
    // in: UTF-8 unless the operator chose otherwise.
    if cfg!(windows) && std::env::var_os("PYTHONUTF8").is_none() {
        process.env("PYTHONUTF8", "1");
    }
    #[cfg(unix)]
    process.process_group(0);
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return Output::failed(format!("The command couldn't start: {error}")),
    };
    let pid = child.id();
    let tree = ProcessTree::adopt(&child);
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
            stop_tree(pid, tree).await;
            return Output::failed("The command was stopped: the turn was cancelled.");
        }
    };
    let Some((out, err, status)) = outcome else {
        stop_tree(pid, tree).await;
        return Output::failed(format!(
            "The command was stopped after {} seconds without finishing.",
            timeout.as_secs()
        ));
    };
    tree.end();
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
            if sandbox::denied(&text, context.cwd, context.command) {
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
    system_shell(command)
}

#[cfg(not(windows))]
fn system_shell(command: &str) -> Command {
    let mut process = Command::new("/bin/sh");
    process.arg("-c").arg(command);
    process
}

/// cmd.exe, given the command line exactly as the agent wrote it.
///
/// - `/d` skips the `AutoRun` commands the registry may hold for cmd.exe.
/// - `/s /c "…"`: cmd.exe drops the outer quotes and runs everything between them as typed, so
///   the agent's own quotes, `&`, `|` and `>` reach it unchanged.
/// - The line is appended raw: Rust's quoting is for programs that read their arguments the way C
///   programs do, which cmd.exe does not.
/// - No console window: the daemon may run without one, and cmd.exe would open its own.
/// - cmd.exe from the system folder, so a `cmd.exe` in the work folder or on `PATH` is never the
///   one that runs.
#[cfg(windows)]
fn system_shell(command: &str) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let cmd = std::env::var_os("SystemRoot").map_or_else(
        || PathBuf::from("cmd.exe"),
        |root| PathBuf::from(root).join("System32").join("cmd.exe"),
    );
    let mut process = Command::new(cmd);
    process
        .raw_arg(format!("/d /s /c \"{command}\""))
        .creation_flags(CREATE_NO_WINDOW);
    process
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
///
/// On macOS and Linux that is the process group the command leads. On Windows it is the
/// command's job: closing it ends every process in it, however deep.
#[cfg_attr(not(unix), allow(clippy::unused_async))]
async fn stop_tree(pid: Option<u32>, tree: ProcessTree) {
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
    tree.end();
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

/// A folder holding the `sitecustomize.py` that gives Python's web requests [`USER_AGENT`], made
/// for one command and removed when it ends: a file every command shared is one any of them could
/// change for the rest.
struct PythonName(PathBuf);

impl PythonName {
    fn new() -> std::io::Result<Self> {
        let folder =
            std::env::temp_dir().join(format!("loomwatch-python-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder)?;
        let name = Self(folder);
        std::fs::write(
            name.0.join("sitecustomize.py"),
            include_str!("sitecustomize.py").replace("@USER_AGENT@", USER_AGENT),
        )?;
        Ok(name)
    }

    /// `PYTHONPATH` with this folder first, so its `sitecustomize` is the one Python finds. The
    /// daemon's own `PYTHONPATH` follows unchanged.
    fn path(&self) -> OsString {
        let mut path = self.0.clone().into_os_string();
        if let Some(rest) = std::env::var_os("PYTHONPATH").filter(|rest| !rest.is_empty()) {
            path.push(if cfg!(windows) { ";" } else { ":" });
            path.push(rest);
        }
        path
    }
}

impl Drop for PythonName {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
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

    /// The same check written for the shell this system runs commands with.
    fn script(sh: &'static str, cmd: &'static str) -> serde_json::Value {
        serde_json::json!({"command": if cfg!(windows) { cmd } else { sh }})
    }

    struct Folder(PathBuf);

    impl Folder {
        fn new() -> Self {
            let folder =
                std::env::temp_dir().join(format!("loomwatch-agent-cmd-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&folder).unwrap();
            Self(crate::platform::canonicalize(&folder).unwrap())
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A command that starts another shell, which writes `late.txt` two seconds later: if the
    /// command's whole tree is stopped, the file never appears.
    fn writes_late() -> serde_json::Value {
        script(
            "/bin/sh -c 'sleep 2; echo late > late.txt'",
            "cmd /d /c \"ping -n 3 127.0.0.1 >nul & echo late> late.txt\"",
        )
    }

    async fn never_written(folder: &Folder) {
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(
            !folder.0.join("late.txt").exists(),
            "a process the command started outlived it"
        );
    }

    #[tokio::test]
    async fn a_command_runs_in_its_folder_and_reports_failure_and_timeouts() {
        let folder = Folder::new();
        let cwd = &folder.0;
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let cancel = Cancel::new(cancel_rx);
        let settings = CommandSettings::default();
        let context = Context {
            cwd,
            connected: &[],
            cancel: &cancel,
            command: &settings,
            pictures: super::super::Pictures::default(),
        };
        let done = run(
            &script(
                "pwd && echo $OPENROUTER_API_KEY",
                "cd & echo %OPENROUTER_API_KEY%",
            ),
            &context,
        )
        .await;
        assert!(!done.failed, "{}", done.text);
        assert_eq!(
            done.text.lines().next().map(str::trim_end),
            Some(cwd.to_string_lossy().as_ref())
        );
        assert!(!done.text.contains("sk-"));

        // The command line reaches the shell as written: quotes and `&` included.
        let quoted = run(&script("echo \"a & b\"", "echo \"a & b\""), &context).await;
        assert!(!quoted.failed, "{}", quoted.text);
        assert!(quoted.text.contains("a & b"), "{}", quoted.text);

        let failed = run(
            &script("echo oops >&2; exit 3", "echo oops 1>&2 & exit 3"),
            &context,
        )
        .await;
        assert!(failed.failed);
        assert!(
            failed.text.contains("exit code 3") && failed.text.contains("oops"),
            "{}",
            failed.text
        );

        let mut slow = writes_late();
        slow["timeout_seconds"] = 1.into();
        let slow = run(&slow, &context).await;
        assert!(
            slow.failed && slow.text.contains("after 1 seconds"),
            "{}",
            slow.text
        );
        never_written(&folder).await;
    }

    /// The agent learns the real reason when the sandbox stopped a command, and only then.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn on_a_mac_only_what_the_sandbox_blocked_says_so() {
        let folder = Folder::new();
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let cancel = Cancel::new(cancel_rx);
        let settings = CommandSettings::default();
        let context = Context {
            cwd: &folder.0,
            connected: &[],
            cancel: &cancel,
            command: &settings,
            pictures: super::super::Pictures::default(),
        };
        let note = "(The sandbox blocked this";
        let home = std::env::var("HOME").unwrap();
        let outside = format!(
            "echo x > '{home}/.loomwatch-outside-probe-{}'",
            uuid::Uuid::new_v4()
        );
        let outside = run(&serde_json::json!({ "command": outside }), &context).await;
        assert!(
            outside.failed && outside.text.contains(note),
            "{}",
            outside.text
        );
        // A locked file in the work folder fails with the same words, but not for the sandbox.
        let locked = run(
            &serde_json::json!({ "command": "touch locked && chflags uchg locked && \
                 { echo x > \"$PWD/locked\"; failed=$?; chflags nouchg locked; exit $failed; }" }),
            &context,
        )
        .await;
        assert!(
            locked.failed
                && locked.text.contains("Operation not permitted")
                && !locked.text.contains(note),
            "{}",
            locked.text
        );
    }

    async fn run_in(folder: &Folder, network: bool, input: &serde_json::Value) -> Output {
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let cancel = Cancel::new(cancel_rx);
        let settings = CommandSettings {
            network,
            ..CommandSettings::default()
        };
        let context = Context {
            cwd: &folder.0,
            connected: &[],
            cancel: &cancel,
            command: &settings,
            pictures: super::super::Pictures::default(),
        };
        run(input, &context).await
    }

    /// A web server on this computer that answers every request with "ok" and passes on the name
    /// each request came with.
    #[cfg(unix)]
    fn names_heard() -> (u16, std::sync::mpsc::Receiver<String>) {
        use std::io::{BufRead, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (heard, names) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut name = String::new();
                let mut reader = std::io::BufReader::new(&stream);
                let mut line = String::new();
                // Headers end at the first empty line.
                while reader.read_line(&mut line).is_ok_and(|read| read > 2) {
                    if line.to_ascii_lowercase().starts_with("user-agent:") {
                        line["user-agent:".len()..].trim().clone_into(&mut name);
                    }
                    line.clear();
                }
                let _ = (&stream).write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
                let _ = heard.send(name);
            }
        });
        (port, names)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn python_asks_for_pages_as_loomwatch_when_the_agent_may_use_the_web() {
        let folder = Folder::new();
        let (port, names) = names_heard();
        let url = format!("http://127.0.0.1:{port}/");
        let fetch = serde_json::json!({"command": format!(
            "no_proxy='*' python3 -c \"import sys; print('urllib.request' in sys.modules); \
             import urllib.request as r; r.urlopen('{url}').read(); \
             r.urlopen(r.Request('{url}', headers={{'User-Agent': 'their-own/1'}})).read()\""
        )});
        let fetched = run_in(&folder, true, &fetch).await;
        assert!(!fetched.failed, "{}", fetched.text);
        // Nothing is imported before the script asks for it.
        assert_eq!(fetched.text.trim(), "False");
        let heard = || names.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(heard(), USER_AGENT);
        // A name the script gives itself wins.
        assert_eq!(heard(), "their-own/1");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_name_comes_only_with_the_web_and_hides_no_other_sitecustomize() {
        let folder = Folder::new();
        let theirs = folder.0.join("theirs");
        std::fs::create_dir(&theirs).unwrap();
        std::fs::write(theirs.join("sitecustomize.py"), "print('theirs ran')\n").unwrap();
        let name = serde_json::json!({"command": "PYTHONPATH=\"$PYTHONPATH:$PWD/theirs\" python3 -c \
            \"import urllib.request as r; print(dict(r.build_opener().addheaders)['User-agent'])\""});

        let named = run_in(&folder, true, &name).await;
        assert!(!named.failed, "{}", named.text);
        assert!(named.text.contains("theirs ran"), "{}", named.text);
        assert!(named.text.contains(USER_AGENT), "{}", named.text);

        let own = run_in(&folder, false, &name).await;
        assert!(!own.failed, "{}", own.text);
        assert!(own.text.contains("theirs ran"), "{}", own.text);
        assert!(own.text.contains("Python-urllib/"), "{}", own.text);
    }

    #[tokio::test]
    async fn the_name_is_made_for_each_command_and_goes_when_it_ends() {
        let folder = Folder::new();
        let said = run_in(
            &folder,
            true,
            &script("echo \"$PYTHONPATH\"", "echo %PYTHONPATH%"),
        )
        .await;
        assert!(!said.failed, "{}", said.text);
        let first = std::env::split_paths(said.text.trim()).next().unwrap();
        assert!(
            first.to_string_lossy().contains("loomwatch-python-"),
            "{}",
            said.text
        );
        assert!(!first.exists(), "{} was left behind", first.display());
    }

    #[tokio::test]
    async fn cancelling_the_turn_stops_everything_the_command_started() {
        let folder = Folder::new();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let cancel = Cancel::new(cancel_rx);
        let settings = CommandSettings::default();
        let context = Context {
            cwd: &folder.0,
            connected: &[],
            cancel: &cancel,
            command: &settings,
            pictures: super::super::Pictures::default(),
        };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = cancel_tx.send(true);
            // Kept until the command is stopped: a closed channel is no cancel.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let stopped = run(&writes_late(), &context).await;
        assert!(
            stopped.failed && stopped.text.contains("the turn was cancelled"),
            "{}",
            stopped.text
        );
        never_written(&folder).await;
    }
}
