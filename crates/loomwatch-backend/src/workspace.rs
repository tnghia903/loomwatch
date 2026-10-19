//! Materialising an agent's wired capabilities into a workspace the agent can discover.
//!
//! `docs/decisions/0011-planned-capability-sidecar.md` recorded capability wiring as intent the
//! daemon stores and never executes. `docs/decisions/0012-capability-delivery.md` supersedes that
//! half of it: a capability declared on an agent in the team file is delivered here, by writing it
//! into a per-agent workspace — the same arrangement `teams/daily-news/` proves by hand.
//!
//! Delivery is not authorisation (TNG122 §8 item 4). Copying a skill where the agent will find it
//! grants nothing; every use still passes the agent's permission policy (`permissions.rs`). What
//! delivery does guarantee is honesty: a capability the daemon cannot place fails the run loudly
//! instead of leaving the operator to wonder why nothing used it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::capabilities::{self, CapabilityDefinition};
use crate::config::{AgentConfig, CapabilityKind, CapabilityRef, DeliverAs};
use crate::memory::TeamMemory;
/// Re-exported so a caller that materialises a workspace names the Bus surface it is about to
/// give the agent from the same module it calls [`materialise`] on.
pub use crate::skill_routing::BusMode;
use crate::skill_routing::{self, SkillKind, SkillNeed, SkillRoute, TranslationRequest};

/// Where an agent's wired skills are copied in its workspace: the shared Agent Skills folder,
/// which `LoomWatch`'s agent lists skills from (`engine::session_config`).
pub const SKILL_DIRECTORY: &str = ".agents/skills";
/// The project notes file the Brief is written as for `deliverAs: native-file`, which the agent
/// reads from its work folder at the start of every session (`agent::prompt::project_notes`).
pub const MEMORY_FILE: &str = "AGENTS.md";
/// What a prepared skill's record names as the agent that runs it.
const RUNS_ON: &str = "LoomWatch";

/// Why a wired capability could not be delivered. Every variant is the operator's problem to fix,
/// so each one names the capability and says what to do about it.
#[derive(Debug)]
pub struct CapabilityError {
    pub agent_id: String,
    pub message: String,
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "agent {}: {}", self.agent_id, self.message)
    }
}

impl std::error::Error for CapabilityError {}

/// What `materialise` produced, so the caller can spawn into it and say what it delivered.
#[derive(Debug, Clone)]
pub struct Workspace {
    /// Where the agent starts: [`Self::root`], or the folder the operator chose for it (ADR 0042).
    pub cwd: PathBuf,
    /// `LoomWatch`'s own folder for this agent, holding the copies it reads: skills, the full texts
    /// of added files, and its grants.
    pub root: PathBuf,
    pub skills: Vec<String>,
    /// Exact instructions copied for this agent, before it starts.
    pub required_skills: Vec<PreparedSkill>,
    /// The project notes file the Brief was written as ([`MEMORY_FILE`]), or `None` when the
    /// Brief reached this agent through the packet only.
    pub brief_file: Option<String>,
    /// The knowledge sources and tools wired to this agent (ADR 0029).
    pub delivery: crate::delivery::Delivery,
}

/// A selected skill's exact identity and bytes. Metadata is archived; the instruction text is
/// carried by its prompt section. Where a skill came from never restricts the agent it is given to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSkill {
    pub harness: String,
    pub name: String,
    pub source: String,
    pub source_path: String,
    pub path: String,
    /// SHA-256 of the **delivered file bytes**, unchanged by routing.
    ///
    /// The receipt proves the bundle, not the prompt (ADR 0021). Routing changes what the prompt
    /// says about the skill; it never changes a byte on disk, so this fingerprint keeps meaning
    /// exactly what it meant before routing existed.
    pub sha256: String,
    pub chars: usize,
    /// How this skill reaches this agent.
    pub route: SkillRoute,
    pub kind: SkillKind,
    pub needs: Vec<SkillNeed>,
    /// The skill's own `description:`, which is the whole of what a `native` route puts in a
    /// prompt. `None` when the file has no frontmatter description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// SHA-256 of [`Self::body`] — the frontmatter-stripped text that may enter a prompt.
    ///
    /// Archived beside `sha256` so the record can prove both halves: which bytes were delivered,
    /// and which bytes could have been injected. One hash could not say both.
    pub body_sha256: String,
    /// The delivered file, verbatim.
    #[serde(skip)]
    pub text: String,
    /// The delivered file with its YAML frontmatter removed. The only thing ever inlined.
    #[serde(skip)]
    pub body: String,
    /// The translation note written for this (skill, agent) pair, on the `inline` route only.
    ///
    /// Skipped in this record because it is archived in full as its own `skill_translation`
    /// prompt section; carrying it twice would put the same text in two places that could drift.
    #[serde(skip)]
    pub translation: Option<String>,
}

impl PreparedSkill {
    /// The delivered bundle's directory — where a script or a reference actually is.
    #[must_use]
    pub fn bundle_dir(&self) -> String {
        Path::new(&self.path)
            .parent()
            .unwrap_or(Path::new("."))
            .display()
            .to_string()
    }

    /// A prepared skill for a test, derived from its text the way `materialise` derives it.
    ///
    /// Derived rather than hand-written so a test cannot describe a skill `materialise` would
    /// never produce — a hand-written literal whose `body` still carried its frontmatter would
    /// make the frontmatter contract pass against an impossible input.
    #[cfg(test)]
    pub(crate) fn fixture(name: &str, path: &str, text: &str, route: SkillRoute) -> Self {
        let portability = skill_routing::analyse(text);
        let body = skill_routing::split_frontmatter(text).1.to_owned();
        Self {
            harness: RUNS_ON.to_owned(),
            name: name.to_owned(),
            source: "Claude Code".to_owned(),
            source_path: "/source/SKILL.md".to_owned(),
            path: path.to_owned(),
            sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
            chars: text.chars().count(),
            route,
            kind: portability.kind,
            needs: portability.needs.clone(),
            description: skill_routing::description(text),
            body_sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
            text: text.to_owned(),
            body,
            translation: (route == SkillRoute::Inline).then(|| {
                skill_routing::translation_note(&TranslationRequest {
                    skill: name,
                    needs: &portability.needs,
                    bundle_dir: Path::new(path)
                        .parent()
                        .unwrap_or(Path::new("."))
                        .to_str()
                        .unwrap_or("."),
                    bus: skill_routing::bus_tools(BusMode::Pipeline, true),
                    siblings_wired: &[],
                    siblings_missing: &[],
                })
            }),
        }
    }
}

