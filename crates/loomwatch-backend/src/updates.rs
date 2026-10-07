//! New versions of `LoomWatch` (ADR 0052): whether one was released, what changed in it, and how
//! to install it.
//!
//! Once a day, and again right after an update, the daemon asks GitHub for the newest published
//! release and compares its version with its own. The request carries nothing about the operator:
//! one `GET` naming this version in its `User-Agent`, plus the `ETag` of the answer already held,
//! so an unchanged answer costs nothing against GitHub's hourly limit. The operator can turn the
//! daily check off in the app, and `LOOMWATCH_UPDATE_CHECK=off` turns every check off on this
//! computer.
//!
//! Installing is the launcher's job. In the terminal, `loomwatch update` stops nothing without
//! asking, backs the database up, and keeps the version it replaces for `loomwatch rollback`. A
//! ready-built copy whose launcher stays beside it ([`SUPERVISED_ENV`]) can also be updated from
//! the app: `POST /api/updates/install` names the release in a file the launcher reads, and the
//! daemon exits with [`EXIT_TO_UPDATE`]. The launcher then runs that same update and starts
//! `LoomWatch` again in its terminal, or starts this version again when the update did not finish.

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;

use crate::api::ApiError;
use crate::archive::EventArchive;
use crate::runs::{RunRecord, RunRegistry, RunStatus};
use crate::watch_api::local_evidence;

/// Where `LoomWatch` is published.
pub const REPOSITORY: &str = "tnghia903/loomwatch";
/// GitHub's newest published release: never a draft, never a pre-release.
const LATEST_RELEASE: &str = "https://api.github.com/repos/tnghia903/loomwatch/releases/latest";
/// Turns every check off on this computer: `0`, `off`, `false` or `no`.
pub const CHECK_ENV: &str = "LOOMWATCH_UPDATE_CHECK";
/// Asks another server instead of GitHub, for trying a release before it is published. Only
/// `https`, or `http` on this computer.
pub const URL_ENV: &str = "LOOMWATCH_UPDATE_URL";
/// `release` or `source`: how the launcher found this copy (`./loomwatch` sets it).
pub const INSTALL_ENV: &str = "LOOMWATCH_INSTALL";
/// The update command as the operator would type it, such as `loomwatch update`.
pub const COMMAND_ENV: &str = "LOOMWATCH_UPDATE_COMMAND";
/// `1` from a launcher that stays beside the daemon: when the daemon exits with
/// [`EXIT_TO_UPDATE`], it installs the release named in [`REQUEST_ENV`]'s file and starts the
/// daemon again. `./loomwatch` sets it for a ready-built copy.
pub const SUPERVISED_ENV: &str = "LOOMWATCH_SUPERVISED";
/// The file, an absolute path, where the daemon names the release for that launcher to install.
pub const REQUEST_ENV: &str = "LOOMWATCH_UPDATE_REQUEST";
/// Set by that launcher when an update did not finish and it started this version again: why.
pub const FAILED_ENV: &str = "LOOMWATCH_UPDATE_FAILED";
/// The exit status that asks the launcher to update: sysexits' `EX_TEMPFAIL`, which nothing else
/// in `LoomWatch` exits with. Any other status ends the launcher, as it always has.
pub const EXIT_TO_UPDATE: i32 = 75;
/// How long a daemon stopping to update waits for requests still open, such as the app's live
/// streams, before it exits anyway.
pub const STOP_GRACE: Duration = Duration::from_secs(3);

/// How often the daily check asks, and how soon it asks again after it could not.
const CHECK_EVERY: Duration = Duration::from_hours(24);
const RETRY_AFTER_FAILURE: Duration = Duration::from_hours(6);
/// The first check waits until the daemon has started, and then wakes hourly to see if one is due.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
const WAKE_EVERY: Duration = Duration::from_hours(1);
/// "Check now" asks GitHub at most this often; a quicker click gets the answer just fetched.
const MANUAL_GAP: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// A release's JSON is a few kilobytes; anything near this is not an answer worth reading.
const MAX_ANSWER_BYTES: usize = 1024 * 1024;
const MAX_NOTES_CHARS: usize = 20_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_COMMAND_CHARS: usize = 300;
const MAX_FAILURE_CHARS: usize = 2_000;

const UNREACHABLE: &str = "Couldn’t reach GitHub to check for a new version. Check your internet connection, then try again.";
const UNREADABLE: &str = "GitHub’s answer about the newest version could not be read.";
const RATE_LIMITED: &str =
    "GitHub asked this computer to wait before checking again. LoomWatch will try again later.";

/// A version number as `LoomWatch` releases use it: `MAJOR.MINOR.PATCH`, an optional `-pre.release`
/// and optional `+build` details, with or without a leading `v`. Ordered as Semantic Versioning
/// orders them: `0.1.10` is newer than `0.1.9`, and `0.2.0-rc.1` is older than `0.2.0`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<Identifier>,
}

/// One dot-separated part of a pre-release. Numbers sort below words, as Semantic Versioning says,
/// which is the order these variants are declared in.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Identifier {
    Number(u64),
    Word(String),
}

impl Version {
    /// `None` for anything that is not exactly a version number.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.strip_prefix('v').unwrap_or(text);
        let (text, build) = match text.split_once('+') {
            Some((text, build)) => (text, Some(build)),
            None => (text, None),
        };
        if build.is_some_and(|build| build.split('.').any(|part| !is_word(part))) {
            return None;
        }
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let mut numbers = core.split('.');
        let major = number(numbers.next()?)?;
        let minor = number(numbers.next()?)?;
        let patch = number(numbers.next()?)?;
        if numbers.next().is_some() {
            return None;
        }
        let pre = match pre {
            Some(pre) => pre.split('.').map(identifier).collect::<Option<Vec<_>>>()?,
            None => Vec::new(),
        };
        Some(Self {
            major,
            minor,
            patch,
            pre,
        })
    }
}

fn number(text: &str) -> Option<u64> {
    let leading_zero = text.len() > 1 && text.starts_with('0');
    if text.is_empty() || leading_zero || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn is_word(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn identifier(text: &str) -> Option<Identifier> {
    if text.bytes().all(|byte| byte.is_ascii_digit()) {
        number(text).map(Identifier::Number)
    } else if is_word(text) {
        Some(Identifier::Word(text.to_owned()))
    } else {
        None
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                // A release is newer than any pre-release of the same number.
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)?;
        for (index, part) in self.pre.iter().enumerate() {
            formatter.write_str(if index == 0 { "-" } else { "." })?;
            match part {
                Identifier::Number(number) => write!(formatter, "{number}")?,
                Identifier::Word(word) => formatter.write_str(word)?,
            }
        }
        Ok(())
    }
}

/// The newest published release, as the app shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// `0.1.6`, without the tag's `v`.
    pub version: String,
    pub tag: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    /// The release's page. Built from the tag here, never taken from the answer.
    pub url: String,
    /// Its notes, Markdown as written on GitHub, shortened when very long.
    pub notes: String,
}

