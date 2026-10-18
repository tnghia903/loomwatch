//! Update and restart for the desktop apps (ADR 0052): what the `loomwatch` launcher does for a
//! copy in the terminal, done by `LoomWatch.app` and `LoomWatch.exe` for themselves.
//!
//! The app starts `loomwatchd` with the same hand-over the launcher gives it ([`SUPERVISED_ENV`]
//! and [`REQUEST_ENV`]), but only when it can replace itself; otherwise it says why
//! ([`BLOCKED_ENV`]), and the app's updates dialog shows the steps to do it by hand. When the
//! operator clicks Update and restart, `loomwatchd` names the release in the request file, stops
//! the runs they agreed to stop and exits with [`EXIT_TO_UPDATE`]. The app then
//!
//! 1. downloads the release's file over HTTPS from its GitHub release, with its `.sha256`, and
//!    checks one against the other ([`download`]);
//! 2. saves a copy of the run history, as `loomwatch update` does ([`back_up`]): a new version may
//!    change how the history is stored, which the version it replaces cannot read;
//! 3. on a Mac, mounts the `.dmg` read-only, copies `LoomWatch.app` beside the running one, checks
//!    the copy is the version asked for, and swaps it in by renaming, keeping the one it replaces
//!    hidden beside it ([`mac::put_in_place`]); then opens the new app and quits. On Windows, it
//!    runs `LoomWatch-windows-setup.exe` silently, which quits this app and opens the new one
//!    ([`windows::run_setup`]).
//!
//! When a step fails nothing has changed, and the app starts the version it is again, telling it
//! why ([`FAILED_ENV`]), so the dialog says so. Teams and settings are never touched: they live in
//! `~/LoomWatch` and the state folder, not beside the app.
//!
//! Downloads go through the system's own `curl`, which every Mac has and Windows has had since
//! Windows 10 1803, so the app needs no HTTP client of its own.

// Some of this is used on one platform only; all of it is tested everywhere.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};

/// Where `LoomWatch` is published.
const REPOSITORY: &str = "tnghia903/loomwatch";
/// The exit status `loomwatchd` asks for an update with: `updates::EXIT_TO_UPDATE`.
pub const EXIT_TO_UPDATE: i32 = 75;
/// What `loomwatchd` reads (`updates.rs`): `1` when the app can install a release and start
/// `LoomWatch` again, the file it names the release in, why the last update did not finish, and
/// why this app cannot replace itself.
pub const SUPERVISED_ENV: &str = "LOOMWATCH_SUPERVISED";
pub const REQUEST_ENV: &str = "LOOMWATCH_UPDATE_REQUEST";
pub const FAILED_ENV: &str = "LOOMWATCH_UPDATE_FAILED";
pub const BLOCKED_ENV: &str = "LOOMWATCH_UPDATE_BLOCKED";
/// Testing a release before it is published: the folder its files are served from, as
/// `install.sh` reads it. `https` anywhere, or `http` on this computer only.
pub const DOWNLOAD_BASE_ENV: &str = "LOOMWATCH_DOWNLOAD_BASE";
/// Where updates keep copies of the run history, as the launcher reads it.
pub const BACKUP_DIR_ENV: &str = "LOOMWATCH_BACKUP_DIR";
/// The copies of the run history kept, newest first, as `loomwatch update` keeps them.
const BACKUPS_KEPT: usize = 3;

/// The release `loomwatchd` named for the app to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    /// `v0.7.0`, as the release is tagged on GitHub.
    pub tag: String,
    /// `0.7.0`.
    pub version: String,
}

/// The release named in `file`, which is removed so it is installed once. Like the launcher, it
/// installs only a version number newer than `current`.
pub fn requested(file: &Path, current: &str) -> Result<Release, String> {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let _ = std::fs::remove_file(file);
    let tag = text.lines().next().unwrap_or_default().trim();
    let version = tag
        .strip_prefix('v')
        .filter(|version| parse(version).is_some())
        .filter(|_| {
            tag.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
        })
        .ok_or_else(|| "LoomWatch did not say which version to install.".to_owned())?;
    if !newer(version, current) {
        return Err(format!(
            "{version} is not newer than LoomWatch {current}, so nothing was changed."
        ));
    }
    Ok(Release {
        tag: tag.to_owned(),
        version: version.to_owned(),
    })
}

/// `MAJOR.MINOR.PATCH`, and whether a pre-release follows. Build details after `+` don't count.
fn parse(version: &str) -> Option<(u64, u64, u64, bool)> {
    let version = version.split('+').next()?;
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, !pre.is_empty()),
        None => (version, false),
    };
    let mut numbers = core.split('.').map(|part| {
        (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse::<u64>().ok())
            .flatten()
    });
    let parsed = (numbers.next()??, numbers.next()??, numbers.next()??, pre);
    numbers.next().is_none().then_some(parsed)
}

/// Whether `candidate` is a newer version than `current`. A release is newer than a pre-release of
/// the same number; `loomwatchd` offers only releases, so pre-releases are not ordered further.
fn newer(candidate: &str, current: &str) -> bool {
    match (parse(candidate), parse(current)) {
        (Some((major, minor, patch, pre)), Some((now_major, now_minor, now_patch, now_pre))) => {
            let (next, now) = ((major, minor, patch), (now_major, now_minor, now_patch));
            next > now || (next == now && now_pre && !pre)
        }
        _ => false,
    }
}