/// Build the agent's workspace, or `None` when it wired nothing and keeps the cwd it declared.
///
/// The workspace lives beside the team file under `.loomwatch/`, one directory per agent, and its
/// managed skill trees are rebuilt on every run so a capability removed from the canvas stops
/// being delivered.
///
/// The agent starts in it only when the folder it declared is the team's own (ADR 0042). A folder
/// the operator chose stays where the agent works: what was delivered is read from the workspace
/// by its full path, which the prompt names and the permission policy allows.
///
/// # Errors
///
/// Returns an error when a wired capability names a skill that is not installed, or the
/// workspace cannot be written.
// Eight arguments, because the delivery this performs genuinely depends on eight independent
// facts and grouping them into a struct would only move the same list one line up. The house
// pattern for that is an explicit allowance beside the reason (`lib.rs::run_team_mode`).
#[allow(clippy::too_many_arguments)]
pub fn materialise(
    skills: Option<&Path>,
    teams_root: &Path,
    team_path: &Path,
    team_id: &str,
    agent: &AgentConfig,
    declared_cwd: &Path,
    memory: &TeamMemory,
    bus: BusMode,
) -> Result<Option<Workspace>, CapabilityError> {
    // Decision 2: memory implies the managed workspace, the same way wiring a skill already does.
    // `native_memory_file` is `None` — and the workspace is not created for memory's sake — when
    // the team has no Brief for this agent, the agent opted out, `deliverAs: packet-only` keeps it
    // in its own `cwd`. In every one of those cases the Brief still reaches the agent through the
    // context packet.
    //
    // ADR 0042: the agent starts in the workspace only when the folder it declared holds its team
    // file (`cwd: .`, every template's default), which is the teams folder. A folder the operator
    // chose is a project, so the agent stays in it however much is connected. The Brief then
    // reaches it through the packet alone: writing `AGENTS.md` there would change their project.
    let starts_here = holds(declared_cwd, team_path);
    // The declared folder, when the agent starts in the workspace instead of it.
    let carried = starts_here.then_some(declared_cwd);
    let brief_file = native_memory_file(agent, memory).filter(|_| starts_here);
    // ADR 0037: the teams folder is never an agent's own folder, so the team files stay out of its
    // reach. An agent that would start there always gets a folder of its own: an edit can be
    // allowed once at any time, and an allowed command may write in its working folder.
    if agent.capabilities.is_empty() && brief_file.is_none() && !starts_here {
        return Ok(None);
    }
    let fail = |message: String| CapabilityError {
        agent_id: agent.id.clone(),
        message,
    };
    let root = workspace_root(team_path, team_id, &agent.id).map_err(&fail)?;
    let skills_dir = prepare_root(&root, agent).map_err(&fail)?;

    let inventory = capabilities::detect_capabilities(skills, teams_root);
    let mut delivered = Vec::new();
    let mut required_skills = Vec::new();
    let mut instruction_bytes = 0usize;
    // Knowledge and tools are delivered by `deliver_knowledge_and_tools` below (ADR 0029).
    let wired_skills =
        (agent.capabilities.iter()).filter(|wired| wired.kind == CapabilityKind::Skill);
    for CapabilityRef { name, .. } in wired_skills {
        // The Library lists a skill once whatever its spelling, so the same skill wired twice is
        // delivered once.
        if required_skills
            .iter()
            .any(|skill: &PreparedSkill| skill.name.eq_ignore_ascii_case(name))
        {
            continue;
        }
        // Rows are keyed by lowercased name, so a team file that spells a skill differently from
        // its frontmatter still names the same skill.
        let item = inventory
            .skills
            .iter()
            .find(|item| item.name == *name)
            .or_else(|| {
                inventory
                    .skills
                    .iter()
                    .find(|item| item.name.eq_ignore_ascii_case(name))
            })
            .ok_or_else(|| {
                fail(format!(
                    "cannot use the skill {name}: no skill by that name is installed on this machine."
                ))
            })?;
        let definition = capabilities::skill_definitions_for(skills, teams_root, item)
            .into_iter()
            .next()
            .ok_or_else(|| {
                fail(format!(
                    "cannot use the skill {name}: its installed definition could not be read."
                ))
            })?;
        let destination = skills_dir.as_deref().ok_or_else(|| {
            fail(format!(
                "cannot use the skill {name}: no project skill directory was prepared."
            ))
        })?;
        let directory = copy_skill(&definition, name, destination)
            .map_err(|error| fail(format!("cannot use the skill {name}: {error}")))?;
        let path = destination.join(&directory).join("SKILL.md");
        let bytes = fs::read(&path)
            .map_err(|error| fail(format!("cannot load required skill {name}: {error}")))?;
        instruction_bytes += bytes.len();
        // Never silently shorten a required instruction bundle to fit a prompt budget.
        if instruction_bytes > 128 * 1024 {
            return Err(fail(
                "required skill instructions exceed 128 KiB; attach fewer skills to this agent"
                    .to_owned(),
            ));
        }
        let text = String::from_utf8(bytes)
            .map_err(|error| fail(format!("required skill {name} is not UTF-8: {error}")))?;
        required_skills.push(prepare_skill(agent, name, &definition, &path, text, bus));
        delivered.push(directory);
    }
    let delivery = deliver_knowledge_and_tools(
        team_path.parent().unwrap_or(Path::new(".")),
        &inventory,
        agent,
        &root,
        carried,
    )
    .map_err(&fail)?;
    // Written after the skills so a failed skill delivery does not leave a Brief file behind for a
    // run that never starts. Rewritten on every run, like the skills tree, so an edited Brief is
    // picked up and a removed one stops being delivered.
    // `native_memory_file` and `native_file_body` agree on when there is something to write, but
    // that is an invariant across two functions rather than one the type system holds — so this
    // reads the body and does nothing when it is absent, instead of asserting they agree.
    if let Some((name, body)) = brief_file.zip(memory.native_file_body(team_id, agent)) {
        fs::write(root.join(name), body).map_err(|error| {
            fail(format!(
                "cannot write the Brief as {name} in the managed workspace: {error}"
            ))
        })?;
    }
    Ok(Some(Workspace {
        cwd: carried.map_or_else(|| declared_cwd.to_path_buf(), |_| root.clone()),
        root,
        skills: delivered,
        required_skills,
        brief_file: brief_file.map(str::to_owned),
        delivery,
    }))
}