/// The part of GitHub's release JSON this reads.
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// A release the app can show, or `None` when its tag is not a plain version number. The tag
/// ends up in a link, so it may only hold the characters a version number has.
fn release_from(answer: GitHubRelease) -> Option<Release> {
    let tag = answer.tag_name.trim();
    let version = Version::parse(tag)?;
    if !tag
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return None;
    }
    let name = answer
        .name
        .map(|name| shorten(name.trim(), MAX_NAME_CHARS))
        .filter(|name| !name.is_empty());
    let published_at = answer
        .published_at
        .and_then(|at| DateTime::parse_from_rfc3339(&at).ok())
        .map(|at| {
            at.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        });
    let notes = answer.body.unwrap_or_default().replace("\r\n", "\n");
    Some(Release {
        version: version.to_string(),
        tag: tag.to_owned(),
        name,
        published_at,
        url: format!("https://github.com/{REPOSITORY}/releases/tag/{tag}"),
        notes: shorten(notes.trim(), MAX_NOTES_CHARS),
    })
}

fn shorten(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

/// How this copy of `LoomWatch` was installed, which decides how it is updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Install {
    /// A ready-built release from `install.sh`: `loomwatch update` downloads the next one.
    Release,
    /// A copy of the source code: `./loomwatch update` pulls it with Git and builds it.
    Source,
    /// Started some other way, such as in a container: the releases page says what changed.
    Other,
}

/// What the daemon remembers between starts, in `updates.json` in its state folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
    /// The operator's choice: check once a day.
    automatic: bool,
    /// A version the operator chose not to be told about again. A newer one is told about.
    skipped: Option<String>,
    /// The last time GitHub answered, and the last time it was asked.
    checked_at: Option<DateTime<Utc>>,
    attempted_at: Option<DateTime<Utc>>,
    /// The version that made the last attempt. `None` in a file saved before this was recorded.
    checked_by: Option<String>,
    /// Why the last attempt failed, until one succeeds.
    error: Option<String>,
    latest: Option<Release>,
    /// GitHub's `ETag` for [`Saved::latest`], sent back so an unchanged answer is a cheap 304.
    etag: Option<String>,
}

impl Default for Saved {
    fn default() -> Self {
        Self {
            automatic: true,
            skipped: None,
            checked_at: None,
            attempted_at: None,
            checked_by: None,
            error: None,
            latest: None,
            etag: None,
        }
    }
}

/// `GET /api/updates`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This daemon's version.
    pub current: String,
    pub install: Install,
    /// The command that updates this copy, for a release or a copy of the source.
    pub command: Option<String>,
    /// Whether the daily check is on.
    pub automatic: bool,
    /// The setting that turned every check off on this computer, which the app cannot change.
    pub turned_off_by: Option<&'static str>,
    pub checked_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub latest: Option<Release>,
    /// The newest release is newer than this daemon.
    pub available: bool,
    pub skipped: Option<String>,
    pub releases_url: String,
    /// The app can install the newest release itself: a ready-built copy whose launcher starts it
    /// again afterwards.
    pub can_install: bool,
    /// Why the last update asked for in the app did not finish, when the launcher started this
    /// version again instead.
    pub install_error: Option<String>,
}

/// How [`Updates`] is set up. [`Updates::from_env`] reads it from the daemon's environment.
#[derive(Debug, Clone)]
pub struct Options {
    /// This daemon's version, normally `CARGO_PKG_VERSION`.
    pub current: String,
    /// The latest-release endpoint.
    pub url: String,
    /// Where the state is kept between starts; `None` keeps it in memory only.
    pub file: Option<PathBuf>,
    /// Set when a computer-wide setting turned every check off.
    pub turned_off_by: Option<&'static str>,
    pub install: Install,
    pub command: Option<String>,
    /// Where to name the release the operator chose, when a launcher that installs it and starts
    /// the daemon again is running this one ([`SUPERVISED_ENV`]).
    pub handoff: Option<PathBuf>,
    /// Why the update that launcher last tried did not finish ([`FAILED_ENV`]).
    pub install_error: Option<String>,
}

/// The update check, shared by its background task and the API.
#[derive(Clone)]
pub struct Updates {
    inner: Arc<Inner>,
}

struct Inner {
    current: Version,
    current_text: String,
    url: String,
    client: Option<reqwest::Client>,
    file: Option<PathBuf>,
    turned_off_by: Option<&'static str>,
    install: Install,
    command: Option<String>,
    saved: Mutex<Saved>,
    /// One request at a time: a click and the daily check never both ask.
    checking: tokio::sync::Mutex<()>,
    /// The version last announced in the terminal, so each is announced once.
    announced: Mutex<Option<String>>,
    handoff: Option<PathBuf>,
    install_error: Option<String>,
    /// Claimed by the first "Update and restart", so a second click never stops runs again.
    installing: AtomicBool,
    /// The version being installed, once the daemon should stop serving and exit.
    restart: tokio::sync::watch::Sender<Option<String>>,
}

enum Fetched {
    Unchanged,
    Release {
        release: Release,
        etag: Option<String>,
    },
}

