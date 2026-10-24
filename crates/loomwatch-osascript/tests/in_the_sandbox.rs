//! `loomwatch-osascript` signed as the daemon signs it (`agent/sandbox.rs`), run inside a sandbox
//! that, like `LoomWatch`'s, lets programs write only to the temporary folders: scripts run, and a
//! script's shell commands still can't write anywhere else.
#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const OURS: &str = env!("CARGO_BIN_EXE_loomwatch-osascript");

const PROFILE: &str = "(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath \"/private/tmp\") (subpath \"/private/var/folders\") \
 (literal \"/dev/null\"))";

const ENTITLEMENTS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.temporary-exception.apple-events</key>
  <array><string>com.apple.iCal</string></array>
</dict></plist>
"#;

/// A signed copy of the stand-in in a folder of its own.
fn signed() -> PathBuf {
    let folder = std::env::temp_dir().join(format!(
        "loomwatch-osascript-sandbox-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&folder).unwrap();
    let program = folder.join("osascript");
    std::fs::copy(OURS, &program).unwrap();
    let entitlements = folder.join("entitlements.plist");
    std::fs::write(&entitlements, ENTITLEMENTS).unwrap();
    let signing = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--entitlements"])
        .arg(&entitlements)
        .arg(&program)
        .output()
        .unwrap();
    assert!(signing.status.success(), "{signing:?}");
    program
}

fn sandboxed(program: &Path, script: &str) -> Output {
    Command::new("/usr/bin/sandbox-exec")
        .args(["-p", PROFILE])
        .arg(program)
        .args(["-e", script])
        .output()
        .unwrap()
}

#[test]
fn signed_it_runs_scripts_in_the_sandbox_and_the_sandbox_still_holds() {
    let program = signed();
    let sum = sandboxed(&program, "return 1 + 1");
    assert_eq!(String::from_utf8_lossy(&sum.stdout), "2\n", "{sum:?}");

    let home = std::env::var("HOME").unwrap();
    let outside =
        PathBuf::from(home).join(format!(".loomwatch-osascript-probe-{}", std::process::id()));
    let wrote = sandboxed(
        &program,
        &format!("do shell script \"echo x > '{}'\"", outside.display()),
    );
    let refused = !outside.exists();
    let _ = std::fs::remove_file(&outside);
    assert!(
        refused,
        "a script's shell command wrote outside the sandbox"
    );
    assert!(
        String::from_utf8_lossy(&wrote.stderr).contains("Operation not permitted"),
        "{wrote:?}"
    );
    let _ = std::fs::remove_dir_all(program.parent().unwrap());
}
