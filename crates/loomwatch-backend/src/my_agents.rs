//! Every agent lives in My agents (ADR 0094).
//!
//! A team file's agent entry points at one of the person's agents, `from: {agent: <id>}`, and
//! holds only what is the team's: where it works, what the team connects to it beyond what it
//! reads itself, its place in the flow, what the team turned off for it, its spending guard there
//! and whether it learns there. The agent's own fields (its name, instructions, model, skills,
//! tools and their always-allowed calls, what it reads, Done when, switches and helpers switch)
//! come from `<teams root>/.jobs/<id>.yaml` each time the team is read, so a change saved to the
//! agent reaches every team that uses it from that team's next run.
//!
//! An entry that still holds instructions of its own (`role`) runs as it is written: a team file
//! written out in full, an example, or one from before the move. Its `from` then only names whose
//! lessons it reads (ADR 0078).
//!
//! The app fills a team the same way (`ui/src/lib/team-file/myAgents.ts`); both are tested with
//! the cases in `schemas/my-agents.cases.json`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_yaml::{Mapping, Value};

use crate::jobs::{self, JobRead, JobSpec};

/// The folder in the teams folder that holds My agents, one file each.
pub(crate) const FOLDER: &str = ".jobs";

/// Fill in every agent of a team document that points at one of My agents and holds none of its
/// own fields, from its file under `teams_root`.
///
/// # Errors
///
/// An agent that points at one of My agents that isn't there, or no longer reads as one, and has
/// nothing of its own to run with: the message names it and says what to do.
pub(crate) fn fill(document: &mut Value, teams_root: &Path) -> Result<(), String> {
    let Some(agents) = document.get_mut("agents").and_then(Value::as_sequence_mut) else {
        return Ok(());
    };
    for entry in agents {
        let Some(entry) = entry.as_mapping_mut() else {
            continue;
        };
        let Some(agent) = pointer(entry) else {
            continue;
        };
        let Some(spec) = jobs::read_job(teams_root, &agent) else {
            return Err(missing(entry, &agent));
        };
        fill_entry(entry, &agent, &spec);
    }
    Ok(())
}

/// Copy every team file in `teams_root`, and the files of My agents with their chats' teams, into
/// a dated folder in `state_dir`, once per teams folder, before the first `LoomWatch` that moves
/// teams onto My agents changes any (ADR 0094). Putting the copies back undoes the move. What the
/// move never touches, files agents read (`.jobs/.files`) and versions an earlier `LoomWatch`
/// kept, is left where it is. Returns the folder when it made one.
///
/// # Errors
///
/// When a file can't be copied or the mark can't be written: the daemon then doesn't start, so
/// nothing changes a team without its copy kept.
pub fn back_up_once(
    state_dir: &Path,
    teams_root: &Path,
) -> std::io::Result<Option<std::path::PathBuf>> {
    let mark = mark_path(state_dir, teams_root);
    if mark.is_file() {
        return Ok(None);
    }
    let mut files = crate::api::discover_team_files(teams_root).unwrap_or_default();
    for inner in [FOLDER.to_owned(), format!("{FOLDER}/{}", jobs::BENCH_DIR)] {
        let Ok(entries) = std::fs::read_dir(teams_root.join(&inner)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && Path::new(&name)
                    .extension()
                    .is_some_and(|extension| extension == "yaml" || extension == "yml")
            {
                files.push(format!("{inner}/{name}"));
            }
        }
    }
    // A teams folder with nothing in it yet has nothing to keep.
    let folder = (!files.is_empty()).then(|| {
        state_dir.join("backups").join(format!(
            "{}-before-my-agents-{}",
            chrono::Utc::now().format("%Y-%m-%d"),
            folder_key(teams_root)
        ))
    });
    if let Some(folder) = &folder {
        for file in &files {
            copy_into(teams_root, file, folder)?;
        }
    }
    let record = serde_json::json!({
        "teamsRoot": teams_root.display().to_string(),
        "backup": folder.as_ref().map(|folder| folder.display().to_string()),
        "files": files,
        "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    crate::approvals::write_private(
        &mark,
        &serde_json::to_vec_pretty(&record).map_err(std::io::Error::other)?,
    )?;
    Ok(folder)
}

fn mark_path(state_dir: &Path, teams_root: &Path) -> std::path::PathBuf {
    state_dir.join(format!("my-agents-move-{}.json", folder_key(teams_root)))
}

/// Where the move onto My agents stands for a teams folder (ADR 0094): whether the app has moved
/// its teams yet, and what it changed in each team, by the team's path, as that team's chat says
/// it once.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_at: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub changed: std::collections::BTreeMap<String, Vec<String>>,
}

