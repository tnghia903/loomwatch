//! Jobs the operator saved for reuse (ADR 0030).
//!
//! The Build palette leads with built-in jobs (Researcher, Writer, …) that live in the UI. A job
//! the operator saves from an agent that worked — its instructions, preferred app, model and
//! skills — is a small YAML file in `<teams root>/.jobs/`, one file per job, named by its id. The
//! folder is hidden, so the team list never mistakes a job for a team, and it sits beside the
//! teams, so jobs travel with a teams folder that is copied or kept in version control.
//!
//! A job is a starting point, never a link: placing one copies its fields into the team file, and
//! editing or removing the job later changes no team. Removing moves the file into
//! `.jobs/.removed/`, where it can be moved back by hand.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The folder below the teams root that holds saved jobs.
pub(crate) const JOBS_DIR: &str = ".jobs";
/// Where a removed job's file goes, below [`JOBS_DIR`].
const REMOVED_DIR: &str = ".removed";

const MAX_NAME: usize = 80;
const MAX_DOES: usize = 120;
const MAX_INSTRUCTIONS: usize = 20_000;
const MAX_MODEL: usize = 200;
const MAX_LIST: usize = 32;

/// The icons a job may name; the UI draws one for each, and a job without one gets a plain mark.
const ICONS: &[&str] = &[
    "research", "write", "edit", "review", "code", "design", "analyse",
];

const FILE_HEADER: &str = "# A LoomWatch job: add it to a team from \"Your jobs\" in the Build palette.\n\
# Placing it copies these fields into the team; editing this file later changes no team.\n";

/// One job as written on disk and sent over the API (without `id` and `file`, which come from the
/// file name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobSpec {
    pub(crate) name: String,
    /// What the job does, in a few words; shown under its name in the palette.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) does: String,
    /// What the agent is told to do. A team file calls this `role`, which is accepted too, so an
    /// agent block copied out of a team file is already a job.
    #[serde(alias = "role")]
    pub(crate) instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) icon: Option<String>,
    /// App ids in the order the job prefers them. Any installed app beats none, so a job whose
    /// apps are all missing still runs, on the best app the computer has.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) apps: Vec<String>,
    /// Model id for the first of `apps`. Model ids belong to one app, so it is applied only when
    /// the job runs there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    /// Skill names, delivered to whichever app the job runs on (ADR 0021 routes them).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) skills: Vec<String>,
}

/// A saved job as `GET /api/jobs` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedJob {
    pub(crate) id: String,
    #[serde(flatten)]
    pub(crate) spec: JobSpec,
    /// The file, relative to the teams root.
    pub(crate) file: String,
}

/// A file in the jobs folder that could not be read as a job, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobProblem {
    pub(crate) file: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobList {
    /// The jobs folder, relative to the teams root.
    pub(crate) folder: String,
    pub(crate) jobs: Vec<SavedJob>,
    pub(crate) problems: Vec<JobProblem>,
}

/// Why a save or removal was refused.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum JobError {
    /// The request itself is wrong; the message says what to fix.
    Invalid(String),
    /// `create_only` was asked for and a job with this id exists.
    Exists(String),
    NotFound(String),
    Io(String),
}

/// A job id is its file name: lowercase letters, digits and single hyphens, like a team agent id.
pub(crate) fn is_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.ends_with('-')
        && !id.contains("--")
}

fn is_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Trim every field and refuse what the palette could not show or the team file could not hold.
pub(crate) fn normalize(spec: JobSpec) -> Result<JobSpec, String> {
    let name = spec.name.trim().to_owned();
    if name.is_empty() {
        return Err("Give the job a name.".into());
    }
    if name.chars().count() > MAX_NAME {
        return Err(format!("Keep the name under {MAX_NAME} characters."));
    }
    let does = spec.does.trim().to_owned();
    if does.chars().count() > MAX_DOES {
        return Err(format!(
            "Keep \"what it does\" under {MAX_DOES} characters."
        ));
    }
    let instructions = spec.instructions.trim().to_owned();
    if instructions.is_empty() {
        return Err("A job needs instructions: what should the agent do?".into());
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS {
        return Err(format!(
            "Keep the instructions under {MAX_INSTRUCTIONS} characters."
        ));
    }
    let icon = spec
        .icon
        .map(|icon| icon.trim().to_owned())
        .filter(|icon| !icon.is_empty());
    if let Some(icon) = &icon
        && !ICONS.contains(&icon.as_str())
    {
        return Err(format!(
            "Unknown icon {icon:?}. Use one of: {}.",
            ICONS.join(", ")
        ));
    }
    let mut apps = Vec::new();
    for app in spec.apps {
        let app = app.trim().to_owned();
        if !is_app_id(&app) {
            return Err(format!("{app:?} is not an app id."));
        }
        if !apps.contains(&app) {
            apps.push(app);
        }
    }
    let model = spec
        .model
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty());
    if model
        .as_ref()
        .is_some_and(|model| model.chars().count() > MAX_MODEL)
    {
        return Err("That model id is too long.".into());
    }
    let mut skills = Vec::new();
    for skill in spec.skills {
        let skill = skill.trim().to_owned();
        if skill.is_empty() || skill.chars().count() > MAX_NAME * 2 {
            return Err("A skill name is empty or too long.".into());
        }
        if !skills.contains(&skill) {
            skills.push(skill);
        }
    }
    if apps.len() > MAX_LIST || skills.len() > MAX_LIST {
        return Err(format!(
            "A job can name at most {MAX_LIST} apps and {MAX_LIST} skills."
        ));
    }
    Ok(JobSpec {
        name,
        does,
        instructions,
        icon,
        apps,
        model,
        skills,
    })
}

