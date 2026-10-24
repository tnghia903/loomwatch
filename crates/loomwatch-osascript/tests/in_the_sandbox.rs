//! `loomwatch-osascript` signed as the daemon signs it (`agent/sandbox.rs`), run inside a sandbox
//! that, like `LoomWatch`'s, lets programs write only to the temporary folders: scripts run, a
//! script's shell commands still can't write anywhere else, and an app macOS quit to free memory is
//! started again.
#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

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

/// A signed copy of the stand-in in a folder of its own, one for each test.
fn signed(test: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!(
        "loomwatch-osascript-sandbox-{test}-{}",
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
    let program = signed("holds");
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

/// A small app that, the first time it starts, has itself quit the way macOS quits an app under
/// memory pressure (`AppKit`'s own `_forceAutoQuit:`), which leaves it listed as running. Started
/// again, it stays a little and then quits for good.
const QUITS_ITSELF: &str = r#"
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
ProcessInfo.processInfo.automaticTerminationSupportEnabled = true
let again = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("started").path
if FileManager.default.fileExists(atPath: again) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { exit(0) }
} else {
    FileManager.default.createFile(atPath: again, contents: nil)
    let quit = NSSelectorFromString("_forceAutoQuit:")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        if app.responds(to: quit) { app.perform(quit, with: nil) }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { exit(0) }
}
app.run()
"#;

/// `QUITS_ITSELF` built as an app in `folder`, or `None` without a Swift compiler.
fn app_that_quits_itself(folder: &Path, id: &str) -> Option<PathBuf> {
    let app = folder.join("Quits Itself.app");
    let programs = app.join("Contents/MacOS");
    std::fs::create_dir_all(&programs).unwrap();
    let source = folder.join("quits-itself.swift");
    std::fs::write(&source, QUITS_ITSELF).unwrap();
    let built = Command::new("/usr/bin/swiftc")
        .args(["-O", "-o"])
        .arg(programs.join("QuitsItself"))
        .arg(&source)
        .output()
        .ok()
        .filter(|built| built.status.success())?;
    drop(built);
    std::fs::write(
        app.join("Contents/Info.plist"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{id}</string>
<key>CFBundleExecutable</key><string>QuitsItself</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSSupportsAutomaticTermination</key><true/>
</dict></plist>
"#
        ),
    )
    .unwrap();
    let signing = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(&app)
        .output()
        .unwrap();
    assert!(signing.status.success(), "{signing:?}");
    Some(app)
}

fn running(app: &Path) -> bool {
    Command::new("/usr/bin/pgrep")
        .arg("-f")
        .arg(app.join("Contents/MacOS/QuitsItself"))
        .output()
        .is_ok_and(|found| found.status.success())
}

fn listed(id: &str) -> bool {
    Command::new("/usr/bin/lsappinfo")
        .args(["find", &format!("bundleid={id}")])
        .output()
        .is_ok_and(|found| !found.stdout.trim_ascii().is_empty())
}

/// macOS keeps an app it quit to free memory listed as running, so `AppleScript` sends to it and
/// fails with "Application isn't running" (-600), in `/usr/bin/osascript` too. Ours starts it again
/// and sends once more. `run` needs no permission from the person, so nothing asks.
#[test]
fn an_app_macos_quit_to_free_memory_is_started_again() {
    let program = signed("quit-app");
    let folder = program.parent().unwrap().to_path_buf();
    let id = format!(
        "io.github.loomwatch.test.quits-itself-{}",
        std::process::id()
    );
    let Some(app) = app_that_quits_itself(&folder, &id) else {
        eprintln!("skipped: no Swift compiler to build the app that quits itself");
        return;
    };
    let opened = Command::new("/usr/bin/open")
        .arg("-g")
        .arg(&app)
        .output()
        .unwrap();
    assert!(opened.status.success(), "{opened:?}");
    let quit = |deadline: Instant| loop {
        if folder.join("started").exists() && !running(&app) {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if !quit(Instant::now() + Duration::from_secs(20)) || !listed(&id) {
        eprintln!("skipped: macOS didn't keep the app listed after quitting it");
        let _ = std::fs::remove_dir_all(&folder);
        return;
    }

    let ran = sandboxed(
        &program,
        &format!("tell application \"{}\" to run", app.display()),
    );
    let started = running(&app);
    let _ = Command::new("/usr/bin/pkill")
        .arg("-f")
        .arg(app.join("Contents/MacOS/QuitsItself"))
        .output();
    let _ = std::fs::remove_dir_all(&folder);
    assert!(ran.status.success(), "{ran:?}");
    assert!(started, "the app wasn't started again");
}
