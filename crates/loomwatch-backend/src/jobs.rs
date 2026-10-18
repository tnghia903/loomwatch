//! Jobs the operator saved for reuse (ADR 0030).
//!
//! The Build palette leads with built-in jobs (Researcher, Writer, …) that live in the UI. A job
//! the operator saves from an agent that worked — its instructions, preferred app, model and
//! skills — is a small YAML file in `<teams root>/.jobs/`, one file per job, named by its id. The
//! folder is hidden, so the team list never mistakes a job for a team, and it sits beside the
//! teams, so jobs travel with a teams folder that is copied or kept in version control.
//!
//! A saved job is one of "Your agents", and it has versions. Placing one copies the fields of its
//! current version into the team file together with a `from: {agent, version}` link, so the team
//! runs exactly what it was approved with. Saving a change that a team would copy makes a new
//! version and keeps the previous one in `.jobs/.versions/<id>/`; a team reaches the new version
//! only when the operator updates it. Removing moves the file into `.jobs/.removed/`, where it can
//! be moved back by hand, and changes no team.
//!
//! `.jobs/.bench/` holds the one-agent teams the agent builder's test bench runs. It is hidden, so
//! neither the team list nor the scheduler ever sees them.
//!
//! What an agent reads (its folders, files and Notion pages) can be its own as well as a team's: a
//! saved agent's `reads` go with it into every team it joins, and a team can give it more. A file
//! it reads is copied into `.jobs/.files/` and named by its full path, so every team, wherever its
//! file is, reads the same one.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The folder below the teams root that holds saved jobs.
pub(crate) const JOBS_DIR: &str = ".jobs";
/// Where a removed job's file goes, below [`JOBS_DIR`].
const REMOVED_DIR: &str = ".removed";
/// Earlier versions of each job, below [`JOBS_DIR`]: `.versions/<id>/v<n>.yaml`.
const VERSIONS_DIR: &str = ".versions";
/// The test bench's one-agent teams, below [`JOBS_DIR`].
pub(crate) const BENCH_DIR: &str = ".bench";
/// The files Your agents read, below [`JOBS_DIR`]. One folder for all of them: a file is read by
/// its path, and an identical one is kept once.
const FILES_DIR: &str = ".files";

const MAX_NAME: usize = 80;
const MAX_DOES: usize = 120;
const MAX_NOTE: usize = 200;
const MAX_INSTRUCTIONS: usize = 20_000;
const MAX_MODEL: usize = 200;
const MAX_PATH: usize = 4096;
const MAX_LIST: usize = 32;

/// The icons a job may name; the UI draws one for each, and a job without one gets a plain mark.
const ICONS: &[&str] = &[
    "research", "write", "edit", "review", "code", "design", "analyse",
];

/// The figures an agent may wear in Your agents, and their colours (ui/src/lib/library/figures.ts
/// draws them). Only the builder and the agent lists show it: a team never copies it. The last
/// ones are earned on quests (`crate::wardrobe`), and the app offers them once they are.
const FIGURES: &[&str] = &[
    "yarn",
    "spool",
    "button",
    "thimble",
    "pincushion",
    "cone",
    "scissors",
    "bobbin",
];
const FIGURE_COLORS: &[&str] = &["clay", "butter", "sage", "sky", "lilac", "rose", "oat"];

const FILE_HEADER: &str = "# One of your LoomWatch agents: add it to a team from \"Your agents\" in the Build palette.\n\
# A team keeps the version it was placed with until you choose Update in that team.\n";

/// What the agent may do without asking (ADR 0037), as a team file's `allow:` block writes it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobAllow {
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) web: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) edits: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) commands: bool,
}

impl JobAllow {
    // serde's `skip_serializing_if` passes a reference.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    fn is_empty(&self) -> bool {
        !self.web && !self.edits && !self.commands
    }
}

// serde's `skip_serializing_if` passes a reference.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(value: &bool) -> bool {
    !*value
}

/// A folder, file or Notion page the agent reads in every team it joins: what a team file's
/// `{kind: knowledge, name, path | notion}` capability holds (ADR 0035, ADR 0050).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobRead {
    /// Its label, as the team's card shows it.
    pub(crate) name: String,
    /// A folder or file, by its full path (or from `~/`): every team reads it from its own folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    /// A Notion page, read through the operator's Notion connection when each run starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) notion: Option<JobNotionPage>,
}

/// Which Notion page a read names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobNotionPage {
    pub(crate) page: String,
}

/// Which figure an agent wears in Your agents, and in what colour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobFigure {
    pub(crate) kind: String,
    pub(crate) color: String,
    /// Accessories from the wardrobe it wears (`crate::wardrobe::ACCESSORIES`), each once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) wear: Vec<String>,
}

fn first_version() -> u32 {
    1
}