/// ADR 0029: resolve the knowledge and tools an agent wires, after its skills.
///
/// `carried` is the declared folder, when the agent starts in the workspace instead. When it
/// starts in a folder the operator chose (ADR 0042), an excerpted file's full text is named by its
/// path in the workspace, which the permission policy lets the agent read.
fn deliver_knowledge_and_tools(
    team_dir: &Path,
    inventory: &capabilities::CapabilityInventory,
    agent: &AgentConfig,
    root: &Path,
    carried: Option<&Path>,
) -> Result<crate::delivery::Delivery, String> {
    let copies = root.join(crate::chosen_knowledge::TEXT_COPY_DIR);
    let mut delivery = crate::delivery::prepare_for(
        team_dir,
        inventory,
        agent,
        carried.is_none().then_some(copies.as_path()),
    )?;
    // ADR 0035: an added file whose prompt section is only its opening has its full text put in
    // the workspace, where the agent reads it without a PDF reader.
    for knowledge in &delivery.knowledge {
        if let Some(copy) = &knowledge.text_copy {
            fs::create_dir_all(&copies).map_err(|error| error.to_string())?;
            fs::write(copies.join(&copy.file_name), &copy.text).map_err(|error| {
                format!(
                    "cannot put the full text of {} in the working folder: {error}",
                    knowledge.name
                )
            })?;
        }
    }
    delivery.copies = Some(root.to_path_buf());
    Ok(delivery)
}

/// `.loomwatch/<team>/<agent>` beside the team file.
///
/// `TeamConfig::parse` already refuses ids that are not plain names. Checked again here because
/// [`prepare_root`] deletes inside this folder, so it must never be anywhere but under
/// `.loomwatch/`: an agent id of `../../../..` would otherwise make it the home folder.
fn workspace_root(team_path: &Path, team_id: &str, agent_id: &str) -> Result<PathBuf, String> {
    if !crate::config::is_identifier(agent_id)
        || !(team_id.is_empty() || crate::config::is_identifier(team_id))
    {
        return Err(format!(
            "team id {team_id:?} or agent id {agent_id:?} is not a plain name, so LoomWatch will \
             not make a folder for it"
        ));
    }
    Ok(team_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(".loomwatch")
        .join(team_id)
        .join(agent_id))
}

/// Rebuild the managed workspace directory and return the skill tree to copy into, if any.
///
/// `.claude/skills` and `.claude/settings.json` are what an earlier `LoomWatch` wrote for Claude
/// Code. They are cleared too: the agent lists skills from `.claude/skills`, so one wired there
/// once would otherwise be offered for good (ADR 0019 decision 4).
fn prepare_root(root: &Path, agent: &AgentConfig) -> Result<Option<PathBuf>, String> {
    // `knowledge/` holds full texts of added files (ADR 0035), rebuilt on every run for the same
    // reason as the skill trees: a file disconnected since must not linger.
    for relative in [
        ".claude/skills",
        SKILL_DIRECTORY,
        crate::chosen_knowledge::TEXT_COPY_DIR,
    ] {
        let directory = under(root, relative);
        if directory.exists() {
            fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
        }
    }
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    // Only a wired skill needs a skill tree; an agent wired to knowledge or tools alone does not.
    let skills_dir = if agent
        .capabilities
        .iter()
        .any(|capability| capability.kind == CapabilityKind::Skill)
    {
        let directory = under(root, SKILL_DIRECTORY);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Some(directory)
    } else {
        None
    };
    let old_settings = under(root, ".claude/settings.json");
    if old_settings.is_file() {
        fs::remove_file(&old_settings).map_err(|error| error.to_string())?;
    }
    Ok(skills_dir)
}

/// Decide one delivered skill's route, and write its translation note if it needs one.
///
/// Split out of [`materialise`] because it is the whole of ADR 0021's decision and belongs in one
/// readable place: the route is chosen from the skill's own text, once,
/// so the prompt, the archive and the inspector cannot disagree about what was delivered.
fn prepare_skill(
    agent: &AgentConfig,
    name: &str,
    definition: &CapabilityDefinition,
    path: &Path,
    text: String,
    bus: BusMode,
) -> PreparedSkill {
    let portability = skill_routing::analyse(&text);
    let route = skill_routing::route(&portability);
    let body = skill_routing::split_frontmatter(&text).1.to_owned();
    let mut prepared = PreparedSkill {
        harness: RUNS_ON.to_owned(),
        name: name.to_owned(),
        source: definition.source.clone(),
        source_path: definition.path.clone(),
        path: path.to_string_lossy().into_owned(),
        sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
        chars: text.chars().count(),
        route,
        kind: portability.kind,
        needs: portability.needs.clone(),
        description: skill_routing::description(&text),
        body_sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
        text,
        body,
        translation: None,
    };
    if route == SkillRoute::Inline {
        let (wired, missing) = resolve_siblings(agent, name, &portability.siblings);
        prepared.translation = Some(skill_routing::translation_note(&TranslationRequest {
            skill: name,
            needs: &portability.needs,
            bundle_dir: &prepared.bundle_dir(),
            bus: skill_routing::bus_tools(bus, agent.allow_recruiting),
            siblings_wired: &wired,
            siblings_missing: &missing,
        }));
    }
    prepared
}

/// Split the skills a bundle names into the ones wired to this same agent and the ones that are
/// not, so the translation note can say which of them the agent will actually have.
///
/// Resolved against the agent's own `capabilities`, not against everything installed on the
/// machine: a skill installed but not connected is not available to this agent, and telling it
/// otherwise would send it looking for something that was never delivered.
fn resolve_siblings(
    agent: &AgentConfig,
    self_name: &str,
    siblings: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut wired = Vec::new();
    let mut missing = Vec::new();
    for sibling in siblings {
        if sibling.eq_ignore_ascii_case(self_name) {
            continue;
        }
        let connected = agent
            .capabilities
            .iter()
            .any(|capability| capability.name.eq_ignore_ascii_case(sibling));
        if connected {
            wired.push(sibling.clone());
        } else {
            missing.push(sibling.clone());
        }
    }
    (wired, missing)
}

/// The project notes file this agent's Brief should be written as, if any.
fn native_memory_file(agent: &AgentConfig, memory: &TeamMemory) -> Option<&'static str> {
    if memory.brief_for(&agent.id).is_empty() || !agent.reads_brief() {
        return None;
    }
    if agent.deliver_as(memory.deliver_as) != DeliverAs::NativeFile {
        return None;
    }
    Some(MEMORY_FILE)
}

