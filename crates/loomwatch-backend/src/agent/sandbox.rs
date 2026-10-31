//! The sandbox an agent's commands run in on a Mac.
//!
//! macOS's Seatbelt (`/usr/bin/sandbox-exec`) is what `OpenAI`'s Codex CLI uses for the same job
//! (`codex-rs/sandboxing`, Apache-2.0). Codex starts from "deny everything" and lists hundreds of
//! exceptions; this profile starts from "allow" and takes away the things a newcomer's agent must
//! not do by accident:
//! - change files outside its work folder (and temporary and cache folders, which tools need);
//! - reach the network, unless the agent is allowed the web;
//! - use the microphone. macOS counts an agent's command as `LoomWatch`, and `LoomWatch` may be
//!   allowed the microphone so the box at the notch can listen while ⌃⌥Space is held: that
//!   permission is the person's, for talking, never an agent's.
//!
//! Every command is also approved before it runs, so the sandbox is the second line, not the
//! first. Other systems run commands without it for now.
//!
//! macOS refuses Apple Events from any sandboxed program whose signature lacks an Apple Events
//! entitlement, so `/usr/bin/osascript` can't work in Calendar, Mail or any other app from in here.
//! A command finds `LoomWatch`'s own `osascript` first on its `PATH` instead (ADR 0087): a copy of
//! `loomwatch-osascript` signed with that entitlement. macOS still asks the person once for each
//! app, and the sandbox still keeps writes to the work folder.

use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{PoisonError, RwLock};

use tokio::process::Command;

use super::tools::CommandSettings;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The `osascript` stand-in, built beside `loomwatchd` (`crates/loomwatch-osascript`).
const OSASCRIPT_PROGRAM: &str = "loomwatch-osascript";

/// What macOS looks for in a sandboxed program's signature before it delivers the Apple Events the
/// program sends. macOS 26 checks only that the entitlement is there; Apple's own apps are named so
/// that agents keep working in them should a later macOS read the list.
const ENTITLEMENTS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.temporary-exception.apple-events</key>
  <array>
    <string>com.apple.iCal</string>
    <string>com.apple.reminders</string>
    <string>com.apple.Notes</string>
    <string>com.apple.mail</string>
    <string>com.apple.AddressBook</string>
    <string>com.apple.MobileSMS</string>
    <string>com.apple.Music</string>
    <string>com.apple.Photos</string>
    <string>com.apple.Safari</string>
    <string>com.apple.finder</string>
    <string>com.apple.systemevents</string>
    <string>com.apple.shortcuts.events</string>
    <string>com.apple.iWork.Pages</string>
    <string>com.apple.iWork.Numbers</string>
    <string>com.apple.iWork.Keynote</string>
  </array>
</dict>
</plist>
"#;

/// The folder of `LoomWatch`'s own programs, first on every command's `PATH` once made.
static PROGRAMS: RwLock<Option<PathBuf>> = RwLock::new(None);

/// The profile. `WORK`, `TMP` and `CACHE` are filled in per command; `WRITABLE_<n>` for extra
/// granted folders.
fn profile(network: bool, extra: usize) -> String {
    let mut profile = String::from(
        "(version 1)\n\
         (allow default)\n\
         (deny device-microphone)\n\
         (deny file-write*)\n\
         (allow file-write*\n  \
           (subpath (param \"WORK\"))\n  \
           (subpath (param \"TMP\"))\n  \
           (subpath (param \"CACHE\"))\n  \
           (subpath \"/private/tmp\")\n  \
           (subpath \"/private/var/folders\")\n  \
           (literal \"/dev/null\")\n  \
           (literal \"/dev/zero\")\n  \
           (literal \"/dev/dtracehelper\")\n  \
           (regex #\"^/dev/tty\")\n  \
           (regex #\"^/dev/fd/\"))\n",
    );
    for index in 0..extra {
        let _ = writeln!(
            profile,
            "(allow file-write* (subpath (param \"WRITABLE_{index}\")))"
        );
    }
    if !network {
        profile.push_str("(deny network-outbound (remote ip))\n");
    }
    profile
}