impl Updates {
    /// Set up from the daemon's environment, keeping its state in `state_dir`.
    #[must_use]
    pub fn from_env(state_dir: &Path) -> Self {
        let turned_off_by = std::env::var(CHECK_ENV)
            .ok()
            .filter(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "0" | "off" | "false" | "no"
                )
            })
            .map(|_| CHECK_ENV);
        let url = match std::env::var(URL_ENV) {
            Ok(url) if allowed_url(&url) => url,
            Ok(url) => {
                eprintln!(
                    "warning: ignoring {URL_ENV}={url}: it must be https, or http on this computer"
                );
                LATEST_RELEASE.to_owned()
            }
            Err(_) => LATEST_RELEASE.to_owned(),
        };
        let install = match std::env::var(INSTALL_ENV).as_deref() {
            Ok("release") => Install::Release,
            Ok("source") => Install::Source,
            _ => Install::Other,
        };
        let command = std::env::var(COMMAND_ENV)
            .ok()
            .map(|command| command.trim().to_owned())
            .filter(|command| {
                !command.is_empty()
                    && command.chars().count() <= MAX_COMMAND_CHARS
                    && !command.chars().any(char::is_control)
            });
        let handoff = std::env::var(SUPERVISED_ENV)
            .is_ok_and(|value| value.trim() == "1")
            .then(|| std::env::var_os(REQUEST_ENV).map(PathBuf::from))
            .flatten()
            .filter(|path| path.is_absolute());
        let install_error = std::env::var(FAILED_ENV)
            .ok()
            .map(|text| failure_text(&text))
            .filter(|text| !text.is_empty());
        Self::new(Options {
            current: env!("CARGO_PKG_VERSION").to_owned(),
            url,
            file: Some(state_dir.join("updates.json")),
            turned_off_by,
            install,
            command,
            handoff,
            install_error,
        })
    }

    /// # Panics
    ///
    /// When `options.current` is not a version number, which `CARGO_PKG_VERSION` always is.
    #[must_use]
    pub fn new(options: Options) -> Self {
        let current = Version::parse(&options.current).expect("the daemon's own version parses");
        let client = reqwest::Client::builder()
            .user_agent(format!(
                "LoomWatch/{} (+https://github.com/{REPOSITORY})",
                options.current
            ))
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(3))
            .https_only(options.url.starts_with("https://"))
            .build()
            .inspect_err(|error| eprintln!("warning: update checks are unavailable: {error}"))
            .ok();
        let saved = options.file.as_deref().map(load).unwrap_or_default();
        // A command only makes sense for a copy the launcher knows how to update.
        let command = options
            .command
            .filter(|_| options.install != Install::Other);
        Self {
            inner: Arc::new(Inner {
                current,
                current_text: options.current,
                url: options.url,
                client,
                file: options.file,
                turned_off_by: options.turned_off_by,
                install: options.install,
                command,
                saved: Mutex::new(saved),
                checking: tokio::sync::Mutex::new(()),
                announced: Mutex::new(None),
                handoff: options.handoff,
                install_error: options.install_error,
                installing: AtomicBool::new(false),
                restart: tokio::sync::watch::Sender::new(None),
            }),
        }
    }

    fn saved(&self) -> std::sync::MutexGuard<'_, Saved> {
        self.inner
            .saved
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Where things stand, from what is already known. Never asks GitHub.
    #[must_use]
    pub fn status(&self) -> Status {
        let saved = self.saved().clone();
        let available = saved
            .latest
            .as_ref()
            .and_then(|latest| Version::parse(&latest.version))
            // Only finished releases: a pre-release published as one is not offered to everyone.
            .is_some_and(|latest| latest.pre.is_empty() && latest > self.inner.current);
        Status {
            current: self.inner.current_text.clone(),
            install: self.inner.install,
            command: self.inner.command.clone(),
            automatic: saved.automatic,
            turned_off_by: self.inner.turned_off_by,
            checked_at: saved.checked_at,
            error: saved.error,
            latest: saved.latest,
            available,
            skipped: saved.skipped,
            releases_url: format!("https://github.com/{REPOSITORY}/releases"),
            can_install: self.inner.install == Install::Release && self.inner.handoff.is_some(),
            install_error: self.inner.install_error.clone(),
        }
    }

    /// Resolves once the app asked to install a release, with that release's version. The daemon
    /// then stops serving and exits with [`EXIT_TO_UPDATE`].
    pub async fn restart_requested(&self) -> String {
        let mut requested = self.inner.restart.subscribe();
        // The version is copied out at once: the borrow it comes in must not be held while waiting.
        let version = requested
            .wait_for(Option::is_some)
            .await
            .map(|version| version.clone().unwrap_or_default());
        match version {
            Ok(version) => version,
            Err(_) => std::future::pending().await,
        }
    }

    /// Whether the app asked to install a release, so the daemon is stopping for the launcher.
    #[must_use]
    pub fn restarting(&self) -> bool {
        self.inner.restart.borrow().is_some()
    }

    /// Whether the daily check should ask now.
    fn due(&self, now: DateTime<Utc>) -> bool {
        if self.inner.turned_off_by.is_some() {
            return false;
        }
        let saved = self.saved();
        if !saved.automatic {
            return false;
        }
        // Another version's answer, such as the one just updated from, can predate a release that
        // came out since: ask at once rather than up to a day later.
        let checked_by = saved.checked_by.as_deref().and_then(Version::parse);
        if checked_by.as_ref() != Some(&self.inner.current) {
            return true;
        }
        let Some(attempted_at) = saved.attempted_at else {
            return true;
        };
        let wait = if saved.error.is_some() {
            RETRY_AFTER_FAILURE
        } else {
            CHECK_EVERY
        };
        // A clock set back would otherwise postpone the next check by however far it moved.
        attempted_at > now
            || (now - attempted_at)
                .to_std()
                .is_ok_and(|elapsed| elapsed >= wait)
    }

    /// Ask GitHub now, unless a check just did. Waits for a check already under way.
    pub async fn check(&self) {
        let _one_at_a_time = self.inner.checking.lock().await;
        let recently = self.saved().attempted_at.is_some_and(|at| {
            (Utc::now() - at)
                .to_std()
                .is_ok_and(|elapsed| elapsed < MANUAL_GAP)
        });
        if !recently {
            self.ask_github().await;
        }
    }

    async fn ask_github(&self) {
        let etag = {
            let saved = self.saved();
            // Without the answer it stands for, a 304 would leave nothing to show.
            saved.latest.as_ref().and(saved.etag.clone())
        };
        let outcome = self.fetch(etag).await;
        let now = Utc::now();
        {
            let mut saved = self.saved();
            saved.attempted_at = Some(now);
            saved.checked_by = Some(self.inner.current.to_string());
            match outcome {
                Ok(fetched) => {
                    if let Fetched::Release { release, etag } = fetched {
                        saved.latest = Some(release);
                        saved.etag = etag;
                    }
                    saved.checked_at = Some(now);
                    saved.error = None;
                }
                Err(message) => saved.error = Some(message.to_owned()),
            }
        }
        self.persist();
        self.announce();
    }

    async fn fetch(&self, etag: Option<String>) -> Result<Fetched, &'static str> {
        let Some(client) = &self.inner.client else {
            return Err(UNREACHABLE);
        };
        let mut request = client
            .get(&self.inner.url)
            .header(header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let mut response = request.send().await.map_err(|_| UNREACHABLE)?;
        match response.status() {
            StatusCode::OK => {}
            StatusCode::NOT_MODIFIED => return Ok(Fetched::Unchanged),
            StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => return Err(RATE_LIMITED),
            StatusCode::NOT_FOUND => {
                return Err("GitHub has no published LoomWatch release to compare with.");
            }
            _ => {
                return Err(
                    "GitHub could not say which version is the newest. LoomWatch will try again later.",
                );
            }
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|etag| etag.to_str().ok())
            .filter(|etag| etag.len() <= 200)
            .map(str::to_owned);
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ANSWER_BYTES as u64)
        {
            return Err(UNREADABLE);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| UNREACHABLE)? {
            if body.len() + chunk.len() > MAX_ANSWER_BYTES {
                return Err(UNREADABLE);
            }
            body.extend_from_slice(&chunk);
        }
        let answer: GitHubRelease = serde_json::from_slice(&body).map_err(|_| UNREADABLE)?;
        // `releases/latest` never names one, but an answer from elsewhere might.
        if answer.draft || answer.prerelease {
            return Ok(Fetched::Unchanged);
        }
        let release = release_from(answer).ok_or(UNREADABLE)?;
        Ok(Fetched::Release { release, etag })
    }

    /// Say in the daemon's terminal, once per version, that a newer one is out. The operator
    /// runs the update command in a terminal, so that is where they look.
    fn announce(&self) {
        let status = self.status();
        let Some(latest) = status.latest.filter(|_| status.available) else {
            return;
        };
        if status.skipped.as_deref() == Some(latest.version.as_str()) {
            return;
        }
        let mut announced = self
            .inner
            .announced
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if announced.as_deref() == Some(latest.version.as_str()) {
            return;
        }
        let how = match &status.command {
            Some(command) if status.can_install => format!(
                "Update it in the app with Update and restart, or stop LoomWatch and run: {command}"
            ),
            Some(command) => format!("Stop LoomWatch, then run: {command}"),
            None => format!("Get it from {}", latest.url),
        };
        println!(
            "LoomWatch {} is available (this is {}). {how}",
            latest.version, status.current
        );
        *announced = Some(latest.version);
    }

    fn persist(&self) {
        let Some(file) = &self.inner.file else {
            return;
        };
        let saved = self.saved().clone();
        let written = serde_json::to_vec_pretty(&saved)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::approvals::write_private(file, &text));
        if let Err(error) = written {
            eprintln!(
                "warning: could not save the update check in {}: {error}",
                file.display()
            );
        }
    }

    /// Check once a day while the daemon runs, starting shortly after it starts.
    pub fn spawn_checks(&self) {
        let updates = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(FIRST_CHECK_AFTER).await;
            // What an earlier start found, said again: the next check may be most of a day away.
            updates.announce();
            loop {
                if updates.due(Utc::now()) {
                    updates.check().await;
                }
                tokio::time::sleep(WAKE_EVERY).await;
            }
        });
    }

    fn change(&self, change: SettingsChange) -> Result<(), ApiError> {
        let skipped = match change.skipped {
            Skipped::Keep => None,
            Skipped::Forget => Some(None),
            Skipped::Set(version) => Some(Some(
                Version::parse(version.trim())
                    .filter(|_| version.len() <= 64)
                    .ok_or_else(|| {
                        ApiError::new(
                            StatusCode::BAD_REQUEST,
                            "skipped must be a version number".to_owned(),
                        )
                    })?
                    .to_string(),
            )),
        };
        {
            let mut saved = self.saved();
            if let Some(automatic) = change.automatic {
                saved.automatic = automatic;
            }
            if let Some(skipped) = skipped {
                saved.skipped = skipped;
            }
        }
        self.persist();
        // Turned on after a long time off: check now rather than at the next hourly wake.
        if change.automatic == Some(true) && self.due(Utc::now()) {
            let updates = self.clone();
            tokio::spawn(async move { updates.check().await });
        }
        Ok(())
    }
}