fn job_file(teams_root: &Path, id: &str) -> PathBuf {
    teams_root.join(JOBS_DIR).join(format!("{id}.yaml"))
}

fn relative(id: &str) -> String {
    format!("{JOBS_DIR}/{id}.yaml")
}

/// The jobs folder, refusing one that is a link: following it could read or write outside the
/// teams root.
fn jobs_folder(teams_root: &Path) -> Result<Option<PathBuf>, JobError> {
    let folder = teams_root.join(JOBS_DIR);
    match fs::symlink_metadata(&folder) {
        Ok(metadata) if metadata.is_dir() => Ok(Some(folder)),
        Ok(_) => Err(JobError::Io(format!(
            "{JOBS_DIR} in the teams folder is not a plain folder"
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(JobError::Io(error.to_string())),
    }
}

/// Every job in the jobs folder, sorted by name, and every file that is not a valid job.
pub(crate) fn list_jobs(teams_root: &Path) -> Result<JobList, JobError> {
    let mut list = JobList {
        folder: JOBS_DIR.to_owned(),
        jobs: Vec::new(),
        problems: Vec::new(),
    };
    let Some(folder) = jobs_folder(teams_root)? else {
        return Ok(list);
    };
    let entries = fs::read_dir(&folder).map_err(|error| JobError::Io(error.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(id) = file_name
            .strip_suffix(".yaml")
            .or_else(|| file_name.strip_suffix(".yml"))
        else {
            continue;
        };
        if file_name.starts_with('.') {
            continue;
        }
        let file = format!("{JOBS_DIR}/{file_name}");
        // A link is never followed: a job is plain text the operator saved here.
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            list.problems.push(JobProblem {
                file,
                message: "Not a plain file, so it is not read.".into(),
            });
            continue;
        }
        if !is_job_id(id) {
            list.problems.push(JobProblem {
                file,
                message: "Rename it with lowercase letters, digits and hyphens only.".into(),
            });
            continue;
        }
        let parsed = fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_yaml::from_str::<JobSpec>(&text).map_err(|error| error.to_string())
            })
            .and_then(normalize);
        match parsed {
            Ok(spec) => list.jobs.push(SavedJob {
                id: id.to_owned(),
                spec,
                file,
            }),
            Err(message) => list.problems.push(JobProblem { file, message }),
        }
    }
    list.jobs.sort_by(|a, b| {
        a.spec
            .name
            .to_lowercase()
            .cmp(&b.spec.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    list.problems.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(list)
}

/// Write `spec` as job `id`, replacing an existing one unless `create_only`.
///
/// The caller holds the API's write lock, so the existence check and the write cannot interleave
/// with another save through this daemon.
pub(crate) fn save_job(
    teams_root: &Path,
    id: &str,
    spec: JobSpec,
    create_only: bool,
) -> Result<SavedJob, JobError> {
    if !is_job_id(id) {
        return Err(JobError::Invalid(
            "A job id uses lowercase letters, digits and single hyphens only.".into(),
        ));
    }
    let spec = normalize(spec).map_err(JobError::Invalid)?;
    let folder = teams_root.join(JOBS_DIR);
    if jobs_folder(teams_root)?.is_none() {
        fs::create_dir(&folder).map_err(|error| JobError::Io(error.to_string()))?;
    }
    let path = folder.join(format!("{id}.yaml"));
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(JobError::Io(format!(
                "{} is not a plain file",
                relative(id)
            )));
        }
        Ok(_) if create_only => return Err(JobError::Exists(spec.name)),
        _ => {}
    }
    let yaml = serde_yaml::to_string(&spec).map_err(|error| JobError::Io(error.to_string()))?;
    write_replacing(&path, format!("{FILE_HEADER}{yaml}").as_bytes())
        .map_err(|error| JobError::Io(error.to_string()))?;
    Ok(SavedJob {
        id: id.to_owned(),
        spec,
        file: relative(id),
    })
}

/// Move job `id` into `.jobs/.removed/`, keeping every earlier removal of the same id.
pub(crate) fn remove_job(teams_root: &Path, id: &str) -> Result<String, JobError> {
    if !is_job_id(id) {
        return Err(JobError::NotFound(id.to_owned()));
    }
    let path = job_file(teams_root, id);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(JobError::Io(format!(
                "{} is not a plain file",
                relative(id)
            )));
        }
        Err(_) => return Err(JobError::NotFound(id.to_owned())),
    }
    let removed = teams_root.join(JOBS_DIR).join(REMOVED_DIR);
    match fs::symlink_metadata(&removed) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(JobError::Io(format!(
                "{JOBS_DIR}/{REMOVED_DIR} is not a plain folder"
            )));
        }
        Err(_) => fs::create_dir(&removed).map_err(|error| JobError::Io(error.to_string()))?,
    }
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H%M%SZ");
    let mut target = removed.join(format!("{stamp}-{id}.yaml"));
    let mut suffix = 2;
    while target.exists() {
        target = removed.join(format!("{stamp}-{id}-{suffix}.yaml"));
        suffix += 1;
    }
    fs::rename(&path, &target).map_err(|error| JobError::Io(error.to_string()))?;
    Ok(format!(
        "{JOBS_DIR}/{REMOVED_DIR}/{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
    ))
}