/// `command` wrapped in the sandbox, or `None` where there is no sandbox to run it in.
pub(crate) fn wrap(command: &str, cwd: &Path, settings: &CommandSettings) -> Option<Command> {
    if !cfg!(target_os = "macos") || !Path::new(SANDBOX_EXEC).exists() {
        return None;
    }
    let (temp, cache) = temp_and_cache();
    let mut process = Command::new(SANDBOX_EXEC);
    process
        .arg("-p")
        .arg(profile(settings.network, settings.writable.len()))
        .arg("-D")
        .arg(format!("WORK={}", canonical(cwd).display()))
        .arg("-D")
        .arg(format!("TMP={}", temp.display()))
        .arg("-D")
        .arg(format!("CACHE={}", cache.display()));
    for (index, folder) in settings.writable.iter().enumerate() {
        process
            .arg("-D")
            .arg(format!("WRITABLE_{index}={}", canonical(folder).display()));
    }
    process.arg("/bin/sh").arg("-c").arg(command);
    Some(process)
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// The temporary folder and the cache folder (`~/Library/Caches`) a command may change.
fn temp_and_cache() -> (PathBuf, PathBuf) {
    let temp = canonical(&std::env::temp_dir());
    let cache = std::env::var_os("HOME").map_or_else(
        || temp.clone(),
        |home| canonical(&PathBuf::from(home).join("Library/Caches")),
    );
    (temp, cache)
}

/// Puts `LoomWatch`'s own `osascript` first on the `PATH` of agents' commands from now on: the
/// `loomwatch-osascript` beside this program, signed into `state_dir`. Only on a Mac; slow the
/// first time a version of `LoomWatch` runs, as it signs a copy, so call it off the async threads.
pub fn use_own_programs(state_dir: &Path) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let program = std::env::current_exe().map(|daemon| daemon.with_file_name(OSASCRIPT_PROGRAM));
    match program.and_then(|program| own_programs(&program, state_dir)) {
        Ok(folder) => *PROGRAMS.write().unwrap_or_else(PoisonError::into_inner) = Some(folder),
        Err(error) => eprintln!(
            "warning: agents' commands use macOS's own osascript, which the sandbox keeps from \
             other apps: {error}"
        ),
    }
}