/// Where `release`'s files are downloaded from: its GitHub release, or [`DOWNLOAD_BASE_ENV`].
pub fn download_base(release: &Release) -> Result<String, String> {
    base_for(release, std::env::var(DOWNLOAD_BASE_ENV).ok().as_deref())
}

fn base_for(release: &Release, configured: Option<&str>) -> Result<String, String> {
    match configured.map(str::trim).filter(|base| !base.is_empty()) {
        Some(base) if protocols_for(base).is_some() => Ok(base.trim_end_matches('/').to_owned()),
        Some(base) => Err(format!(
            "{DOWNLOAD_BASE_ENV}={base} was ignored: it must be https, or http on this computer."
        )),
        None => Ok(format!(
            "https://github.com/{REPOSITORY}/releases/download/{}",
            release.tag
        )),
    }
}

/// What `curl` may use for `base` and wherever it redirects: `https` anywhere, and `http` too for
/// a folder served on this computer. `None` for anything else.
fn protocols_for(base: &str) -> Option<&'static str> {
    if let Some(rest) = base.strip_prefix("https://") {
        return (!rest.is_empty() && !rest.starts_with('/')).then_some("=https");
    }
    let authority = base
        .strip_prefix("http://")?
        .split(['/', '?', '#'])
        .next()?;
    if authority.contains('@') {
        return None;
    }
    let host = match authority.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next()?,
        None => authority.split(':').next()?,
    };
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    loopback.then_some("=https,http")
}

/// The system's `curl`.
fn curl() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("SystemRoot").map_or_else(
            || PathBuf::from("curl.exe"),
            |root| PathBuf::from(root).join("System32").join("curl.exe"),
        )
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/usr/bin/curl")
    } else {
        PathBuf::from("curl")
    }
}

/// Downloads `asset` and `asset.sha256` from `base` into `folder`, and checks the one against the
/// other. Returns where the checked file is. `log` hears what `curl` said when it failed.
pub fn download(
    base: &str,
    asset: &str,
    folder: &Path,
    log: &dyn Fn(&str),
) -> Result<PathBuf, String> {
    let protocols = protocols_for(base).ok_or_else(|| format!("{base} is not https."))?;
    std::fs::create_dir_all(folder)
        .map_err(|error| format!("there is no room to download it ({error})."))?;
    let file = folder.join(asset);
    let checksum = folder.join(format!("{asset}.sha256"));
    let fetch = |url: &str, to: &Path| -> bool {
        let _ = std::fs::remove_file(to);
        let mut command = Command::new(curl());
        command
            .args(["--fail", "--silent", "--show-error", "--location"])
            .args(["--proto", protocols, "--proto-redir", protocols])
            .args([
                "--retry",
                "2",
                "--connect-timeout",
                "30",
                "--max-time",
                "1200",
            ])
            .arg("--output")
            .arg(to)
            .arg(url)
            .stdin(Stdio::null());
        hide_window(&mut command);
        match command.output() {
            Ok(out) if out.status.success() && to.is_file() => true,
            Ok(out) => {
                log(&format!(
                    "could not download {url}: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
                false
            }
            Err(error) => {
                log(&format!("could not run curl to download {url}: {error}"));
                false
            }
        }
    };
    if !fetch(&format!("{base}/{asset}"), &file) {
        return Err(format!(
            "the download of {asset} did not finish. Check your internet connection, then try again."
        ));
    }
    if !fetch(&format!("{base}/{asset}.sha256"), &checksum) {
        return Err(format!(
            "the checksum for {asset} could not be downloaded, so the download cannot be checked."
        ));
    }
    let expected = std::fs::read_to_string(&checksum)
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .map(str::to_ascii_lowercase)
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let actual = sha256_hex(&file).ok();
    if expected.is_none() || expected != actual {
        log(&format!(
            "{asset}: the checksum says {}, the file is {}",
            expected.as_deref().unwrap_or("nothing readable"),
            actual.as_deref().unwrap_or("unreadable")
        ));
        let _ = std::fs::remove_file(&file);
        return Err(format!(
            "the download does not match the release’s checksum, so it was not installed. Try again; if it keeps happening, report it at https://github.com/{REPOSITORY}/issues"
        ));
    }
    Ok(file)
}

/// The SHA-256 of `file`, in lower-case hex as `shasum -a 256` writes it.
pub fn sha256_hex(file: &Path) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    std::io::copy(&mut std::fs::File::open(file)?, &mut hasher)?;
    Ok(hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
            hex
        }))
}

/// Where the app keeps copies of its run history: [`BACKUP_DIR_ENV`], or `~/LoomWatch/backups`,
/// in a folder of its own beside the terminal install's.
pub fn backup_folder(home: &Path) -> PathBuf {
    std::env::var_os(BACKUP_DIR_ENV)
        .map(PathBuf::from)
        .filter(|folder| folder.is_absolute())
        .unwrap_or_else(|| home.join("LoomWatch").join("backups"))
        .join("desktop-app")
}