// serde's `skip_serializing_if` passes a reference.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_first_version(version: &u32) -> bool {
    *version <= 1
}

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
    /// The figure it wears in Your agents. Absent, it wears one picked from its id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) figure: Option<JobFigure>,
    /// Retired: the AI apps an earlier `LoomWatch` ran the job on. Read so a job saved then still
    /// loads, ignored, and never written again.
    #[serde(default, skip_serializing)]
    pub(crate) apps: Vec<String>,
    /// The `OpenRouter` model id it runs on; absent means the default model. A name saved for an
    /// AI app (`sonnet`, `gpt-5.5`) is read as the matching `OpenRouter` id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    /// How hard that model thinks; absent means the model's own default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) thinking_effort: Option<String>,
    /// Skill names, delivered with the job.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) skills: Vec<String>,
    /// Tools it is given, by the name of a tool connected in `LoomWatch` (ADR 0069). A team copies
    /// them into the agent's capabilities like its skills.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) tools: Vec<String>,
    /// Calls of those tools the operator always allows it to make without asking, by tool name
    /// (ADR 0069). A team copies each into the tool's `alwaysAllow`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub(crate) tool_allow: std::collections::BTreeMap<String, Vec<String>>,
    /// The folders, files and Notion pages it reads, in every team it joins. A team copies each
    /// into the agent's capabilities as knowledge, and may give it more.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) reads: Vec<JobRead>,
    /// What the finished result must satisfy (ADR 0062), copied into the team with the rest.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) done_when: Vec<String>,
    /// What it may do without asking, copied into the team with the rest.
    #[serde(default, skip_serializing_if = "JobAllow::is_empty")]
    pub(crate) allow: JobAllow,
    /// Which version this is. The daemon owns it: a save that changes anything a team copies makes
    /// the next one, and whatever a client sends here is ignored.
    #[serde(default = "first_version", skip_serializing_if = "is_first_version")]
    pub(crate) version: u32,
    /// What changed in this version, in the operator's words.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) note: String,
    /// When this version was saved (RFC 3339). Set by the daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) saved_at: Option<String>,
}

impl JobSpec {
    /// Whether a team placed from `self` would copy anything different from `other`: the fields
    /// that reach the team file. What it is called in the palette and its note are not among them.
    fn copies_differently(&self, other: &JobSpec) -> bool {
        self.name != other.name
            || self.instructions != other.instructions
            || self.model != other.model
            || self.thinking_effort != other.thinking_effort
            || self.skills != other.skills
            || self.tools != other.tools
            || self.tool_allow != other.tool_allow
            || self.reads != other.reads
            || self.done_when != other.done_when
            || self.allow != other.allow
    }
}

/// One version of a job, as the version list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobVersion {
    pub(crate) version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) saved_at: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) note: String,
    /// That version's fields, so a team can see what an update would change.
    pub(crate) spec: JobSpec,
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
    /// The save named the version it was edited from, and the job has moved on since: this is
    /// the version it is at now.
    Stale(u32),
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
        // `.jobs/con.yaml` can't be made on Windows; refused everywhere so job files stay portable.
        && !crate::platform::is_reserved_name(id)
}

/// An icon is one the UI draws; a blank one is none.
fn normalize_icon(icon: Option<String>) -> Result<Option<String>, String> {
    let icon = icon
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
    Ok(icon)
}

/// A figure is one the UI draws, in one of its colours.
fn normalize_figure(figure: Option<JobFigure>) -> Result<Option<JobFigure>, String> {
    let Some(JobFigure { kind, color, wear }) = figure else {
        return Ok(None);
    };
    let (kind, color) = (kind.trim().to_owned(), color.trim().to_owned());
    if !FIGURES.contains(&kind.as_str()) {
        return Err(format!(
            "Unknown figure {kind:?}. Use one of: {}.",
            FIGURES.join(", ")
        ));
    }
    if !FIGURE_COLORS.contains(&color.as_str()) {
        return Err(format!(
            "Unknown figure colour {color:?}. Use one of: {}.",
            FIGURE_COLORS.join(", ")
        ));
    }
    let mut worn: Vec<String> = Vec::new();
    for item in wear {
        let item = item.trim().to_owned();
        if !crate::wardrobe::ACCESSORIES.contains(&item.as_str()) {
            return Err(format!(
                "Unknown accessory {item:?}. Use one of: {}.",
                crate::wardrobe::ACCESSORIES.join(", ")
            ));
        }
        if !worn.contains(&item) {
            worn.push(item);
        }
    }
    Ok(Some(JobFigure {
        kind,
        color,
        wear: worn,
    }))
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
    let icon = normalize_icon(spec.icon)?;
    let figure = normalize_figure(spec.figure)?;
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
    let model = model.map(|model| crate::ai::openrouter_id(&model));
    let thinking_effort = spec
        .thinking_effort
        .map(|effort| effort.trim().to_owned())
        .filter(|effort| !effort.is_empty());
    if thinking_effort
        .as_ref()
        .is_some_and(|effort| effort.chars().count() > MAX_MODEL)
    {
        return Err("That thinking effort is too long.".into());
    }
    let skills = normalize_names(spec.skills, "skill")?;
    let tools = normalize_names(spec.tools, "tool")?;
    let done_when = normalize_done_when(spec.done_when)?;
    let tool_allow = normalize_tool_allow(spec.tool_allow, &tools)?;
    if skills.len() > MAX_LIST || tools.len() > MAX_LIST {
        return Err(format!(
            "A job can name at most {MAX_LIST} skills and {MAX_LIST} tools."
        ));
    }
    let reads = normalize_reads(spec.reads)?;
    let note = spec.note.trim().to_owned();
    if note.chars().count() > MAX_NOTE {
        return Err(format!(
            "Keep \"what changed\" under {MAX_NOTE} characters."
        ));
    }
    Ok(JobSpec {
        name,
        does,
        instructions,
        icon,
        figure,
        apps: Vec::new(),
        model,
        thinking_effort,
        skills,
        tools,
        tool_allow,
        reads,
        done_when,
        allow: spec.allow,
        version: spec.version.max(1),
        note,
        saved_at: spec.saved_at,
    })
}