/// `relative`, a `/`-separated path, under `root`, joined part by part so that Windows writes it
/// with `\` throughout, as the agent is told it and as paths are compared.
fn under(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Whether `path` lies inside `folder`, both resolved as far as they exist.
fn holds(folder: &Path, path: &Path) -> bool {
    let resolved =
        |path: &Path| crate::platform::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let folder = resolved(folder);
    let path = path.parent().map_or_else(
        || resolved(path),
        |parent| resolved(parent).join(path.file_name().unwrap_or_default()),
    );
    path.starts_with(folder)
}

/// Copy the skill's whole directory, not just its `SKILL.md`: a skill may ship scripts, references
/// and assets it loads by relative path, and half a skill is worse than none.
///
/// The copy is named for the skill, not for the folder it came from. Installers name folders
/// freely (`claude-design--fd7fe6db51`, a plugin's `index`), so two wired skills could land in one
/// folder and overwrite each other, and the run's "opened the skill" evidence — which matches
/// `<skills>/<name>/SKILL.md` — missed every skill whose folder was named otherwise. A name that
/// cannot be a folder name falls back to the source folder's.
fn copy_skill(definition: &CapabilityDefinition, skill: &str, into: &Path) -> io::Result<String> {
    let source = Path::new(&definition.path)
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "skill file has no directory"))?
        .to_path_buf();
    let usable = !skill.is_empty()
        && !skill.starts_with('.')
        && !skill.contains(['/', '\\', '\0'])
        && skill.len() <= 128;
    let name = if usable {
        skill.to_owned()
    } else {
        source
            .file_name()
            .and_then(|part| part.to_str())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "skill directory has no name")
            })?
            .to_owned()
    };
    let target = into.join(&name);
    if target.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("another wired skill was already delivered as {name}"),
        ));
    }
    copy_tree(&source, &target)?;
    Ok(name)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
        // Symlinks are skipped: following one would copy whatever it points at into the
        // workspace, which is exactly the escape the teams-root boundary exists to prevent.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SpawnConfig;
    use std::collections::BTreeMap;

    /// `prepare_root` deletes `.claude/skills` and `.claude/settings.json` inside this folder, so
    /// an id that climbs out of `.loomwatch/` gets no folder at all, however the agent was built.
    #[test]
    fn workspace_root_stays_under_loomwatch() {
        let team_file = Path::new("/home/me/LoomWatch/teams/team.yaml");
        assert_eq!(
            workspace_root(team_file, "team", "writer").expect("plain ids"),
            Path::new("/home/me/LoomWatch/teams/.loomwatch/team/writer")
        );
        assert_eq!(
            workspace_root(team_file, "", "writer").expect("a team file without an id"),
            Path::new("/home/me/LoomWatch/teams/.loomwatch/writer")
        );
        for (team_id, agent_id) in [
            ("team", "../../../.."),
            ("team", ".."),
            ("team", "a/b"),
            ("team", "/abs"),
            ("../..", "writer"),
        ] {
            let error = workspace_root(team_file, team_id, agent_id)
                .expect_err(&format!("{team_id:?}/{agent_id:?}"));
            assert!(error.contains("not a plain name"), "{error}");
        }
    }

    /// The crate rolls its own scratch directory rather than taking a dev-dependency for it;
    /// `api.rs` tests do the same.
    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-workspace-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create scratch directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn agent(cmd: &str, args: &[&str], capabilities: Vec<CapabilityRef>) -> AgentConfig {
        AgentConfig {
            kind: crate::config::AgentKind::Harness,
            id: "writer".to_owned(),
            name: "Writer".to_owned(),
            role: "writes".to_owned(),
            spawn: SpawnConfig {
                cmd: cmd.to_owned(),
                args: args.iter().map(|part| (*part).to_owned()).collect(),
                env: BTreeMap::new(),
                cwd: PathBuf::from("."),
            },
            model: "default".to_owned(),
            thinking_effort: None,
            allow_recruiting: true,
            capabilities,
            memory: None,
            allow: crate::config::AgentAllow::default(),
            turned_off: Vec::new(),
            done_when: Vec::new(),
            checks: None,
            send_back: None,
            spend: crate::spend::SpendConfig::default(),
        }
    }

    /// Most workspace tests are about capability delivery, not memory; an empty memory is the
    /// state every team without a `memory:` block is in.
    fn no_memory() -> TeamMemory {
        TeamMemory::default()
    }

    fn skill(name: &str) -> CapabilityRef {
        CapabilityRef {
            kind: CapabilityKind::Skill,
            name: name.to_owned(),
            path: None,
            notion: None,
            always_allow: Vec::new(),
        }
    }

    /// ADR 0029: a wired knowledge folder is delivered from its path, readable without asking, with
    /// no skill tree prepared for an agent that wired no skill. What an earlier `LoomWatch` wrote
    /// for Claude Code in the workspace is cleared.
    #[test]
    fn a_wired_knowledge_folder_is_delivered_and_old_claude_settings_are_cleared() {
        let temp = TempDirectory::new();
        let project = temp.path().join("demo");
        let teams = project.join("teams");
        fs::create_dir_all(&teams).expect("teams");
        fs::write(project.join("README.md"), "# Demo\n").expect("readme");
        let team = teams.join("team.yaml");
        let knowledge = vec![CapabilityRef {
            kind: CapabilityKind::Knowledge,
            name: "demo project".to_owned(),
            path: Some(project.clone()),
            notion: None,
            always_allow: Vec::new(),
        }];
        let old = workspace_root(&team, "team", "writer").expect("root");
        fs::create_dir_all(old.join(".claude/skills/stale")).expect("old skills");
        fs::write(old.join(".claude/settings.json"), "{}").expect("old settings");

        let workspace = materialise(
            None,
            &teams,
            &team,
            "team",
            &agent("npx", &[], knowledge),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("delivered")
        .expect("a workspace");
        assert!(!workspace.cwd.join(".agents/skills").exists());
        assert!(!workspace.cwd.join(SKILL_DIRECTORY).exists());
        assert!(!workspace.cwd.join(".claude/settings.json").exists());
        let folder = crate::platform::canonicalize(&project).expect("canonical");
        assert_eq!(
            workspace.delivery.knowledge[0].folders,
            [folder.to_string_lossy()]
        );
        assert_eq!(
            workspace.delivery.knowledge[0].read_access,
            Some(crate::delivery::Permission::Granted)
        );
    }

    /// ADR 0035: a folder the operator linked and a file they added are delivered from their
    /// paths, not looked up in the Library. The file is granted on its own — not its folder, which
    /// holds every file added to the team — and a long file's full text is put in the working
    /// folder, then removed once the file is disconnected.
    #[test]
    fn a_linked_folder_and_an_added_file_are_delivered_from_their_paths() {
        let temp = TempDirectory::new();
        let teams = temp.path().join("teams");
        let reports = temp.path().join("reports");
        fs::create_dir_all(teams.join("team.files")).expect("files");
        fs::create_dir_all(&reports).expect("reports");
        fs::write(reports.join("q3.csv"), "a,b\n").expect("csv");
        let long = "a line of the memo\n".repeat(1_000);
        fs::write(teams.join("team.files/memo.md"), &long).expect("memo");
        fs::write(teams.join("team.files/other.md"), "not this one").expect("other");
        let team = teams.join("team.yaml");
        let chosen = |name: &str, path: &Path| CapabilityRef {
            kind: CapabilityKind::Knowledge,
            name: name.to_owned(),
            path: Some(path.to_path_buf()),
            notion: None,
            always_allow: Vec::new(),
        };
        let wired = vec![
            chosen("reports", &reports),
            chosen("memo.md", Path::new("team.files/memo.md")),
        ];

        let workspace = materialise(
            None,
            &teams,
            &team,
            "team",
            &agent("npx", &["@agentclientprotocol/claude-agent-acp"], wired),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("delivered")
        .expect("a workspace");
        let [folder, file] = workspace.delivery.knowledge.as_slice() else {
            panic!("two sources: {:?}", workspace.delivery.knowledge);
        };
        assert_eq!(folder.source, "Linked folder");
        let memo = crate::platform::canonicalize(teams.join("team.files/memo.md")).expect("memo");
        assert_eq!(file.source, "Added file");
        assert_eq!(file.files, [memo.to_string_lossy()]);
        assert_eq!(file.read_access, Some(crate::delivery::Permission::Granted));
        let policy = crate::permissions::PermissionPolicy::for_agent(
            crate::config::AgentAllow::default(),
            &workspace.cwd,
            &workspace.delivery,
        );
        assert!(policy.may_read(&memo));
        assert!(
            !policy.may_read(&teams.join("team.files/other.md")),
            "only the added file is readable, never its folder"
        );
        assert_eq!(
            fs::read_to_string(workspace.cwd.join("knowledge/memo.md")).expect("full text"),
            long
        );
        // The prompt carries the opening, says where the rest is, and names the grant.
        let prompt = crate::compose_prompt(
            &agent(
                "npx",
                &["@agentclientprotocol/claude-agent-acp"],
                Vec::new(),
            ),
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask::goal("Summarise the memo"),
        )
        .with_delivery(&workspace.delivery);
        assert!(
            prompt.text.contains(&format!(
                "File: {}\nYou have read access to this file.",
                memo.display()
            )),
            "{}",
            prompt.text
        );
        assert!(
            prompt
                .text
                .contains("The full text is in knowledge/memo.md in your working folder")
        );

        let without = materialise(
            None,
            &teams,
            &team,
            "team",
            &agent(
                "npx",
                &["@agentclientprotocol/claude-agent-acp"],
                vec![chosen("reports", &reports)],
            ),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("delivered")
        .expect("a workspace");
        assert!(
            !without.cwd.join("knowledge").exists(),
            "a disconnected file's full text must not linger"
        );
    }

    /// A folder the operator chose is theirs, so an agent that wired nothing stays in it.
    #[test]
    fn an_agent_that_wired_nothing_keeps_a_folder_the_operator_chose() {
        let temp = TempDirectory::new();
        let team = temp.path().join("team.yaml");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let materialised = materialise(
            None,
            temp.path(),
            &team,
            "team",
            &agent("npx", &["claude-agent-acp"], Vec::new()),
            &project,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("no capabilities is not an error");
        assert!(materialised.is_none());
    }

    /// ADR 0037: the teams folder is never an agent's own folder. An agent that would otherwise
    /// work beside its team file is given one, whatever it is allowed: an edit can be allowed once
    /// at any time, and an allowed command may write in its working folder.
    #[test]
    fn an_agent_allowed_to_edit_never_works_in_the_folder_holding_its_team_file() {
        let temp = TempDirectory::new();
        let team = temp.path().join("team.yaml");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project folder");
        let with = |allow: crate::config::AgentAllow, cwd: &Path| {
            let mut agent = agent("npx", &["claude-agent-acp"], Vec::new());
            agent.allow = allow;
            materialise(
                None,
                temp.path(),
                &team,
                "team",
                &agent,
                cwd,
                &no_memory(),
                BusMode::Pipeline,
            )
            .expect("materialise")
        };
        let edits = crate::config::AgentAllow {
            edits: true,
            ..Default::default()
        };
        let moved = with(edits, temp.path()).expect("a folder of its own");
        assert_eq!(moved.cwd, temp.path().join(".loomwatch/team/writer"));
        assert!(
            with(edits, &project).is_none(),
            "a folder the operator chose, without the team file in it, stays the agent's"
        );
        let web_and_commands = crate::config::AgentAllow {
            web: true,
            commands: true,
            ..Default::default()
        };
        for allow in [web_and_commands, crate::config::AgentAllow::default()] {
            let moved = with(allow, temp.path()).expect("a folder of its own");
            assert_eq!(moved.cwd, temp.path().join(".loomwatch/team/writer"));
            assert!(with(allow, &project).is_none());
        }
    }

    #[test]
    fn a_skill_is_copied_into_the_agents_skill_folder_and_its_receipt_kept() {
        let temp = TempDirectory::new();
        let home = temp.path().join("home");
        let source = home.join(".claude").join("skills").join("claude-design");
        fs::create_dir_all(&source).expect("skill directory");
        fs::write(
            source.join("SKILL.md"),
            "---\nname: claude-design\ndescription: Design artifacts\n---\nBody",
        )
        .expect("SKILL.md");
        let teams = temp.path().join("teams");
        fs::create_dir_all(&teams).expect("teams");
        let team = teams.join("team.yaml");

        let workspace = materialise(
            Some(&home),
            &teams,
            &team,
            "team",
            &agent(
                "npx",
                &["-y", "@agentclientprotocol/codex-acp"],
                vec![skill("claude-design")],
            ),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("delivery succeeds")
        .expect("a wired capability produces a workspace");

        assert!(
            workspace
                .cwd
                .join(".agents/skills/claude-design/SKILL.md")
                .is_file(),
            "the agent lists skills from the shared Agent Skills folder",
        );
        assert!(!workspace.cwd.join(".claude/skills/claude-design").exists());
        let receipt = &workspace.required_skills[0];
        assert_eq!(receipt.name, "claude-design");
        assert_eq!(
            receipt.source_path,
            source.join("SKILL.md").to_string_lossy()
        );
        assert_eq!(
            receipt.text,
            fs::read_to_string(&receipt.path).expect("delivered instructions")
        );
        assert_eq!(
            receipt.sha256,
            format!("{:x}", Sha256::digest(receipt.text.as_bytes()))
        );
        fs::write(source.join("SKILL.md"), "source edited after preparation").expect("source edit");
        assert!(
            receipt.text.ends_with("Body"),
            "the prepared prompt retains the selected revision"
        );
    }

    /// Installers name folders freely. The copy is named for the skill, so two skills from folders
    /// with the same name cannot overwrite each other, and the run's evidence — which matches
    /// `<skills>/<name>/SKILL.md` — can see the skill being opened.
    #[test]
    fn a_skill_is_delivered_under_its_own_name_and_matched_whatever_its_case() {
        let temp = TempDirectory::new();
        let home = temp.path().join("home");
        for (folder, name) in [
            ("claude-design--fd7fe6db51", "claude-design"),
            ("sales/index", "sales-index"),
            ("data/index", "data-index"),
        ] {
            let source = home.join(folder);
            fs::create_dir_all(&source).expect("skill directory");
            fs::write(
                source.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: d\n---\n{name} body"),
            )
            .expect("SKILL.md");
        }
        let teams = temp.path().join("teams");
        fs::create_dir_all(&teams).expect("teams");

        let workspace = materialise(
            Some(&home),
            &teams,
            &teams.join("team.yaml"),
            "team",
            &agent(
                "claude-agent-acp",
                &[],
                vec![
                    skill("Claude-Design"),
                    skill("sales-index"),
                    skill("data-index"),
                    skill("claude-design"),
                ],
            ),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("delivery succeeds")
        .expect("a workspace");

        let skills = workspace.cwd.join(".agents/skills");
        assert!(skills.join("Claude-Design/SKILL.md").is_file());
        assert!(
            fs::read_to_string(skills.join("sales-index/SKILL.md"))
                .expect("sales")
                .contains("sales-index body")
        );
        assert!(
            fs::read_to_string(skills.join("data-index/SKILL.md"))
                .expect("data")
                .contains("data-index body")
        );
        assert!(!skills.join("index").exists());
        assert_eq!(
            workspace.required_skills.len(),
            3,
            "the same skill wired twice is delivered once"
        );
    }

    #[test]
    fn a_skill_that_is_not_installed_fails_the_run_rather_than_going_quiet() {
        let temp = TempDirectory::new();
        let team = temp.path().join("team.yaml");
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".claude/skills")).expect("home");
        let error = materialise(
            Some(&home),
            temp.path(),
            &team,
            "team",
            &agent("npx", &["claude-agent-acp"], vec![skill("nonexistent")]),
            temp.path(),
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect_err("an absent skill is an error");
        assert!(error.message.contains("no skill by that name"), "{error}");
    }

    #[test]
    fn a_wired_skill_is_copied_whole_into_the_workspace_the_harness_reads() {
        let temp = TempDirectory::new();
        let home = temp.path().join("home");
        let source = home.join(".claude/skills/report-writer");
        fs::create_dir_all(source.join("references")).expect("skill dirs");
        fs::write(
            source.join("SKILL.md"),
            "---\nname: report-writer\ndescription: Writes reports\n---\nBody",
        )
        .expect("SKILL.md");
        fs::write(source.join("references/style.md"), "House style").expect("reference");
        let teams = temp.path().join("teams");
        fs::create_dir_all(&teams).expect("teams");
        let team = teams.join("team.yaml");

        let workspace = materialise(
            Some(&home),
            &teams,
            &team,
            "team",
            &agent("npx", &["claude-agent-acp"], vec![skill("report-writer")]),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("delivery succeeds")
        .expect("a wired capability produces a workspace");

        assert_eq!(workspace.skills, vec!["report-writer".to_owned()]);
        let delivered = workspace.cwd.join(".agents/skills/report-writer");
        assert!(delivered.join("SKILL.md").is_file());
        // The whole directory travels, so a skill that loads a reference by relative path works.
        assert!(delivered.join("references/style.md").is_file());
    }

    /// A team whose Writer works in a project folder of its own and has a skill, a long added file
    /// and a Brief, for the ADR 0042 tests.
    struct ChosenFolderTeam {
        _temp: TempDirectory,
        home: PathBuf,
        teams: PathBuf,
        team: PathBuf,
        project: PathBuf,
        writer: AgentConfig,
    }

    impl ChosenFolderTeam {
        fn new() -> Self {
            let temp = TempDirectory::new();
            let home = temp.path().join("home");
            let source = home.join(".claude/skills/report-writer");
            fs::create_dir_all(&source).expect("skill dir");
            fs::write(
                source.join("SKILL.md"),
                "---\nname: report-writer\ndescription: Writes reports\n---\nBody",
            )
            .expect("SKILL.md");
            let teams = temp.path().join("teams");
            fs::create_dir_all(teams.join("team.files")).expect("files");
            fs::create_dir_all(teams.join("brief")).expect("brief");
            let team = teams.join("team.yaml");
            fs::write(&team, "").expect("team");
            fs::write(
                teams.join("brief/constraints.md"),
                "# C\nNever touch main.\n",
            )
            .expect("brief");
            fs::write(
                teams.join("team.files/memo.md"),
                "a line of the memo\n".repeat(1_000),
            )
            .expect("memo");
            let project = temp.path().join("project");
            fs::create_dir_all(project.join(".claude")).expect("project");
            fs::write(
                project.join(".claude/settings.json"),
                r#"{"permissions":{}}"#,
            )
            .expect("project settings");
            let project = crate::platform::canonicalize(&project).expect("canonical");
            let mut writer = agent(
                "npx",
                &["@agentclientprotocol/claude-agent-acp"],
                vec![
                    skill("report-writer"),
                    CapabilityRef {
                        kind: CapabilityKind::Knowledge,
                        name: "memo.md".to_owned(),
                        path: Some(PathBuf::from("team.files/memo.md")),
                        notion: None,
                        always_allow: Vec::new(),
                    },
                ],
            );
            writer.allow.edits = true;
            Self {
                _temp: temp,
                home,
                teams,
                team,
                project,
                writer,
            }
        }

        fn materialise(&self, memory: &TeamMemory) -> Workspace {
            materialise(
                Some(&self.home),
                &self.teams,
                &self.team,
                "team",
                &self.writer,
                &self.project,
                memory,
                BusMode::Pipeline,
            )
            .expect("delivered")
            .expect("a workspace still holds the copies")
        }
    }

    /// ADR 0042: connecting a skill, a file or a Brief to an agent that works in a folder the
    /// operator chose used to move it into the workspace, so it silently stopped working on their
    /// project. It stays in the chosen folder, the workspace still holds the copies, and nothing is
    /// written into the project.
    #[test]
    fn an_agent_in_a_chosen_folder_stays_there_whatever_is_connected() {
        let team = ChosenFolderTeam::new();
        let workspace = team.materialise(&brief_memory(&team.teams, &team.team));
        let project = &team.project;

        assert_eq!(
            &workspace.cwd, project,
            "it starts in the folder it was given"
        );
        assert_eq!(workspace.root, team.teams.join(".loomwatch/team/writer"));
        assert_eq!(
            workspace.delivery.copies.as_deref(),
            Some(workspace.root.as_path())
        );
        assert!(
            workspace
                .root
                .join(".agents/skills/report-writer/SKILL.md")
                .is_file()
        );
        assert!(workspace.root.join("knowledge/memo.md").is_file());
        // The Brief reaches it through the packet; nothing is added to the project.
        assert_eq!(workspace.brief_file, None);
        assert!(!project.join("AGENTS.md").exists());
        assert!(!project.join(".agents/skills").exists());
        assert_eq!(
            fs::read_to_string(project.join(".claude/settings.json")).expect("untouched"),
            r#"{"permissions":{}}"#
        );
        assert!(
            !workspace.root.join(".claude/settings.json").exists(),
            "grants in a folder the app never opens would only mislead"
        );
    }

    /// ADR 0042: an agent working in a chosen folder is told where its copies are by their full
    /// paths, and the permission policy lets it read them there, but not the team files.
    #[test]
    fn an_agent_in_a_chosen_folder_is_pointed_at_its_copies_and_may_read_them() {
        let team = ChosenFolderTeam::new();
        let workspace = team.materialise(&no_memory());
        let prompt = crate::compose_for(
            &team.writer,
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask::goal("Summarise the memo"),
            Some(&workspace),
        );
        let skill_file = under(&workspace.root, ".agents/skills/report-writer/SKILL.md");
        assert!(
            prompt
                .text
                .contains(&format!("read {} in full", skill_file.display())),
            "{}",
            prompt.text
        );
        let copy = workspace.root.join("knowledge").join("memo.md");
        assert!(
            prompt
                .text
                .contains(&format!("The full text is in {}; read it", copy.display())),
            "{}",
            prompt.text
        );
        let policy = crate::permissions::PermissionPolicy::for_agent(
            team.writer.allow,
            &team.project,
            &workspace.delivery,
        );
        let read = |path: &Path| {
            policy.approves(&serde_json::json!({"params": {"toolCall": {
                "kind": "read",
                "locations": [{"path": path.to_string_lossy()}],
            }}}))
        };
        assert!(read(&skill_file));
        assert!(read(&copy));
        assert!(
            !read(&team.teams.join("team.yaml")),
            "the team files stay out of reach"
        );
    }

    /// Delivery channel 2: the Brief written as the project notes file the agent reads at the
    /// start of every session, the one channel a compaction does not reach. A `native-file` agent with no
    /// wired capabilities still gets a managed workspace, because there is nowhere else to put it.
    #[test]
    fn a_native_file_brief_moves_the_agent_into_a_managed_workspace() {
        let temp = TempDirectory::new();
        let teams = temp.path().join("teams");
        fs::create_dir_all(teams.join("brief")).expect("teams");
        let team = teams.join("team.yaml");
        fs::write(&team, "").expect("team");
        fs::write(
            teams.join("brief/constraints.md"),
            "# House constraints\nNever touch main.\n",
        )
        .expect("brief");
        let memory = brief_memory(&teams, &team);

        let workspace = materialise(
            None,
            &teams,
            &team,
            "team",
            &agent(
                "npx",
                &["-y", "@agentclientprotocol/claude-agent-acp"],
                Vec::new(),
            ),
            &teams,
            &memory,
            BusMode::Pipeline,
        )
        .expect("delivery succeeds")
        .expect("a native-file Brief produces a workspace even with no capabilities wired");

        assert_eq!(workspace.brief_file.as_deref(), Some("AGENTS.md"));
        let written = fs::read_to_string(workspace.cwd.join("AGENTS.md")).expect("AGENTS.md");
        assert!(written.contains("Never touch main."), "{written}");
        // It is machine-written and rebuilt every run, so it must say so rather than inviting an
        // edit that the next run silently discards.
        assert!(written.contains("Rebuilt on every run"), "{written}");
    }

    /// `packet-only` is how an agent that must run inside a repository opts out: nothing is
    /// written beside its code and it keeps the cwd it declared.
    #[test]
    fn packet_only_keeps_the_agent_in_its_own_directory() {
        let temp = TempDirectory::new();
        let teams = temp.path().join("teams");
        fs::create_dir_all(teams.join("brief")).expect("teams");
        let team = teams.join("team.yaml");
        fs::write(&team, "").expect("team");
        fs::write(
            teams.join("brief/constraints.md"),
            "# C\nNever touch main.\n",
        )
        .expect("brief");
        let memory = brief_memory(&teams, &team);

        let mut opted_out = agent("npx", &["claude-agent-acp"], Vec::new());
        opted_out.memory = Some(crate::config::AgentMemoryConfig {
            brief: true,
            deliver_as: Some(DeliverAs::PacketOnly),
        });
        // The repository it must run in: a folder of its own, not the teams folder.
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        let workspace = materialise(
            None,
            &teams,
            &team,
            "team",
            &opted_out,
            &repo,
            &memory,
            BusMode::Pipeline,
        )
        .expect("delivery succeeds");
        assert!(
            workspace.is_none(),
            "packet-only must not create a workspace"
        );
    }

    fn brief_memory(teams: &Path, team: &Path) -> TeamMemory {
        TeamMemory::load(
            &crate::memory::MemoryRoots {
                team_dir: teams,
                teams_root: teams,
            },
            team,
            Some(&crate::config::MemoryConfig {
                enabled: true,
                brief: vec![crate::config::BriefEntryConfig {
                    path: PathBuf::from("brief/constraints.md"),
                    applies_to: None,
                }],
                inherits: Vec::new(),
                notebook: crate::config::NotebookConfig::default(),
                packet: crate::config::PacketConfig::default(),
                deliver_as: DeliverAs::NativeFile,
            }),
        )
        .expect("load the test Brief")
    }

    /// A skill that assumes Claude Code's own execution facilities. Written out once because
    /// three tests turn on these bytes.
    const COUPLED_SKILL: &str = "---\nname: claude-design\ndescription: Design one-off HTML artifacts (landing, deck, prototype).\n---\n# Designing\n\nUse the Task tool to fan out three variants in parallel.\nRun `python3 scripts/render.py --out deck.html` to build it.\nTrack the steps with TodoWrite.\n\n## House rules\n\nOne idea per screen. Type sets the rhythm; colour is the accent, never the structure.\nMeasure twice: a layout that only works at one width is not a layout.\nPrefer one strong photograph to three weak ones, and no photograph at all to one stock image.\nWhite space is not empty space. Leave the margins alone.\nEvery number on a chart earns its ink or comes off.\n";

    /// The same skill without the coupling: what it says, not what Claude Code does it with.
    const PORTABLE_SKILL: &str = "---\nname: claude-design\ndescription: Design one-off HTML artifacts (landing, deck, prototype).\n---\n# Designing\n\nOne idea per screen. Type sets the rhythm; colour is the accent, never the structure.\nWhite space is not empty space. Leave the margins alone.\n";

    /// Deliver `COUPLED_SKILL` to one agent and hand back what was prepared.
    fn deliver(temp: &TempDirectory, recruiting: bool) -> PreparedSkill {
        deliver_text(temp, COUPLED_SKILL, recruiting)
    }

    fn deliver_text(temp: &TempDirectory, text: &str, recruiting: bool) -> PreparedSkill {
        let home = temp.path().join(format!("home-{}", uuid::Uuid::new_v4()));
        let source = home.join("claude-design");
        fs::create_dir_all(&source).expect("skill directory");
        fs::write(source.join("SKILL.md"), text).expect("SKILL.md");
        let teams = temp.path().join(format!("teams-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&teams).expect("teams");
        let team = teams.join("team.yaml");
        let mut wired = agent("npx", &[], vec![skill("claude-design")]);
        wired.allow_recruiting = recruiting;
        let workspace = materialise(
            Some(&home),
            &teams,
            &team,
            "team",
            &wired,
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("delivery succeeds")
        .expect("a wired capability produces a workspace");
        workspace
            .required_skills
            .into_iter()
            .next()
            .expect("one prepared skill")
    }

    /// Contract (i) of ADR 0021: the YAML manifest is a message to a skill loader, and no route
    /// puts it in front of a model. The file on disk keeps it, byte for byte.
    #[test]
    fn no_route_puts_a_skills_yaml_frontmatter_in_front_of_the_model() {
        let temp = TempDirectory::new();
        for (text, route) in [
            (COUPLED_SKILL, SkillRoute::Inline),
            (PORTABLE_SKILL, SkillRoute::Native),
        ] {
            let prepared = deliver_text(&temp, text, true);
            assert_eq!(prepared.route, route);
            // What may be injected.
            assert!(
                !prepared.body.contains("description:"),
                "{:?}",
                prepared.body
            );
            assert!(!prepared.body.starts_with("---"));
            assert!(prepared.body.starts_with("# Designing"));
            // What was delivered: untouched, including the frontmatter and its fingerprint.
            assert_eq!(prepared.text, text);
            assert_eq!(
                fs::read_to_string(&prepared.path).expect("delivered file"),
                text,
                "the file on disk is never rewritten",
            );
            assert_eq!(
                prepared.sha256,
                format!("{:x}", Sha256::digest(text.as_bytes())),
                "the receipt still fingerprints the delivered bytes, not the prompt",
            );
            assert_ne!(
                prepared.body_sha256, prepared.sha256,
                "a stripped body and a whole file are different bytes and get different hashes",
            );
            // And the prompt agrees with the record.
            let prompt = crate::memory::ComposedPrompt::default()
                .with_required_skills(std::slice::from_ref(&prepared));
            assert!(
                !prompt.text.contains("description: Design one-off"),
                "{}",
                prompt.text
            );
        }
    }

    /// Contract (ii): a skill coupled to Claude Code is inlined and translated, and the note names
    /// a Team Bus tool only when this agent will actually be offered it.
    #[test]
    fn a_coupled_skill_is_inlined_with_a_note_that_only_promises_tools_it_has() {
        let temp = TempDirectory::new();

        let recruiting = deliver(&temp, true);
        assert_eq!(recruiting.route, SkillRoute::Inline);
        assert_eq!(recruiting.kind, SkillKind::Artifact);
        assert!(recruiting.needs.contains(&SkillNeed::Subagents));
        assert!(recruiting.needs.contains(&SkillNeed::Scripts));
        assert!(recruiting.needs.contains(&SkillNeed::NamedTools));
        let note = recruiting.translation.clone().expect("a translation note");
        assert!(note.contains("`ask`"), "{note}");
        assert!(
            !note.contains("`dispatch`") && !note.contains("`handoff`"),
            "pipeline mode withdraws both outright: {note}"
        );
        assert!(note.contains("may be asked first and may say no"), "{note}");
        assert!(note.contains(&recruiting.bundle_dir()), "{note}");

        let restricted = deliver(&temp, false);
        let note = restricted.translation.expect("a translation note");
        assert!(
            !note.contains("`ask`"),
            "an agent refused `ask` by `allowRecruiting: false` must not be told to call it: {note}"
        );
        assert!(note.contains("do the steps yourself"), "{note}");
    }

    /// Contract (iii): a skill that assumes nothing takes the short route: a pointer to its file
    /// instead of its text.
    #[test]
    fn a_portable_skill_is_native_with_a_pointer_instead_of_its_text() {
        let temp = TempDirectory::new();
        let prepared = deliver_text(&temp, PORTABLE_SKILL, true);
        assert_eq!(prepared.route, SkillRoute::Native);
        assert!(prepared.translation.is_none(), "nothing to translate");
        let section = crate::memory::ComposedPrompt::default()
            .with_required_skills(std::slice::from_ref(&prepared))
            .sections
            .into_iter()
            .next()
            .expect("a required-skill section");
        assert!(section.text.contains("Design one-off HTML artifacts"));
        assert!(section.text.contains("SKILL.md in full"));
        assert!(
            !section.text.contains("One idea per screen"),
            "the body stays on disk, where the agent reads it: {}",
            section.text
        );
    }

    #[test]
    fn removing_a_capability_stops_delivering_it_on_the_next_run() {
        let temp = TempDirectory::new();
        let home = temp.path().join("home");
        for name in ["kept", "dropped"] {
            let source = home.join(name);
            fs::create_dir_all(&source).expect("skill dir");
            fs::write(
                source.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: d\n---\nBody"),
            )
            .expect("SKILL.md");
        }
        let teams = temp.path().join("teams");
        fs::create_dir_all(&teams).expect("teams");
        let team = teams.join("team.yaml");

        materialise(
            Some(&home),
            &teams,
            &team,
            "team",
            &agent(
                "npx",
                &["claude-agent-acp"],
                vec![skill("kept"), skill("dropped")],
            ),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("first run")
        .expect("workspace");
        let workspace = materialise(
            Some(&home),
            &teams,
            &team,
            "team",
            &agent("npx", &["claude-agent-acp"], vec![skill("kept")]),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("second run")
        .expect("workspace");

        assert!(workspace.cwd.join(".agents/skills/kept").is_dir());
        assert!(
            !workspace.cwd.join(".agents/skills/dropped").exists(),
            "a capability taken off the canvas must stop being delivered",
        );
    }
}