/// Saves a copy of the run history in `folder`, as `loomwatch update` does: `daemon backup`
/// writes a consistent copy, readable by this account only, and the newest three are kept.
/// `Ok(None)` when there is no run history yet, as before `LoomWatch` first started. `log` hears
/// what `daemon backup` said when it failed.
pub fn back_up(
    daemon: &Path,
    folder: &Path,
    version: &str,
    log: &dyn Fn(&str),
) -> Result<Option<PathBuf>, String> {
    const FAILED: &str = "the copy of your run history could not be saved, so LoomWatch was not changed. Show log says why.";
    let layout = quiet(Command::new(daemon).arg("database-layout"))
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .unwrap_or_default();
    if layout.is_empty() {
        return Ok(None);
    }
    std::fs::create_dir_all(folder).map_err(|_| FAILED.to_owned())?;
    private(folder, 0o700);
    if let Some(root) = folder.parent() {
        private(root, 0o700);
    }
    let file = folder.join(format!(
        "loomwatch-{}-{version}.db",
        stamp(chrono::Utc::now())
    ));
    let mut partial = file.clone().into_os_string();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    let _ = std::fs::remove_file(&partial);
    let saved = match quiet(Command::new(daemon).arg("backup").arg(&partial)).output() {
        Ok(out) if out.status.success() => true,
        Ok(out) => {
            log(&format!(
                "{} backup: {}",
                daemon.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
            false
        }
        Err(error) => {
            log(&format!("could not run {}: {error}", daemon.display()));
            false
        }
    } && std::fs::metadata(&partial).is_ok_and(|meta| meta.len() > 0);
    if !saved || std::fs::rename(&partial, &file).is_err() {
        let _ = std::fs::remove_file(&partial);
        return Err(FAILED.to_owned());
    }
    private(&file, 0o600);
    // Named from the time first, so sorting the names sorts the copies oldest first.
    let mut copies: Vec<PathBuf> = std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("loomwatch-"))
                        && path.extension().is_some_and(|extension| extension == "db")
                })
                .collect()
        })
        .unwrap_or_default();
    copies.sort();
    let extra = copies.len().saturating_sub(BACKUPS_KEPT);
    for old in &copies[..extra] {
        let _ = std::fs::remove_file(old);
    }
    Ok(Some(file))
}