/// Always-allowed calls as a job keeps them: only for a tool it is given (by that tool's name as
/// the job writes it), each call trimmed and once, tools with none left out.
fn normalize_tool_allow(
    allowed: std::collections::BTreeMap<String, Vec<String>>,
    tools: &[String],
) -> Result<std::collections::BTreeMap<String, Vec<String>>, String> {
    let mut kept = std::collections::BTreeMap::new();
    for (tool, calls) in allowed {
        let Some(given) = tools
            .iter()
            .find(|given| given.eq_ignore_ascii_case(tool.trim()))
        else {
            continue;
        };
        let calls = normalize_names(calls, "call")?;
        if calls.len() > MAX_LIST {
            return Err(format!(
                "A job can always allow at most {MAX_LIST} calls of {given}."
            ));
        }
        if !calls.is_empty() {
            kept.insert(given.clone(), calls);
        }
    }
    Ok(kept)
}

/// What it reads, as a job keeps it: each a folder or file by its full path, or a Notion page,
/// trimmed and once, labelled. A path that only means something beside one team file is refused,
/// since every team it joins reads it from its own folder.
fn normalize_reads(reads: Vec<JobRead>) -> Result<Vec<JobRead>, String> {
    let mut kept: Vec<JobRead> = Vec::new();
    for read in reads {
        let path = read
            .path
            .map(|path| path.trim().to_owned())
            .filter(|path| !path.is_empty());
        let page = read
            .notion
            .map(|notion| notion.page.trim().to_owned())
            .filter(|page| !page.is_empty());
        let (path, notion) = match (path, page) {
            (Some(path), None) => {
                if !(Path::new(&path).is_absolute() || path == "~" || path.starts_with("~/")) {
                    return Err(format!(
                        "{path} is not a full path. An agent reads a folder or file by its full path, so every team finds it."
                    ));
                }
                if path.chars().count() > MAX_PATH {
                    return Err("That folder or file's path is too long.".into());
                }
                (Some(path), None)
            }
            (None, Some(page)) => {
                if page.chars().count() > MAX_MODEL {
                    return Err("That Notion page id is too long.".into());
                }
                (None, Some(JobNotionPage { page }))
            }
            _ => {
                return Err(
                    "Each thing an agent reads is a folder, a file or a Notion page.".into(),
                );
            }
        };
        let name = read.name.trim().to_owned();
        let name = if name.is_empty() {
            path.as_deref()
                .and_then(|path| Path::new(path).file_name())
                .map_or_else(
                    || "Notion page".to_owned(),
                    |name| name.to_string_lossy().into_owned(),
                )
        } else {
            name
        };
        if name.chars().count() > MAX_NAME * 2 {
            return Err(format!("{name} is too long a name for something it reads."));
        }
        if kept
            .iter()
            .any(|other| other.path == path && other.notion == notion)
        {
            continue;
        }
        kept.push(JobRead { name, path, notion });
    }
    if kept.len() > MAX_LIST {
        return Err(format!(
            "An agent can read at most {MAX_LIST} folders, files and pages."
        ));
    }
    Ok(kept)
}

/// Names as a job keeps them: trimmed, each once, none blank or too long.
fn normalize_names(names: Vec<String>, what: &str) -> Result<Vec<String>, String> {
    let mut kept = Vec::new();
    for name in names {
        let name = name.trim().to_owned();
        if name.is_empty() || name.chars().count() > MAX_NAME * 2 {
            return Err(format!("A {what} name is empty or too long."));
        }
        if !kept.contains(&name) {
            kept.push(name);
        }
    }
    Ok(kept)
}

