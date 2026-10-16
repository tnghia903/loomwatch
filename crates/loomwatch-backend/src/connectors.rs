//! `LoomWatch`'s own copy of the Node-based ACP bridges that start Claude Code and Codex.
//!
//! Both bridges are Node programs. Started as `npx -y <package>@<version>`, every agent start paid
//! for npm resolving the package (about a second, measured 2026-10-16) and kept an npm process
//! alive beside the bridge (about 140 MB per agent), and a computer without Node.js could not
//! start either app at all. Instead, each bridge is installed once, from a lockfile shipped with
//! `LoomWatch`, into the state folder, and started directly with Node.
//!
//! Team files keep saying `npx -y <package>@<version>`, so they stay portable and the review gate
//! (ADR 0048) still reads the command it always did: the swap happens only when an agent starts,
//! in [`Connectors::resolve`].
//!
//! Node.js comes from `LoomWatch`'s own download when there is one, then from the computer when it
//! has Node.js 22 or newer with npm beside it, and otherwise from nodejs.org, checked against a
//! checksum pinned here.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One bridge `LoomWatch` installs itself.
#[derive(Debug)]
struct Bridge {
    /// The harness id in `api::HARNESSES`.
    app: &'static str,
    /// The app's name, for sentences the UI shows.
    name: &'static str,
    /// The npm package, as team files name it after `npx -y`.
    package: &'static str,
    version: &'static str,
    /// The script the package's `bin` names, relative to the package folder.
    entry: &'static str,
    manifest: &'static str,
    lockfile: &'static str,
    /// Where the app itself sits under `node_modules`: each bridge's packages carry their own
    /// Claude Code or Codex program. `*` matches the one platform folder npm installed.
    engine: &'static [&'static str],
}

const BRIDGES: &[Bridge] = &[
    Bridge {
        app: "claude",
        name: "Claude",
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.85.1",
        entry: "dist/index.js",
        manifest: include_str!("../connectors/claude/package.json"),
        lockfile: include_str!("../connectors/claude/package-lock.json"),
        engine: &["@anthropic-ai", "claude-agent-sdk-*", "claude"],
    },
    Bridge {
        app: "codex",
        name: "Codex",
        package: "@agentclientprotocol/codex-acp",
        version: "2.1.1",
        entry: "dist/index.js",
        manifest: include_str!("../connectors/codex/package.json"),
        lockfile: include_str!("../connectors/codex/package-lock.json"),
        engine: &["@openai", "codex-*", "vendor", "*", "bin", "codex"],
    },
];

/// The Node.js `LoomWatch` downloads when the computer has none it can use: the newest Node 24 LTS
/// release that was at least a month old when it was pinned.
const NODE_VERSION: &str = "24.21.0";
/// The oldest Node.js both bridges run on (their `engines` ask for 22 or newer).
const NODE_MIN_MAJOR: u64 = 22;
const NODE_DIST: &str = "https://nodejs.org/dist";
/// How long one `npm ci` may take before it is given up as stuck.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const MARKER: &str = "loomwatch-ready.json";

/// How nodejs.org packs a build for this computer: a zip for Windows, a gzipped tarball elsewhere.
const NODE_ARCHIVE: &str = if cfg!(windows) { "zip" } else { "tar.gz" };

/// The nodejs.org build for this computer and its SHA-256, from that release's `SHASUMS256.txt`.
fn node_build() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some((
            "darwin-arm64",
            "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
        )),
        ("macos", "x86_64") => Some((
            "darwin-x64",
            "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
        )),
        ("linux", "aarch64") => Some((
            "linux-arm64",
            "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
        )),
        ("linux", "x86_64") => Some((
            "linux-x64",
            "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
        )),
        // Windows builds come as .zip (see [`NODE_ARCHIVE`]).
        ("windows", "x86_64") => Some((
            "win-x64",
            "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
        )),
        ("windows", "aarch64") => Some((
            "win-arm64",
            "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
        )),
        _ => None,
    }
}

/// Where one app's connector stands, as `/api/harnesses` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConnectorStatus {
    /// Installed: agents start directly with Node.
    Ready,
    /// Not installed, and nothing is installing it.
    Needed,
    /// Being installed now. `step` says what is happening, in words the UI can show.
    Preparing { step: String },
    /// The last attempt failed. `reason` says why, in words the UI can show.
    Failed { reason: String },
}