/// What [`record_moved`] wrote for `teams_root`, or nothing yet.
#[must_use]
pub fn moved(state_dir: &Path, teams_root: &Path) -> Move {
    std::fs::read(mark_path(state_dir, teams_root))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Move>(&bytes).ok())
        .unwrap_or_default()
}

/// The app moved the teams of `teams_root` onto My agents: keep when, and which agents it changed
/// in each team, beside the backup's record.
///
/// # Errors
///
/// When the mark can't be written.
pub fn record_moved(
    state_dir: &Path,
    teams_root: &Path,
    changed: std::collections::BTreeMap<String, Vec<String>>,
) -> std::io::Result<()> {
    let path = mark_path(state_dir, teams_root);
    let mut record = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    record["movedAt"] =
        serde_json::json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    record["changed"] = serde_json::to_value(changed).map_err(std::io::Error::other)?;
    crate::approvals::write_private(
        &path,
        &serde_json::to_vec_pretty(&record).map_err(std::io::Error::other)?,
    )
}

/// A short name for a teams folder, so two folders' moves never share a mark or a backup.
fn folder_key(teams_root: &Path) -> String {
    use sha2::Digest as _;
    use std::fmt::Write as _;
    let digest = sha2::Sha256::digest(teams_root.as_os_str().as_encoded_bytes());
    let mut key = String::new();
    for byte in &digest[..6] {
        let _ = write!(key, "{byte:02x}");
    }
    key
}

/// Copy `file`, relative to `teams_root`, to the same place under `folder`.
fn copy_into(teams_root: &Path, file: &str, folder: &Path) -> std::io::Result<()> {
    let target = folder.join(file);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(teams_root.join(file), target).map(|_| ())
}

/// The agents of My agents a team document's entries are filled in from, each once: what it runs
/// besides its own file, and so what has to be approved with it (ADR 0048). Nothing for a document
/// that isn't YAML: reading it says what is wrong.
pub(crate) fn filled_from(source: &str) -> Vec<String> {
    let Ok(document) = serde_yaml::from_str::<Value>(source) else {
        return Vec::new();
    };
    let mut agents: Vec<String> = document
        .get("agents")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(Value::as_mapping)
        .filter_map(pointer)
        .collect();
    agents.sort();
    agents.dedup();
    agents
}