/// A job's `doneWhen` as a team will copy it: trimmed, blank lines dropped, within the team file's
/// own limits (ADR 0062), so a saved agent never carries a list its team would refuse.
fn normalize_done_when(items: Vec<String>) -> Result<Vec<String>, String> {
    let items: Vec<String> = items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect();
    if items.len() > crate::config::DONE_WHEN_ITEMS
        || items
            .iter()
            .any(|item| item.chars().count() > crate::config::DONE_WHEN_CHARS)
    {
        return Err(format!(
            "Keep \"done when\" to {} short lines of at most {} characters.",
            crate::config::DONE_WHEN_ITEMS,
            crate::config::DONE_WHEN_CHARS
        ));
    }
    Ok(items)
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

/// A job file's fields and its text, or why it could not be read as a job.
fn read_spec(path: &Path) -> Result<(JobSpec, String), String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let spec = serde_yaml::from_str::<JobSpec>(&text)
        .map_err(|error| error.to_string())
        .and_then(normalize)?;
    Ok((spec, text))
}

/// Write `spec` as job `id`, replacing an existing one unless `create_only`.
///
/// When the saved job differs from the one on disk in anything a team copies, the one on disk is
/// kept as an earlier version and the new one gets the next number. `expected_version` is the
/// version the operator edited: a save made from a version the job has moved on from is refused,
/// so two windows never overwrite each other without a word.
///
/// The caller holds the API's write lock, so the existence check and the write cannot interleave
/// with another save through this daemon.
pub(crate) fn save_job(
    teams_root: &Path,
    id: &str,
    spec: JobSpec,
    create_only: bool,
    expected_version: Option<u32>,
) -> Result<SavedJob, JobError> {
    if !is_job_id(id) {
        return Err(JobError::Invalid(
            "A job id uses lowercase letters, digits and single hyphens only.".into(),
        ));
    }
    let mut spec = normalize(spec).map_err(JobError::Invalid)?;
    let folder = teams_root.join(JOBS_DIR);
    if jobs_folder(teams_root)?.is_none() {
        fs::create_dir(&folder).map_err(|error| JobError::Io(error.to_string()))?;
    }
    let path = folder.join(format!("{id}.yaml"));
    let existing = match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(JobError::Io(format!(
                "{} is not a plain file",
                relative(id)
            )));
        }
        Ok(_) if create_only => return Err(JobError::Exists(spec.name)),
        // A file that no longer reads as a job is replaced, as it always was; there is no version
        // of it worth keeping.
        Ok(_) => read_spec(&path).ok(),
        Err(_) => None,
    };
    if let (Some(expected), Some((current, _))) = (expected_version, &existing)
        && current.version != expected
    {
        return Err(JobError::Stale(current.version));
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    match &existing {
        Some((current, _)) if !spec.copies_differently(current) => {
            // Nothing a team copies changed: the same version, saved when it was. Only the
            // palette's line, the icon, the figure or the note can differ.
            spec.version = current.version;
            spec.saved_at.clone_from(&current.saved_at);
            if spec.note.is_empty() {
                spec.note.clone_from(&current.note);
            }
            if spec == *current {
                return Ok(SavedJob {
                    id: id.to_owned(),
                    spec,
                    file: relative(id),
                });
            }
        }
        Some((current, text)) => {
            keep_version(teams_root, id, current.version, text)?;
            spec.version = current.version + 1;
            spec.saved_at = Some(now);
        }
        None => {
            spec.version = 1;
            spec.saved_at = Some(now);
        }
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

/// A plain folder at `path`, made when missing. A link is refused: following it could write
/// outside the teams root.
fn plain_folder(path: &Path, shown: &str) -> Result<(), JobError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(JobError::Io(format!("{shown} is not a plain folder"))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| JobError::Io(error.to_string()))
        }
        Err(error) => Err(JobError::Io(error.to_string())),
    }
}

/// Keep `text`, version `version` of job `id`, as `.jobs/.versions/<id>/v<version>.yaml`.
fn keep_version(teams_root: &Path, id: &str, version: u32, text: &str) -> Result<(), JobError> {
    let versions = teams_root.join(JOBS_DIR).join(VERSIONS_DIR);
    plain_folder(&versions, &format!("{JOBS_DIR}/{VERSIONS_DIR}"))?;
    let own = versions.join(id);
    plain_folder(&own, &format!("{JOBS_DIR}/{VERSIONS_DIR}/{id}"))?;
    write_replacing(&own.join(format!("v{version}.yaml")), text.as_bytes())
        .map_err(|error| JobError::Io(error.to_string()))
}

/// Every version of job `id`, newest first: the current one, then those kept in
/// `.jobs/.versions/<id>/`. A kept file that no longer reads is left out.
pub(crate) fn list_versions(teams_root: &Path, id: &str) -> Result<Vec<JobVersion>, JobError> {
    if !is_job_id(id) || jobs_folder(teams_root)?.is_none() {
        return Err(JobError::NotFound(id.to_owned()));
    }
    let path = job_file(teams_root, id);
    if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
        return Err(JobError::NotFound(id.to_owned()));
    }
    let (current, _) = read_spec(&path).map_err(JobError::Invalid)?;
    let mut versions = vec![current];
    let own = teams_root.join(JOBS_DIR).join(VERSIONS_DIR).join(id);
    if fs::symlink_metadata(&own).is_ok_and(|metadata| metadata.is_dir())
        && let Ok(entries) = fs::read_dir(&own)
    {
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            if let Ok((spec, _)) = read_spec(&entry.path())
                && spec.version < versions[0].version
                && versions.iter().all(|kept| kept.version != spec.version)
            {
                versions.push(spec);
            }
        }
    }
    versions.sort_by_key(|spec| std::cmp::Reverse(spec.version));
    Ok(versions
        .into_iter()
        .map(|spec| JobVersion {
            version: spec.version,
            saved_at: spec.saved_at.clone(),
            note: spec.note.clone(),
            spec,
        })
        .collect())
}

