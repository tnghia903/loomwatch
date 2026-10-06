//! New versions of `LoomWatch` (ADR 0052): whether one was released, what changed in it, and how
//! to install it.
//!
//! Once a day the daemon asks GitHub for the newest published release and compares its version
//! with its own. The request carries nothing about the operator: one `GET` naming this version in
//! its `User-Agent`, plus the `ETag` of the answer already held, so an unchanged answer costs
//! nothing against GitHub's hourly limit. The operator can turn the daily check off in the app,
//! and `LOOMWATCH_UPDATE_CHECK=off` turns every check off on this computer.
//!
//! Installing stays the operator's own step, in the terminal: `loomwatch update` stops nothing
//! without asking, backs the database up, and keeps the version it replaces for
//! `loomwatch rollback`. The daemon only says that a new version exists and which command to run.

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::middleware;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};

use crate::api::ApiError;
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
        Self::new(Options {
            current: env!("CARGO_PKG_VERSION").to_owned(),
            url,
            file: Some(state_dir.join("updates.json")),
            turned_off_by,
            install,
            command,
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
        }
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

/// `GET /api/updates`, `POST /api/updates/check` and `PUT /api/updates/settings`. Loopback and
/// this origin only, like run control: a page elsewhere must not learn the version or turn the
/// check off.
pub fn router(updates: Updates) -> Router {
    Router::new()
        .route("/api/updates", get(get_status))
        .route("/api/updates/check", post(post_check))
        .route("/api/updates/settings", axum::routing::put(put_settings))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(updates)
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

    fn updates(url: &str, file: Option<PathBuf>) -> Updates {
        Updates::new(Options {
            current: "0.1.5".to_owned(),
            url: url.to_owned(),
            file,
            turned_off_by: None,
            install: Install::Release,
            command: Some("loomwatch update".to_owned()),
        })
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
        let router = router(updates(&url, None));

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
        });
        assert!(!updates.due(Utc::now()));
        let router = router(updates);
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
        let router = router(updates("http://127.0.0.1:9/latest", None));
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
}