/// `https` anywhere, or `http` on this computer only, as for trying a release before publishing.
fn allowed_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.scheme() {
        "https" => parsed.host().is_some(),
        "http" => {
            matches!(parsed.host(), Some(url::Host::Domain("localhost")))
                || matches!(parsed.host(), Some(url::Host::Ipv4(ip)) if ip.is_loopback())
                || matches!(parsed.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback())
        }
        _ => false,
    }
}

/// The launcher's account of an update that did not finish, made safe to show: one paragraph of
/// plain text, cut short when long.
fn failure_text(text: &str) -> String {
    let plain: String = text
        .chars()
        .map(|character| {
            if character.is_control() && character != '\n' {
                ' '
            } else {
                character
            }
        })
        .collect();
    shorten(plain.trim(), MAX_FAILURE_CHARS)
}

/// When this daemon started, as RFC 3339 with milliseconds. It tells one start from the next: after
/// "Update and restart", the app waits for a different start to answer (`GET /api/about`).
static STARTED_AT: LazyLock<String> =
    LazyLock::new(|| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));

/// See [`STARTED_AT`]. `main` reads it first thing, so it is the daemon's start.
#[must_use]
pub fn started_at() -> &'static str {
    &STARTED_AT
}

/// The state saved by an earlier start. A file that cannot be read starts over: it holds a cache
/// and two choices, and losing it only means asking once more.
fn load(file: &Path) -> Saved {
    match std::fs::read(file) {
        Ok(text) => serde_json::from_slice(&text).unwrap_or_else(|error| {
            eprintln!(
                "warning: starting the update check over: {} could not be read: {error}",
                file.display()
            );
            Saved::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Saved::default(),
        Err(error) => {
            eprintln!(
                "warning: starting the update check over: {} could not be read: {error}",
                file.display()
            );
            Saved::default()
        }
    }
}

/// `PUT /api/updates/settings`. `skipped: null` forgets a skipped version; leaving it out keeps it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsChange {
    automatic: Option<bool>,
    #[serde(default, deserialize_with = "skipped")]
    skipped: Skipped,
}

/// What a settings change does to the skipped version.
#[derive(Debug, Default)]
enum Skipped {
    /// Left out of the change.
    #[default]
    Keep,
    /// Sent as `null`.
    Forget,
    Set(String),
}

fn skipped<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Skipped, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.map_or(Skipped::Forget, Skipped::Set))
}

/// `POST /api/updates/install`. `stopRuns` agrees to stop the teams at work.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct InstallRequest {
    stop_runs: bool,
}

/// What "Update and restart" needs beside the check: the runs it would stop.
#[derive(Clone)]
struct InstallState {
    updates: Updates,
    runs: RunRegistry,
    archive: Option<EventArchive>,
}

/// A run that updating would stop, as the confirmation names it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveRun {
    run_id: String,
    team_path: String,
    status: RunStatus,
}

impl From<RunRecord> for LiveRun {
    fn from(run: RunRecord) -> Self {
        Self {
            run_id: run.run_id,
            team_path: run.team_path,
            status: run.status,
        }
    }
}

/// `GET /api/updates`, `POST /api/updates/check`, `PUT /api/updates/settings` and
/// `POST /api/updates/install`. Loopback and this origin only, like run control: a page elsewhere
/// must not learn the version, turn the check off, or stop `LoomWatch`.
pub fn router(updates: Updates, runs: RunRegistry, archive: Option<EventArchive>) -> Router {
    let install = Router::new()
        .route("/api/updates/install", post(post_install))
        .with_state(InstallState {
            updates: updates.clone(),
            runs,
            archive,
        });
    Router::new()
        .route("/api/updates", get(get_status))
        .route("/api/updates/check", post(post_check))
        .route("/api/updates/settings", axum::routing::put(put_settings))
        .with_state(updates)
        .merge(install)
        .route_layer(middleware::from_fn(local_evidence))
}

async fn get_status(State(updates): State<Updates>) -> Json<Status> {
    Json(updates.status())
}

/// A check the operator asked for. It asks even with the daily check off, since asking is the
/// point of the click, but never when a computer-wide setting turned checks off.
async fn post_check(State(updates): State<Updates>) -> Result<Json<Status>, ApiError> {
    if let Some(setting) = updates.inner.turned_off_by {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!("Checking for new versions is turned off on this computer ({setting})."),
        ));
    }
    updates.check().await;
    Ok(Json(updates.status()))
}

async fn put_settings(
    State(updates): State<Updates>,
    Json(change): Json<SettingsChange>,
) -> Result<Json<Status>, ApiError> {
    updates.change(change)?;
    Ok(Json(updates.status()))
}

/// A refusal the app explains: `code` says which, `error` says it in words.
fn refusal(code: &str, error: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": error, "code": code })),
    )
        .into_response()
}

