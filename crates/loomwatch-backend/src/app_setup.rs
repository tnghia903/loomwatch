//! Setting up an AI app from the Home panel without Terminal: signing in to Claude or Codex with
//! the app's own sign-in, and installing `OpenCode` with its own installer.
//!
//! Each is the vendor's command, run the way the panel used to ask people to paste it, with its
//! output kept so the panel can show the sign-in page's address and, for Claude, take the code
//! its page ends with. One job per app at a time; a finished job stays readable until the next.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};

/// How long a sign-in or install may wait (for the person in the browser, or the download).
const JOB_TIMEOUT: Duration = Duration::from_mins(15);
/// The most output kept per job: enough for the address and the last error.
const OUTPUT_MAX_BYTES: usize = 64 * 1024;
/// How Claude's sign-in asks for the code its page shows, with no line end after it.
const PASTE_PROMPT: &str = "Paste code here if prompted >";
/// Where a sign-in page may be, so the panel only ever links to the vendor's own.
const SIGN_IN_HOSTS: &[&str] = &[
    "claude.com",
    "claude.ai",
    "platform.claude.com",
    "console.anthropic.com",
    "auth.openai.com",
    "chatgpt.com",
];

/// What a job does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    SignIn,
    Install,
}

/// Where a job stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Running,
    Done,
    Failed,
}

/// One app's setup job, as `/api/harnesses` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupJob {
    pub kind: JobKind,
    pub state: JobState,
    /// The vendor's sign-in page, when the app printed it: the panel's "open it again" link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The app is waiting for the code its sign-in page shows at the end (Claude).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_code: bool,
    /// Why a failed job failed, in the app's own words when it said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

struct Job {
    kind: JobKind,
    state: JobState,
    /// Everything the program said, as bytes: a chunk can end inside a character.
    output: Vec<u8>,
    stdin: Option<ChildStdin>,
    reason: Option<String>,
    finished_at: Option<Instant>,
}

impl Job {
    fn report(&self) -> SetupJob {
        let output = String::from_utf8_lossy(&self.output);
        SetupJob {
            kind: self.kind,
            state: self.state,
            url: sign_in_url(&output),
            needs_code: self.state == JobState::Running
                && self.kind == JobKind::SignIn
                && self.stdin.is_some()
                && output.contains(PASTE_PROMPT),
            reason: self.reason.clone(),
        }
    }
}

/// Every app's latest job.
#[derive(Default)]
pub struct Jobs {
    jobs: Mutex<HashMap<String, Arc<Mutex<Job>>>>,
}

static JOBS: OnceLock<Jobs> = OnceLock::new();

/// This process's jobs.
pub fn jobs() -> &'static Jobs {
    JOBS.get_or_init(Jobs::default)
}

/// The command that signs in to `app` with its program at `executable`, or `None` for an app
/// whose sign-in the panel does not run.
fn sign_in_args(app: &str) -> Option<&'static [&'static str]> {
    match app {
        // The subscription sign-in, which `claude auth login` defaults to; said, so it never asks.
        "claude" => Some(&["auth", "login", "--claudeai"]),
        "codex" => Some(&["login"]),
        _ => None,
    }
}

/// The vendor's own installer for `app`, or `None` for an app the panel does not install. Claude
/// and Codex need none: their connectors carry them (`crate::connectors`).
fn installer(app: &str) -> Option<&'static str> {
    match app {
        "opencode" => Some("curl -fsSL https://opencode.ai/install | bash"),
        _ => None,
    }
}

/// Whether the panel can sign in to `app` for the person.
#[must_use]
pub fn can_sign_in(app: &str) -> bool {
    sign_in_args(app).is_some()
}

/// Whether the panel can install `app` for the person.
#[must_use]
pub fn can_install(app: &str) -> bool {
    installer(app).is_some()
}

impl Jobs {
    /// Every app's latest job, by app id.
    #[must_use]
    pub fn snapshot(&self) -> HashMap<String, SetupJob> {
        self.lock()
            .iter()
            .map(|(app, job)| (app.clone(), lock(job).report()))
            .collect()
    }

    /// When `app`'s last sign-in finished well: a sign-in verdict recorded before then is stale.
    #[must_use]
    pub fn signed_in_at(&self, app: &str) -> Option<Instant> {
        let job = self.lock().get(app).cloned()?;
        let job = lock(&job);
        (job.kind == JobKind::SignIn && job.state == JobState::Done)
            .then_some(job.finished_at)
            .flatten()
    }