/// How to start an agent's `spawn` command.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
    /// Start `program` with `args` instead, with `node_dir` first on its `PATH`.
    Direct {
        program: PathBuf,
        args: Vec<String>,
        node_dir: PathBuf,
    },
    /// A bridge `LoomWatch` installs itself, but not yet.
    NotReady {
        app: &'static str,
        name: &'static str,
    },
    /// Not a bridge `LoomWatch` installs: start it as written.
    AsWritten,
}

/// What a finished install records, so a start can check it with two file lookups.
#[derive(Debug, Serialize, Deserialize)]
struct Marker {
    node: PathBuf,
}

/// A Node.js that can install packages: the program and npm's own script.
#[derive(Debug, Clone)]
struct NodeProgram {
    node: PathBuf,
    npm_cli: PathBuf,
}

/// The connectors kept in one state folder.
#[derive(Debug)]
pub struct Connectors {
    root: PathBuf,
    /// The `PATH` the daemon started with, plus the per-user install folders: where the computer's
    /// own Node.js and npx are looked for.
    search_path: Option<OsString>,
    node_dist: String,
    /// Only the in-between states: `Ready` and `Needed` are read from the disk.
    progress: Mutex<HashMap<&'static str, ConnectorStatus>>,
    /// One install at a time, so two apps never download Node.js twice.
    installing: tokio::sync::Mutex<()>,
}

static CONNECTORS: OnceLock<Connectors> = OnceLock::new();

/// Keep connectors in `state_dir` for the rest of this process. The first call wins.
pub fn init(state_dir: &Path) -> &'static Connectors {
    CONNECTORS.get_or_init(|| {
        // The per-user folders too: Node.js and npx installed there count, as apps there do.
        let home = crate::platform::home_dir();
        let search_path =
            crate::api::augment_search_path(std::env::var_os("PATH"), home.as_deref());
        Connectors::new(state_dir.join("connectors"), search_path)
    })
}

/// The connectors [`init`] set up, or `None` in a process that never did (the CLI and tests).
#[must_use]
pub fn installed() -> Option<&'static Connectors> {
    CONNECTORS.get()
}

fn bridge_for(app: &str) -> Option<&'static Bridge> {
    BRIDGES.iter().find(|bridge| bridge.app == app)
}

/// The bridge `npx -y <package>` or `npx -y <package>@<its pinned version>` starts. Any other
/// version is what someone asked for on purpose, so it is started as written.
fn requested_bridge(cmd: &str, args: &[String]) -> Option<&'static Bridge> {
    let program = Path::new(cmd);
    // On Windows also `npx.cmd`, the npx a search of the PATH finds there.
    let npx = if cfg!(windows) {
        program
            .file_stem()
            .is_some_and(|stem| stem.eq_ignore_ascii_case("npx"))
            && program.extension().is_none_or(|extension| {
                ["cmd", "exe", "bat"]
                    .iter()
                    .any(|known| extension.eq_ignore_ascii_case(known))
            })
    } else {
        program.file_name() == Some(OsStr::new("npx"))
    };
    if !npx {
        return None;
    }
    let [flag, requested] = args else {
        return None;
    };
    if !matches!(flag.as_str(), "-y" | "--yes") {
        return None;
    }
    BRIDGES.iter().find(|bridge| {
        requested == bridge.package
            || requested
                .strip_prefix(bridge.package)
                .and_then(|rest| rest.strip_prefix('@'))
                == Some(bridge.version)
    })
}

impl Connectors {
    fn new(root: PathBuf, search_path: Option<OsString>) -> Self {
        Self {
            root,
            search_path,
            node_dist: NODE_DIST.to_owned(),
            progress: Mutex::new(HashMap::new()),
            installing: tokio::sync::Mutex::new(()),
        }
    }

    /// The folder `bridge` is installed in, named for its lockfile so a `LoomWatch` that pins
    /// another version installs beside it instead of over it.
    fn dir(&self, bridge: &Bridge) -> PathBuf {
        let digest = Sha256::digest(bridge.lockfile.as_bytes());
        let short = hex(&digest[..4]);
        self.root
            .join(format!("{}-{}-{short}", bridge.app, bridge.version))
    }

    /// The Node program and script that start `bridge`, when it is installed and both still exist.
    fn ready(&self, bridge: &Bridge) -> Option<(PathBuf, PathBuf)> {
        let dir = self.dir(bridge);
        let marker: Marker = serde_json::from_slice(&std::fs::read(dir.join(MARKER)).ok()?).ok()?;
        let entry = entry_script(&dir, bridge);
        (marker.node.is_file() && entry.is_file()).then_some((marker.node, entry))
    }

