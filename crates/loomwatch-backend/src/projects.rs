//! Projects hold the work (ADR 0097).
//!
//! A project is a file in the teams folder, `<teams root>/.projects/<id>.yaml`: its name, its About
//! (what it is, who it is for, the person's requirements and decisions so far), the folders and
//! files every agent in it may read, and the notes kept in it. A team names the one project it
//! works in with `project: <id>`. When the team is read in its teams folder, every agent of it is
//! given the project's folders as it is given a folder connected to it, and the project's About and
//! notes come first in its `## What the team knows` ([`crate::memory::TeamMemory::load_for`]). The
//! team's Notebook is the project's, shared by every team in it ([`crate::memory::notebook_scope`]).
//! A chat with one agent outside any project gets none of it.
//!
//! The file is read each time a team is read, so a change reaches every team of the project from
//! its next run. The app changes it through `/api/projects` (`api.rs`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The folder in the teams folder that holds the projects, one file each.
pub(crate) const FOLDER: &str = ".projects";

/// The most characters a project's About may hold: a few paragraphs every agent reads at the
/// start of every session, well inside the memory packet's budget (ADR 0014).
pub const ABOUT_CHARS: usize = 4000;
/// The most characters one note may hold.
pub const NOTE_CHARS: usize = 500;
/// The most notes a project keeps. The oldest goes when one more is added.
pub const NOTES: usize = 40;

/// One project, as its file holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub name: String,
    /// What the project is, who it is for, and the person's requirements and decisions so far.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub about: String,
    /// The folders and files every agent in the project may read without asking.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<ProjectFolder>,
    /// What was kept from earlier work: the person's notes, and lessons about the project the
    /// learner filed here rather than with an agent (ADR 0078).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<ProjectNote>,
    /// The colour of the small mark beside the project's name, by name (`ui/src/lib/projects`).
    /// Never the room's colour: colour on a room would compete with the glows that carry state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<String>,
    /// Put away: shown on Home as one tile with the others put away.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub put_away: bool,
}

/// A folder or file every agent in a project may read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFolder {
    /// Its label, as the project's wall shows it.
    pub name: String,
    /// Its full path, or one from `~/`.
    pub path: String,
}

/// One note kept in a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectNote {
    pub text: String,
    /// When it was kept (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Who kept it, when it wasn't the person: the agent whose lesson it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

