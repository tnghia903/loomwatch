//! `loomwatch-osascript` against `/usr/bin/osascript`: the same command lines, the same standard
//! input, and the same standard output, standard error and exit code. None of these scripts talks
//! to another app, so none of them needs macOS's permission to run.
#![cfg(target_os = "macos")]

use std::io::Write as _;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const OURS: &str = env!("CARGO_BIN_EXE_loomwatch-osascript");
const REAL: &str = "/usr/bin/osascript";

struct Case {
    args: &'static [&'static str],
    stdin: Option<&'static str>,
}

const fn args(args: &'static [&'static str]) -> Case {
    Case { args, stdin: None }
}

const CASES: &[Case] = &[
    // Results, for people and as source.
    args(&["-e", "return \"hi\""]),
    args(&["-e", "{1, \"a\", {b:2}, 2.5, missing value, true}"]),
    args(&["-e", "return {name:\"x\", |odd key|:2}"]),
    args(&["-s", "s", "-e", "{1, \"a\", {b:2}}"]),
    args(&["-e", "set x to 1"]),
    args(&["-e", "return"]),
    args(&["-e", "return \"\""]),
    args(&["-e", "return \"héllo ✓\""]),
    args(&["-e", "return \"one\" & linefeed & \"two\""]),
    args(&["-e", "return 1.0E+20"]),
    args(&["-e", "return path to home folder"]),
    // Errors, in both places they can go.
    args(&["-e", "set x to"]),
    args(&["-e", "error \"boom\" number 42"]),
    args(&["-e", "return 1 / 0"]),
    args(&["-s", "o", "-e", "error \"out\""]),
    // `log` lines go to standard error, always for people.
    args(&[
        "-e",
        "log \"to stderr\"",
        "-e",
        "log {1, 2}",
        "-e",
        "return 3",
    ]),
    args(&["-s", "s", "-e", "log \"for people\"", "-e", "return \"x\""]),
    args(&["-e", "log 1"]),
    // Arguments reach the `run` handler.
    args(&[
        "-e",
        "on run argv",
        "-e",
        "return (count of argv) & item 1 of argv",
        "-e",
        "end run",
        "hello",
        "there",
    ]),
    args(&[
        "-e",
        "on run argv",
        "-e",
        "return count of argv",
        "-e",
        "end run",
    ]),
    args(&[
        "-e",
        "on run argv",
        "-e",
        "return item 1 of argv",
        "-e",
        "end run",
        "ünï ✓",
    ]),
    // JavaScript for Automation.
    args(&["-l", "JavaScript", "-e", "1+1"]),
    args(&["-l", "JavaScript", "-e", "console.log(\"c\"); [1, \"a\"]"]),
    args(&[
        "-l",
        "JavaScript",
        "-e",
        "function run(argv) { return argv.join(\"+\") }",
        "a",
        "b",
    ]),
    args(&["-l", "JavaScript", "-e", "x.y"]),
    args(&["-l", "javascript", "-e", "1+1"]),
    args(&["-l", "Foo", "-e", "1"]),
    // Script files, text and compiled, and standard input.
    args(&["args.applescript", "one", "two"]),
    args(&["compiled.scpt", "x", "y"]),
    args(&["-l", "JavaScript", "shebang.js", "a", "b", "c"]),
    args(&["missing.applescript"]),
    Case {
        args: &[],
        stdin: Some("on run argv\nreturn \"stdin \" & (count of argv)\nend run\n"),
    },
    Case {
        args: &["-", "one"],
        stdin: Some("on run argv\nreturn item 1 of argv\nend run\n"),
    },
    // Command lines it can't read.
    args(&["-x"]),
    args(&["-e"]),
    args(&["-s", "z", "-e", "1"]),
];

/// A folder with the script files the cases name.
fn scripts() -> PathBuf {
    let folder = std::env::temp_dir().join(format!("loomwatch-osascript-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("args.applescript"),
        "on run argv\nreturn \"file:\" & (item 2 of argv)\nend run\n",
    )
    .unwrap();
    std::fs::write(
        folder.join("shebang.js"),
        "#!/usr/bin/osascript -l JavaScript\nfunction run(argv) { return argv.length }\n",
    )
    .unwrap();
    let compiled = Command::new("/usr/bin/osacompile")
        .current_dir(&folder)
        .args(["-o", "compiled.scpt", "-e", "on run argv"])
        .args([
            "-e",
            "return \"compiled \" & (count of argv)",
            "-e",
            "end run",
        ])
        .output()
        .unwrap();
    assert!(compiled.status.success(), "{compiled:?}");
    folder
}

/// Started by the name commands use, which `getopt`'s complaints begin with.
fn run(program: &str, case: &Case, folder: &Path) -> Output {
    let mut child = Command::new(program)
        .arg0("osascript")
        .args(case.args)
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(case.stdin.unwrap_or_default().as_bytes())
        .unwrap();
    drop(stdin);
    child.wait_with_output().unwrap()
}

#[test]
fn every_case_prints_what_osascript_prints() {
    let folder = scripts();
    let mut different = Vec::new();
    for case in CASES {
        let real = run(REAL, case, &folder);
        let ours = run(OURS, case, &folder);
        let shown = |output: &Output| {
            format!(
                "exit {:?}, stdout {:?}, stderr {:?}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        };
        if shown(&real) != shown(&ours) {
            different.push(format!(
                "{:?}\n  osascript: {}\n  ours:      {}",
                case.args,
                shown(&real),
                shown(&ours)
            ));
        }
    }
    let _ = std::fs::remove_dir_all(&folder);
    assert!(different.is_empty(), "{}", different.join("\n"));
}

/// `getopt`'s complaints begin with the name the program was started by, whatever it is.
#[test]
fn bad_command_lines_name_the_program_as_it_was_started() {
    for args in [["-x"], ["-e"]] {
        let started = |program: &str| {
            let output = Command::new(program)
                .arg0("/some/folder/osascript")
                .args(args)
                .stdin(Stdio::null())
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stderr).into_owned()
        };
        let real = started(REAL);
        assert!(real.starts_with("/some/folder/osascript: "), "{real}");
        assert_eq!(started(OURS), real);
    }
}

/// After macOS's own line for a refusal, the setting that lifts it, where the error goes. A script
/// raising the number itself stands in for macOS, which asks no one here.
#[test]
fn a_refusal_names_the_automation_setting() {
    for (args, to_stdout) in [
        (&["-e", "error \"Not authorized.\" number -1743"][..], false),
        (
            &["-s", "o", "-e", "error \"Not authorized.\" number -1743"][..],
            true,
        ),
    ] {
        let output = Command::new(OURS).args(args).output().unwrap();
        let said = String::from_utf8_lossy(if to_stdout {
            &output.stdout
        } else {
            &output.stderr
        })
        .into_owned();
        let mut lines = said.lines();
        assert_eq!(
            lines.next(),
            Some("6:23: execution error: Not authorized. (-1743)"),
            "{said}"
        );
        assert!(
            lines
                .next()
                .is_some_and(|hint| hint.contains("Privacy & Security → Automation → LoomWatch")),
            "{said}"
        );
    }
    let other = Command::new(OURS)
        .args(["-e", "error \"boom\" number 42"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&other.stderr).lines().count(), 1);
}

#[test]
fn interactive_mode_says_why_it_is_not_there() {
    let output = Command::new(OURS)
        .arg("-i")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("-i waits for someone typing"));
}
