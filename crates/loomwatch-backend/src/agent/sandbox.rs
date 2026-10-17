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
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let temp = canonical(&std::env::temp_dir());
    let cache = std::env::var_os("HOME").map_or_else(
        || temp.clone(),
        |home| canonical(&PathBuf::from(home).join("Library/Caches")),
    );
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

/// Whether a command's output reads like the sandbox stopped it.
pub(crate) fn denied(output: &str) -> bool {
    cfg!(target_os = "macos")
        && (output.contains("Operation not permitted") || output.contains("sandbox"))
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