/// The folder the test bench writes its one-agent teams to, made when missing, relative to the
/// teams root.
pub(crate) fn bench_folder(teams_root: &Path) -> Result<String, JobError> {
    plain_folder(&teams_root.join(JOBS_DIR), JOBS_DIR)?;
    plain_folder(
        &teams_root.join(JOBS_DIR).join(BENCH_DIR),
        &format!("{JOBS_DIR}/{BENCH_DIR}"),
    )?;
    Ok(format!("{JOBS_DIR}/{BENCH_DIR}"))
}

/// Keep a file one of Your agents reads, in `.jobs/.files/`, and name it by its full path: what
/// the agent's `reads` holds, so every team it joins reads the same file wherever that team is.
/// An identical file already there is reused; another with the same name gets a numbered name.
pub(crate) fn store_agent_file(
    teams_root: &Path,
    requested_name: &str,
    bytes: &[u8],
) -> Result<crate::chosen_knowledge::StoredFile, JobError> {
    let jobs = teams_root.join(JOBS_DIR);
    plain_folder(&jobs, JOBS_DIR)?;
    plain_folder(&jobs.join(FILES_DIR), &format!("{JOBS_DIR}/{FILES_DIR}"))?;
    let jobs =
        crate::platform::canonicalize(&jobs).map_err(|error| JobError::Io(error.to_string()))?;
    let mut stored =
        crate::chosen_knowledge::store_file_in(&jobs, FILES_DIR, requested_name, bytes)
            .map_err(JobError::Invalid)?;
    stored.path = jobs.join(&stored.path).to_string_lossy().into_owned();
    Ok(stored)
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
    // Its earlier versions go with it, so a new job saved under the same name starts its own
    // history instead of inheriting this one's.
    let versions = teams_root.join(JOBS_DIR).join(VERSIONS_DIR).join(id);
    if fs::symlink_metadata(&versions).is_ok_and(|metadata| metadata.is_dir()) {
        let kept = target.with_extension("versions");
        fs::rename(&versions, &kept).map_err(|error| JobError::Io(error.to_string()))?;
    }
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
            figure: None,
            apps: Vec::new(),
            model: Some("openai/gpt-5.6".into()),
            thinking_effort: None,
            skills: vec!["release-style".into()],
            tools: Vec::new(),
            tool_allow: std::collections::BTreeMap::new(),
            reads: Vec::new(),
            done_when: Vec::new(),
            allow: JobAllow::default(),
            version: 1,
            note: String::new(),
            saved_at: None,
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
        let saved = save_job(
            root.path(),
            "release-notes",
            spec(" Release notes "),
            true,
            None,
        )
        .expect("save");
        assert_eq!(saved.spec.name, "Release notes");
        assert_eq!(saved.file, ".jobs/release-notes.yaml");
        let list = list_jobs(root.path()).expect("list");
        assert_eq!(list.jobs, vec![saved]);
        let text = fs::read_to_string(root.path().join(".jobs/release-notes.yaml")).expect("file");
        assert!(text.starts_with("# One of your LoomWatch agents"), "{text}");
        assert!(
            text.contains("instructions: Write the release notes."),
            "{text}"
        );
    }

    #[test]
    fn create_only_refuses_an_existing_job_and_a_plain_save_replaces_it() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        assert_eq!(
            save_job(root.path(), "notes", spec("Notes"), true, None),
            Err(JobError::Exists("Notes".into()))
        );
        let mut changed = spec("Notes");
        changed.instructions = "Shorter notes.".into();
        save_job(root.path(), "notes", changed, false, None).expect("replace");
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
            save_job(root.path(), "x", nameless, false, None),
            Err(JobError::Invalid(_))
        ));
        let mut empty = spec("x");
        empty.instructions = "\n".into();
        assert!(matches!(
            save_job(root.path(), "x", empty, false, None),
            Err(JobError::Invalid(_))
        ));
        let mut icon = spec("x");
        icon.icon = Some("rocket".into());
        assert!(matches!(
            save_job(root.path(), "x", icon, false, None),
            Err(JobError::Invalid(_))
        ));
    }

    #[test]
    fn a_figure_is_one_we_draw_and_choosing_it_keeps_the_version() {
        let root = root();
        let first = save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let mut dressed = spec("Notes");
        dressed.figure = Some(JobFigure {
            kind: " button ".into(),
            color: "sage".into(),
            wear: vec!["monocle".into(), " band".into(), "monocle".into()],
        });
        let same = save_job(root.path(), "notes", dressed, false, Some(1)).expect("figure");
        assert_eq!(same.spec.version, 1);
        assert_eq!(same.spec.saved_at, first.spec.saved_at);
        assert_eq!(
            same.spec.figure,
            Some(JobFigure {
                kind: "button".into(),
                color: "sage".into(),
                wear: vec!["monocle".into(), "band".into()],
            })
        );
        let written = fs::read_to_string(root.path().join(".jobs/notes.yaml")).expect("file");
        assert!(
            written.contains(
                "figure:\n  kind: button\n  color: sage\n  wear:\n  - monocle\n  - band\n"
            ),
            "{written}"
        );
        for (kind, color, wear) in [
            ("robot", "sage", None),
            ("button", "red", None),
            ("button", "sage", Some("crown")),
        ] {
            let mut odd = spec("Notes");
            odd.figure = Some(JobFigure {
                kind: kind.into(),
                color: color.into(),
                wear: wear.into_iter().map(str::to_owned).collect(),
            });
            assert!(matches!(
                save_job(root.path(), "notes", odd, false, None),
                Err(JobError::Invalid(_))
            ));
        }
    }

    #[test]
    fn ids_that_could_leave_the_folder_are_refused() {
        let root = root();
        for id in ["../escape", "a/b", ".hidden", "UPPER", "", "-x", "a--b"] {
            assert!(
                matches!(
                    save_job(root.path(), id, spec("x"), false, None),
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
    fn duplicate_skills_collapse_and_blank_optionals_drop() {
        let mut messy = spec("x");
        messy.skills = vec!["a".into(), "a".into()];
        messy.model = Some("  ".into());
        messy.icon = Some(String::new());
        let clean = normalize(messy).expect("valid");
        assert_eq!(clean.skills, vec!["a"]);
        assert_eq!(clean.model, None);
        assert_eq!(clean.icon, None);
    }

    /// A job saved for an AI app still loads: its apps are dropped, and the model it named there
    /// becomes the matching `OpenRouter` model.
    #[test]
    fn a_job_saved_for_an_app_loses_the_app_and_keeps_its_model() {
        let old: JobSpec = serde_yaml::from_str(
            "name: Writer\ninstructions: Write.\napps: [claude, codex]\nmodel: sonnet\n",
        )
        .expect("an old job still parses");
        let clean = normalize(old).expect("valid");
        assert!(clean.apps.is_empty());
        assert_eq!(clean.model.as_deref(), Some("anthropic/claude-sonnet-5.5"));
        let written = serde_yaml::to_string(&clean).expect("yaml");
        assert!(!written.contains("apps"), "{written}");
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
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("save");
        let first = remove_job(root.path(), "notes").expect("remove");
        assert!(
            first.starts_with(".jobs/.removed/") && first.ends_with("-notes.yaml"),
            "{first}"
        );
        assert!(root.path().join(&first).is_file());
        assert!(list_jobs(root.path()).expect("list").jobs.is_empty());
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("save again");
        let second = remove_job(root.path(), "notes").expect("remove again");
        assert_ne!(first, second);
        assert!(root.path().join(&first).is_file() && root.path().join(&second).is_file());
        assert_eq!(
            remove_job(root.path(), "notes"),
            Err(JobError::NotFound("notes".into()))
        );
    }

    #[test]
    fn a_change_a_team_would_copy_makes_the_next_version_and_keeps_the_last() {
        let root = root();
        let first = save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        assert_eq!(first.spec.version, 1);
        assert!(first.spec.saved_at.is_some());

        // The palette's line is not something a team copies: same version.
        let mut described = spec("Notes");
        described.does = "Short release notes".into();
        let same = save_job(root.path(), "notes", described, false, Some(1)).expect("does");
        assert_eq!(same.spec.version, 1);
        assert_eq!(same.spec.saved_at, first.spec.saved_at);

        let mut changed = spec("Notes");
        changed.instructions = "Write shorter release notes.".into();
        changed.allow.web = true;
        changed.note = "Shorter, and it may search the web".into();
        let second = save_job(root.path(), "notes", changed, false, Some(1)).expect("second");
        assert_eq!(second.spec.version, 2);
        assert!(root.path().join(".jobs/.versions/notes/v1.yaml").is_file());

        let versions = list_versions(root.path(), "notes").expect("versions");
        let numbers: Vec<u32> = versions.iter().map(|version| version.version).collect();
        assert_eq!(numbers, vec![2, 1]);
        assert_eq!(versions[0].note, "Shorter, and it may search the web");
        assert!(versions[0].spec.allow.web);
        assert_eq!(versions[1].spec.instructions, "Write the release notes.");
        assert!(!versions[1].spec.allow.web);
        let text = fs::read_to_string(root.path().join(".jobs/notes.yaml")).expect("file");
        assert!(
            text.contains("version: 2") && text.contains("web: true"),
            "{text}"
        );
    }

    #[test]
    fn a_new_done_when_is_a_new_version_and_is_written_down_trimmed() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let mut checked = spec("Notes");
        checked.done_when = vec!["  Every change links its PR ".into(), "  ".into()];
        let second = save_job(root.path(), "notes", checked, false, Some(1)).expect("second");
        assert_eq!(
            second.spec.version, 2,
            "a team copies it, so it is a new version"
        );
        assert_eq!(second.spec.done_when, ["Every change links its PR"]);
        let text = fs::read_to_string(root.path().join(".jobs/notes.yaml")).expect("file");
        assert!(text.contains("doneWhen:"), "{text}");
        let mut essay = spec("Notes");
        essay.done_when = vec!["x".repeat(161)];
        assert!(save_job(root.path(), "notes", essay, false, Some(2)).is_err());
    }

    #[test]
    fn a_tool_given_is_a_new_version_and_is_kept_once_trimmed() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let mut tooled = spec("Notes");
        tooled.tools = vec![" github ".into(), "github".into(), "agentmemory".into()];
        let second = save_job(root.path(), "notes", tooled, false, Some(1)).expect("second");
        assert_eq!(
            second.spec.version, 2,
            "a team copies its tools, so it is a new version"
        );
        assert_eq!(second.spec.tools, ["github", "agentmemory"]);
        let text = fs::read_to_string(root.path().join(".jobs/notes.yaml")).expect("file");
        assert!(text.contains("tools:"), "{text}");
        let mut blank = spec("Notes");
        blank.tools = vec!["  ".into()];
        assert!(save_job(root.path(), "notes", blank, false, Some(2)).is_err());
        // A job saved before tools existed has none, and reads back unchanged.
        let old = spec("Notes");
        assert!(serde_yaml::to_string(&old).is_ok_and(|text| !text.contains("tools")));
    }

    /// What it reads goes with it into every team, so a change to it is a new version. Each is a
    /// folder or file by its full path, or a Notion page, kept once and labelled.
    #[test]
    fn what_it_reads_is_a_new_version_kept_once_by_full_path() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let folder = root.path().join("brand").to_string_lossy().into_owned();
        let mut reading = spec("Notes");
        reading.reads = vec![
            JobRead {
                name: " Brand ".into(),
                path: Some(format!(" {folder} ")),
                notion: None,
            },
            JobRead {
                name: "Brand again".into(),
                path: Some(folder.clone()),
                notion: None,
            },
            JobRead {
                name: String::new(),
                path: None,
                notion: Some(JobNotionPage {
                    page: " 1234abcd ".into(),
                }),
            },
            JobRead {
                name: String::new(),
                path: Some("~/Documents/plan.md".into()),
                notion: None,
            },
        ];
        let second = save_job(root.path(), "notes", reading, false, Some(1)).expect("second");
        assert_eq!(
            second.spec.version, 2,
            "a team copies what it reads, so it is a new version"
        );
        assert_eq!(
            second.spec.reads,
            vec![
                JobRead {
                    name: "Brand".into(),
                    path: Some(folder),
                    notion: None,
                },
                JobRead {
                    name: "Notion page".into(),
                    path: None,
                    notion: Some(JobNotionPage {
                        page: "1234abcd".into(),
                    }),
                },
                JobRead {
                    name: "plan.md".into(),
                    path: Some("~/Documents/plan.md".into()),
                    notion: None,
                },
            ]
        );
        let text = fs::read_to_string(root.path().join(".jobs/notes.yaml")).expect("file");
        assert!(text.contains("reads:"), "{text}");
        assert_eq!(
            list_jobs(root.path()).expect("list").jobs[0].spec,
            second.spec
        );

        let mut relative = spec("Notes");
        relative.reads = vec![JobRead {
            name: "Notes".into(),
            path: Some("notes.files/a.md".into()),
            notion: None,
        }];
        let refused = save_job(root.path(), "notes", relative, false, Some(2));
        assert!(
            matches!(&refused, Err(JobError::Invalid(message)) if message.contains("full path")),
            "{refused:?}"
        );
        let mut both = spec("Notes");
        both.reads = vec![JobRead {
            name: "Both".into(),
            path: Some("/tmp/a".into()),
            notion: Some(JobNotionPage { page: "x".into() }),
        }];
        assert!(save_job(root.path(), "notes", both, false, Some(2)).is_err());
        // A job saved before reads existed has none, and writes none.
        assert!(serde_yaml::to_string(&spec("Notes")).is_ok_and(|text| !text.contains("reads")));
    }

    /// A file an agent reads is kept in `.jobs/.files/` and named by its full path; the same file
    /// again is the same one, and another with its name gets a numbered name.
    #[test]
    fn a_file_an_agent_reads_is_kept_once_by_full_path() {
        let root = root();
        let first = store_agent_file(root.path(), "plan.md", b"# Plan\n").expect("store");
        let jobs = crate::platform::canonicalize(root.path().join(JOBS_DIR)).expect("jobs");
        assert_eq!(first.name, "plan.md");
        assert_eq!(Path::new(&first.path), jobs.join(".files").join("plan.md"));
        assert!(Path::new(&first.path).is_absolute());
        let again = store_agent_file(root.path(), "plan.md", b"# Plan\n").expect("again");
        assert_eq!(again.path, first.path);
        let other = store_agent_file(root.path(), "../plan.md", b"# Other\n").expect("other");
        assert_eq!(other.name, "plan (2).md");
        assert!(
            list_jobs(root.path()).expect("list").problems.is_empty(),
            "the files folder is never read as a job"
        );
    }

    /// ADR 0069: a call always allowed is kept for a tool the job is given, and only for one.
    #[test]
    fn always_allowed_calls_are_kept_for_tools_it_is_given() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let mut allowed = spec("Notes");
        allowed.tools = vec!["Linear".into()];
        allowed.tool_allow = [
            (
                "linear".to_owned(),
                vec![" create_issue ".to_owned(), "create_issue".to_owned()],
            ),
            ("Gone".to_owned(), vec!["anything".to_owned()]),
        ]
        .into_iter()
        .collect();
        let second = save_job(root.path(), "notes", allowed, false, Some(1)).expect("second");
        assert_eq!(second.spec.version, 2);
        assert_eq!(
            second.spec.tool_allow,
            [("Linear".to_owned(), vec!["create_issue".to_owned()])]
                .into_iter()
                .collect()
        );
        let text = fs::read_to_string(root.path().join(".jobs/notes.yaml")).expect("file");
        assert!(text.contains("toolAllow:"), "{text}");
    }

    #[test]
    fn a_new_thinking_effort_is_a_new_version_and_is_written_down() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let mut harder = spec("Notes");
        harder.thinking_effort = Some("  high ".into());
        let second = save_job(root.path(), "notes", harder, false, Some(1)).expect("second");
        assert_eq!(second.spec.version, 2);
        assert_eq!(second.spec.thinking_effort.as_deref(), Some("high"));
        let text = fs::read_to_string(root.path().join(".jobs/notes.yaml")).expect("file");
        assert!(text.contains("thinkingEffort: high"), "{text}");

        // Blank means the app's own default, and is not written at all.
        let mut blank = spec("Notes");
        blank.thinking_effort = Some("   ".into());
        let third = save_job(root.path(), "notes", blank, false, Some(2)).expect("third");
        assert_eq!(third.spec.thinking_effort, None);
        assert_eq!(third.spec.version, 3);
    }

    #[test]
    fn a_save_made_from_an_older_version_is_refused() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let mut changed = spec("Notes");
        changed.instructions = "Version two.".into();
        save_job(root.path(), "notes", changed.clone(), false, Some(1)).expect("second");
        changed.instructions = "Written in a window still showing version one.".into();
        assert_eq!(
            save_job(root.path(), "notes", changed, false, Some(1)),
            Err(JobError::Stale(2))
        );
    }

    #[test]
    fn whatever_version_a_client_sends_is_ignored() {
        let root = root();
        let mut claimed = spec("Notes");
        claimed.version = 9;
        claimed.saved_at = Some("2001-01-01T00:00:00Z".into());
        let saved = save_job(root.path(), "notes", claimed, true, None).expect("save");
        assert_eq!(saved.spec.version, 1);
        assert_ne!(saved.spec.saved_at.as_deref(), Some("2001-01-01T00:00:00Z"));
    }

    #[test]
    fn removing_takes_the_earlier_versions_along() {
        let root = root();
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("first");
        let mut changed = spec("Notes");
        changed.instructions = "Version two.".into();
        save_job(root.path(), "notes", changed, false, None).expect("second");
        let moved = remove_job(root.path(), "notes").expect("remove");
        assert!(!root.path().join(".jobs/.versions/notes").exists());
        let kept = root.path().join(moved).with_extension("versions");
        assert!(kept.join("v1.yaml").is_file(), "{}", kept.display());
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("again");
        let versions = list_versions(root.path(), "notes").expect("versions");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version, 1);
    }

    #[test]
    fn the_bench_folder_is_made_on_request_and_never_listed_as_a_job() {
        let root = root();
        assert_eq!(bench_folder(root.path()).expect("bench"), ".jobs/.bench");
        assert!(root.path().join(".jobs/.bench").is_dir());
        fs::write(
            root.path().join(".jobs/.bench/notes.yaml"),
            "schemaVersion: 1\nname: test\n",
        )
        .expect("write");
        save_job(root.path(), "notes", spec("Notes"), true, None).expect("save");
        let list = list_jobs(root.path()).expect("list");
        assert_eq!(list.jobs.len(), 1);
        assert!(list.problems.is_empty(), "{:?}", list.problems);
        assert_eq!(bench_folder(root.path()).expect("again"), ".jobs/.bench");
    }

    #[test]
    fn versions_of_a_missing_job_are_not_found() {
        let root = root();
        assert_eq!(
            list_versions(root.path(), "nobody"),
            Err(JobError::NotFound("nobody".into()))
        );
        assert_eq!(
            list_versions(root.path(), "../x"),
            Err(JobError::NotFound("../x".into()))
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
            save_job(root.path(), "x", spec("x"), false, None),
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