/// `program` signed for Apple Events, as `osascript` in `state_dir/programs`, the folder it
/// returns. Signed once for each build of `program`: the next start finds it already there.
fn own_programs(program: &Path, state_dir: &Path) -> std::io::Result<PathBuf> {
    use sha2::{Digest as _, Sha256};

    let bytes = std::fs::read(program).map_err(|error| {
        std::io::Error::new(error.kind(), format!("{}: {error}", program.display()))
    })?;
    let digest = crate::skills_store::hex(&Sha256::digest(&bytes));
    let folder = state_dir.join("programs");
    let signed = folder.join("osascript");
    // Which build `signed` was copied from.
    let stamp = folder.join("osascript.from");
    if signed.is_file() && std::fs::read_to_string(&stamp).is_ok_and(|from| from.trim() == digest) {
        return Ok(folder);
    }
    std::fs::create_dir_all(&folder)?;
    // Signed under a name of its own, then moved into place whole.
    let fresh = folder.join(format!(".osascript-{}", std::process::id()));
    let entitlements = folder.join(format!(".osascript-{}.plist", std::process::id()));
    std::fs::write(&fresh, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::write(&entitlements, ENTITLEMENTS)?;
    let signing = std::process::Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--entitlements"])
        .arg(&entitlements)
        .arg(&fresh)
        .output();
    let _ = std::fs::remove_file(&entitlements);
    let failed = match signing {
        Ok(output) if output.status.success() => None,
        Ok(output) => Some(format!(
            "codesign: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Err(error) => Some(format!("codesign: {error}")),
    };
    if let Some(failed) = failed {
        let _ = std::fs::remove_file(&fresh);
        return Err(std::io::Error::other(failed));
    }
    std::fs::rename(&fresh, &signed)?;
    std::fs::write(&stamp, digest)?;
    Ok(folder)
}

/// The `PATH` a command gets: `LoomWatch`'s own programs first, once there are any, then the
/// daemon's own `path`. `None` leaves the command the daemon's.
pub(crate) fn path(path: Option<&OsStr>) -> Option<OsString> {
    let programs = PROGRAMS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()?;
    path_with(&programs, path)
}

/// Uses `folder` as `LoomWatch`'s own programs, as [`use_own_programs`] does once it has signed
/// them.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn use_programs_folder(folder: PathBuf) {
    *PROGRAMS.write().unwrap_or_else(PoisonError::into_inner) = Some(folder);
}

fn path_with(programs: &Path, path: Option<&OsStr>) -> Option<OsString> {
    // Without a `PATH` the shell would look in its own default folders; keep them.
    let rest = path.unwrap_or_else(|| OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin"));
    let rest = std::env::split_paths(rest).filter(|folder| folder != programs);
    std::env::join_paths(std::iter::once(programs.to_path_buf()).chain(rest)).ok()
}

/// Whether a failed command's output reads like the sandbox stopped it.
///
/// - The sandbox refuses with `EPERM`, which programs print as "Operation not permitted", Node in
///   lower case, and npm as a bare `code EPERM` under its own wrong guess ("Your cache folder
///   contains root-owned files").
/// - An `EPERM` about a folder the command may change is not the sandbox's: a locked file, or a
///   folder macOS keeps private, inside the work folder. Nor is `EACCES` ("Permission denied"),
///   which the sandbox never answers with.
/// - Without the web, curl and git only say they couldn't connect.
pub(crate) fn denied(output: &str, cwd: &Path, settings: &CommandSettings) -> bool {
    cfg!(target_os = "macos") && blocked(output, &writable(cwd, settings), settings.network)
}

/// Whether the sandbox kept `command` off the network it reaches for (ADR 0104): the agent may not
/// use the web, and the command names a web address or a program that downloads. The sandbox
/// tells the command nothing, and `curl -s` prints nothing, so this is read from the command line.
pub(crate) fn keeps_off_network(command: &str, settings: &CommandSettings) -> bool {
    cfg!(target_os = "macos")
        && !settings.network
        && Path::new(SANDBOX_EXEC).exists()
        && reaches_network(command)
}

/// Whether `command` names a web address or a program that goes to the network.
pub(crate) fn reaches_network(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    if command.contains("http://") || command.contains("https://") {
        return true;
    }
    let words: Vec<&str> = command
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')'))
        .filter(|word| !word.is_empty())
        .map(|word| word.rsplit('/').next().unwrap_or(word))
        .collect();
    let programs = ["curl", "wget", "ssh", "scp", "rsync", "ping", "nc", "ftp"];
    let fetching = [
        ("git", ["clone", "fetch", "pull", "push"].as_slice()),
        ("pip", &["install", "download"]),
        ("pip3", &["install", "download"]),
        ("npm", &["install", "i", "ci"]),
        ("brew", &["install", "update", "upgrade"]),
    ];
    words.iter().enumerate().any(|(at, word)| {
        programs.contains(word)
            || fetching.iter().any(|(program, actions)| {
                word == program && words.get(at + 1).is_some_and(|next| actions.contains(next))
            })
    })
}

/// The folders the profile lets a command change, as a command may print them: as given and with
/// links resolved (`/tmp` is `/private/tmp`).
fn writable(cwd: &Path, settings: &CommandSettings) -> Vec<String> {
    let (temp, cache) = temp_and_cache();
    let given = [cwd, &temp, &cache]
        .into_iter()
        .chain(settings.writable.iter().map(PathBuf::as_path))
        .flat_map(|folder| [folder.to_path_buf(), canonical(folder)]);
    [
        "/tmp",
        "/private/tmp",
        "/var/folders",
        "/private/var/folders",
        "/dev",
    ]
    .into_iter()
    .map(PathBuf::from)
    .chain(given)
    .map(|folder| folder.to_string_lossy().trim_end_matches('/').to_owned())
    .filter(|folder| !folder.is_empty())
    .collect()
}

fn blocked(output: &str, writable: &[String], network: bool) -> bool {
    if output.contains("sandbox") || (!network && output.contains("Couldn't connect to server")) {
        return true;
    }
    let refusals: Vec<&str> = output.lines().filter(|line| refused(line)).collect();
    if refusals.is_empty() {
        return false;
    }
    // npm names the path on a line of its own.
    let npm_paths = output
        .lines()
        .filter(|line| line.starts_with("npm error path /") || line.starts_with("npm ERR! path /"));
    let mut named = refusals
        .into_iter()
        .chain(npm_paths)
        .flat_map(paths)
        .peekable();
    // A refusal that names no path, such as a blocked connection, is the sandbox's.
    named.peek().is_none() || named.any(|path| !writable.iter().any(|folder| inside(path, folder)))
}

/// Whether a line reports an `EPERM`.
fn refused(line: &str) -> bool {
    line.to_ascii_lowercase()
        .contains("operation not permitted")
        || line
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| word == "EPERM")
}