    /// Whether `app` has had a sign-in or install running, or finishing, since `since`, however
    /// it went: what the app's own sign-in status said before then may no longer be so.
    #[must_use]
    pub fn changed_since(&self, app: &str, since: Instant) -> bool {
        let Some(job) = self.lock().get(app).cloned() else {
            return false;
        };
        lock(&job)
            .finished_at
            .is_none_or(|finished| finished >= since)
    }

    /// Start `app`'s own sign-in with its program at `executable`. A sign-in already running is
    /// left to finish and reported instead of being started twice (Codex's waits on a fixed port).
    ///
    /// # Errors
    ///
    /// Returns an error for an app the panel does not sign in to, or when it cannot start.
    pub fn sign_in(&self, app: &str, executable: &Path) -> Result<SetupJob> {
        let args =
            sign_in_args(app).with_context(|| format!("LoomWatch can't sign in to {app}"))?;
        let mut command = Command::new(executable);
        command.args(args);
        self.start(app, JobKind::SignIn, command)
    }

    /// Run `app`'s own installer.
    ///
    /// # Errors
    ///
    /// Returns an error for an app the panel does not install, or when the installer cannot start.
    pub fn install(&self, app: &str) -> Result<SetupJob> {
        let script = installer(app).with_context(|| format!("LoomWatch can't install {app}"))?;
        let mut command = Command::new("/bin/bash");
        command.args(["-c", script]);
        self.start(app, JobKind::Install, command)
    }