/// "Update and restart": name the newest release for the launcher, stop the runs the operator
/// agreed to stop, and have the daemon exit with [`EXIT_TO_UPDATE`] once this answer is sent. The
/// launcher saves the run history, installs the release and starts `LoomWatch` again.
async fn post_install(
    State(state): State<InstallState>,
    Json(request): Json<InstallRequest>,
) -> Response {
    let InstallState {
        updates,
        runs,
        archive,
    } = state;
    let status = updates.status();
    if status.install != Install::Release {
        return refusal(
            "not_release",
            "Only a ready-built LoomWatch can update itself from the app. Update this copy in its terminal.",
        );
    }
    let Some(handoff) = updates.inner.handoff.clone() else {
        let how = status.command.as_deref().map_or_else(
            || "Stop LoomWatch, then update it the way you installed it.".to_owned(),
            |command| format!("Stop LoomWatch, then run: {command}"),
        );
        return refusal(
            "not_supervised",
            &format!(
                "This LoomWatch was started in a way that cannot start it again after updating. {how}"
            ),
        );
    };
    let Some(latest) = status.latest.filter(|_| status.available) else {
        return refusal(
            "nothing_newer",
            &format!("LoomWatch {} is the newest version.", status.current),
        );
    };
    let live: Vec<LiveRun> = runs
        .list()
        .into_iter()
        .filter(|run| !run.status.is_terminal())
        .map(LiveRun::from)
        .collect();
    if !live.is_empty() && !request.stop_runs {
        let teams = if live.len() == 1 {
            "A team is working".to_owned()
        } else {
            format!("{} teams are working", live.len())
        };
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("{teams}. Updating stops {}.", if live.len() == 1 { "it" } else { "them" }),
                "code": "runs_live",
                "liveRuns": live,
            })),
        )
            .into_response();
    }
    if updates.inner.installing.swap(true, AtomicOrdering::SeqCst) {
        return refusal("updating", "LoomWatch is already updating.");
    }
    // Named before anything stops, so a launcher that cannot be told leaves every run working.
    if let Err(error) = std::fs::write(&handoff, format!("{}\n", latest.tag)) {
        updates
            .inner
            .installing
            .store(false, AtomicOrdering::SeqCst);
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "Could not tell the launcher which version to install ({}): {error}",
                handoff.display()
            ),
        )
        .into_response();
    }
    let stopped = crate::runs::cancel_live_runs(&runs, archive.as_ref()).await;
    let and_runs = match stopped.len() {
        0 => String::new(),
        1 => " and the run in progress".to_owned(),
        count => format!(" and the {count} runs in progress"),
    };
    println!(
        "Stopping LoomWatch {}{and_runs} to install {}, as asked in the app. This window starts LoomWatch again when the update is done.",
        status.current, latest.version
    );
    updates
        .inner
        .restart
        .send_replace(Some(latest.version.clone()));
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "from": status.current,
            "to": latest.version,
            "startedAt": started_at(),
            "stoppedRuns": stopped.len(),
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use axum::body::Body;
    use axum::http::{HeaderMap, Request};
    use axum::response::{IntoResponse, Response};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|| panic!("{text} should parse"))
    }

    #[test]
    fn versions_order_as_semantic_versioning_does() {
        let ordered = [
            "0.1.9",
            "v0.1.10",
            "0.2.0-alpha",
            "0.2.0-alpha.1",
            "0.2.0-alpha.beta",
            "0.2.0-beta.2",
            "0.2.0-beta.11",
            "0.2.0-rc.1",
            "0.2.0",
            "1.0.0",
        ];
        for pair in ordered.windows(2) {
            assert!(
                version(pair[0]) < version(pair[1]),
                "{} < {}",
                pair[0],
                pair[1]
            );
        }
        assert_eq!(version("v1.2.3+build.5"), version("1.2.3"));
        assert_eq!(version("v0.2.0-rc.1").to_string(), "0.2.0-rc.1");
    }

    #[test]
    fn only_exact_version_numbers_parse() {
        for text in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.3-",
            "1.2.3-01",
            "1.2.3-a..b",
            "1.2.3+",
            "1.2.x",
            " 1.2.3",
            "1.2.3-é",
            "latest",
            "v",
        ] {
            assert_eq!(Version::parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_release_link_is_built_from_a_tag_that_is_a_version() {
        let answer = |tag: &str| GitHubRelease {
            tag_name: tag.to_owned(),
            name: Some("  LoomWatch 0.1.6 ".to_owned()),
            body: Some("## What's new\r\n\r\n- Faster".to_owned()),
            published_at: Some("2026-10-07T09:30:00+02:00".to_owned()),
            draft: false,
            prerelease: false,
        };
        let release = release_from(answer("v0.1.6")).expect("a plain tag is a release");
        assert_eq!(release.version, "0.1.6");
        assert_eq!(
            release.url,
            "https://github.com/tnghia903/loomwatch/releases/tag/v0.1.6"
        );
        assert_eq!(release.name.as_deref(), Some("LoomWatch 0.1.6"));
        assert_eq!(
            release.published_at.as_deref(),
            Some("2026-10-07T07:30:00Z")
        );
        assert_eq!(release.notes, "## What's new\n\n- Faster");
        for tag in ["v0.1.6/../../evil", "v0.1.6?x=1", "v0.1.6#x", "nightly", ""] {
            assert!(release_from(answer(tag)).is_none(), "{tag:?}");
        }
    }

    #[test]
    fn long_notes_are_shortened_on_a_character_boundary() {
        let notes = "é".repeat(MAX_NOTES_CHARS + 5);
        let shortened = shorten(&notes, MAX_NOTES_CHARS);
        assert_eq!(shortened.chars().count(), MAX_NOTES_CHARS + 1);
        assert!(shortened.ends_with('…'));
    }

    #[test]
    fn only_https_or_this_computers_http_may_stand_in_for_github() {
        assert!(allowed_url("https://example.test/latest"));
        assert!(allowed_url("http://127.0.0.1:8765/latest"));
        assert!(allowed_url("http://localhost:8765/latest"));
        assert!(allowed_url("http://[::1]:8765/latest"));
        assert!(!allowed_url("http://example.test/latest"));
        assert!(!allowed_url("http://192.168.1.4/latest"));
        assert!(!allowed_url("file:///etc/passwd"));
        assert!(!allowed_url("not a url"));
    }

    /// A stand-in for GitHub's latest-release endpoint, counting what it was asked.
    #[derive(Clone)]
    struct FakeGitHub {
        answer: Arc<Mutex<(StatusCode, HeaderMap, String)>>,
        requests: Arc<AtomicUsize>,
        last_headers: Arc<Mutex<HeaderMap>>,
    }

    impl FakeGitHub {
        fn answer(&self, status: StatusCode, etag: Option<&str>, body: &str) {
            let mut headers = HeaderMap::new();
            if let Some(etag) = etag {
                headers.insert(header::ETAG, etag.parse().unwrap());
            }
            *self.answer.lock().unwrap() = (status, headers, body.to_owned());
        }

        fn requests(&self) -> usize {
            self.requests.load(AtomicOrdering::SeqCst)
        }

        fn last_header(&self, name: header::HeaderName) -> Option<String> {
            self.last_headers
                .lock()
                .unwrap()
                .get(name)
                .map(|value| value.to_str().unwrap().to_owned())
        }
    }

    async fn fake_github() -> (FakeGitHub, String) {
        let fake = FakeGitHub {
            answer: Arc::new(Mutex::new((
                StatusCode::OK,
                HeaderMap::new(),
                String::new(),
            ))),
            requests: Arc::default(),
            last_headers: Arc::default(),
        };
        let serving = fake.clone();
        let app = Router::new().route(
            "/latest",
            get(move |headers: HeaderMap| {
                let fake = serving.clone();
                async move {
                    fake.requests.fetch_add(1, AtomicOrdering::SeqCst);
                    let (status, answer_headers, body) = fake.answer.lock().unwrap().clone();
                    let matched = headers
                        .get(header::IF_NONE_MATCH)
                        .is_some_and(|sent| Some(sent) == answer_headers.get(header::ETAG));
                    *fake.last_headers.lock().unwrap() = headers;
                    let response: Response = if matched {
                        StatusCode::NOT_MODIFIED.into_response()
                    } else {
                        (status, answer_headers, body).into_response()
                    };
                    response
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (fake, format!("http://{address}/latest"))
    }

    fn release_json(tag: &str) -> String {
        json!({
            "tag_name": tag,
            "name": format!("LoomWatch {tag}"),
            "body": "- Something new",
            "published_at": "2026-10-07T07:30:00Z",
            "html_url": "https://evil.test/not-used",
            "draft": false,
            "prerelease": false,
        })
        .to_string()
    }

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-updates-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn options(url: &str, file: Option<PathBuf>) -> Options {
        Options {
            current: "0.1.5".to_owned(),
            url: url.to_owned(),
            file,
            turned_off_by: None,
            install: Install::Release,
            command: Some("loomwatch update".to_owned()),
            handoff: None,
            install_error: None,
        }
    }

    fn updates(url: &str, file: Option<PathBuf>) -> Updates {
        Updates::new(options(url, file))
    }

    /// The API around `updates`, with no runs.
    fn api(updates: Updates) -> Router {
        router(updates, RunRegistry::default(), None)
    }

    /// A check the gap would otherwise skip: as if the last one was long ago.
    fn forget_last_attempt(updates: &Updates) {
        updates.saved().attempted_at = Some(Utc::now() - chrono::Duration::days(2));
    }

    #[tokio::test]
    async fn a_newer_release_is_available_and_an_unchanged_answer_is_not_downloaded_again() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, Some("\"one\""), &release_json("v0.1.6"));
        let updates = updates(&url, None);
        assert!(updates.due(Utc::now()), "never checked, so a check is due");

        updates.check().await;
        let status = updates.status();
        assert!(status.available);
        assert_eq!(status.error, None);
        let latest = status.latest.expect("the release was read");
        assert_eq!(latest.version, "0.1.6");
        assert_eq!(
            latest.url, "https://github.com/tnghia903/loomwatch/releases/tag/v0.1.6",
            "the link is built from the tag, never taken from the answer"
        );
        assert_eq!(status.command.as_deref(), Some("loomwatch update"));
        assert!(
            github
                .last_header(header::USER_AGENT)
                .is_some_and(|agent| agent.starts_with("LoomWatch/0.1.5")),
            "GitHub wants a User-Agent, and it says only the version"
        );
        assert!(!updates.due(Utc::now()), "checked just now");

        forget_last_attempt(&updates);
        assert!(updates.due(Utc::now()), "a day later, a check is due again");
        updates.check().await;
        assert_eq!(github.requests(), 2);
        assert_eq!(
            github.last_header(header::IF_NONE_MATCH).as_deref(),
            Some("\"one\""),
            "the ETag is sent back, so an unchanged answer is a 304"
        );
        assert_eq!(
            updates
                .status()
                .latest
                .map(|latest| latest.version)
                .as_deref(),
            Some("0.1.6")
        );
    }

    #[tokio::test]
    async fn the_same_or_an_older_release_is_not_an_update() {
        let (github, url) = fake_github().await;
        for (tag, available) in [
            ("v0.1.5", false),
            ("v0.1.4", false),
            ("v0.1.6-rc.1", false),
            ("v0.2.0", true),
        ] {
            github.answer(StatusCode::OK, None, &release_json(tag));
            let updates = updates(&url, None);
            updates.check().await;
            assert_eq!(updates.status().available, available, "{tag}");
        }
    }

    #[tokio::test]
    async fn failures_are_explained_and_retried_sooner_without_losing_what_was_known() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, Some("\"one\""), &release_json("v0.1.6"));
        let updates = updates(&url, None);
        updates.check().await;

        for (status, body, expected) in [
            (StatusCode::FORBIDDEN, "{}".to_owned(), RATE_LIMITED),
            (StatusCode::TOO_MANY_REQUESTS, "{}".to_owned(), RATE_LIMITED),
            (StatusCode::OK, "not json".to_owned(), UNREADABLE),
            (StatusCode::OK, "x".repeat(MAX_ANSWER_BYTES + 1), UNREADABLE),
            (StatusCode::OK, release_json("nightly"), UNREADABLE),
        ] {
            github.answer(status, None, &body);
            forget_last_attempt(&updates);
            updates.check().await;
            let shown = updates.status();
            assert_eq!(shown.error.as_deref(), Some(expected), "{status}");
            assert_eq!(
                shown.latest.map(|latest| latest.version).as_deref(),
                Some("0.1.6"),
                "a failed check keeps the release already known"
            );
        }

        // Retried after hours, not the next day.
        let now = Utc::now();
        updates.saved().attempted_at = Some(now - chrono::Duration::hours(5));
        assert!(!updates.due(now));
        updates.saved().attempted_at = Some(now - chrono::Duration::hours(7));
        assert!(updates.due(now));
        // A clock set back does not postpone the check.
        updates.saved().attempted_at = Some(now + chrono::Duration::days(3));
        assert!(updates.due(now));
    }

    #[tokio::test]
    async fn an_update_asks_again_at_once_instead_of_trusting_the_old_versions_answer() {
        let (github, url) = fake_github().await;
        let folder = TempDirectory::new();
        let file = folder.0.join("updates.json");

        // 0.1.4 checked two hours ago and was the newest.
        github.answer(StatusCode::OK, Some("\"old\""), &release_json("v0.1.4"));
        let old = Updates::new(Options {
            current: "0.1.4".to_owned(),
            ..options(&url, Some(file.clone()))
        });
        old.check().await;
        old.saved().attempted_at = Some(Utc::now() - chrono::Duration::hours(2));
        old.persist();
        assert!(!old.due(Utc::now()), "0.1.4 checked within the day");

        // Since then 0.1.6 came out, and the operator updated to 0.1.5.
        github.answer(StatusCode::OK, Some("\"new\""), &release_json("v0.1.6"));
        let updated = updates(&url, Some(file.clone()));
        assert!(!updated.status().available, "0.1.4's answer predates 0.1.6");
        assert!(
            updated.due(Utc::now()),
            "another version's check is due at once"
        );
        updated.check().await;
        assert!(updated.status().available);
        assert_eq!(github.requests(), 2);

        let restarted = updates(&url, Some(file.clone()));
        assert!(
            !restarted.due(Utc::now()),
            "this version checked within the day"
        );
        assert!(restarted.due(Utc::now() + chrono::Duration::days(1)));

        // A file saved before the version was recorded counts as another version's.
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["checkedBy"], "0.1.5");
        saved.as_object_mut().unwrap().remove("checkedBy");
        std::fs::write(&file, saved.to_string()).unwrap();
        assert!(updates(&url, Some(file)).due(Utc::now()));
    }

    #[tokio::test]
    async fn unreachable_github_is_said_plainly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/latest", listener.local_addr().unwrap());
        drop(listener);
        let updates = updates(&url, None);
        updates.check().await;
        assert_eq!(updates.status().error.as_deref(), Some(UNREACHABLE));
        assert!(!updates.status().available);
    }

    #[tokio::test]
    async fn a_draft_or_pre_release_answer_is_not_offered() {
        let (github, url) = fake_github().await;
        let mut answer: Value = serde_json::from_str(&release_json("v0.2.0")).unwrap();
        answer["prerelease"] = json!(true);
        github.answer(StatusCode::OK, None, &answer.to_string());
        let updates = updates(&url, None);
        updates.check().await;
        let status = updates.status();
        assert_eq!(status.latest, None);
        assert_eq!(status.error, None);
    }

    #[tokio::test]
    async fn clicks_close_together_ask_github_once() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, None, &release_json("v0.1.6"));
        let updates = updates(&url, None);
        tokio::join!(updates.check(), updates.check(), updates.check());
        updates.check().await;
        assert_eq!(github.requests(), 1);
    }

    #[tokio::test]
    async fn choices_and_the_last_answer_survive_a_restart() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, Some("\"one\""), &release_json("v0.1.6"));
        let folder = TempDirectory::new();
        let file = folder.0.join("updates.json");
        let first = updates(&url, Some(file.clone()));
        first.check().await;
        first
            .change(SettingsChange {
                automatic: Some(false),
                skipped: Skipped::Set("v0.1.6".to_owned()),
            })
            .unwrap();

        let second = updates(&url, Some(file.clone()));
        let status = second.status();
        assert!(!status.automatic);
        assert_eq!(status.skipped.as_deref(), Some("0.1.6"));
        assert_eq!(
            status.latest.map(|latest| latest.version).as_deref(),
            Some("0.1.6")
        );
        assert!(
            !second.due(Utc::now() + chrono::Duration::days(30)),
            "the daily check is off"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // Leaving `skipped` out keeps it; `null` forgets it.
        second
            .change(SettingsChange {
                automatic: Some(true),
                skipped: Skipped::Keep,
            })
            .unwrap();
        assert_eq!(second.status().skipped.as_deref(), Some("0.1.6"));
        second
            .change(SettingsChange {
                automatic: None,
                skipped: Skipped::Forget,
            })
            .unwrap();
        assert_eq!(second.status().skipped, None);

        std::fs::write(&file, "{ not json").unwrap();
        let third = updates(&url, Some(file));
        assert!(third.status().automatic, "an unreadable file starts over");
    }

    async fn call(
        router: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:3000");
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let request = request
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn the_api_reports_checks_and_saves_choices() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, None, &release_json("v0.1.6"));
        let router = api(updates(&url, None));

        let (status, before) = call(&router, "GET", "/api/updates", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(before["current"], "0.1.5");
        assert_eq!(before["install"], "release");
        assert_eq!(before["available"], false);
        assert_eq!(before["latest"], Value::Null);
        assert_eq!(github.requests(), 0, "reading the status never asks GitHub");

        let (status, checked) = call(&router, "POST", "/api/updates/check", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(checked["available"], true);
        assert_eq!(checked["latest"]["version"], "0.1.6");
        assert_eq!(checked["latest"]["notes"], "- Something new");

        let (status, saved) = call(
            &router,
            "PUT",
            "/api/updates/settings",
            Some(json!({ "automatic": false, "skipped": "0.1.6" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["automatic"], false);
        assert_eq!(saved["skipped"], "0.1.6");

        for wrong in [
            json!({ "skipped": "soon" }),
            json!({ "automatic": "yes" }),
            json!({ "other": 1 }),
        ] {
            let (status, _) =
                call(&router, "PUT", "/api/updates/settings", Some(wrong.clone())).await;
            assert!(status.is_client_error(), "{wrong}");
        }
    }

    #[tokio::test]
    async fn a_computer_wide_setting_turns_every_check_off() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, None, &release_json("v0.1.6"));
        let updates = Updates::new(Options {
            current: "0.1.5".to_owned(),
            url,
            file: None,
            turned_off_by: Some(CHECK_ENV),
            install: Install::Other,
            command: Some("loomwatch update".to_owned()),
            handoff: None,
            install_error: None,
        });
        assert!(!updates.due(Utc::now()));
        let router = api(updates);
        let (status, body) = call(&router, "POST", "/api/updates/check", None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"].as_str().unwrap().contains(CHECK_ENV));
        let (_, shown) = call(&router, "GET", "/api/updates", None).await;
        assert_eq!(shown["turnedOffBy"], CHECK_ENV);
        assert_eq!(
            shown["command"],
            Value::Null,
            "a copy started another way has no command"
        );
        assert_eq!(github.requests(), 0);
    }

    #[tokio::test]
    async fn another_site_cannot_read_or_change_it() {
        let router = api(updates("http://127.0.0.1:9/latest", None));
        let request = Request::builder()
            .method("PUT")
            .uri("/api/updates/settings")
            .header(header::HOST, "127.0.0.1:3000")
            .header(header::ORIGIN, "https://evil.test")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"automatic":false}"#))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let (_, shown) = call(&router, "GET", "/api/updates", None).await;
        assert_eq!(shown["automatic"], true);
    }

    /// A copy as `./loomwatch` starts a ready-built one: it names the release in `handoff`.
    async fn supervised(url: &str, handoff: &Path, install: Install) -> Updates {
        let updates = Updates::new(Options {
            install,
            handoff: Some(handoff.to_path_buf()),
            ..options(url, None)
        });
        updates.check().await;
        updates
    }

    fn live_run(team: &str) -> RunRecord {
        serde_json::from_value(json!({
            "runId": uuid::Uuid::new_v4().to_string(),
            "sessionId": "s",
            "teamPath": team,
            "prompt": "plan the trip",
            "status": "running",
            "mode": "team",
            "entrypoint": "a",
            "responder": "a",
            "agentIds": ["a"],
            "createdAt": "2026-10-07T07:30:00.000Z",
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn install_is_refused_unless_a_launcher_can_install_something_newer() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, None, &release_json("v0.1.6"));
        let folder = TempDirectory::new();
        let handoff = folder.0.join("update-request");

        // A copy of the source code is rebuilt in its terminal, never from the app.
        let source = supervised(&url, &handoff, Install::Source).await;
        assert!(!source.status().can_install);
        let (status, body) = call(
            &api(source.clone()),
            "POST",
            "/api/updates/install",
            Some(json!({})),
        )
        .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (StatusCode::CONFLICT, Some("not_release")),
            "{body}"
        );

        // A ready-built copy started without the launcher that would start it again.
        let alone = Updates::new(options(&url, None));
        alone.check().await;
        assert!(alone.status().available);
        assert!(!alone.status().can_install);
        let (status, body) = call(
            &api(alone.clone()),
            "POST",
            "/api/updates/install",
            Some(json!({})),
        )
        .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (StatusCode::CONFLICT, Some("not_supervised")),
            "{body}"
        );
        assert!(
            body["error"].as_str().unwrap().contains("loomwatch update"),
            "it says what to do instead: {body}"
        );

        // Nothing newer: the same release, or none known yet.
        github.answer(StatusCode::OK, None, &release_json("v0.1.5"));
        let newest = supervised(&url, &handoff, Install::Release).await;
        assert!(newest.status().can_install);
        let (status, body) = call(
            &api(newest.clone()),
            "POST",
            "/api/updates/install",
            Some(json!({})),
        )
        .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (StatusCode::CONFLICT, Some("nothing_newer")),
            "{body}"
        );
        let unchecked = Updates::new(Options {
            handoff: Some(handoff.clone()),
            ..options(&url, None)
        });
        let (status, body) = call(
            &api(unchecked.clone()),
            "POST",
            "/api/updates/install",
            Some(json!({})),
        )
        .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (StatusCode::CONFLICT, Some("nothing_newer")),
            "{body}"
        );

        for refused in [&source, &alone, &newest, &unchecked] {
            assert!(!refused.restarting());
        }
        assert!(!handoff.exists(), "no release was named for the launcher");
    }

    #[tokio::test]
    async fn install_asks_before_stopping_runs_then_hands_the_release_to_the_launcher() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, None, &release_json("v0.1.6"));
        let folder = TempDirectory::new();
        let handoff = folder.0.join("update-request");
        let updates = supervised(&url, &handoff, Install::Release).await;
        let runs = RunRegistry::default();
        let working = live_run("trips/japan.yaml");
        runs.insert(working.clone());
        let mut finished = live_run("digest.yaml");
        finished.status = RunStatus::Succeeded;
        runs.insert(finished);
        let router = router(updates.clone(), runs.clone(), None);

        let (status, body) = call(&router, "POST", "/api/updates/install", Some(json!({}))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "runs_live");
        assert_eq!(body["error"], "A team is working. Updating stops it.");
        assert_eq!(
            body["liveRuns"],
            json!([{ "runId": working.run_id, "teamPath": "trips/japan.yaml", "status": "running" }]),
            "only the run still working is named"
        );
        assert_eq!(
            runs.get(&working.run_id).unwrap().status,
            RunStatus::Running
        );
        assert!(!handoff.exists());
        assert!(!updates.restarting());

        for wrong in [json!({ "stopRuns": "yes" }), json!({ "other": true })] {
            let (status, _) =
                call(&router, "POST", "/api/updates/install", Some(wrong.clone())).await;
            assert!(status.is_client_error(), "{wrong}");
        }
        assert!(!updates.restarting());

        let (status, body) = call(
            &router,
            "POST",
            "/api/updates/install",
            Some(json!({ "stopRuns": true })),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(body["from"], "0.1.5");
        assert_eq!(body["to"], "0.1.6");
        assert_eq!(body["stoppedRuns"], 1);
        assert_eq!(body["startedAt"], started_at());
        assert_eq!(
            std::fs::read_to_string(&handoff).unwrap(),
            "v0.1.6\n",
            "the launcher installs exactly the release whose notes were shown"
        );
        assert_eq!(
            runs.get(&working.run_id).unwrap().status,
            RunStatus::Cancelled
        );
        assert!(updates.restarting());
        let version = tokio::time::timeout(Duration::from_secs(1), updates.restart_requested())
            .await
            .expect("the daemon is told to stop");
        assert_eq!(version, "0.1.6");

        // A second click never stops anything again.
        let (status, body) = call(
            &router,
            "POST",
            "/api/updates/install",
            Some(json!({ "stopRuns": true })),
        )
        .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (StatusCode::CONFLICT, Some("updating")),
            "{body}"
        );
    }

    #[tokio::test]
    async fn install_stops_nothing_when_the_launcher_cannot_be_told() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, None, &release_json("v0.1.6"));
        let folder = TempDirectory::new();
        let updates = supervised(
            &url,
            &folder.0.join("gone/update-request"),
            Install::Release,
        )
        .await;
        let runs = RunRegistry::default();
        let working = live_run("trip.yaml");
        runs.insert(working.clone());
        let router = router(updates.clone(), runs.clone(), None);
        let (status, body) = call(
            &router,
            "POST",
            "/api/updates/install",
            Some(json!({ "stopRuns": true })),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("Could not tell the launcher")
        );
        assert_eq!(
            runs.get(&working.run_id).unwrap().status,
            RunStatus::Running
        );
        assert!(!updates.restarting());
    }

    #[tokio::test]
    async fn another_site_cannot_stop_loomwatch_to_update_it() {
        let (github, url) = fake_github().await;
        github.answer(StatusCode::OK, None, &release_json("v0.1.6"));
        let folder = TempDirectory::new();
        let handoff = folder.0.join("update-request");
        let updates = supervised(&url, &handoff, Install::Release).await;
        let router = api(updates.clone());
        for (name, value) in [
            (header::ORIGIN, "https://evil.test"),
            (
                header::HeaderName::from_static("sec-fetch-site"),
                "cross-site",
            ),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/api/updates/install")
                .header(header::HOST, "127.0.0.1:3000")
                .header(name.clone(), value)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"stopRuns":true}"#))
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{name}: {value}");
        }
        // Nor through a name that only resolves here.
        let request = Request::builder()
            .method("POST")
            .uri("/api/updates/install")
            .header(header::HOST, "attacker.example")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            router.oneshot(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        assert!(!updates.restarting());
        assert!(!handoff.exists());
    }

    #[tokio::test]
    async fn the_launchers_account_of_a_failed_update_is_shown_as_plain_text() {
        let updates = Updates::new(Options {
            install_error: Some(failure_text(
                "  the download did not finish,\u{1b}[1m and LoomWatch 0.1.5\twas left as it was.\nThe messages above say why.  ",
            )),
            ..options("http://127.0.0.1:9/latest", None)
        });
        assert_eq!(
            updates.status().install_error.as_deref(),
            Some(
                "the download did not finish, [1m and LoomWatch 0.1.5 was left as it was.\nThe messages above say why."
            )
        );
        let (_, shown) = call(&api(updates), "GET", "/api/updates", None).await;
        assert!(
            shown["installError"]
                .as_str()
                .unwrap()
                .starts_with("the download")
        );
        assert_eq!(shown["canInstall"], false);
        assert_eq!(
            failure_text(&"x".repeat(MAX_FAILURE_CHARS + 9))
                .chars()
                .count(),
            MAX_FAILURE_CHARS + 1
        );
    }
}