/// Replace `path` without ever leaving a half-written job behind.
fn write_replacing(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".job.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> JobSpec {
        JobSpec {
            name: name.into(),
            does: "Drafts release notes".into(),
            instructions: "Write the release notes.".into(),
            icon: Some("write".into()),
            apps: vec!["codex".into(), "claude".into()],
            model: Some("gpt-5.6".into()),
            skills: vec!["release-style".into()],
        }
    }

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn root() -> TempDirectory {
        let path = std::env::temp_dir().join(format!("loomwatch-jobs-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).expect("create temporary directory");
        TempDirectory(path)
    }

    #[test]
    fn an_empty_teams_folder_has_no_jobs_and_no_problems() {
        let root = root();
        let list = list_jobs(root.path()).expect("list");
        assert!(list.jobs.is_empty());
        assert!(list.problems.is_empty());
        assert!(
            !root.path().join(JOBS_DIR).exists(),
            "listing never creates the folder"
        );
    }

    #[test]
    fn a_saved_job_lists_back_with_every_field() {
        let root = root();
        let saved =
            save_job(root.path(), "release-notes", spec(" Release notes "), true).expect("save");
        assert_eq!(saved.spec.name, "Release notes");
        assert_eq!(saved.file, ".jobs/release-notes.yaml");
        let list = list_jobs(root.path()).expect("list");
        assert_eq!(list.jobs, vec![saved]);
        let text = fs::read_to_string(root.path().join(".jobs/release-notes.yaml")).expect("file");
        assert!(text.starts_with("# A LoomWatch job"), "{text}");
        assert!(
            text.contains("instructions: Write the release notes."),
            "{text}"
        );
    }

    #[test]
    fn create_only_refuses_an_existing_job_and_a_plain_save_replaces_it() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true).expect("first");
        assert_eq!(
            save_job(root.path(), "notes", spec("Notes"), true),
            Err(JobError::Exists("Notes".into()))
        );
        let mut changed = spec("Notes");
        changed.instructions = "Shorter notes.".into();
        save_job(root.path(), "notes", changed, false).expect("replace");
        let list = list_jobs(root.path()).expect("list");
        assert_eq!(list.jobs.len(), 1);
        assert_eq!(list.jobs[0].spec.instructions, "Shorter notes.");
    }

    #[test]
    fn a_job_needs_a_name_and_instructions_and_a_known_icon() {
        let root = root();
        let mut nameless = spec("x");
        nameless.name = "  ".into();
        assert!(matches!(
            save_job(root.path(), "x", nameless, false),
            Err(JobError::Invalid(_))
        ));
        let mut empty = spec("x");
        empty.instructions = "\n".into();
        assert!(matches!(
            save_job(root.path(), "x", empty, false),
            Err(JobError::Invalid(_))
        ));
        let mut icon = spec("x");
        icon.icon = Some("rocket".into());
        assert!(matches!(
            save_job(root.path(), "x", icon, false),
            Err(JobError::Invalid(_))
        ));
    }

    #[test]
    fn ids_that_could_leave_the_folder_are_refused() {
        let root = root();
        for id in ["../escape", "a/b", ".hidden", "UPPER", "", "-x", "a--b"] {
            assert!(
                matches!(
                    save_job(root.path(), id, spec("x"), false),
                    Err(JobError::Invalid(_))
                ),
                "{id:?} was accepted"
            );
        }
        assert_eq!(
            remove_job(root.path(), "../x"),
            Err(JobError::NotFound("../x".into()))
        );
    }

    #[test]
    fn duplicate_apps_and_skills_collapse_and_blank_optionals_drop() {
        let mut messy = spec("x");
        messy.apps = vec!["codex".into(), " codex ".into(), "claude".into()];
        messy.skills = vec!["a".into(), "a".into()];
        messy.model = Some("  ".into());
        messy.icon = Some(String::new());
        let clean = normalize(messy).expect("valid");
        assert_eq!(clean.apps, vec!["codex", "claude"]);
        assert_eq!(clean.skills, vec!["a"]);
        assert_eq!(clean.model, None);
        assert_eq!(clean.icon, None);
    }

    #[test]
    fn a_hand_written_file_may_use_role_and_leave_out_the_optionals() {
        let root = root();
        fs::create_dir(root.path().join(JOBS_DIR)).expect("dir");
        fs::write(
            root.path().join(".jobs/translator.yaml"),
            "name: Translator\nrole: Translate the text you are handed into French.\n",
        )
        .expect("write");
        let list = list_jobs(root.path()).expect("list");
        assert_eq!(list.jobs.len(), 1);
        assert_eq!(list.jobs[0].id, "translator");
        assert_eq!(
            list.jobs[0].spec.instructions,
            "Translate the text you are handed into French."
        );
        assert!(list.jobs[0].spec.apps.is_empty());
    }

    #[test]
    fn broken_and_misnamed_files_are_reported_not_listed() {
        let root = root();
        let folder = root.path().join(JOBS_DIR);
        fs::create_dir(&folder).expect("dir");
        fs::write(folder.join("broken.yaml"), "name: [unclosed\n").expect("write");
        fs::write(folder.join("Bad Name.yaml"), "name: X\ninstructions: Y\n").expect("write");
        fs::write(
            folder.join("typo.yaml"),
            "name: X\ninstructions: Y\ninstruction: Z\n",
        )
        .expect("write");
        fs::write(folder.join("notes.txt"), "not a job").expect("write");
        let list = list_jobs(root.path()).expect("list");
        assert!(list.jobs.is_empty());
        let files: Vec<_> = list
            .problems
            .iter()
            .map(|problem| problem.file.as_str())
            .collect();
        assert_eq!(
            files,
            vec![
                ".jobs/Bad Name.yaml",
                ".jobs/broken.yaml",
                ".jobs/typo.yaml"
            ]
        );
    }

    #[test]
    fn removing_moves_the_file_aside_and_keeps_earlier_removals() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true).expect("save");
        let first = remove_job(root.path(), "notes").expect("remove");
        assert!(
            first.starts_with(".jobs/.removed/") && first.ends_with("-notes.yaml"),
            "{first}"
        );
        assert!(root.path().join(&first).is_file());
        assert!(list_jobs(root.path()).expect("list").jobs.is_empty());
        save_job(root.path(), "notes", spec("Notes"), true).expect("save again");
        let second = remove_job(root.path(), "notes").expect("remove again");
        assert_ne!(first, second);
        assert!(root.path().join(&first).is_file() && root.path().join(&second).is_file());
        assert_eq!(
            remove_job(root.path(), "notes"),
            Err(JobError::NotFound("notes".into()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_jobs_folder_or_job_file_is_never_followed() {
        let root = root();
        let outside = self::root();
        std::os::unix::fs::symlink(outside.path(), root.path().join(JOBS_DIR)).expect("link");
        assert!(matches!(list_jobs(root.path()), Err(JobError::Io(_))));
        assert!(matches!(
            save_job(root.path(), "x", spec("x"), false),
            Err(JobError::Io(_))
        ));
        assert!(
            fs::read_dir(outside.path()).expect("read").next().is_none(),
            "nothing written outside"
        );

        let root = self::root();
        fs::create_dir(root.path().join(JOBS_DIR)).expect("dir");
        fs::write(
            outside.path().join("secret.yaml"),
            "name: S\ninstructions: S\n",
        )
        .expect("write");
        std::os::unix::fs::symlink(
            outside.path().join("secret.yaml"),
            root.path().join(".jobs/secret.yaml"),
        )
        .expect("link");
        let list = list_jobs(root.path()).expect("list");
        assert!(list.jobs.is_empty());
        assert_eq!(list.problems.len(), 1);
    }
}