/// The agents a save made into agents of My agents: each agent of `after`, by its id in the team,
/// that points at one there (`from: {agent}`) while the same agent in `before` pointed at none, and
/// the agent it points at. Their lessons were the team's and become the agent's (ADR 0094).
pub(crate) fn became_mine(before: &str, after: &str) -> Vec<(String, String)> {
    let entries = |source: &str| -> Vec<Mapping> {
        serde_yaml::from_str::<Value>(source)
            .ok()
            .and_then(|document| document.get("agents")?.as_sequence().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entry| entry.as_mapping().cloned())
            .collect()
    };
    let id = |entry: &Mapping| entry.get("id").and_then(Value::as_str).map(str::to_owned);
    let mine = |entry: &Mapping| {
        entry
            .get("from")
            .and_then(|from| from.get("agent"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let before = entries(before);
    entries(after)
        .iter()
        .filter_map(|entry| Some((id(entry)?, mine(entry)?)))
        .filter(|(agent, _)| {
            before
                .iter()
                .any(|earlier| id(earlier).as_ref() == Some(agent) && mine(earlier).is_none())
        })
        .collect()
}

/// The names of the teams in `teams_root` that have agent `agent` of My agents on them, in the
/// team list's order: a team file whose entry names it in `from`, filled in or written out.
pub(crate) fn teams_using(teams_root: &Path, agent: &str) -> Vec<String> {
    let Ok(files) = crate::api::discover_team_files(teams_root) else {
        return Vec::new();
    };
    files
        .into_iter()
        .filter_map(|file| {
            let path = teams_root.join(&file);
            let document: Value =
                serde_yaml::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
            let uses = document.get("agents")?.as_sequence()?.iter().any(|entry| {
                entry
                    .get("from")
                    .and_then(|from| from.get("agent"))
                    .and_then(Value::as_str)
                    == Some(agent)
            });
            uses.then(|| {
                document
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map_or_else(
                        || {
                            path.file_stem()
                                .map_or(file, |stem| stem.to_string_lossy().into_owned())
                        },
                        str::to_owned,
                    )
            })
        })
        .collect()
}

/// "A", "A and B", "A, B and C".
pub(crate) fn listed(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [only] => only.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The teams folder a team file is read in: the nearest folder that holds My agents (`.jobs`), from
/// the file's own folder upward, or the file's own folder when none does. An agent's own chat, kept
/// in `.jobs/.bench/`, is read in the teams folder above it.
pub(crate) fn teams_root_of(team_path: &Path) -> PathBuf {
    let folder = team_path
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    folder
        .ancestors()
        .find(|candidate| candidate.join(FOLDER).is_dir())
        .unwrap_or(folder)
        .to_path_buf()
}

/// The agent in My agents an entry points at, when the entry holds none of the agent's own fields
/// and so is to be filled in: not a review stop, and no `role` of its own.
fn pointer(entry: &Mapping) -> Option<String> {
    if entry.get("kind").and_then(Value::as_str) == Some("operator") || entry.contains_key("role") {
        return None;
    }
    entry.get("from")?.get("agent")?.as_str().map(str::to_owned)
}

fn missing(entry: &Mapping, agent: &str) -> String {
    let id = entry.get("id").and_then(Value::as_str).unwrap_or(agent);
    format!(
        "The agent “{id}” isn't in My agents any more, so this team can't run. In Workflow, \
         select it, press Delete and save."
    )
}

/// `entry` with the fields of `spec`, agent `agent` in My agents, filled in over it: what the team
/// file's entry for it would hold were the agent written out in full. Everything that is the
/// team's stays as the entry has it.
pub(crate) fn fill_entry(entry: &mut Mapping, agent: &str, spec: &JobSpec) {
    set(entry, "name", spec.name.clone());
    set(entry, "role", spec.instructions.clone());
    if let Some(model) = &spec.model {
        set(entry, "model", model.clone());
        // The effort goes with the model it belongs to, and a model the agent names is its own
        // choice, not one the app suggests.
        match &spec.thinking_effort {
            Some(effort) => set(entry, "thinkingEffort", effort.clone()),
            None => {
                entry.remove("thinkingEffort");
            }
        }
        entry.remove("followsSuggestion");
    }
    let capabilities = capabilities(entry, spec);
    if capabilities.is_empty() {
        entry.remove("capabilities");
    } else {
        set(entry, "capabilities", Value::Sequence(capabilities));
    }
    if spec.done_when.is_empty() {
        entry.remove("doneWhen");
    } else {
        set(entry, "doneWhen", spec.done_when.clone());
    }
    let mut allow = Mapping::new();
    for (switch, on) in [
        ("web", spec.allow.web),
        ("edits", spec.allow.edits),
        ("commands", spec.allow.commands),
    ] {
        if on {
            allow.insert(switch.into(), true.into());
        }
    }
    if allow.is_empty() {
        entry.remove("allow");
    } else {
        set(entry, "allow", Value::Mapping(allow));
    }
    if spec.helpers {
        entry.remove("allowRecruiting");
    } else {
        set(entry, "allowRecruiting", false);
    }
    if spec.brings_in {
        entry.remove("allowMyAgents");
    } else {
        set(entry, "allowMyAgents", false);
    }
    let mut from = Mapping::new();
    from.insert("agent".into(), agent.into());
    set(entry, "from", Value::Mapping(from));
}

fn set(entry: &mut Mapping, key: &str, value: impl Into<Value>) {
    entry.insert(key.into(), value.into());
}

/// What the team connected to the agent beyond what it reads itself, then what it reads, its
/// skills and its tools less what the team turned off (ADR 0060), then the skills and tools the
/// team gives it besides: the order the app fills them in too.
fn capabilities(entry: &Mapping, spec: &JobSpec) -> Vec<Value> {
    let given: Vec<&Value> = entry
        .get("capabilities")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .collect();
    let kind = |capability: &Value| {
        capability
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let named = |capability: &Value| {
        capability
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let off: BTreeSet<(Option<String>, Option<String>)> = entry
        .get("turnedOff")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .map(|item| (kind(item), named(item)))
        .collect();
    let reads: BTreeSet<String> = spec.reads.iter().map(job_read_key).collect();
    let mut kept: Vec<Value> = given
        .iter()
        .filter(|capability| {
            kind(capability).as_deref() == Some("knowledge")
                && !reads.contains(&entry_read_key(capability))
        })
        .map(|capability| (*capability).clone())
        .collect();
    // The skills and tools the team wired beyond the agent's own: given in that team only.
    let besides: Vec<Value> = given
        .iter()
        .filter(|capability| match kind(capability).as_deref() {
            Some("skill") => !named(capability).is_some_and(|name| spec.skills.contains(&name)),
            Some("tool") => !named(capability).is_some_and(|name| spec.tools.contains(&name)),
            _ => false,
        })
        .map(|capability| (*capability).clone())
        .collect();
    let is_off =
        |kind: &str, name: &str| off.contains(&(Some(kind.to_owned()), Some(name.to_owned())));
    // Each label once, as the team's cards are named: a read of the agent's takes another when
    // the team uses its name.
    let mut taken: BTreeSet<String> = kept
        .iter()
        .filter_map(|capability| capability.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    for read in &spec.reads {
        kept.push(knowledge(read, unique_label(&read.name, &mut taken)));
    }
    for skill in spec.skills.iter().filter(|skill| !is_off("skill", skill)) {
        let mut capability = Mapping::new();
        capability.insert("kind".into(), "skill".into());
        capability.insert("name".into(), skill.as_str().into());
        kept.push(Value::Mapping(capability));
    }
    for tool in spec.tools.iter().filter(|tool| !is_off("tool", tool)) {
        let mut capability = Mapping::new();
        capability.insert("kind".into(), "tool".into());
        capability.insert("name".into(), tool.as_str().into());
        if let Some(calls) = spec.tool_allow.get(tool).filter(|calls| !calls.is_empty()) {
            capability.insert(
                "alwaysAllow".into(),
                calls
                    .iter()
                    .map(|call| Value::from(call.as_str()))
                    .collect(),
            );
        }
        kept.push(Value::Mapping(capability));
    }
    kept.extend(besides);
    kept
}

fn knowledge(read: &JobRead, name: String) -> Value {
    let mut capability = Mapping::new();
    capability.insert("kind".into(), "knowledge".into());
    capability.insert("name".into(), name.into());
    if let Some(notion) = &read.notion {
        let mut page = Mapping::new();
        page.insert("page".into(), notion.page.as_str().into());
        capability.insert("notion".into(), Value::Mapping(page));
    } else if let Some(path) = &read.path {
        capability.insert("path".into(), path.as_str().into());
    }
    Value::Mapping(capability)
}

/// Which folder, file or page a read names, whatever it is labelled (`readKey` in the app).
fn job_read_key(read: &JobRead) -> String {
    match &read.notion {
        Some(notion) => format!("notion:{}", notion_page_key(&notion.page)),
        None => format!("path:{}", read.path.as_deref().unwrap_or_default()),
    }
}

fn entry_read_key(capability: &Value) -> String {
    match capability
        .get("notion")
        .and_then(|notion| notion.get("page"))
        .and_then(Value::as_str)
    {
        Some(page) => format!("notion:{}", notion_page_key(page)),
        None => format!(
            "path:{}",
            capability
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
    }
}

/// A Notion page however it was written down: its id, lowercase, without dashes
/// (`notionPageKey` in the app).
fn notion_page_key(page: &str) -> String {
    page.trim().to_lowercase().replace('-', "")
}

/// `name`, or `name (2)`, `name (3)`… when it is taken; the label it gets is taken from then on
/// (`uniqueLabel` in the app).
fn unique_label(name: &str, taken: &mut BTreeSet<String>) -> String {
    let mut label = name.to_owned();
    let mut counter = 2;
    while taken.contains(&label) {
        label = format!("{name} ({counter})");
        counter += 1;
    }
    taken.insert(label.clone());
    label
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct Folder(PathBuf);

    impl Folder {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn teams_folder() -> Folder {
        let path =
            std::env::temp_dir().join(format!("loomwatch-my-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).expect("a teams folder");
        // As the daemon holds its teams folder: the team list only lists files below it.
        Folder(crate::platform::canonicalize(&path).expect("a canonical teams folder"))
    }

    /// The cases the app's twin is tested with too (`myAgents.test.ts`): a team file's entry and
    /// the agent in My agents it points at, and the entry as a run reads it.
    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        entry: Value,
        agent: String,
        job: Value,
        filled: Value,
    }

    #[test]
    fn a_pointer_is_filled_in_from_my_agents_as_the_app_fills_it() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../schemas/my-agents.cases.json"))
                .expect("schemas/my-agents.cases.json holds the cases");
        assert!(cases.len() >= 5, "the shared cases are there");
        for case in cases {
            let spec: JobSpec = serde_yaml::from_value(case.job).expect("the case's agent reads");
            let mut entry = case
                .entry
                .as_mapping()
                .expect("an entry is a mapping")
                .clone();
            if pointer(&entry).is_some() {
                fill_entry(&mut entry, &case.agent, &spec);
            }
            assert_eq!(Value::Mapping(entry), case.filled, "{}", case.name);
        }
    }

    #[test]
    fn a_team_reads_its_agent_from_my_agents_and_keeps_what_is_its_own() {
        let root = teams_folder();
        std::fs::create_dir(root.path().join(".jobs")).expect("the agents folder");
        std::fs::write(
            root.path().join(".jobs/researcher.yaml"),
            "name: Researcher\ninstructions: Find facts with sources.\nmodel: anthropic/claude-sonnet-5.5\nskills: [cite]\nallow:\n  web: true\n",
        )
        .expect("the agent is saved");
        let team = "schemaVersion: 1\nentrypoint: lead\nagents:\n  - id: lead\n    from:\n      agent: researcher\n    spawn:\n      cwd: work\n    turnedOff:\n      - kind: skill\n        name: pdf\n";
        let team = crate::config::TeamConfig::parse_in(team, root.path()).expect("the team reads");
        let lead = &team.agents[0];
        assert_eq!(lead.name, "Researcher");
        assert_eq!(lead.role, "Find facts with sources.");
        assert_eq!(lead.model, "anthropic/claude-sonnet-5.5");
        assert!(lead.allow.web);
        assert_eq!(lead.from_agent.as_deref(), Some("researcher"));
        assert_eq!(lead.capabilities.len(), 1);
        assert_eq!(lead.capabilities[0].name, "cite");
        // The team's own: where it works and what it turned off.
        assert!(lead.spawn.cwd.ends_with("work"), "{:?}", lead.spawn.cwd);
        assert_eq!(lead.turned_off.len(), 1);
    }

    #[test]
    fn an_agent_gone_from_my_agents_is_named_with_what_to_do() {
        let root = teams_folder();
        let team = "schemaVersion: 1\nentrypoint: lead\nagents:\n  - id: lead\n    from:\n      agent: researcher\n";
        let error = crate::config::TeamConfig::parse_in(team, root.path())
            .expect_err("a pointer at nothing can't run")
            .to_string();
        assert!(
            error.contains(
                "The agent “lead” isn't in My agents any more, so this team can't run. In \
                 Workflow, select it, press Delete and save."
            ),
            "{error}"
        );
    }

    #[test]
    fn a_copy_of_every_team_and_agent_is_kept_once_before_anything_moves() {
        let root = teams_folder();
        let state = teams_folder();
        std::fs::create_dir_all(root.path().join("work")).unwrap();
        std::fs::write(
            root.path().join("work/brief.yaml"),
            "schemaVersion: 1\n# mine\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.path().join(".jobs/.bench")).unwrap();
        std::fs::create_dir_all(root.path().join(".jobs/.files")).unwrap();
        std::fs::write(
            root.path().join(".jobs/writer.yaml"),
            "name: Writer\ninstructions: Write.\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join(".jobs/.bench/writer-chat.yaml"),
            "schemaVersion: 1\n",
        )
        .unwrap();
        std::fs::write(root.path().join(".jobs/.files/big.pdf"), "a file it reads").unwrap();

        let folder = back_up_once(state.path(), root.path())
            .expect("the copy is kept")
            .expect("there was something to keep");
        assert_eq!(
            std::fs::read_to_string(folder.join("work/brief.yaml")).unwrap(),
            "schemaVersion: 1\n# mine\n",
            "a team file as it was, comments and all"
        );
        assert!(folder.join(".jobs/writer.yaml").is_file());
        assert!(folder.join(".jobs/.bench/writer-chat.yaml").is_file());
        assert!(
            !folder.join(".jobs/.files").exists(),
            "what the move never touches stays where it is"
        );
        assert!(folder.starts_with(state.path().join("backups")));

        std::fs::write(root.path().join("work/brief.yaml"), "changed").unwrap();
        assert_eq!(
            back_up_once(state.path(), root.path()).unwrap(),
            None,
            "once"
        );
        assert_eq!(
            std::fs::read_to_string(folder.join("work/brief.yaml")).unwrap(),
            "schemaVersion: 1\n# mine\n",
            "the copy isn't taken again over a moved team"
        );

        let empty = teams_folder();
        let empty_state = teams_folder();
        assert_eq!(
            back_up_once(empty_state.path(), empty.path()).unwrap(),
            None
        );
        assert!(
            !empty_state.path().join("backups").exists(),
            "nothing to keep, no folder"
        );
    }

    #[test]
    fn the_move_is_recorded_beside_the_backup_with_what_it_changed_where() {
        let root = teams_folder();
        let state = teams_folder();
        std::fs::write(root.path().join("blog.yaml"), "schemaVersion: 1\n").unwrap();
        assert_eq!(
            moved(state.path(), root.path()),
            Move::default(),
            "not moved yet"
        );
        back_up_once(state.path(), root.path()).unwrap();
        let changed = std::collections::BTreeMap::from([(
            "blog.yaml".to_owned(),
            vec!["Researcher".to_owned()],
        )]);
        record_moved(state.path(), root.path(), changed.clone()).unwrap();
        let record = moved(state.path(), root.path());
        assert!(record.moved_at.is_some());
        assert_eq!(record.changed, changed);
        // The backup's own record is kept: the copy is still where it says, and taken only once.
        let text = std::fs::read_to_string(mark_path(state.path(), root.path())).unwrap();
        assert!(text.contains("\"backup\""), "{text}");
        assert_eq!(back_up_once(state.path(), root.path()).unwrap(), None);
    }

    #[test]
    fn a_save_that_points_a_teams_own_agent_at_my_agents_is_seen() {
        let before = "agents:\n  - id: writer\n    name: Writer\n    role: Write.\n  - id: editor\n    from:\n      agent: editor\n  - id: lead\n    role: Lead.\n";
        let after = "agents:\n  - id: writer\n    from:\n      agent: writer-market-brief\n  - id: editor\n    from:\n      agent: editor\n  - id: lead\n    role: Lead.\n  - id: new\n    from:\n      agent: researcher\n";
        assert_eq!(
            became_mine(before, after),
            vec![("writer".to_owned(), "writer-market-brief".to_owned())],
            "an agent that already was one, one still the team's own, and one new to the team aren't"
        );
    }

    #[test]
    fn the_teams_that_use_an_agent_are_named_and_listed() {
        let root = teams_folder();
        std::fs::write(
            root.path().join("a.yaml"),
            "schemaVersion: 1\nname: Market brief\nentrypoint: w\nagents:\n  - id: w\n    from:\n      agent: writer\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join("b.yaml"),
            "schemaVersion: 1\nentrypoint: w\nagents:\n  - id: w\n    role: Write.\n    from:\n      agent: writer\n      version: 2\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join("c.yaml"),
            "schemaVersion: 1\nname: Other\nentrypoint: e\nagents:\n  - id: e\n    from:\n      agent: editor\n",
        )
        .unwrap();
        let mut using = teams_using(root.path(), "writer");
        using.sort();
        assert_eq!(using, vec!["Market brief".to_owned(), "b".to_owned()]);
        assert_eq!(listed(&using), "Market brief and b");
        assert_eq!(listed(&["A".into(), "B".into(), "C".into()]), "A, B and C");
    }

    #[test]
    fn a_pointer_read_without_its_teams_folder_says_so_rather_than_running_empty() {
        let team = "schemaVersion: 1\nentrypoint: lead\nagents:\n  - id: lead\n    from:\n      agent: researcher\n    model: fake/offline\n";
        let error = format!(
            "{:#}",
            crate::config::TeamConfig::parse(team)
                .expect_err("a pointer can't run with no instructions")
        );
        assert!(error.contains("read in its teams folder"), "{error}");
    }

    #[test]
    fn an_agent_written_out_in_full_runs_as_written() {
        let root = teams_folder();
        std::fs::create_dir(root.path().join(".jobs")).expect("the agents folder");
        std::fs::write(
            root.path().join(".jobs/researcher.yaml"),
            "name: Researcher\ninstructions: The saved one.\n",
        )
        .expect("the agent is saved");
        let team = "schemaVersion: 1\nentrypoint: lead\nagents:\n  - id: lead\n    name: Lead\n    role: The team's copy.\n    model: fake/offline\n    from:\n      agent: researcher\n      version: 2\n";
        let team = crate::config::TeamConfig::parse_in(team, root.path()).expect("the team reads");
        assert_eq!(team.agents[0].role, "The team's copy.");
        assert_eq!(team.agents[0].from_agent.as_deref(), Some("researcher"));
    }
}