    /// The app's own program, as its installed connector carries it: what a computer without
    /// Claude Code or Codex installed signs in with and is listed by.
    #[must_use]
    pub fn engine(&self, app: &str) -> Option<PathBuf> {
        let bridge = bridge_for(app)?;
        self.ready(bridge)?;
        let mut found = self.dir(bridge).join("node_modules");
        for segment in bridge.engine {
            found = match segment.split_once('*') {
                None => found.join(segment),
                Some((prefix, suffix)) => std::fs::read_dir(&found)
                    .ok()?
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .and_then(OsStr::to_str)
                            .is_some_and(|name| name.starts_with(prefix) && name.ends_with(suffix))
                    })
                    .min()?,
            };
        }
        // `claude.exe` and `codex.exe` on Windows.
        crate::platform::program_candidates(&found)
            .into_iter()
            .find(|candidate| candidate.is_file())
    }

    /// The apps that have a connector, and where each stands: what the Home panel shows for an
    /// app that isn't on this computer yet.
    #[must_use]
    pub fn all_status(&self) -> Vec<(&'static str, ConnectorStatus)> {
        BRIDGES
            .iter()
            .filter_map(|bridge| Some((bridge.app, self.status(bridge.app)?)))
            .collect()
    }

    /// Where `app`'s connector stands, or `None` for an app that needs none.
    #[must_use]
    pub fn status(&self, app: &str) -> Option<ConnectorStatus> {
        let bridge = bridge_for(app)?;
        if self.ready(bridge).is_some() {
            return Some(ConnectorStatus::Ready);
        }
        Some(
            self.lock_progress()
                .get(bridge.app)
                .cloned()
                .unwrap_or(ConnectorStatus::Needed),
        )
    }

    /// How to start `cmd args`: directly with Node when it is `npx -y` of an installed bridge.
    #[must_use]
    pub fn resolve(&self, cmd: &str, args: &[String]) -> Resolved {
        let Some(bridge) = requested_bridge(cmd, args) else {
            return Resolved::AsWritten;
        };
        match self.ready(bridge) {
            Some((node, entry)) => Resolved::Direct {
                node_dir: node.parent().map(Path::to_path_buf).unwrap_or_default(),
                program: node,
                args: vec![entry.to_string_lossy().into_owned()],
            },
            None => Resolved::NotReady {
                app: bridge.app,
                name: bridge.name,
            },
        }
    }

    /// Whether `npx` is on the `PATH` the daemon started with: a start can still go that way while
    /// the connector installs.
    #[must_use]
    pub fn npx_available(&self) -> bool {
        self.search_path
            .as_deref()
            .is_some_and(|path| crate::api::find_executable(path, "npx").is_some())
    }

    /// Install `app`'s connector in the background unless it is installed or installing.
    pub fn prepare_in_background(&'static self, app: &str) {
        let Some(bridge) = bridge_for(app) else {
            return;
        };
        if self.ready(bridge).is_some()
            || matches!(
                self.lock_progress().get(bridge.app),
                Some(ConnectorStatus::Preparing { .. })
            )
        {
            return;
        }
        self.set(
            bridge,
            ConnectorStatus::Preparing {
                step: "Waiting to start".to_owned(),
            },
        );
        tokio::spawn(async move {
            if let Err(error) = self.prepare(bridge.app).await {
                eprintln!("warning: could not get {} ready: {error:#}", bridge.name);
            }
        });
    }

    /// Install every connector whose app is on the `PATH` without its own standalone bridge. Run at
    /// start, so an app is ready before its first run asks for it.
    pub fn prepare_detected(&'static self) {
        let Some(path) = self.search_path.as_deref() else {
            return;
        };
        for bridge in BRIDGES {
            let standalone = bridge.package.rsplit('/').next().unwrap_or(bridge.package);
            if crate::api::find_executable(path, bridge.app).is_some()
                && crate::api::find_executable(path, standalone).is_none()
            {
                self.prepare_in_background(bridge.app);
            }
        }
    }

    /// Install `app`'s connector if it isn't. Safe to call again: an installed one returns at once.
    ///
    /// # Errors
    ///
    /// Returns a plain sentence for the UI when no usable Node.js can be found or downloaded, or
    /// when npm cannot install the lockfile.
    pub async fn prepare(&self, app: &str) -> Result<()> {
        let bridge = bridge_for(app).with_context(|| format!("{app} needs no connector"))?;
        let _one_at_a_time = self.installing.lock().await;
        if self.ready(bridge).is_some() {
            self.lock_progress().remove(bridge.app);
            return Ok(());
        }
        let result = self.install(bridge).await;
        match &result {
            Ok(()) => {
                self.lock_progress().remove(bridge.app);
                self.remove_other_versions(bridge);
            }
            Err(error) => self.set(
                bridge,
                ConnectorStatus::Failed {
                    reason: format!("{error:#}"),
                },
            ),
        }
        result
    }

    async fn install(&self, bridge: &Bridge) -> Result<()> {
        self.set(
            bridge,
            ConnectorStatus::Preparing {
                step: "Finding Node.js".to_owned(),
            },
        );
        let node = self.node(bridge).await?;
        self.set(
            bridge,
            ConnectorStatus::Preparing {
                step: format!("Installing what {} needs (once)", bridge.name),
            },
        );
        let dir = self.dir(bridge);
        let staging = dir.with_extension(format!("tmp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)
            .with_context(|| format!("couldn't create {}", staging.display()))?;
        std::fs::write(staging.join("package.json"), bridge.manifest)?;
        std::fs::write(staging.join("package-lock.json"), bridge.lockfile)?;
        if let Err(error) = run_npm_ci(&node, &staging).await {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error.context(format!("couldn't install what {} needs", bridge.name)));
        }
        let entry = entry_script(&staging, bridge);
        ensure!(
            entry.is_file(),
            "npm finished but {} is missing from {}",
            bridge.entry,
            bridge.package
        );
        std::fs::write(
            staging.join(MARKER),
            serde_json::to_vec_pretty(&Marker { node: node.node })?,
        )?;
        // A folder left by an install that stopped half way has no marker: replace it.
        let _ = std::fs::remove_dir_all(&dir);
        rename_dir(&staging, &dir)
            .with_context(|| format!("couldn't move the install into {}", dir.display()))?;
        Ok(())
    }

    /// Delete this app's connectors for other versions, once this one works: an update would
    /// otherwise leave a few hundred megabytes behind each time. Best effort.
    fn remove_other_versions(&self, bridge: &Bridge) {
        let keep = self.dir(bridge);
        let prefix = format!("{}-", bridge.app);
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let named_for_app = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix));
            if named_for_app && path != keep && path.join(MARKER).is_file() {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }

    /// A Node.js that can install packages: `LoomWatch`'s own download, then the computer's, then
    /// a fresh download.
    async fn node(&self, bridge: &Bridge) -> Result<NodeProgram> {
        if let Some(own) = self.own_node() {
            return Ok(own);
        }
        if let Some(system) = self.system_node().await {
            return Ok(system);
        }
        self.set(
            bridge,
            ConnectorStatus::Preparing {
                step: "Downloading Node.js (about 50 MB, once)".to_owned(),
            },
        );
        self.download_node().await
    }

    fn own_node_dir(&self) -> Option<PathBuf> {
        let (platform, _) = node_build()?;
        Some(self.root.join(format!("node-v{NODE_VERSION}-{platform}")))
    }

    fn own_node(&self) -> Option<NodeProgram> {
        let program = node_layout(&self.own_node_dir()?);
        (program.node.is_file() && program.npm_cli.is_file()).then_some(program)
    }

    /// The computer's `node`, when it is new enough and npm's script sits beside it.
    async fn system_node(&self) -> Option<NodeProgram> {
        let path = self.search_path.as_deref()?;
        let node = crate::api::find_executable(path, "node")?;
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new(&node)
                .arg("--version")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        let version = String::from_utf8(output.stdout).ok()?;
        let major: u64 = version
            .trim()
            .strip_prefix('v')?
            .split('.')
            .next()?
            .parse()
            .ok()?;
        if !output.status.success() || major < NODE_MIN_MAJOR {
            return None;
        }
        let npm_cli = npm_cli_beside(&node)?;
        Some(NodeProgram { node, npm_cli })
    }

    async fn download_node(&self) -> Result<NodeProgram> {
        let (platform, sha256) = node_build().context(
            "LoomWatch can't download Node.js for this computer. Install Node.js 22 or newer from https://nodejs.org, then try again.",
        )?;
        let dir = self.own_node_dir().context("no folder for Node.js")?;
        let name = format!("node-v{NODE_VERSION}-{platform}");
        std::fs::create_dir_all(&self.root)?;
        let archive = self.root.join(format!("{name}.{NODE_ARCHIVE}.part"));
        let url = format!("{}/v{NODE_VERSION}/{name}.{NODE_ARCHIVE}", self.node_dist);
        fetch_verified(&url, sha256, &archive)
            .await
            .context("couldn't download Node.js")?;
        let staging = self.root.join(format!("{name}.tmp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staging);
        let unpack_into = staging.clone();
        let unpack_from = archive.clone();
        tokio::task::spawn_blocking(move || unpack(&unpack_from, &unpack_into))
            .await
            .context("unpacking Node.js stopped")?
            .context("couldn't unpack Node.js")?;
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_dir_all(&dir);
        rename_dir(&staging.join(&name), &dir)
            .with_context(|| format!("couldn't move Node.js into {}", dir.display()))?;
        let _ = std::fs::remove_dir_all(&staging);
        self.own_node()
            .context("Node.js was unpacked but its node or npm is missing")
    }

    fn set(&self, bridge: &Bridge, status: ConnectorStatus) {
        self.lock_progress().insert(bridge.app, status);
    }

    fn lock_progress(&self) -> std::sync::MutexGuard<'_, HashMap<&'static str, ConnectorStatus>> {
        self.progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Where a Node.js install keeps `node` and npm's script, under its own folder: `bin/node` and
/// `lib/node_modules/npm` on macOS and Linux, `node.exe` and `node_modules\npm` on Windows.
fn node_layout(prefix: &Path) -> NodeProgram {
    let npm_cli = |modules: PathBuf| modules.join("npm").join("bin").join("npm-cli.js");
    if cfg!(windows) {
        NodeProgram {
            node: prefix.join("node.exe"),
            npm_cli: npm_cli(prefix.join("node_modules")),
        }
    } else {
        NodeProgram {
            node: prefix.join("bin").join("node"),
            npm_cli: npm_cli(prefix.join("lib").join("node_modules")),
        }
    }
}

/// The script `bridge`'s package names as its program, inside the install in `dir`.
fn entry_script(dir: &Path, bridge: &Bridge) -> PathBuf {
    // Joined one name at a time: a `/` inside one `join` stays a `/` on Windows.
    bridge
        .package
        .split('/')
        .chain(bridge.entry.split('/'))
        .fold(dir.join("node_modules"), |path, name| path.join(name))
}

/// npm's own script for the `node` found on the `PATH`: the `npm` beside it is a link to that
/// script for nodejs.org installs, Homebrew and nvm. A shim (Volta, asdf) is not, and gets `None`.
/// On Windows, nodejs.org's installer (and nvm-windows) keeps it in `node_modules` beside
/// `node.exe`.
fn npm_cli_beside(node: &Path) -> Option<PathBuf> {
    let beside = node.parent()?.join("npm");
    let linked = crate::platform::canonicalize(&beside).ok();
    let resolved = crate::platform::canonicalize(node).ok()?;
    let installed = if cfg!(windows) {
        node_layout(resolved.parent()?).npm_cli
    } else {
        node_layout(resolved.parent()?.parent()?).npm_cli
    };
    linked
        .into_iter()
        .chain(std::iter::once(installed))
        .find(|candidate| candidate.is_file() && candidate.extension() == Some(OsStr::new("js")))
}

/// Move the folder `from` to `to`. On Windows a virus scanner often still has a file just written
/// open, and the move is refused for a moment, so it is tried again for a few seconds.
fn rename_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = if cfg!(windows) { 20 } else { 1 };
    loop {
        match std::fs::rename(from, to) {
            Err(error) if tries > 1 && error.kind() == std::io::ErrorKind::PermissionDenied => {
                tries -= 1;
                std::thread::sleep(Duration::from_millis(250));
            }
            done => return done,
        }
    }
}

/// Unpack nodejs.org's `archive` into `into`.
fn unpack(archive: &Path, into: &Path) -> Result<()> {
    let file = std::fs::File::open(archive)?;
    #[cfg(windows)]
    zip::ZipArchive::new(std::io::BufReader::new(file))?.extract(into)?;
    #[cfg(not(windows))]
    tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(into)?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `PATH` for a child started with the Node in `node_dir`: that folder first, so anything the
/// bridge starts as `node` finds the same one.
#[must_use]
pub fn path_with(node_dir: &Path, path: Option<&OsStr>) -> OsString {
    let mut entries = vec![node_dir.to_path_buf()];
    if let Some(path) = path {
        entries.extend(std::env::split_paths(path).filter(|entry| entry != node_dir));
    }
    std::env::join_paths(entries).unwrap_or_else(|_| node_dir.as_os_str().to_owned())
}

async fn run_npm_ci(node: &NodeProgram, folder: &Path) -> Result<()> {
    let node_dir = node.node.parent().unwrap_or(Path::new("/"));
    let mut command = tokio::process::Command::new(&node.node);
    command
        .arg(&node.npm_cli)
        .args([
            "ci",
            "--ignore-scripts",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
        ])
        .current_dir(folder)
        .env(
            "PATH",
            path_with(node_dir, std::env::var_os("PATH").as_deref()),
        )
        .env("npm_config_update_notifier", "false")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(INSTALL_TIMEOUT, command.output())
        .await
        .context("npm took longer than 10 minutes")?
        .context("couldn't start npm")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("npm stopped without saying why");
        bail!("npm: {}", last.chars().take(300).collect::<String>());
    }
    Ok(())
}

/// Download `url` to `dest`, refusing it unless its SHA-256 is `sha256`.
async fn fetch_verified(url: &str, sha256: &str, dest: &Path) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?;
    let mut file = tokio::fs::File::create(dest).await?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(60), response.chunk())
        .await
        .context("the download stalled")??
    {
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    let got = hex(&hasher.finalize());
    if got != sha256 {
        let _ = tokio::fs::remove_file(dest).await;
        bail!("the download didn't match its checksum, so it was thrown away");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own for one test, removed afterwards.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("loomwatch-connectors-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    fn connectors(root: &Path) -> Connectors {
        Connectors::new(root.to_path_buf(), None)
    }

    /// Lay out a finished install for `bridge` the way [`Connectors::install`] leaves one.
    fn fake_install(connectors: &Connectors, bridge: &Bridge, node: &Path) {
        let dir = connectors.dir(bridge);
        let entry = entry_script(&dir, bridge);
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "").unwrap();
        std::fs::write(
            dir.join(MARKER),
            serde_json::to_vec(&Marker {
                node: node.to_path_buf(),
            })
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn every_bridge_lockfile_pins_the_version_loomwatch_starts() {
        for bridge in BRIDGES {
            let manifest: serde_json::Value = serde_json::from_str(bridge.manifest).unwrap();
            assert_eq!(
                manifest["dependencies"][bridge.package], bridge.version,
                "{} package.json",
                bridge.app
            );
            let lock: serde_json::Value = serde_json::from_str(bridge.lockfile).unwrap();
            assert_eq!(
                lock["packages"][format!("node_modules/{}", bridge.package)]["version"],
                bridge.version,
                "{} package-lock.json",
                bridge.app
            );
            assert_eq!(
                crate::api::fallback_package(bridge.app),
                Some(format!("{}@{}", bridge.package, bridge.version).as_str()),
                "api::HARNESSES and the connector must start the same version of {}",
                bridge.app
            );
        }
    }

    #[test]
    fn lockfiles_run_no_install_scripts() {
        // `npm ci --ignore-scripts` is only safe while no package needs one.
        for bridge in BRIDGES {
            let lock: serde_json::Value = serde_json::from_str(bridge.lockfile).unwrap();
            for (name, package) in lock["packages"].as_object().unwrap() {
                assert_ne!(
                    package["hasInstallScript"],
                    serde_json::Value::Bool(true),
                    "{name} in the {} lockfile has an install script",
                    bridge.app
                );
            }
        }
    }

    #[test]
    fn only_npx_of_a_known_bridge_at_its_pinned_version_or_unpinned_is_swapped() {
        let claude = bridge_for("claude").unwrap();
        let pinned = format!("{}@{}", claude.package, claude.version);
        assert!(requested_bridge("npx", &args(&["-y", &pinned])).is_some());
        assert!(
            requested_bridge("/opt/homebrew/bin/npx", &args(&["--yes", claude.package])).is_some()
        );
        // Another version is what someone asked for.
        assert!(
            requested_bridge("npx", &args(&["-y", &format!("{}@0.66.0", claude.package)]))
                .is_none()
        );
        // An extra argument can change what npx runs (`--registry`).
        assert!(
            requested_bridge(
                "npx",
                &args(&["-y", "--registry", "https://example.com", &pinned])
            )
            .is_none()
        );
        assert!(requested_bridge("npx", &args(&[&pinned])).is_none());
        // What a search of the PATH finds on Windows.
        assert_eq!(
            requested_bridge(r"C:\Program Files\nodejs\npx.cmd", &args(&["-y", &pinned])).is_some(),
            cfg!(windows)
        );
        assert!(requested_bridge("npx.js", &args(&["-y", &pinned])).is_none());
        assert!(requested_bridge("claude-agent-acp", &args(&[])).is_none());
        assert!(
            requested_bridge(
                "npx",
                &args(&["-y", "@agentclientprotocol/claude-agent-acp-evil"])
            )
            .is_none()
        );
    }

    #[test]
    fn an_installed_bridge_starts_directly_with_its_node() {
        let temp = Scratch::new();
        let connectors = connectors(temp.path());
        let codex = bridge_for("codex").unwrap();
        let spawn = args(&["-y", &format!("{}@{}", codex.package, codex.version)]);
        assert_eq!(
            connectors.resolve("npx", &spawn),
            Resolved::NotReady {
                app: "codex",
                name: "Codex"
            }
        );
        assert_eq!(connectors.status("codex"), Some(ConnectorStatus::Needed));

        let node_dir = temp.path().join("node/bin");
        std::fs::create_dir_all(&node_dir).unwrap();
        let node = node_dir.join("node");
        std::fs::write(&node, "").unwrap();
        fake_install(&connectors, codex, &node);

        let entry = ["@agentclientprotocol", "codex-acp", "dist", "index.js"]
            .iter()
            .fold(connectors.dir(codex).join("node_modules"), |path, name| {
                path.join(name)
            });
        assert_eq!(
            connectors.resolve("npx", &spawn),
            Resolved::Direct {
                program: node.clone(),
                args: vec![entry.to_string_lossy().into_owned()],
                node_dir: node_dir.clone(),
            }
        );
        assert_eq!(connectors.status("codex"), Some(ConnectorStatus::Ready));
        assert_eq!(connectors.status("opencode"), None);

        // The Node it was installed with is gone (an uninstall, a Homebrew upgrade): not ready.
        std::fs::remove_file(&node).unwrap();
        assert!(matches!(
            connectors.resolve("npx", &spawn),
            Resolved::NotReady { .. }
        ));
    }

    #[test]
    fn the_app_itself_is_found_inside_its_installed_connector() {
        let temp = Scratch::new();
        let connectors = connectors(temp.path());
        let codex = bridge_for("codex").unwrap();
        let node = temp.path().join("node");
        std::fs::write(&node, "").unwrap();
        assert_eq!(connectors.engine("codex"), None);
        fake_install(&connectors, codex, &node);
        assert_eq!(connectors.engine("codex"), None, "no program inside yet");
        // As npm lays it out on Windows, with the program's `.exe`, or elsewhere.
        let (platform, program) = if cfg!(windows) {
            ("codex-win32-x64/vendor/x86_64-pc-windows-msvc", "codex.exe")
        } else {
            ("codex-darwin-arm64/vendor/aarch64-apple-darwin", "codex")
        };
        let program = connectors
            .dir(codex)
            .join("node_modules")
            .join("@openai")
            .join(platform)
            .join("bin")
            .join(program);
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        std::fs::write(&program, "").unwrap();
        assert_eq!(connectors.engine("codex"), Some(program));
        assert_eq!(connectors.engine("opencode"), None);
    }

    #[test]
    fn a_half_finished_install_is_not_ready() {
        let temp = Scratch::new();
        let connectors = connectors(temp.path());
        let claude = bridge_for("claude").unwrap();
        let entry = entry_script(&connectors.dir(claude), claude);
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "").unwrap();
        assert_eq!(connectors.status("claude"), Some(ConnectorStatus::Needed));
    }

    #[test]
    fn other_versions_go_once_this_one_is_installed() {
        let temp = Scratch::new();
        let connectors = connectors(temp.path());
        let claude = bridge_for("claude").unwrap();
        let node = temp.path().join("node");
        std::fs::write(&node, "").unwrap();
        fake_install(&connectors, claude, &node);
        let old = temp.path().join("claude-0.66.0-abcdef12");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(MARKER), "{}").unwrap();
        let unfinished = temp.path().join("claude-0.70.0-12345678");
        std::fs::create_dir_all(&unfinished).unwrap();
        let codex = temp.path().join("codex-2.0.0-abcdef12");
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::write(codex.join(MARKER), "{}").unwrap();

        connectors.remove_other_versions(claude);

        assert!(connectors.dir(claude).is_dir());
        assert!(!old.exists());
        // Not finished, so possibly another process's install in progress: left alone.
        assert!(unfinished.exists());
        assert!(codex.exists());
    }

    #[test]
    fn the_childs_path_starts_with_its_node() {
        let node = Path::new("/lw/node/bin");
        let path = std::env::join_paths(["/usr/bin", "/lw/node/bin", "/bin"]).unwrap();
        let joined = path_with(node, Some(&path));
        assert_eq!(
            joined,
            std::env::join_paths(["/lw/node/bin", "/usr/bin", "/bin"]).unwrap()
        );
        assert_eq!(path_with(node, None), OsString::from("/lw/node/bin"));
    }

    /// nodejs.org's Windows builds are zips: one unpacks into the folder it names.
    #[cfg(windows)]
    #[test]
    fn a_windows_node_zip_unpacks() {
        use std::io::Write;
        let temp = Scratch::new();
        let archive = temp.path().join("node.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("node-v1-win-x64/node.exe", stored).unwrap();
        zip.write_all(b"node").unwrap();
        zip.start_file("node-v1-win-x64/node_modules/npm/bin/npm-cli.js", stored)
            .unwrap();
        zip.finish().unwrap();
        let into = temp.path().join("out");
        unpack(&archive, &into).unwrap();
        let program = node_layout(&into.join("node-v1-win-x64"));
        assert_eq!(std::fs::read(&program.node).unwrap(), b"node");
        assert!(program.npm_cli.is_file());
    }

    /// nodejs.org's Windows installer: `npm.cmd` beside `node.exe`, npm's script in `node_modules`.
    #[cfg(windows)]
    #[test]
    fn npm_is_found_beside_node_exe() {
        let temp = Scratch::new();
        let nodejs = crate::platform::canonicalize(temp.path()).unwrap();
        let cli = nodejs.join("node_modules\\npm\\bin\\npm-cli.js");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "").unwrap();
        std::fs::write(nodejs.join("node.exe"), "").unwrap();
        std::fs::write(nodejs.join("npm.cmd"), "").unwrap();
        assert_eq!(npm_cli_beside(&nodejs.join("node.exe")), Some(cli));
    }

    #[cfg(unix)]
    #[test]
    fn npm_is_found_beside_a_linked_node_and_not_beside_a_shim() {
        let temp = Scratch::new();
        let prefix = temp.path().join("cellar/node/24");
        let cli = prefix.join("lib/node_modules/npm/bin/npm-cli.js");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "").unwrap();
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        std::fs::write(prefix.join("bin/node"), "").unwrap();
        // Homebrew's layout: bin/node and bin/npm are links in another folder.
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(prefix.join("bin/node"), bin.join("node")).unwrap();
        std::os::unix::fs::symlink(&cli, bin.join("npm")).unwrap();
        assert_eq!(
            npm_cli_beside(&bin.join("node")),
            Some(std::fs::canonicalize(&cli).unwrap())
        );

        // A shim: `npm` is a program, and nothing sits under the node's prefix.
        let shims = temp.path().join("shims");
        std::fs::create_dir_all(&shims).unwrap();
        std::fs::write(shims.join("node"), "").unwrap();
        std::fs::write(shims.join("npm"), "").unwrap();
        assert_eq!(npm_cli_beside(&shims.join("node")), None);
    }

    #[tokio::test]
    async fn a_download_with_the_wrong_checksum_is_thrown_away() {
        use axum::{Router, routing::get};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/node.tar.gz", get(|| async { "pretend node" })),
            )
            .await
            .unwrap();
        });
        let temp = Scratch::new();
        let dest = temp.path().join("node.tar.gz.part");
        let url = format!("http://{address}/node.tar.gz");
        let right = hex(&Sha256::digest(b"pretend node"));

        let wrong = fetch_verified(&url, &"0".repeat(64), &dest).await;
        assert!(wrong.unwrap_err().to_string().contains("checksum"));
        assert!(!dest.exists(), "a refused download must not stay on disk");

        fetch_verified(&url, &right, &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"pretend node");
    }
}