    /// Give `app`'s running sign-in the code its page showed.
    ///
    /// # Errors
    ///
    /// Returns an error when no sign-in is waiting for a code, or the code is not one.
    pub async fn submit_code(&self, app: &str, code: &str) -> Result<()> {
        let code = code.trim();
        if code.is_empty() || code.len() > 512 || code.chars().any(char::is_control) {
            bail!(
                "That doesn't look like a sign-in code. Copy it again from the page and paste it here."
            );
        }
        let job = self
            .lock()
            .get(app)
            .cloned()
            .context("no sign-in is running")?;
        let stdin = {
            let mut job = lock(&job);
            if job.kind != JobKind::SignIn || job.state != JobState::Running {
                bail!("no sign-in is running");
            }
            job.stdin
                .take()
                .context("the sign-in already has its code")?
        };
        let mut stdin = stdin;
        stdin.write_all(format!("{code}\n").as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    fn start(&self, app: &str, kind: JobKind, mut command: Command) -> Result<SetupJob> {
        let mut jobs = self.lock();
        if let Some(running) = jobs.get(app)
            && lock(running).state == JobState::Running
        {
            return Ok(lock(running).report());
        }
        for (key, _) in std::env::vars_os() {
            if let Some(key) = key.to_str()
                && (key == "DATABASE_URL"
                    || key.starts_with("LOOMWATCH_")
                    || key.starts_with("POSTGRES_"))
            {
                command.env_remove(key);
            }
        }
        command
            .stdin(if kind == JobKind::SignIn {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().context("couldn't start it")?;
        let job = Arc::new(Mutex::new(Job {
            kind,
            state: JobState::Running,
            output: Vec::new(),
            stdin: child.stdin.take(),
            reason: None,
            finished_at: None,
        }));
        for stream in [
            child
                .stdout
                .take()
                .map(|out| Box::new(out) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
            child
                .stderr
                .take()
                .map(|err| Box::new(err) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        ]
        .into_iter()
        .flatten()
        {
            let job = Arc::clone(&job);
            tokio::spawn(async move {
                // Not by lines: Claude's "Paste code here if prompted > " ends without one.
                let mut stream = stream;
                let mut chunk = [0_u8; 4096];
                while let Ok(read) = stream.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    let mut job = lock(&job);
                    if job.output.len() < OUTPUT_MAX_BYTES {
                        job.output.extend_from_slice(&chunk[..read]);
                    }
                }
            });
        }
        let watched = Arc::clone(&job);
        tokio::spawn(async move {
            let finished = tokio::time::timeout(JOB_TIMEOUT, child.wait()).await;
            let mut job = lock(&watched);
            job.stdin = None;
            job.finished_at = Some(Instant::now());
            match finished {
                Ok(Ok(status)) if status.success() => job.state = JobState::Done,
                Ok(Ok(status)) => {
                    job.state = JobState::Failed;
                    job.reason = Some(
                        // The prompt has no line end, so what follows it would read as part of it.
                        last_line(
                            &String::from_utf8_lossy(&job.output).replace(PASTE_PROMPT, "\n"),
                        )
                        .map_or_else(
                            || format!("it stopped with exit code {}", status.code().unwrap_or(-1)),
                            str::to_owned,
                        ),
                    );
                }
                Ok(Err(error)) => {
                    job.state = JobState::Failed;
                    job.reason = Some(error.to_string());
                }
                Err(_) => {
                    let _ = child.start_kill();
                    job.state = JobState::Failed;
                    job.reason = Some("It waited 15 minutes without finishing, so LoomWatch stopped it. Try again.".to_owned());
                }
            }
        });
        let report = lock(&job).report();
        jobs.insert(app.to_owned(), job);
        Ok(report)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Mutex<Job>>>> {
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn lock(job: &Mutex<Job>) -> std::sync::MutexGuard<'_, Job> {
    job.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The last thing the program said, for a failure's reason.
fn last_line(output: &str) -> Option<&str> {
    output
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| !line.is_empty())
}

/// The first vendor sign-in page address in `output`.
fn sign_in_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .filter(|word| word.starts_with("https://"))
        .find(|word| {
            url::Url::parse(word).is_ok_and(|url| {
                url.host_str().is_some_and(|host| {
                    SIGN_IN_HOSTS
                        .iter()
                        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
                })
            })
        })
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_vendor_sign_in_page_is_linked() {
        let claude = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc\nPaste code here if prompted > ";
        assert_eq!(
            sign_in_url(claude).as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&client_id=abc")
        );
        let codex = "Starting local login server on http://localhost:1455.\n\nhttps://auth.openai.com/oauth/authorize?response_type=code\n";
        assert_eq!(
            sign_in_url(codex).as_deref(),
            Some("https://auth.openai.com/oauth/authorize?response_type=code")
        );
        assert_eq!(
            sign_in_url("visit https://claude.com.evil.example/login"),
            None
        );
        assert_eq!(sign_in_url("visit http://claude.com/login"), None);
    }

    #[test]
    fn panel_runs_only_the_vendors_own_commands() {
        assert!(can_sign_in("claude") && can_sign_in("codex"));
        assert!(!can_sign_in("opencode") && !can_sign_in("gemini"));
        assert!(can_install("opencode"));
        assert!(!can_install("claude") && !can_install("codex"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_sign_in_takes_its_code_and_reports_how_it_ended() {
        let jobs = Jobs::default();
        // Stands in for `claude auth login`: prints the page, waits for a code, checks it.
        let script =
            std::env::temp_dir().join(format!("loomwatch-signin-{}.sh", uuid::Uuid::new_v4()));
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'visit: https://claude.com/cai/oauth/authorize?x=1'\nprintf 'Paste code here if prompted > '\nread code\n[ \"$code\" = right-code ] && echo 'Login successful.' && exit 0\necho 'OAuth error: invalid code' >&2\nexit 1\n",
        )
        .unwrap();
        let mut command = Command::new("/bin/sh");
        command.arg(&script);
        let started = jobs.start("claude", JobKind::SignIn, command).unwrap();
        assert_eq!(started.state, JobState::Running);

        let waiting = wait_for(&jobs, |job| job.needs_code).await;
        assert_eq!(
            waiting.url.as_deref(),
            Some("https://claude.com/cai/oauth/authorize?x=1")
        );
        // A second click while it runs reports the same sign-in instead of starting another.
        let mut again = Command::new("/bin/sh");
        again.arg("-c").arg("exit 3");
        assert!(
            jobs.start("claude", JobKind::SignIn, again)
                .unwrap()
                .needs_code
        );

        assert!(jobs.submit_code("claude", "bad\ncode").await.is_err());
        jobs.submit_code("claude", "  right-code ").await.unwrap();
        let done = wait_for(&jobs, |job| job.state != JobState::Running).await;
        assert_eq!(done.state, JobState::Done);
        assert!(!done.needs_code);
        assert!(jobs.signed_in_at("claude").is_some());

        // The wrong code fails, in the app's own words.
        let mut command = Command::new("/bin/sh");
        command.arg(&script);
        jobs.start("claude", JobKind::SignIn, command).unwrap();
        wait_for(&jobs, |job| job.needs_code).await;
        jobs.submit_code("claude", "wrong").await.unwrap();
        let failed = wait_for(&jobs, |job| job.state != JobState::Running).await;
        assert_eq!(failed.state, JobState::Failed);
        assert_eq!(failed.reason.as_deref(), Some("OAuth error: invalid code"));
        assert!(jobs.signed_in_at("claude").is_none());
        let _ = std::fs::remove_file(script);
    }

    async fn wait_for(jobs: &Jobs, ready: impl Fn(&SetupJob) -> bool) -> SetupJob {
        for _ in 0..200 {
            if let Some(job) = jobs.snapshot().remove("claude")
                && ready(&job)
            {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("job never got there: {:?}", jobs.snapshot());
    }
}