/// Where each absolute path in a line starts, with the rest of the line after it: paths may hold
/// spaces (`Application Support`), so where one ends can't be told. A program that names itself
/// first (`/bin/sh: /x: Operation not permitted`) is not one of them.
fn paths(line: &str) -> impl Iterator<Item = &str> {
    let line = line
        .split_once(": ")
        .filter(|(program, rest)| {
            program.starts_with('/') && !program.contains(' ') && starts(rest).next().is_some()
        })
        .map_or(line, |(_, rest)| rest);
    starts(line)
}

fn starts(line: &str) -> impl Iterator<Item = &str> {
    line.char_indices().filter_map(move |(at, c)| {
        let starts = c == '/'
            && line[..at]
                .chars()
                .next_back()
                .is_none_or(|before| before.is_whitespace() || "'\"`([<=".contains(before));
        starts.then(|| &line[at..])
    })
}

/// Whether a path (and the rest of its line) is in `folder`.
fn inside(path: &str, folder: &str) -> bool {
    path.strip_prefix(folder).is_some_and(|rest| {
        rest.chars()
            .next()
            .is_none_or(|after| "/'\"`:,;)]> \t".contains(after))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_blocks_the_network_only_without_the_web() {
        assert!(profile(false, 0).contains("(deny network-outbound (remote ip))"));
        assert!(!profile(true, 0).contains("network"));
        assert!(profile(true, 2).contains("WRITABLE_1"));
    }

    #[test]
    fn the_profile_keeps_every_command_off_the_microphone() {
        for (network, extra) in [(false, 0), (true, 0), (true, 2)] {
            assert!(profile(network, extra).contains("(deny device-microphone)\n"));
        }
    }

    const WORK: &str = "/Users/me/Library/Application Support/LoomWatch/agents/coby";

    fn folders() -> Vec<String> {
        writable(Path::new(WORK), &CommandSettings::default())
    }

    /// What tools printed when the sandbox stopped them, from runs on a Mac.
    #[test]
    fn what_the_sandbox_refused_reads_as_the_sandbox() {
        let refused = [
            // npm's cache is in the home folder, and npm blames root-owned files.
            "npm error code EPERM\nnpm error syscall open\n\
             npm error path /Users/me/.npm/_cacache/tmp/4fa2b1c0\nnpm error errno EPERM\n\
             npm error\nnpm error Your cache folder contains root-owned files, due to a bug in \
             previous versions of npm which has since been addressed.\nnpm error\n\
             npm error To permanently fix this problem, please run:\n\
             npm error   sudo chown -R 501:20 \"/Users/me/.npm\"",
            "npm error code EPERM\nnpm error syscall mkdir\n\
             npm error path /usr/local/lib/node_modules/linkedom\nnpm error errno -1\n\
             npm error Error: EPERM: operation not permitted, mkdir \
             '/usr/local/lib/node_modules/linkedom'",
            "Error: EPERM: operation not permitted, open '/Users/me/notes.txt'\n    \
             at Object.writeFileSync (node:fs:2430:20)",
            "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\n\
             PermissionError: [Errno 1] Operation not permitted: '/Users/me/.local/x'",
            "error: Failed to initialize cache at `/Users/me/.cache/uv`\n  Caused by: failed \
             to open file `/Users/me/.cache/uv/sdists-v9/.git`: Operation not permitted (os \
             error 1)",
            "error: could not lock config file /Users/me/.gitconfig: Operation not permitted",
            "touch: /Library/x: Operation not permitted",
            "/bin/sh: /Users/me/notes.txt: Operation not permitted",
            "/Users/me/.config/tool: Operation not permitted",
            // Next to the work folder is still outside it.
            "touch: /Users/me/Library/Application Support/LoomWatch/agents/coby-2/x: Operation \
             not permitted",
            // Blocked connections name no path.
            "TypeError: fetch failed\n  [cause]: AggregateError [EPERM]: ",
            "urllib.error.URLError: <urlopen error [Errno 1] Operation not permitted>",
        ];
        for output in refused {
            assert!(blocked(output, &folders(), true), "{output}");
        }
        let curl = "curl: (7) Failed to connect to example.com port 443 after 63 ms: Couldn't \
                    connect to server";
        assert!(blocked(curl, &folders(), false));
        assert!(!blocked(curl, &folders(), true), "the web was allowed");
    }

    #[test]
    fn a_permission_problem_in_a_writable_folder_is_not_the_sandbox() {
        let ordinary = [
            // `EACCES` is a file's own permissions; the sandbox answers `EPERM`.
            "touch: locked/x: Permission denied",
            "Error: EACCES: permission denied, open '/Users/me/Library/Application \
             Support/LoomWatch/agents/coby/locked/x'",
            "PermissionError: [Errno 13] Permission denied: '/etc/sudoers'",
            // `EPERM` about the work folder itself: a locked file, or a folder macOS keeps
            // private.
            "/bin/sh: /Users/me/Library/Application Support/LoomWatch/agents/coby/locked: \
             Operation not permitted",
            "npm error code EPERM\nnpm error syscall open\n\
             npm error path /Users/me/Library/Application Support/LoomWatch/agents/coby/a.json\n\
             npm error errno EPERM",
            "Error: EPERM: operation not permitted, unlink '/tmp/held'",
            "error[E0425]: cannot find value `x` in this scope",
        ];
        for output in ordinary {
            assert!(!blocked(output, &folders(), true), "{output}");
        }
    }

    #[test]
    fn a_granted_folder_counts_as_writable() {
        let settings = CommandSettings {
            network: false,
            writable: vec![PathBuf::from("/Volumes/Shared/out/")],
        };
        let folders = writable(Path::new(WORK), &settings);
        let refused = |path: &str| format!("Error: EPERM: operation not permitted, open '{path}'");
        assert!(!blocked(&refused("/Volumes/Shared/out/x"), &folders, false));
        assert!(blocked(&refused("/Volumes/Shared/x"), &folders, false));
    }

    #[cfg(unix)]
    #[test]
    fn loomwatchs_own_programs_come_first_on_the_path() {
        let programs = Path::new("/s/programs");
        let path = path_with(programs, Some(OsStr::new("/usr/bin:/s/programs:/bin"))).unwrap();
        assert_eq!(path, "/s/programs:/usr/bin:/bin");
        assert_eq!(
            path_with(programs, None).unwrap(),
            "/s/programs:/usr/bin:/bin:/usr/sbin:/sbin"
        );
    }

    /// A folder for one test, removed after it.
    #[cfg(target_os = "macos")]
    struct Scratch(PathBuf);

    #[cfg(target_os = "macos")]
    impl Scratch {
        fn new() -> Self {
            let folder =
                std::env::temp_dir().join(format!("loomwatch-programs-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&folder).unwrap();
            Self(canonical(&folder))
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(target_os = "macos")]
    fn entitled_for_apple_events(program: &Path) -> bool {
        let shown = std::process::Command::new("/usr/bin/codesign")
            .args(["--display", "--entitlements", "-", "--xml"])
            .arg(program)
            .output()
            .unwrap();
        String::from_utf8_lossy(&shown.stdout)
            .contains("<key>com.apple.security.temporary-exception.apple-events</key>")
    }

    /// The copy carries the entitlement macOS looks for, and is signed once for each build.
    #[cfg(target_os = "macos")]
    #[test]
    fn on_a_mac_the_own_osascript_is_signed_for_apple_events_once_per_build() {
        let scratch = Scratch::new();
        let program = scratch.0.join(OSASCRIPT_PROGRAM);
        let state = scratch.0.join("state");
        // Any program stands in for the built one.
        std::fs::copy("/bin/echo", &program).unwrap();
        let folder = own_programs(&program, &state).unwrap();
        let signed = folder.join("osascript");
        assert!(entitled_for_apple_events(&signed));
        assert!(
            !entitled_for_apple_events(&program),
            "the built one is left as it was"
        );
        let modified = || std::fs::metadata(&signed).unwrap().modified().unwrap();
        let first = modified();
        own_programs(&program, &state).unwrap();
        assert_eq!(modified(), first, "signed again for the same build");

        std::fs::copy("/bin/cat", &program).unwrap();
        own_programs(&program, &state).unwrap();
        assert!(entitled_for_apple_events(&signed));
        let mut cat = std::process::Command::new(&signed)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut cat.stdin.take().unwrap(), b"the new build").unwrap();
        let out = cat.wait_with_output().unwrap();
        assert_eq!(
            out.stdout, b"the new build",
            "a new build replaces the copy"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&folder)
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    /// Calendar, Reminders, Contacts and Photos ask macOS whether `LoomWatch` may have their data
    /// before they answer an agent's script. macOS asks the person only when the app's
    /// `Info.plist` says why; without the line it refuses at once (`-1743`), and `LoomWatch` never
    /// shows up under that app in Privacy & Security.
    #[cfg(target_os = "macos")]
    #[test]
    fn on_a_mac_the_app_says_why_for_each_app_whose_data_macos_guards() {
        let info = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packaging/macos/Info.plist");
        let guarded: [(&str, &[&str]); 4] = [
            (
                "com.apple.iCal",
                &[
                    "NSCalendarsFullAccessUsageDescription",
                    "NSCalendarsUsageDescription",
                ],
            ),
            (
                "com.apple.reminders",
                &[
                    "NSRemindersFullAccessUsageDescription",
                    "NSRemindersUsageDescription",
                ],
            ),
            ("com.apple.AddressBook", &["NSContactsUsageDescription"]),
            ("com.apple.Photos", &["NSPhotoLibraryUsageDescription"]),
        ];
        for (app, keys) in guarded {
            assert!(
                ENTITLEMENTS.contains(&format!("<string>{app}</string>")),
                "{app}"
            );
            for key in keys {
                let read = std::process::Command::new("/usr/bin/plutil")
                    .args(["-extract", key, "raw", "-o", "-"])
                    .arg(&info)
                    .output()
                    .unwrap();
                let why = String::from_utf8_lossy(&read.stdout);
                assert!(
                    read.status.success() && !why.trim().is_empty(),
                    "{key} ({app}): {}",
                    String::from_utf8_lossy(&read.stderr)
                );
            }
        }
    }

    /// Inside the sandbox, a command's `osascript` is the signed copy.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn on_a_mac_a_sandboxed_command_finds_the_signed_osascript_first() {
        let scratch = Scratch::new();
        let program = scratch.0.join(OSASCRIPT_PROGRAM);
        std::fs::copy("/bin/echo", &program).unwrap();
        let folder = own_programs(&program, &scratch.0.join("state")).unwrap();
        let work = scratch.0.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let script = "command -v osascript; osascript from LoomWatch";
        let mut command = wrap(script, &work, &CommandSettings::default()).unwrap();
        let path = path_with(&folder, std::env::var_os("PATH").as_deref()).unwrap();
        let output = command
            .current_dir(&work)
            .env("PATH", path)
            .output()
            .await
            .unwrap();
        let printed = String::from_utf8_lossy(&output.stdout);
        let expected = format!("{}\nfrom LoomWatch\n", folder.join("osascript").display());
        assert_eq!(
            printed,
            expected,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// macOS's own check of a sandbox, asked from inside one: the microphone is refused, and the
    /// camera, which the profile leaves alone, is not. It is asked through Python, which comes with
    /// Apple's command line tools; on a Mac without them there is nothing to ask with.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn on_a_mac_a_command_is_refused_the_microphone() {
        let tools = std::process::Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .output();
        if !tools.is_ok_and(|tools| tools.status.success()) {
            eprintln!("skipped: no command line tools, so no Python to ask the sandbox with");
            return;
        }
        let base = std::env::temp_dir().join(format!("loomwatch-sandbox-{}", uuid::Uuid::new_v4()));
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let script = "/usr/bin/python3 -c 'import ctypes, os; check = ctypes.CDLL(None).sandbox_check; \
                      print(check(os.getpid(), b\"device-microphone\", 0), \
                      check(os.getpid(), b\"device-camera\", 0))'";
        let mut command =
            wrap(script, &work, &CommandSettings::default()).expect("macOS has sandbox-exec");
        let output = command.current_dir(&work).output().await.unwrap();
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "1 0\n",
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn on_a_mac_a_command_cannot_write_outside_its_folder() {
        let base = std::env::temp_dir().join(format!("loomwatch-sandbox-{}", uuid::Uuid::new_v4()));
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let home = std::env::var("HOME").unwrap();
        let outside =
            PathBuf::from(&home).join(format!(".loomwatch-sandbox-probe-{}", uuid::Uuid::new_v4()));
        let settings = CommandSettings::default();
        let script = format!(
            "echo inside > inside.txt; echo outside > '{}'",
            outside.display()
        );
        let mut command = wrap(&script, &work, &settings).expect("macOS has sandbox-exec");
        let output = command.current_dir(&work).output().await.unwrap();
        assert!(
            work.join("inside.txt").exists(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !outside.exists(),
            "the sandbox let a command write to the home folder"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
