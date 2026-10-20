//! The sandbox an agent's commands run in on a Mac.
//!
//! macOS's Seatbelt (`/usr/bin/sandbox-exec`) is what `OpenAI`'s Codex CLI uses for the same job
//! (`codex-rs/sandboxing`, Apache-2.0). Codex starts from "deny everything" and lists hundreds of
//! exceptions; this profile starts from "allow" and takes away the two things a newcomer's agent
//! must not do by accident:
//! - change files outside its work folder (and temporary and cache folders, which tools need);
//! - reach the network, unless the agent is allowed the web.
//!
//! Every command is also approved before it runs, so the sandbox is the second line, not the
//! first. Other systems run commands without it for now.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use super::tools::CommandSettings;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The profile. `WORK`, `TMP` and `CACHE` are filled in per command; `WRITABLE_<n>` for extra
/// granted folders.
fn profile(network: bool, extra: usize) -> String {
    let mut profile = String::from(
        "(version 1)\n\
         (allow default)\n\
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
