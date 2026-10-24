//! The quality bench's developer build, through the real program. Without the `prompt-overrides`
//! feature, `loomwatchd` holds no way to read overrides at all; with it, it reads them at start-up
//! from `LOOMWATCH_PROMPT_OVERRIDES` and writes every block with `--dump-prompt-blocks`.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const DAEMON: &str = env!("CARGO_BIN_EXE_loomwatchd");

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("loomwatch-overrides-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Which of `words` the program's own bytes hold, as the text of a setting or flag would be. One
/// pass: the program is over 100 MB in a debug build.
fn program_holds(words: &[&str]) -> BTreeSet<String> {
    let program = fs::read(DAEMON).unwrap();
    let any = words
        .iter()
        .map(|word| regex::escape(word))
        .collect::<Vec<_>>();
    regex::bytes::Regex::new(&any.join("|"))
        .unwrap()
        .find_iter(&program)
        .map(|found| String::from_utf8_lossy(found.as_bytes()).into_owned())
        .collect()
}

/// A build without the feature has no setting, flag or code to read overrides with: the words
/// are not in the program, and the flag is refused. `LOOMWATCH_STATE_DIR`, a setting it does read,
/// shows the search would find one.
#[cfg(not(feature = "prompt-overrides"))]
#[test]
fn a_build_without_the_feature_cannot_read_overrides() {
    assert_eq!(
        program_holds(&[
            "LOOMWATCH_STATE_DIR",
            "LOOMWATCH_PROMPT_OVERRIDES",
            "prompt-overrides",
            "dump-prompt-blocks",
        ]),
        BTreeSet::from(["LOOMWATCH_STATE_DIR".to_owned()]),
        "{DAEMON}"
    );
    let folder = Folder::new();
    let dump = folder.0.join("blocks");
    let output = Command::new(DAEMON)
        .arg("--dump-prompt-blocks")
        .arg(&dump)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!dump.exists());
}

/// Started with an override, the dump writes it in place of its block and every other block as
/// written, and lists each one; that dump, given back as the overrides, writes the same files.
#[cfg(feature = "prompt-overrides")]
#[test]
fn the_dump_writes_every_block_as_the_overrides_left_it() {
    assert_eq!(
        program_holds(&["LOOMWATCH_PROMPT_OVERRIDES", "dump-prompt-blocks"]).len(),
        2
    );
    let folder = Folder::new();
    let overrides = folder.0.join("overrides");
    fs::create_dir(&overrides).unwrap();
    fs::write(
        overrides.join("orientation.delegation.md"),
        "Hand out the work.\n",
    )
    .unwrap();
    let first = folder.0.join("first");
    let output = Command::new(DAEMON)
        .env("LOOMWATCH_PROMPT_OVERRIDES", &overrides)
        .arg("--dump-prompt-blocks")
        .arg(&first)
        .output()
        .unwrap();
    let listed = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("1 block(s) replaced"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(first.join("orientation.delegation.md")).unwrap(),
        "Hand out the work.\n"
    );
    assert!(
        fs::read_to_string(first.join("system.intro.md"))
            .unwrap()
            .starts_with("You are an agent in LoomWatch, working on a task for {the_person}.")
    );
    assert!(
        listed
            .lines()
            .any(|line| line == "orientation.lead  {name} {team}"),
        "{listed}"
    );
    assert_eq!(
        fs::read_dir(&first).unwrap().count(),
        listed.lines().count()
    );

    let second = folder.0.join("second");
    let output = Command::new(DAEMON)
        .arg("--prompt-overrides")
        .arg(&first)
        .arg("--dump-prompt-blocks")
        .arg(&second)
        .output()
        .unwrap();
    assert!(output.status.success());
    for entry in fs::read_dir(&first).unwrap() {
        let name = entry.unwrap().file_name();
        assert_eq!(
            fs::read(first.join(&name)).unwrap(),
            fs::read(second.join(&name)).unwrap(),
            "{name:?}"
        );
    }
}

/// A folder holding a file that is no block stops `loomwatchd serve` before it listens, naming the
/// file.
#[cfg(feature = "prompt-overrides")]
#[test]
fn an_unknown_file_stops_the_start() {
    let folder = Folder::new();
    let overrides = folder.0.join("overrides");
    fs::create_dir(&overrides).unwrap();
    fs::write(overrides.join("system.intro.md"), "Hello, {the_person}.").unwrap();
    fs::write(overrides.join("sytem.plan.md"), "- Plan.").unwrap();
    let mut serving = Command::new(DAEMON)
        .env("LOOMWATCH_PROMPT_OVERRIDES", &overrides)
        .env("LOOMWATCH_STATE_DIR", folder.0.join("state"))
        .env("LOOMWATCH_KEY_STORE", "file")
        .env("LOOMWATCH_UPDATE_CHECK", "off")
        .args(["serve", "--listen", "127.0.0.1:0", "--teams-root"])
        .arg(&folder.0)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while serving.try_wait().unwrap().is_none() {
        if std::time::Instant::now() > deadline {
            let _ = serving.kill();
            panic!("loomwatchd kept running with an unknown file in its overrides");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let output = serving.wait_with_output().unwrap();
    let said = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success());
    assert!(
        said.contains("holds sytem.plan.md, which is not a prompt block"),
        "{said}"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("listening"));
}