/// `20261018T081500Z`, as the launcher names a copy with `date -u +%Y%m%dT%H%M%SZ`.
fn stamp(at: chrono::DateTime<chrono::Utc>) -> String {
    use chrono::{Datelike, Timelike};
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        at.month(),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// `command` run with no window and no input, its output kept for the log.
fn quiet(command: &mut Command) -> &mut Command {
    hide_window(command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// Starts a console program without a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
const fn hide_window(_: &mut Command) {}

/// Readable by this account only, where files have modes.
fn private(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

/// Puts `staged` where `current` is, by renaming, and keeps `current` as `previous` (replacing the
/// one an earlier update kept). Both renames stay in one folder, so nothing is copied and nothing
/// is ever half in place: if the second rename fails, the first is undone.
#[cfg_attr(windows, allow(dead_code))]
pub fn swap(staged: &Path, current: &Path, previous: &Path) -> std::io::Result<()> {
    // Checked first, so a copy that is not there costs nothing, not even the one kept last time.
    std::fs::metadata(staged)?;
    if previous.exists() {
        std::fs::remove_dir_all(previous)?;
    }
    std::fs::rename(current, previous)?;
    if let Err(error) = std::fs::rename(staged, current) {
        let _ = std::fs::rename(previous, current);
        return Err(error);
    }
    Ok(())
}

/// The version a `LoomWatch` folder says it is: the first word of its `VERSION`, as the launcher
/// reads an install's.
#[cfg_attr(windows, allow(dead_code))]
pub fn version_in(version_file: &Path) -> Option<String> {
    std::fs::read_to_string(version_file)
        .ok()?
        .split_whitespace()
        .next()
        .map(str::to_owned)
}

/// `LoomWatch.app` replacing itself.
#[cfg(target_os = "macos")]
pub mod mac {
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::quiet;

    const TRANSLOCATED: &str = "LoomWatch can’t update itself while macOS runs it from a temporary copy, as it does for an app opened from where it was downloaded. Drag LoomWatch to Applications and open it from there, and the next update is one click.";
    const READ_ONLY: &str = "LoomWatch can’t update itself while it runs from the disk image. Drag LoomWatch to Applications and open it from there, and the next update is one click.";

    /// Whether the app at `bundle` can be replaced by this account, or why not: it runs from the
    /// `.dmg` or translocated (macOS runs an app opened from Downloads from a temporary copy), or
    /// its folder can't be written. Tried by making the folder the new copy would be staged in.
    pub fn can_replace(bundle: &Path) -> Result<(), String> {
        if bundle
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
        {
            return Err(TRANSLOCATED.to_owned());
        }
        let staged = staged(bundle).ok_or("This LoomWatch has no name to replace.")?;
        let _ = std::fs::remove_dir_all(&staged);
        match std::fs::create_dir(&staged) {
            Ok(()) => {
                let _ = std::fs::remove_dir(&staged);
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::ReadOnlyFilesystem => {
                Err(READ_ONLY.to_owned())
            }
            Err(error) => {
                let folder = bundle.parent().unwrap_or(bundle);
                Err(format!(
                    "LoomWatch can’t update itself: this account can’t change {}, the folder it is in ({}). Someone who can, such as this Mac’s administrator, can install the new version, or you can drag LoomWatch to a folder of your own.",
                    folder.display(),
                    error.kind()
                ))
            }
        }
    }

    /// Where the new copy is made: hidden beside `bundle`, and not named `.app` until it is whole.
    pub fn staged(bundle: &Path) -> Option<PathBuf> {
        let name = bundle.file_name()?.to_str()?;
        Some(bundle.with_file_name(format!(".{name}.update")))
    }

    /// Where the version an update replaced is kept: hidden beside `bundle`, and not named `.app`,
    /// so neither Finder nor Launchpad shows a second `LoomWatch`. Renaming it back to `bundle`'s
    /// name goes back to it.
    pub fn previous(bundle: &Path) -> Option<PathBuf> {
        let name = bundle.file_name()?.to_str()?;
        Some(bundle.with_file_name(format!(".{name}.previous")))
    }

    /// Empties `work` of what an update left there, detaching a disk image still mounted in it,
    /// such as after a power cut. A folder that still holds a mounted image is left as it is.
    pub fn clear(work: &Path) {
        let volume = work.join("volume");
        if volume.exists() {
            let _ = quiet(
                Command::new("/usr/bin/hdiutil")
                    .arg("detach")
                    .arg(&volume)
                    .args(["-quiet", "-force"]),
            )
            .status();
            if std::fs::read_dir(&volume).is_ok_and(|mut entries| entries.next().is_some()) {
                return;
            }
        }
        let _ = std::fs::remove_dir_all(work);
    }

    /// Detaches the disk image mounted at its folder when dropped, whatever happened meanwhile.
    struct Mounted<'a>(&'a Path);

    impl Drop for Mounted<'_> {
        fn drop(&mut self) {
            let detach = |force: bool| {
                let mut command = Command::new("/usr/bin/hdiutil");
                command.arg("detach").arg(self.0).arg("-quiet");
                if force {
                    command.arg("-force");
                }
                quiet(&mut command)
                    .status()
                    .is_ok_and(|status| status.success())
            };
            if !detach(false) {
                detach(true);
            }
        }
    }

    /// Puts the `LoomWatch.app` in `dmg` where `bundle` is: copied beside `bundle`, checked to be
    /// `version` and whole, then swapped in, keeping `bundle` as [`previous`]. Changes nothing when
    /// a step fails.
    pub fn put_in_place(
        dmg: &Path,
        bundle: &Path,
        version: &str,
        work: &Path,
        log: &dyn Fn(&str),
    ) -> Result<(), String> {
        let staged = staged(bundle).ok_or("this LoomWatch has no name to replace")?;
        let previous = previous(bundle).ok_or("this LoomWatch has no name to replace")?;
        let _ = std::fs::remove_dir_all(&staged);
        let placed = copy_out(dmg, &staged, work, log)
            .and_then(|()| check(&staged, version, log))
            .and_then(|()| {
                super::swap(&staged, bundle, &previous).map_err(|error| {
                    log(&format!(
                        "putting {} in place of {}: {error}",
                        staged.display(),
                        bundle.display()
                    ));
                    format!(
                        "macOS didn’t let LoomWatch put the new version in place ({}), so this one was kept.",
                        error.kind()
                    )
                })
            });
        if placed.is_err() {
            let _ = std::fs::remove_dir_all(&staged);
        }
        placed
    }

    /// Copies the `LoomWatch.app` in `dmg` to `staged`, from the image mounted read-only in `work`.
    fn copy_out(dmg: &Path, staged: &Path, work: &Path, log: &dyn Fn(&str)) -> Result<(), String> {
        const UNOPENED: &str = "the downloaded LoomWatch-macos.dmg could not be opened.";
        let volume = work.join("volume");
        std::fs::create_dir_all(&volume).map_err(|_| UNOPENED.to_owned())?;
        let attached = quiet(
            Command::new("/usr/bin/hdiutil")
                .arg("attach")
                .args([
                    "-nobrowse",
                    "-readonly",
                    "-noautoopen",
                    "-noverify",
                    "-quiet",
                ])
                .arg("-mountpoint")
                .arg(&volume)
                .arg(dmg),
        )
        .output();
        match attached {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                log(&format!(
                    "hdiutil attach {}: {}",
                    dmg.display(),
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
                return Err(UNOPENED.to_owned());
            }
            Err(error) => {
                log(&format!("could not run hdiutil: {error}"));
                return Err(UNOPENED.to_owned());
            }
        }
        let _mounted = Mounted(&volume);
        let source = volume.join("LoomWatch.app");
        if !source.join("Contents").is_dir() {
            return Err(
                "the downloaded LoomWatch-macos.dmg has no LoomWatch.app in it.".to_owned(),
            );
        }
        let said = match quiet(Command::new("/usr/bin/ditto").arg(&source).arg(staged)).output() {
            Ok(out) if out.status.success() => return Ok(()),
            Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            Err(error) => error.to_string(),
        };
        log(&format!("ditto {}: {said}", source.display()));
        Err(format!(
            "the new LoomWatch could not be copied beside this one ({said})."
        ))
    }

    /// Whether the copy at `staged` is `version`, and whole: its signature checks out.
    fn check(staged: &Path, version: &str, log: &dyn Fn(&str)) -> Result<(), String> {
        let found = super::version_in(&staged.join("Contents/Resources/VERSION"));
        if found.as_deref() != Some(version) {
            return Err(format!(
                "the downloaded LoomWatch is {}, not {version}, so it was not installed.",
                found.map_or_else(
                    || "of no version".to_owned(),
                    |found| format!("version {found}")
                )
            ));
        }
        let verified = quiet(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(staged),
        )
        .output();
        match verified {
            Ok(out) if !out.status.success() => {
                log(&format!(
                    "codesign --verify {}: {}",
                    staged.display(),
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
                Err(
                    "the new LoomWatch’s signature does not check out, so it was not installed."
                        .to_owned(),
                )
            }
            _ => Ok(()),
        }
    }

    /// The environment a `LoomWatch` opened for a trial was given (`LOOMWATCH_*`), for the new one
    /// to have too, without what this app sets for its own `loomwatchd`.
    fn passed_on() -> Vec<String> {
        const OWN: [&str; 7] = [
            super::SUPERVISED_ENV,
            super::REQUEST_ENV,
            super::FAILED_ENV,
            super::BLOCKED_ENV,
            "LOOMWATCH_INSTALL",
            "LOOMWATCH_EXIT_WITH_PARENT",
            "LOOMWATCH_COMMIT",
        ];
        std::env::vars()
            .filter(|(name, _)| name.starts_with("LOOMWATCH_") && !OWN.contains(&name.as_str()))
            .map(|(name, value)| format!("{name}={value}"))
            .collect()
    }

    /// Opens the app at `bundle` as a new copy, in the background: the page that asked for the
    /// update is open already and waits for it, so no second tab. This app quits next.
    pub fn open_again(bundle: &Path, log: &dyn Fn(&str)) -> Result<(), String> {
        let mut open = Command::new("/usr/bin/open");
        open.args(["-n", "-g"]);
        for variable in passed_on() {
            open.arg("--env").arg(variable);
        }
        open.arg(bundle).args(["--args", "--background"]);
        match quiet(&mut open).output() {
            Ok(out) if out.status.success() => return Ok(()),
            Ok(out) => log(&format!(
                "open {}: {}",
                bundle.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(error) => log(&format!("could not run open: {error}")),
        }
        // Started as this app's own child instead, it keeps this app's environment.
        Command::new(bundle.join("Contents/MacOS/LoomWatch"))
            .arg("--background")
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .spawn()
            .map(drop)
            .map_err(|error| format!("the new LoomWatch could not be opened ({error})."))
    }
}

/// `LoomWatch.exe` updated by its installer.
#[cfg(windows)]
pub mod windows {
    use std::path::Path;
    use std::process::Command;

    /// Whether `LoomWatch-windows-setup.exe` installed the app at `program`, so running a newer one
    /// replaces it: the installer's uninstaller is beside it.
    pub fn installed_by_setup(program: &Path) -> Result<(), String> {
        let folder = program.parent().unwrap_or(program);
        if folder.join("unins000.exe").is_file() {
            Ok(())
        } else {
            Err("This LoomWatch.exe wasn’t installed by LoomWatch-windows-setup.exe, so it can’t replace itself. Update it the way it was installed.".to_owned())
        }
    }

    /// Runs the installer without a window. It asks this app to quit (`--quit`), replaces its
    /// files, and opens `LoomWatch` again in the background (`/UPDATEDFROM`), or the version still
    /// here when it could not replace it, saying so (`--update-failed`).
    pub fn run_setup(setup: &Path, from: &str) -> Result<(), String> {
        Command::new(setup)
            .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
            .arg(format!("/UPDATEDFROM={from}"))
            .spawn()
            .map(drop)
            .map_err(|error| format!("LoomWatch-windows-setup.exe could not be started ({error})."))
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// A folder of the test's own, removed afterwards.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let unique = format!(
                "loomwatch-app-update-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn release(tag: &str) -> Release {
        Release {
            tag: tag.to_owned(),
            version: tag.trim_start_matches('v').to_owned(),
        }
    }

    #[test]
    fn only_a_newer_version_number_named_by_loomwatchd_is_installed() {
        let scratch = Scratch::new();
        let file = scratch.0.join("app-update-request");
        let ask = |text: &str| {
            std::fs::write(&file, text).unwrap();
            let asked = requested(&file, "0.6.3");
            assert!(!file.exists(), "a request is read once");
            asked
        };
        assert_eq!(ask("v0.7.0\n"), Ok(release("v0.7.0")));
        assert_eq!(ask("v0.6.10\r\n"), Ok(release("v0.6.10")));
        assert_eq!(ask("v1.0.0\nignored"), Ok(release("v1.0.0")));
        for (text, why) in [
            ("v0.6.3\n", "not newer"),
            ("v0.6.2\n", "not newer"),
            ("v0.6.3-rc.1\n", "not newer"),
            ("0.7.0\n", "did not say"),
            ("v0.7\n", "did not say"),
            ("v0.7.0/../../x\n", "did not say"),
            ("v0.7.0 now\n", "did not say"),
            ("", "did not say"),
        ] {
            let refused = ask(text).expect_err(text);
            assert!(refused.contains(why), "{text:?}: {refused}");
        }
        assert!(requested(&scratch.0.join("none"), "0.6.3").is_err());
        assert!(
            newer("0.7.0", "0.7.0-rc.2"),
            "a release is newer than its pre-release"
        );
        assert!(!newer("0.7.0-rc.2", "0.7.0"));
    }

    #[test]
    fn files_come_from_the_release_on_github_or_a_folder_served_on_this_computer() {
        let asked = release("v0.7.0");
        assert_eq!(
            base_for(&asked, None).unwrap(),
            "https://github.com/tnghia903/loomwatch/releases/download/v0.7.0"
        );
        assert_eq!(
            base_for(&asked, Some("  ")).unwrap(),
            base_for(&asked, None).unwrap()
        );
        for (base, protocols) in [
            ("http://127.0.0.1:8765/new/", "=https,http"),
            ("http://localhost:8765", "=https,http"),
            ("http://[::1]:8765/x", "=https,http"),
            ("https://example.test/releases", "=https"),
        ] {
            assert_eq!(protocols_for(base), Some(protocols), "{base}");
            assert_eq!(
                base_for(&asked, Some(base)).unwrap(),
                base.trim_end_matches('/')
            );
        }
        for base in [
            "http://192.168.1.4:8765",
            "http://example.test",
            "http://127.0.0.1@example.test/",
            "file:///tmp/x",
            "ftp://127.0.0.1/",
            "https://",
        ] {
            assert_eq!(protocols_for(base), None, "{base}");
            assert!(base_for(&asked, Some(base)).is_err(), "{base}");
        }
    }

    /// A stand-in for GitHub's release downloads on this computer: `files` by name, 404 for
    /// anything else, and the paths it was asked for.
    fn serve(files: Vec<(String, Vec<u8>)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&asked);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut first = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                if reader.read_line(&mut first).is_err() {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = first.split(' ').nth(1).unwrap_or_default().to_owned();
                seen.lock().unwrap().push(path.clone());
                let found = files
                    .iter()
                    .find(|(name, _)| path == format!("/v0.7.0/{name}"));
                let (status, body): (&str, &[u8]) = match found {
                    Some((_, body)) => ("200 OK", body),
                    None => ("404 Not Found", b"Not Found"),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(body);
            }
        });
        (format!("http://127.0.0.1:{port}/v0.7.0"), asked)
    }

    fn checksum_of(body: &[u8], name: &str) -> Vec<u8> {
        let scratch = Scratch::new();
        let file = scratch.0.join(name);
        std::fs::write(&file, body).unwrap();
        format!("{}  {name}\n", sha256_hex(&file).unwrap()).into_bytes()
    }

    #[test]
    fn a_download_is_kept_only_when_it_matches_the_release_checksum() {
        let asset = "LoomWatch-macos.dmg";
        let body = b"a disk image".to_vec();
        let scratch = Scratch::new();
        let heard = Mutex::new(Vec::<String>::new());
        let log = |line: &str| heard.lock().unwrap().push(line.to_owned());

        let (base, asked) = serve(vec![
            (asset.to_owned(), body.clone()),
            (format!("{asset}.sha256"), checksum_of(&body, asset)),
        ]);
        let file = download(&base, asset, &scratch.0.join("good"), &log).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), body);
        assert_eq!(
            *asked.lock().unwrap(),
            [
                "/v0.7.0/LoomWatch-macos.dmg",
                "/v0.7.0/LoomWatch-macos.dmg.sha256"
            ]
        );

        // Another file's checksum: refused, and the download is not left to be opened.
        let (base, _) = serve(vec![
            (asset.to_owned(), body.clone()),
            (
                format!("{asset}.sha256"),
                checksum_of(b"something else", asset),
            ),
        ]);
        let folder = scratch.0.join("tampered");
        let refused = download(&base, asset, &folder, &log).unwrap_err();
        assert!(
            refused.contains("does not match the release’s checksum"),
            "{refused}"
        );
        assert!(!folder.join(asset).exists());

        // A checksum file that holds no checksum is no checksum.
        let (base, _) = serve(vec![
            (asset.to_owned(), body.clone()),
            (format!("{asset}.sha256"), b"<html>not here</html>".to_vec()),
        ]);
        assert!(download(&base, asset, &scratch.0.join("html"), &log).is_err());

        let (base, _) = serve(vec![(asset.to_owned(), body.clone())]);
        let refused = download(&base, asset, &scratch.0.join("unchecked"), &log).unwrap_err();
        assert!(
            refused.contains("checksum for LoomWatch-macos.dmg could not be downloaded"),
            "{refused}"
        );

        let (base, _) = serve(Vec::new());
        let refused = download(&base, asset, &scratch.0.join("missing"), &log).unwrap_err();
        assert!(refused.contains("did not finish"), "{refused}");
        assert!(
            heard
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.contains("404")),
            "what curl said is in the log: {:?}",
            heard.lock().unwrap()
        );

        assert!(
            download(
                "http://example.test/v0.7.0",
                asset,
                &scratch.0.join("x"),
                &log
            )
            .is_err()
        );
    }

    #[test]
    fn a_swap_keeps_the_version_it_replaces_and_undoes_itself_when_it_cannot_finish() {
        let scratch = Scratch::new();
        let bundle = |name: &str, version: &str| {
            let path = scratch.0.join(name);
            std::fs::create_dir_all(path.join("Contents/Resources")).unwrap();
            std::fs::write(
                path.join("Contents/Resources/VERSION"),
                format!("{version} abc\n"),
            )
            .unwrap();
            path
        };
        let version = |path: &Path| version_in(&path.join("Contents/Resources/VERSION"));
        let current = bundle("LoomWatch.app", "0.6.3");
        let previous = scratch.0.join(".LoomWatch.app.previous");

        let staged = bundle(".LoomWatch.app.update", "0.7.0");
        swap(&staged, &current, &previous).unwrap();
        assert_eq!(version(&current).as_deref(), Some("0.7.0"));
        assert_eq!(version(&previous).as_deref(), Some("0.6.3"));
        assert!(!staged.exists());

        // The next update keeps only the version it replaces.
        let staged = bundle(".LoomWatch.app.update", "0.8.0");
        swap(&staged, &current, &previous).unwrap();
        assert_eq!(version(&current).as_deref(), Some("0.8.0"));
        assert_eq!(version(&previous).as_deref(), Some("0.7.0"));

        // Nothing staged: the app, and the copy kept, stay as they were.
        let gone = scratch.0.join(".LoomWatch.app.missing");
        assert!(swap(&gone, &current, &previous).is_err());
        assert_eq!(version(&current).as_deref(), Some("0.8.0"));
        assert_eq!(version(&previous).as_deref(), Some("0.7.0"));
    }

    /// A stand-in `loomwatchd` that answers `database-layout` with `layout`, and writes `backup`'s
    /// copy unless `broken`.
    #[cfg(unix)]
    fn fake_daemon(folder: &Path, layout: &str, broken: bool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let daemon = folder.join("loomwatchd");
        let backup = if broken {
            "echo 'disk full' >&2; exit 1"
        } else {
            "printf 'SQLite format 3' >\"$2\""
        };
        std::fs::write(
            &daemon,
            format!(
                "#!/bin/sh\ncase $1 in\n  database-layout) printf '{layout}' ;;\n  backup) {backup} ;;\n  *) exit 2 ;;\nesac\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o755)).unwrap();
        daemon
    }

    #[cfg(unix)]
    #[test]
    fn the_run_history_is_saved_first_and_the_newest_three_copies_are_kept() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new();
        let folder = scratch.0.join("backups/desktop-app");

        let heard = Mutex::new(Vec::<String>::new());
        let log = |line: &str| heard.lock().unwrap().push(line.to_owned());
        let never_started = fake_daemon(&scratch.0, "", false);
        assert_eq!(back_up(&never_started, &folder, "0.6.3", &log), Ok(None));
        assert!(!folder.exists(), "no history, no copy");

        let daemon = fake_daemon(&scratch.0, "20261017000000\n", false);
        for old in [
            "loomwatch-20261001T000000Z-0.6.0.db",
            "loomwatch-20261002T000000Z-0.6.1.db",
            "loomwatch-20261003T000000Z-0.6.2.db",
        ] {
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join(old), "old").unwrap();
        }
        let saved = back_up(&daemon, &folder, "0.6.3", &log)
            .unwrap()
            .expect("a copy");
        let name = saved.file_name().unwrap().to_str().unwrap().to_owned();
        assert!(
            name.starts_with("loomwatch-20") && name.ends_with("Z-0.6.3.db"),
            "{name}"
        );
        assert_eq!(std::fs::read_to_string(&saved).unwrap(), "SQLite format 3");
        assert_eq!(
            std::fs::metadata(&saved).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let mut kept: Vec<String> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        kept.sort();
        assert_eq!(
            kept,
            [
                "loomwatch-20261002T000000Z-0.6.1.db",
                "loomwatch-20261003T000000Z-0.6.2.db",
                name.as_str()
            ]
        );

        let broken = fake_daemon(&scratch.0, "20261017000000", true);
        let refused = back_up(&broken, &folder, "0.6.3", &log).unwrap_err();
        assert!(
            refused.contains("could not be saved, so LoomWatch was not changed"),
            "{refused}"
        );
        assert!(
            heard
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.ends_with("backup: disk full")),
            "why is in the log: {:?}",
            heard.lock().unwrap()
        );
        assert!(
            std::fs::read_dir(&folder).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".partial")),
            "a copy that did not finish is not left behind"
        );
    }

    #[test]
    fn copies_go_beside_the_terminal_installs_unless_the_launchers_setting_says_otherwise() {
        if std::env::var_os(BACKUP_DIR_ENV).is_none() {
            assert_eq!(
                backup_folder(Path::new("/Users/ana")),
                Path::new("/Users/ana/LoomWatch/backups/desktop-app")
            );
        }
    }

    #[cfg(target_os = "macos")]
    mod mac {
        use super::super::mac::*;
        use super::*;

        /// A `LoomWatch.app` of `version`, signed ad hoc as the packaging script signs one.
        fn app(folder: &Path, version: &str) -> PathBuf {
            let app = folder.join("LoomWatch.app");
            std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
            std::fs::create_dir_all(app.join("Contents/Resources")).unwrap();
            std::fs::write(app.join("Contents/MacOS/LoomWatch"), "#!/bin/sh\n").unwrap();
            std::fs::write(
                app.join("Contents/Resources/VERSION"),
                format!("{version} abc\n"),
            )
            .unwrap();
            std::fs::write(
                app.join("Contents/Info.plist"),
                format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.loomwatch.update-test</string>
<key>CFBundleExecutable</key><string>LoomWatch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
</dict></plist>
"#),
            )
            .unwrap();
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    app.join("Contents/MacOS/LoomWatch"),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
            let signed = Command::new("/usr/bin/codesign")
                .args(["--force", "--deep", "--sign", "-"])
                .arg(&app)
                .output()
                .unwrap();
            assert!(
                signed.status.success(),
                "{}",
                String::from_utf8_lossy(&signed.stderr)
            );
            app
        }

        /// `LoomWatch-macos.dmg` holding `app`, as the release has one.
        fn dmg(app_folder: &Path, out: &Path) -> PathBuf {
            let dmg = out.join("LoomWatch-macos.dmg");
            let made = Command::new("/usr/bin/hdiutil")
                .args([
                    "create",
                    "-quiet",
                    "-fs",
                    "HFS+",
                    "-volname",
                    "LoomWatch",
                    "-format",
                    "UDZO",
                ])
                .arg("-srcfolder")
                .arg(app_folder)
                .arg(&dmg)
                .output()
                .unwrap();
            assert!(
                made.status.success(),
                "{}",
                String::from_utf8_lossy(&made.stderr)
            );
            dmg
        }

        fn version(bundle: &Path) -> Option<String> {
            version_in(&bundle.join("Contents/Resources/VERSION"))
        }

        #[test]
        fn the_app_downloads_the_dmg_checks_it_and_swaps_the_new_version_in() {
            let scratch = Scratch::new();
            let applications = scratch.0.join("Applications");
            std::fs::create_dir_all(&applications).unwrap();
            let installed = app(&applications, "0.6.3");
            assert_eq!(can_replace(&installed), Ok(()));
            assert!(
                !staged(&installed).unwrap().exists(),
                "trying leaves nothing behind"
            );

            let release_folder = scratch.0.join("release");
            std::fs::create_dir_all(release_folder.join("app")).unwrap();
            app(&release_folder.join("app"), "0.7.0");
            let built = dmg(&release_folder.join("app"), &release_folder);
            let body = std::fs::read(&built).unwrap();
            let (base, _) = serve(vec![
                ("LoomWatch-macos.dmg".to_owned(), body.clone()),
                (
                    "LoomWatch-macos.dmg.sha256".to_owned(),
                    checksum_of(&body, "LoomWatch-macos.dmg"),
                ),
            ]);
            let work = scratch.0.join("state/app-update");
            let heard = Mutex::new(Vec::<String>::new());
            let log = |line: &str| heard.lock().unwrap().push(line.to_owned());
            let downloaded = download(&base, "LoomWatch-macos.dmg", &work, &log).unwrap();

            // A disk image of another version is not put in place.
            let refused = put_in_place(&downloaded, &installed, "0.7.1", &work, &log).unwrap_err();
            assert!(refused.contains("is version 0.7.0, not 0.7.1"), "{refused}");
            assert_eq!(version(&installed).as_deref(), Some("0.6.3"));
            assert!(!staged(&installed).unwrap().exists());

            put_in_place(&downloaded, &installed, "0.7.0", &work, &log).unwrap();
            assert_eq!(version(&installed).as_deref(), Some("0.7.0"));
            let kept = previous(&installed).unwrap();
            assert_eq!(kept.file_name().unwrap(), ".LoomWatch.app.previous");
            assert_eq!(
                version(&kept).as_deref(),
                Some("0.6.3"),
                "the version it replaced is kept"
            );
            assert!(!staged(&installed).unwrap().exists());
            let verified = Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&installed)
                .status()
                .unwrap();
            assert!(verified.success(), "the app in place is whole");
            let mounted = Command::new("/sbin/mount").output().unwrap();
            assert!(
                !String::from_utf8_lossy(&mounted.stdout).contains(&work.display().to_string()),
                "the disk image is detached"
            );

            // Not a disk image at all.
            std::fs::write(&downloaded, "not a disk image").unwrap();
            let refused = put_in_place(&downloaded, &installed, "0.7.0", &work, &log).unwrap_err();
            assert!(refused.contains("could not be opened"), "{refused}");
            assert_eq!(version(&installed).as_deref(), Some("0.7.0"));
        }

        #[test]
        fn an_app_that_cannot_be_replaced_says_why() {
            use std::os::unix::fs::PermissionsExt;
            let scratch = Scratch::new();
            let locked = scratch.0.join("Locked");
            std::fs::create_dir_all(&locked).unwrap();
            let installed = app(&locked, "0.6.3");
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
            let refused = can_replace(&installed);
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
            let refused = refused.unwrap_err();
            assert!(refused.contains("can’t change"), "{refused}");
            assert!(refused.contains(&locked.display().to_string()), "{refused}");

            let translocated =
                Path::new("/private/var/folders/xy/T/AppTranslocation/0A1B2C/d/LoomWatch.app");
            assert!(
                can_replace(translocated)
                    .unwrap_err()
                    .contains("temporary copy")
            );

            // Opened straight from the disk image, which is read-only.
            let source = scratch.0.join("source");
            std::fs::create_dir_all(&source).unwrap();
            app(&source, "0.6.3");
            let built = dmg(&source, &scratch.0);
            let volume = scratch.0.join("volume");
            std::fs::create_dir_all(&volume).unwrap();
            let attached = Command::new("/usr/bin/hdiutil")
                .args([
                    "attach",
                    "-nobrowse",
                    "-readonly",
                    "-noautoopen",
                    "-quiet",
                    "-mountpoint",
                ])
                .arg(&volume)
                .arg(&built)
                .status()
                .unwrap();
            assert!(attached.success());
            let refused = can_replace(&volume.join("LoomWatch.app"));
            let _ = Command::new("/usr/bin/hdiutil")
                .arg("detach")
                .arg(&volume)
                .args(["-quiet", "-force"])
                .status();
            assert!(refused.unwrap_err().contains("disk image"));
        }
    }
}