impl Project {
    /// The project as it may be kept: its name, About, folders and notes trimmed and within their
    /// limits, or what is wrong, in words for the person.
    ///
    /// # Errors
    ///
    /// A project with no name, an About or a note over its limit, or a folder that isn't named by
    /// its full path.
    pub fn checked(mut self) -> Result<Self, String> {
        trim(&mut self.name);
        if self.name.is_empty() {
            return Err("A project needs a name.".to_owned());
        }
        if self.name.chars().count() > 80 {
            return Err("A project's name is at most 80 characters.".to_owned());
        }
        trim(&mut self.about);
        let about = self.about.chars().count();
        if about > ABOUT_CHARS {
            return Err(format!(
                "The About is {about} characters; keep it to {ABOUT_CHARS}. Every agent in the \
                 project reads it in every session."
            ));
        }
        for folder in &mut self.folders {
            trim(&mut folder.name);
            trim(&mut folder.path);
            if !(Path::new(&folder.path).is_absolute() || folder.path.starts_with("~/")) {
                return Err(format!(
                    "The folder “{}” needs its full path, not {:?}.",
                    folder.name, folder.path
                ));
            }
            if folder.name.is_empty() {
                folder.name = label_of(&folder.path);
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        self.folders
            .retain(|folder| seen.insert(folder.path.clone()));
        self.notes.retain(|note| !note.text.trim().is_empty());
        for note in &mut self.notes {
            trim(&mut note.text);
            if note.text.chars().count() > NOTE_CHARS {
                return Err(format!(
                    "A note is at most {NOTE_CHARS} characters. Say it in a sentence or two."
                ));
            }
        }
        if self.notes.len() > NOTES {
            self.notes.drain(..self.notes.len() - NOTES);
        }
        Ok(self)
    }
}

/// `text` without the white space around it, in place.
fn trim(text: &mut String) {
    text.truncate(text.trim_end().len());
    let start = text.len() - text.trim_start().len();
    text.drain(..start);
}

/// A folder's label from its path: its last name.
fn label_of(path: &str) -> String {
    Path::new(path).file_name().map_or_else(
        || path.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// A project id is its file name: lowercase letters, digits and single hyphens, as an agent's in
/// My agents is.
#[must_use]
pub fn is_id(id: &str) -> bool {
    crate::jobs::is_job_id(id)
}

/// A free id for a project called `name`: its words in lowercase joined by hyphens, with a number
/// after it when one in `taken` has it.
#[must_use]
pub fn id_for(name: &str, taken: &[String]) -> String {
    // Accents off and `đ` as `d`, as the chat's search reads words: "Đà Nẵng" is `da-nang`.
    let mut base: String = crate::chat_find::fold(name)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    base.truncate(56);
    let base = base.trim_end_matches('-').to_owned();
    let base = if base.is_empty() {
        "project".to_owned()
    } else {
        base
    };
    let mut id = base.clone();
    let mut counter = 2;
    while taken.contains(&id) {
        id = format!("{base}-{counter}");
        counter += 1;
    }
    id
}

/// Where project `id` is kept.
#[must_use]
pub fn file_of(teams_root: &Path, id: &str) -> PathBuf {
    teams_root.join(FOLDER).join(format!("{id}.yaml"))
}

/// Project `id`, or nothing when it has no file.
///
/// # Errors
///
/// A file that is there but doesn't read as a project: the message names it and says why.
pub fn read(teams_root: &Path, id: &str) -> Result<Option<Project>, String> {
    if !is_id(id) {
        return Err(format!(
            "“{id}” isn't a project's name in the teams folder."
        ));
    }
    let Ok(text) = std::fs::read_to_string(file_of(teams_root, id)) else {
        return Ok(None);
    };
    serde_yaml::from_str::<Project>(&text)
        .map(Some)
        .map_err(|error| format!("The project file {FOLDER}/{id}.yaml doesn't read: {error}"))
}

/// Every project in the teams folder, by id, that reads as one.
#[must_use]
pub fn list(teams_root: &Path) -> BTreeMap<String, Project> {
    let mut projects = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(teams_root.join(FOLDER)) else {
        return projects;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".yaml") else {
            continue;
        };
        if let Ok(Some(project)) = read(teams_root, id) {
            projects.insert(id.to_owned(), project);
        }
    }
    projects
}

/// Keep project `id` as `project` says, whole, replacing the file in one step.
///
/// # Errors
///
/// When the file can't be written.
pub fn write(teams_root: &Path, id: &str, project: &Project) -> std::io::Result<()> {
    let path = file_of(teams_root, id);
    let folder = teams_root.join(FOLDER);
    std::fs::create_dir_all(&folder)?;
    let text = serde_yaml::to_string(project).map_err(std::io::Error::other)?;
    let temporary = folder.join(format!(".{id}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// Add a note to project `id`, the oldest going once it has [`NOTES`]. Returns the project as it
/// now is.
///
/// # Errors
///
/// A project that isn't there, a note over its limit, or a file that can't be written.
pub fn add_note(teams_root: &Path, id: &str, note: ProjectNote) -> Result<Project, String> {
    let mut project = read(teams_root, id)?.ok_or_else(|| missing(id))?;
    project.notes.push(note);
    let project = project.checked()?;
    write(teams_root, id, &project).map_err(|error| error.to_string())?;
    Ok(project)
}

/// What a team that names a project no longer there is told.
#[must_use]
pub fn missing(id: &str) -> String {
    format!(
        "The project “{id}” isn't in LoomWatch any more, so this team can't run. Open \
         LoomWatch's Home: it puts the team in a project of its own."
    )
}

/// The teams of each project, by project id: each team file's path, relative to the teams root,
/// that names it. A team with no project is under the empty id.
#[must_use]
pub fn teams_of(teams_root: &Path) -> BTreeMap<String, Vec<String>> {
    let mut teams: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for file in crate::api::discover_team_files(teams_root).unwrap_or_default() {
        let project = std::fs::read_to_string(teams_root.join(&file))
            .ok()
            .and_then(|text| serde_yaml::from_str::<serde_yaml::Value>(&text).ok())
            .and_then(|document| {
                document
                    .get("project")
                    .and_then(serde_yaml::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        teams.entry(project).or_default().push(file);
    }
    teams
}

/// Give every agent of a team the project's folders, as a folder connected to it is given: it
/// reads the folder's listing and may read anything in it without asking. A folder the agent is
/// given already, by the team or its own setup, is given once. Review stops read nothing.
pub fn give_folders(team: &mut crate::config::TeamConfig, project: &Project) {
    for agent in team.agents.iter_mut().filter(|agent| !agent.is_operator()) {
        for folder in &project.folders {
            let path = PathBuf::from(&folder.path);
            let given = agent.capabilities.iter().any(|capability| {
                capability.kind == crate::config::CapabilityKind::Knowledge
                    && capability.path.as_deref() == Some(path.as_path())
            });
            if !given {
                agent
                    .capabilities
                    .push(crate::config::CapabilityRef::knowledge(&folder.name, path));
            }
        }
    }
}

/// Copy every team file in `teams_root` into a dated folder in `state_dir`, once per teams folder,
/// before the first `LoomWatch` that moves teams into projects changes any (ADR 0097). Putting the
/// copies back undoes the move; the Brief files a team names stay where they are. Returns the
/// folder when it made one.
///
/// # Errors
///
/// When a file can't be copied or the mark can't be written: the daemon then doesn't start, so no
/// team changes without its copy kept.
pub fn back_up_once(state_dir: &Path, teams_root: &Path) -> std::io::Result<Option<PathBuf>> {
    let mark = mark_path(state_dir, teams_root);
    if mark.is_file() {
        return Ok(None);
    }
    let files = crate::api::discover_team_files(teams_root).unwrap_or_default();
    let folder = (!files.is_empty()).then(|| {
        state_dir.join("backups").join(format!(
            "{}-before-projects-{}",
            chrono::Utc::now().format("%Y-%m-%d"),
            crate::my_agents::folder_key(teams_root)
        ))
    });
    if let Some(folder) = &folder {
        for file in &files {
            let target = folder.join(file);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(teams_root.join(file), target)?;
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

fn mark_path(state_dir: &Path, teams_root: &Path) -> PathBuf {
    state_dir.join(format!(
        "projects-move-{}.json",
        crate::my_agents::folder_key(teams_root)
    ))
}

/// Whether the app has moved the teams of `teams_root` into projects yet (ADR 0097).
#[must_use]
pub fn moved(state_dir: &Path, teams_root: &Path) -> bool {
    std::fs::read(mark_path(state_dir, teams_root))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|record| {
            record
                .get("movedAt")
                .is_some_and(serde_json::Value::is_string)
        })
}

/// The app moved the teams of `teams_root` into projects: keep when, beside the backup's record.
///
/// # Errors
///
/// When the mark can't be written.
pub fn record_moved(state_dir: &Path, teams_root: &Path) -> std::io::Result<()> {
    let path = mark_path(state_dir, teams_root);
    let mut record = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    record["movedAt"] =
        serde_json::json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    crate::approvals::write_private(
        &path,
        &serde_json::to_vec_pretty(&record).map_err(std::io::Error::other)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Folder(PathBuf);

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn folder() -> Folder {
        let path =
            std::env::temp_dir().join(format!("loomwatch-projects-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("a folder");
        Folder(crate::platform::canonicalize(&path).expect("a canonical folder"))
    }

    fn sutd() -> Project {
        Project {
            name: "SUTD final project".into(),
            about: "Colin's final project: a gate for the campus library.".into(),
            folders: vec![ProjectFolder {
                name: "SUTD".into(),
                path: "/Users/colin/Documents/SUTD".into(),
            }],
            ..Project::default()
        }
    }

    #[test]
    fn a_project_is_kept_in_its_own_file_and_read_back_as_it_was() {
        let root = folder();
        assert_eq!(read(&root.0, "sutd").expect("no file is no project"), None);
        write(&root.0, "sutd", &sutd()).expect("kept");
        assert_eq!(read(&root.0, "sutd").expect("reads"), Some(sutd()));
        assert!(root.0.join(".projects/sutd.yaml").is_file());
        assert_eq!(list(&root.0).keys().collect::<Vec<_>>(), ["sutd"]);
        std::fs::write(root.0.join(".projects/broken.yaml"), "name: [").unwrap();
        assert!(
            read(&root.0, "broken")
                .expect_err("says why")
                .contains("broken.yaml")
        );
        assert_eq!(
            list(&root.0).len(),
            1,
            "a file that doesn't read isn't listed"
        );
        assert!(read(&root.0, "../escape").is_err(), "an id is a file name");
    }

    #[test]
    fn a_project_is_checked_before_it_is_kept() {
        let mut project = sutd();
        project.name = "  ".into();
        assert!(project.checked().is_err());
        let mut project = sutd();
        project.about = "x".repeat(ABOUT_CHARS + 1);
        assert!(
            project
                .checked()
                .expect_err("too long")
                .contains("keep it to 4000")
        );
        let mut project = sutd();
        project.folders.push(ProjectFolder {
            name: "Notes".into(),
            path: "notes".into(),
        });
        assert!(
            project
                .checked()
                .expect_err("relative")
                .contains("full path")
        );
        let mut project = sutd();
        project.folders.push(project.folders[0].clone());
        project.folders.push(ProjectFolder {
            name: String::new(),
            path: "~/Documents/Brand".into(),
        });
        for index in 0..NOTES + 2 {
            project.notes.push(ProjectNote {
                text: format!(" note {index} "),
                at: None,
                by: None,
            });
        }
        let project = project.checked().expect("kept");
        assert_eq!(project.folders.len(), 2, "each folder once");
        assert_eq!(
            project.folders[1].name, "Brand",
            "named after its last name"
        );
        assert_eq!(project.notes.len(), NOTES);
        assert_eq!(project.notes[0].text, "note 2", "the oldest go first");
    }

    #[test]
    fn a_new_project_takes_a_free_id_from_its_name() {
        assert_eq!(id_for("SUTD final project", &[]), "sutd-final-project");
        assert_eq!(
            id_for("Client review!", &["client-review".into()]),
            "client-review-2"
        );
        assert_eq!(id_for("  ", &[]), "project");
        assert!(is_id(&id_for("Đà Nẵng trip", &[])));
    }

    #[test]
    fn every_agent_of_a_team_in_a_project_is_given_its_folders_once() {
        let mut team = crate::config::TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    model: fake/offline\n    role: Research.\n    capabilities:\n      - {kind: knowledge, name: Mine, path: /Users/colin/Documents/SUTD}\n  - id: b\n    model: fake/offline\n    role: Design.\n  - id: you\n    kind: operator\n    role: Approve it?\nedges:\n  - {from: a, to: you, layer: configured, kind: sequence, ts: \"2026-10-28T00:00:00Z\"}\n  - {from: you, to: b, layer: configured, kind: sequence, ts: \"2026-10-28T00:00:00Z\"}\n",
        )
        .expect("a team");
        give_folders(&mut team, &sutd());
        let paths = |id: &str| {
            team.agents
                .iter()
                .find(|agent| agent.id == id)
                .map(|agent| {
                    agent
                        .capabilities
                        .iter()
                        .filter_map(|capability| capability.path.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        assert_eq!(paths("a"), [PathBuf::from("/Users/colin/Documents/SUTD")]);
        assert_eq!(paths("b"), [PathBuf::from("/Users/colin/Documents/SUTD")]);
        assert!(paths("you").is_empty(), "a review stop reads nothing");
    }

    /// What a team in a project is given when it is read in its teams folder: the project's About
    /// and notes before its own Brief, the project's folders on every agent, and the project's
    /// Notebook, with the notes it kept before still readable. A project gone stops the team with
    /// what to do.
    #[test]
    fn a_team_in_a_project_reads_its_about_folders_and_notebook() {
        let root = folder();
        let mut project = sutd();
        project.notes.push(ProjectNote {
            text: "Colin picked option B.".into(),
            at: None,
            by: None,
        });
        write(&root.0, "sutd", &project).unwrap();
        std::fs::create_dir_all(root.0.join("gate.brief")).unwrap();
        std::fs::write(root.0.join("gate.brief/tone.md"), "# Tone\nPlain words.\n").unwrap();
        let yaml = "schemaVersion: 1\nid: gate\nname: Gate\nproject: sutd\nentrypoint: a\nmemory:\n  brief:\n    - path: gate.brief/tone.md\nagents:\n  - id: a\n    model: fake/offline\n    role: Research.\nedges: []\n";
        let team = crate::config::TeamConfig::parse_in(yaml, &root.0).expect("the team reads");
        assert_eq!(team.project.as_deref(), Some("sutd"));
        assert_eq!(
            team.agents[0].capabilities[0].path.as_deref(),
            Some(Path::new("/Users/colin/Documents/SUTD"))
        );
        let path = root.0.join("gate.yaml");
        let memory = crate::memory::TeamMemory::load_for(
            &crate::memory::MemoryRoots::for_team(&path, Some(&root.0)),
            &path,
            &team,
        )
        .expect("memory loads");
        let packet = memory.packet_for(&team.agents[0]).expect("a packet");
        let about = packet
            .text
            .find("### About SUTD final project\nFrom the project SUTD final project\nColin's final project")
            .expect("the About, named as the project's");
        let notes = packet
            .text
            .find("### Notes kept in the project\nFrom the project SUTD final project\n- Colin picked option B.")
            .expect("its notes");
        let tone = packet.text.find("### Tone").expect("the team's own Brief");
        assert!(
            about < notes && notes < tone,
            "the project first: {}",
            packet.text
        );
        assert_eq!(crate::memory::notebook_scope(&team, &path), "project:sutd");
        assert!(
            memory.inherited_teams.contains(&"gate".to_owned()),
            "earlier notes stay readable"
        );

        // A team in no project keeps its own scope and gets nothing of any project.
        let alone =
            crate::config::TeamConfig::parse_in(&yaml.replace("project: sutd\n", ""), &root.0)
                .expect("reads");
        assert_eq!(crate::memory::notebook_scope(&alone, &path), "gate");
        assert!(alone.agents[0].capabilities.is_empty());

        let gone = crate::config::TeamConfig::parse_in(&yaml.replace("sutd", "gone"), &root.0)
            .expect_err("a project that isn't there");
        assert!(
            format!("{gone:#}").contains("The project “gone” isn't in LoomWatch any more"),
            "{gone:#}"
        );
    }

    #[test]
    fn a_note_is_added_and_the_teams_of_each_project_are_found() {
        let root = folder();
        write(&root.0, "sutd", &sutd()).unwrap();
        let project = add_note(
            &root.0,
            "sutd",
            ProjectNote {
                text: "Colin picked option B.".into(),
                at: None,
                by: None,
            },
        )
        .expect("added");
        assert_eq!(project.notes.len(), 1);
        assert!(add_note(&root.0, "gone", project.notes[0].clone()).is_err());
        std::fs::write(
            root.0.join("gate.yaml"),
            "schemaVersion: 1\nname: Gate\nproject: sutd\n",
        )
        .unwrap();
        std::fs::write(root.0.join("blog.yaml"), "schemaVersion: 1\nname: Blog\n").unwrap();
        let teams = teams_of(&root.0);
        assert_eq!(
            teams.get("sutd").map(Vec::as_slice),
            Some(&["gate.yaml".to_owned()][..])
        );
        assert_eq!(
            teams.get("").map(Vec::as_slice),
            Some(&["blog.yaml".to_owned()][..])
        );
    }

    #[test]
    fn a_copy_of_every_team_is_kept_once_before_the_move_and_the_move_is_recorded() {
        let root = folder();
        let state = folder();
        std::fs::write(root.0.join("gate.yaml"), "schemaVersion: 1\n# mine\n").unwrap();
        let backup = back_up_once(&state.0, &root.0)
            .expect("kept")
            .expect("something to keep");
        assert_eq!(
            std::fs::read_to_string(backup.join("gate.yaml")).unwrap(),
            "schemaVersion: 1\n# mine\n"
        );
        assert!(!moved(&state.0, &root.0));
        assert_eq!(back_up_once(&state.0, &root.0).unwrap(), None, "once");
        record_moved(&state.0, &root.0).unwrap();
        assert!(moved(&state.0, &root.0));
        assert_eq!(back_up_once(&state.0, &root.0).unwrap(), None);
    }
}
