//! Materialising an agent's wired capabilities into a workspace the harness can discover.
//!
//! `docs/decisions/0011-planned-capability-sidecar.md` recorded capability wiring as intent the
//! daemon stores and never executes. `docs/decisions/0012-capability-delivery.md` supersedes that
//! half of it: a capability declared on an agent in the team file is delivered here, by writing it
//! into a per-agent workspace in the harness's own format — the same arrangement
//! `teams/daily-news/` proves by hand.
//!
//! Delivery is not authorisation (TNG122 §8 item 4). Copying a skill where a harness will find it
//! grants nothing the harness would not otherwise allow; every use still passes that harness's own
//! permission gate, which `LoomWatch` answers by refusing anything outside the workspace's
//! `.claude/settings.json`. What delivery does guarantee is honesty: a capability the daemon cannot
//! place fails the run loudly instead of leaving the operator to wonder why nothing used it.

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

/// Which harness an agent spawns, by the ACP adapter its command names. Skill delivery is
/// harness-specific: Claude Code uses its own project directory while the other Agent Skills
/// harnesses use the interoperable `.agents/skills` directory. The same identification chooses
/// the harness-native memory file the Brief is written as (`docs/TEAM_MEMORY.md`, decision 2).
///
/// The variants match the ids in `api.rs`'s `HARNESSES` catalog one for one; adding a harness
/// there without adding it here would silently fall through to [`Harness::Other`] and lose that
/// agent its Brief file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Harness {
    Claude,
    Codex,
    Gemini,
    OpenCode,
    OpenClaw,
    Hermes,
    Pi,
    Other,
}

impl Harness {
    #[must_use]
    pub fn of(agent: &AgentConfig) -> Self {
        let haystack = std::iter::once(&agent.spawn.cmd)
            .chain(agent.spawn.args.iter())
            .map(|part| part.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        // Order matters: the longer, more specific names are tested first so `openclaw` is never
        // read as OpenCode and `claude-agent-acp` is never read as something generic. Neither
        // `openclaw` nor `opencode` contains the substring `claude`, so the Claude test is safe
        // wherever it sits, but the two `open*` names differ by one letter and must not be
        // reordered.
        if haystack.contains("openclaw") {
            Self::OpenClaw
        } else if haystack.contains("opencode") {
            Self::OpenCode
        } else if haystack.contains("claude") {
            Self::Claude
        } else if haystack.contains("codex") {
            Self::Codex
        } else if haystack.contains("gemini") {
            Self::Gemini
        } else if haystack.contains("hermes") {
            Self::Hermes
        } else if Self::names_pi(&haystack) {
            Self::Pi
        } else {
            Self::Other
        }
    }

    /// `pi` is two letters, so a substring test would match `mapi`, `pip`, or any path containing
    /// them. Match it as a whole whitespace- or path-separated word instead.
    fn names_pi(haystack: &str) -> bool {
        haystack
            .split([' ', '/', '\\'])
            .any(|part| part == "pi" || part == "pi.exe")
    }

    /// The project-local directory this harness scans for Agent Skills.
    ///
    /// A skill's source does not constrain where it can run. `LoomWatch` copies the selected bundle
    /// from any scanned provider into this target-harness path. Codex, Gemini, pi and the other
    /// Agent Skills harnesses use the shared path; Claude Code keeps its native project path.
    #[must_use]
    pub const fn skill_directory(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some(".claude/skills"),
            Self::Codex | Self::Gemini | Self::OpenCode | Self::OpenClaw | Self::Pi => {
                Some(".agents/skills")
            }
            // Hermes recognizes project `.agents/skills` only for repositories explicitly added
            // to its own trust list. LoomWatch cannot make that global trust decision on an
            // operator's behalf, so it stays unsupported until the ACP adapter can pass an
            // explicit per-session skill root.
            Self::Hermes | Self::Other => None,
        }
    }

    /// The `id` this harness carries in `api.rs`'s `HARNESSES` catalog, which is the key the web
    /// UI knows an agent's harness by. `None` for a harness `LoomWatch` cannot name.
    #[must_use]
    pub const fn id(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("claude"),
            Self::Codex => Some("codex"),
            Self::Gemini => Some("gemini"),
            Self::OpenCode => Some("opencode"),
            Self::OpenClaw => Some("openclaw"),
            Self::Hermes => Some("hermes"),
            Self::Pi => Some("pi"),
            Self::Other => None,
        }
    }

    /// Every harness `LoomWatch` can route a skill to, for building a per-harness route table.
    pub const ALL: [Self; 7] = [
        Self::Claude,
        Self::Codex,
        Self::Gemini,
        Self::OpenCode,
        Self::OpenClaw,
        Self::Hermes,
        Self::Pi,
    ];

    /// Whether this harness advertises HTTP MCP, which is what decides whether it reaches the Team
    /// Bus at all (`acp.rs::start_recorder` archives `team_bus_unavailable` when it does not).
    ///
    /// Verified rows only, from `docs/ARCHITECTURE.md`'s harness table: `OpenClaw` 2026.8.1 is ACP
    /// with `loadSession` and **no HTTP MCP**, and pi is not ACP at all. An unverified harness
    /// answers `false`, because the one thing a translation note must never do is name a tool the
    /// agent turns out not to have.
    #[must_use]
    pub const fn advertises_http_mcp(self) -> bool {
        match self {
            Self::Claude | Self::Codex | Self::Gemini | Self::OpenCode | Self::Hermes => true,
            Self::OpenClaw | Self::Pi | Self::Other => false,
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Gemini => "Gemini",
            Self::OpenCode => "OpenCode",
            Self::OpenClaw => "OpenClaw",
            Self::Hermes => "Hermes",
            Self::Pi => "pi",
            Self::Other => "this harness",
        }
    }

    /// The project memory file this harness loads from its working directory on its own, which is
    /// the one delivery channel a harness-side context compaction cannot reach (channel 2 in
    /// `docs/TEAM_MEMORY.md`).
    ///
    /// Verified on this machine rather than assumed: Claude Code reads `CLAUDE.md`; Gemini CLI
    /// reads `GEMINI.md`; `Codex`, `OpenCode`, `OpenClaw`, Hermes and pi all read `AGENTS.md`
    /// (pi's `--no-context-files` flag names `AGENTS.md` and `CLAUDE.md` explicitly, and the
    /// Hermes and `OpenClaw` bundles reference `AGENTS.md` far more than any alternative).
    /// `None` means the harness is unknown to `LoomWatch`, so the Brief reaches it through the
    /// context packet only.
    #[must_use]
    pub const fn memory_file(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("CLAUDE.md"),
            Self::Gemini => Some("GEMINI.md"),
            Self::Codex | Self::OpenCode | Self::OpenClaw | Self::Hermes | Self::Pi => {
                Some("AGENTS.md")
            }
            Self::Other => None,
        }
    }
}

/// What `materialise` produced, so the caller can spawn into it and say what it delivered.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub cwd: PathBuf,
    pub skills: Vec<String>,
    /// Exact instructions copied for this agent, before its harness starts.
    pub required_skills: Vec<PreparedSkill>,
    /// The harness-native memory file the Brief was written as (`CLAUDE.md`, `AGENTS.md`,
    /// `GEMINI.md`), or `None` when the Brief reached this agent through the packet only.
    pub brief_file: Option<String>,
}

/// A selected skill's exact identity and bytes. Metadata is archived; the instruction text is
/// carried by its prompt section. The source harness never restricts the receiving harness.
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
            harness: "Codex".to_owned(),
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
                    harness: Harness::Codex,
                    needs: &portability.needs,
                    bundle_dir: Path::new(path)
                        .parent()
                        .unwrap_or(Path::new("."))
                        .to_str()
                        .unwrap_or("."),
                    bus: skill_routing::bus_tools(Harness::Codex, BusMode::Pipeline, true),
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
/// being delivered, including after an agent changes harness.
///
/// # Errors
///
/// Returns an error when a wired capability names a skill that is not installed, the target
/// harness has no known project-level Agent Skills directory, or the workspace cannot be written.
// Eight arguments, because the delivery this performs genuinely depends on eight independent
// facts and grouping them into a struct would only move the same list one line up. The house
// pattern for that is an explicit allowance beside the reason (`lib.rs::run_team_mode`).
#[allow(clippy::too_many_arguments)]
pub fn materialise(
    home: Option<&Path>,
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
    // in its own `cwd`, or LoomWatch does not know which file this harness reads. In every one of
    // those cases the Brief still reaches the agent through the context packet.
    let brief_file = native_memory_file(agent, memory);
    if agent.capabilities.is_empty() && brief_file.is_none() {
        return Ok(None);
    }
    let fail = |message: String| CapabilityError {
        agent_id: agent.id.clone(),
        message,
    };
    let root = team_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(".loomwatch")
        .join(team_id)
        .join(&agent.id);
    let skills_dir = prepare_root(&root, agent, declared_cwd).map_err(&fail)?;

    let inventory = capabilities::detect_capabilities(home, teams_root);
    let mut delivered = Vec::new();
    let mut required_skills = Vec::new();
    let mut instruction_bytes = 0usize;
    for capability in &agent.capabilities {
        let CapabilityRef {
            kind: CapabilityKind::Skill,
            name,
        } = capability;
        let item = inventory
            .skills
            .iter()
            .find(|item| item.name == *name)
            .ok_or_else(|| {
                fail(format!(
                    "cannot use the skill {name}: no skill by that name is installed on this machine."
                ))
            })?;
        let definition = home
            .map(|home| capabilities::skill_definitions_for(home, item))
            .unwrap_or_default()
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
        let directory = copy_skill(&definition, destination)
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
        cwd: root,
        skills: delivered,
        required_skills,
        brief_file: brief_file.map(str::to_owned),
    }))
}

/// Rebuild the managed workspace directory and return the skill tree to copy into, if any.
///
/// Both managed trees are cleared, not just this harness's: that is what prevents a skill wired
/// under an agent's old harness from surviving a harness switch and being discovered accidentally
/// on a later run (ADR 0019 decision 4).
fn prepare_root(
    root: &Path,
    agent: &AgentConfig,
    declared_cwd: &Path,
) -> Result<Option<PathBuf>, String> {
    for relative in [".claude/skills", ".agents/skills"] {
        let directory = root.join(relative);
        if directory.exists() {
            fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
        }
    }
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let skills_dir = if agent.capabilities.is_empty() {
        None
    } else {
        let harness = Harness::of(agent);
        let relative = harness.skill_directory().ok_or_else(|| {
            format!(
                "cannot deliver skills: LoomWatch does not know the project skill directory for {}.",
                harness.label()
            )
        })?;
        let directory = root.join(relative);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Some(directory)
    };
    // The harness only ever asks LoomWatch for permission, and LoomWatch refuses anything the
    // workspace does not allow. Carrying the declared cwd's settings across keeps that contract
    // with the operator's own file rather than inventing a policy here.
    if let Some(settings) = read_settings(declared_cwd) {
        fs::write(root.join(".claude/settings.json"), settings)
            .map_err(|error| error.to_string())?;
    }
    Ok(skills_dir)
}

/// Decide one delivered skill's route, and write its translation note if it needs one.
///
/// Split out of [`materialise`] because it is the whole of ADR 0021's decision and belongs in one
/// readable place: the route is chosen from the skill's own text and the receiving harness, once,
/// so the prompt, the archive and the inspector cannot disagree about what was delivered.
fn prepare_skill(
    agent: &AgentConfig,
    name: &str,
    definition: &CapabilityDefinition,
    path: &Path,
    text: String,
    bus: BusMode,
) -> PreparedSkill {
    let harness = Harness::of(agent);
    let portability = skill_routing::analyse(&text);
    let route = skill_routing::route(&portability, harness);
    let body = skill_routing::split_frontmatter(&text).1.to_owned();
    let mut prepared = PreparedSkill {
        harness: harness.label().to_owned(),
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
            harness,
            needs: &portability.needs,
            bundle_dir: &prepared.bundle_dir(),
            bus: skill_routing::bus_tools(harness, bus, agent.allow_recruiting),
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

/// The harness-native memory file this agent's Brief should be written as, if any.
fn native_memory_file(agent: &AgentConfig, memory: &TeamMemory) -> Option<&'static str> {
    if memory.brief_for(&agent.id).is_empty() || !agent.reads_brief() {
        return None;
    }
    if agent.deliver_as(memory.deliver_as) != DeliverAs::NativeFile {
        return None;
    }
    Harness::of(agent).memory_file()
}

fn read_settings(declared_cwd: &Path) -> Option<Vec<u8>> {
    fs::read(declared_cwd.join(".claude/settings.json")).ok()
}

/// Copy the skill's whole directory, not just its `SKILL.md`: a skill may ship scripts, references
/// and assets it loads by relative path, and half a skill is worse than none.
fn copy_skill(definition: &CapabilityDefinition, into: &Path) -> io::Result<String> {
    let source = Path::new(&definition.path)
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "skill file has no directory"))?
        .to_path_buf();
    let name = source
        .file_name()
        .and_then(|part| part.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "skill directory has no name"))?
        .to_owned();
    copy_tree(&source, &into.join(&name))?;
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
            budget: crate::config::BudgetConfig {
                limit_usd: 1.0,
                warn_at_percent: 80,
            },
            allow_recruiting: true,
            capabilities,
            memory: None,
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
        }
    }

    #[test]
    fn an_agent_that_wired_nothing_keeps_the_cwd_it_declared() {
        let temp = TempDirectory::new();
        let team = temp.path().join("team.yaml");
        let materialised = materialise(
            None,
            temp.path(),
            &team,
            "team",
            &agent("npx", &["claude-agent-acp"], Vec::new()),
            temp.path(),
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("no capabilities is not an error");
        assert!(materialised.is_none());
    }

    #[test]
    fn a_claude_skill_is_delivered_to_a_codex_agents_shared_skill_directory() {
        let temp = TempDirectory::new();
        let home = temp.path().join("home");
        let source = home.join(".claude/skills/claude-design");
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
        .expect("cross-harness delivery succeeds")
        .expect("a wired capability produces a workspace");

        assert!(
            workspace
                .cwd
                .join(".agents/skills/claude-design/SKILL.md")
                .is_file(),
            "Codex discovers project-local skills through the interoperable Agent Skills path",
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

    #[test]
    fn a_codex_skill_is_delivered_to_a_claude_agents_native_skill_directory() {
        let temp = TempDirectory::new();
        let home = temp.path().join("home");
        let source = home.join(".codex/skills/report-writer");
        fs::create_dir_all(&source).expect("skill directory");
        fs::write(
            source.join("SKILL.md"),
            "---\nname: report-writer\ndescription: Write reports\n---\nBody",
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
            &agent("npx", &["claude-agent-acp"], vec![skill("report-writer")]),
            &teams,
            &no_memory(),
            BusMode::Pipeline,
        )
        .expect("reverse cross-harness delivery succeeds")
        .expect("a wired capability produces a workspace");

        assert!(
            workspace
                .cwd
                .join(".claude/skills/report-writer/SKILL.md")
                .is_file()
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
        let delivered = workspace.cwd.join(".claude/skills/report-writer");
        assert!(delivered.join("SKILL.md").is_file());
        // The whole directory travels, so a skill that loads a reference by relative path works.
        assert!(delivered.join("references/style.md").is_file());
    }

    /// Delivery channel 2: the Brief written as the harness's own project memory file, which is
    /// the one channel a harness-side compaction does not reach. A `native-file` agent with no
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

        assert_eq!(workspace.brief_file.as_deref(), Some("CLAUDE.md"));
        let written = fs::read_to_string(workspace.cwd.join("CLAUDE.md")).expect("CLAUDE.md");
        assert!(written.contains("Never touch main."), "{written}");
        // It is machine-written and rebuilt every run, so it must say so rather than inviting an
        // edit that the next run silently discards.
        assert!(written.contains("Rebuilt on every run"), "{written}");
    }

    /// Each harness reads a different file, and writing the wrong name delivers nothing at all
    /// while looking like it worked.
    #[test]
    fn each_harness_gets_the_memory_file_it_actually_reads() {
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

        for (cmd, args, expected) in [
            (
                "npx",
                vec!["-y", "@agentclientprotocol/claude-agent-acp"],
                Some("CLAUDE.md"),
            ),
            (
                "npx",
                vec!["-y", "@agentclientprotocol/codex-acp"],
                Some("AGENTS.md"),
            ),
            ("gemini", vec!["--acp"], Some("GEMINI.md")),
            ("opencode", vec!["acp"], Some("AGENTS.md")),
            ("openclaw", vec!["acp"], Some("AGENTS.md")),
            ("hermes-acp", vec![], Some("AGENTS.md")),
            // A harness LoomWatch has never heard of: no file is invented for it, and the Brief
            // reaches it through the context packet only.
            ("some-other-acp", vec![], None),
        ] {
            let workspace = materialise(
                None,
                &teams,
                &team,
                "team",
                &agent(cmd, &args, Vec::new()),
                &teams,
                &memory,
                BusMode::Pipeline,
            )
            .expect("delivery succeeds");
            match expected {
                Some(name) => {
                    let workspace = workspace.expect("a known harness gets a workspace");
                    assert_eq!(
                        workspace.brief_file.as_deref(),
                        Some(name),
                        "{cmd} {args:?}"
                    );
                    assert!(workspace.cwd.join(name).is_file(), "{cmd} {args:?}");
                }
                None => assert!(
                    workspace.is_none(),
                    "{cmd} {args:?} must keep its declared cwd"
                ),
            }
        }
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
        let workspace = materialise(
            None,
            &teams,
            &team,
            "team",
            &opted_out,
            &teams,
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

    /// A skill that assumes Claude's own execution facilities. Written out once because three
    /// tests turn on the same bytes taking different routes on different harnesses.
    const COUPLED_SKILL: &str = "---\nname: claude-design\ndescription: Design one-off HTML artifacts (landing, deck, prototype).\n---\n# Designing\n\nUse the Task tool to fan out three variants in parallel.\nRun `python3 scripts/render.py --out deck.html` to build it.\nTrack the steps with TodoWrite.\n\n## House rules\n\nOne idea per screen. Type sets the rhythm; colour is the accent, never the structure.\nMeasure twice: a layout that only works at one width is not a layout.\nPrefer one strong photograph to three weak ones, and no photograph at all to one stock image.\nWhite space is not empty space. Leave the margins alone.\nEvery number on a chart earns its ink or comes off.\n";

    /// Deliver `COUPLED_SKILL` to one agent and hand back what was prepared.
    fn deliver(temp: &TempDirectory, spawn: (&str, &[&str]), recruiting: bool) -> PreparedSkill {
        let home = temp.path().join(format!("home-{}", uuid::Uuid::new_v4()));
        let source = home.join(".claude/skills/claude-design");
        fs::create_dir_all(&source).expect("skill directory");
        fs::write(source.join("SKILL.md"), COUPLED_SKILL).expect("SKILL.md");
        let teams = temp.path().join(format!("teams-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&teams).expect("teams");
        let team = teams.join("team.yaml");
        let mut wired = agent(spawn.0, spawn.1, vec![skill("claude-design")]);
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
        for (spawn, route) in [
            (
                ("npx", &["-y", "@agentclientprotocol/codex-acp"][..]),
                SkillRoute::Inline,
            ),
            (("npx", &["claude-agent-acp"][..]), SkillRoute::Native),
        ] {
            let prepared = deliver(&temp, spawn, true);
            assert_eq!(prepared.route, route, "{spawn:?}");
            // What may be injected.
            assert!(
                !prepared.body.contains("description:"),
                "{:?}",
                prepared.body
            );
            assert!(!prepared.body.starts_with("---"));
            assert!(prepared.body.starts_with("# Designing"));
            // What was delivered: untouched, including the frontmatter and its fingerprint.
            assert_eq!(prepared.text, COUPLED_SKILL);
            assert_eq!(
                fs::read_to_string(&prepared.path).expect("delivered file"),
                COUPLED_SKILL,
                "the file on disk is never rewritten",
            );
            assert_eq!(
                prepared.sha256,
                format!("{:x}", Sha256::digest(COUPLED_SKILL.as_bytes())),
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

    /// Contract (ii): a coupled skill on a foreign harness is inlined and translated, and the
    /// note names a Team Bus tool only when this agent will actually be offered it.
    #[test]
    fn a_coupled_skill_on_codex_is_inlined_with_a_note_that_only_promises_tools_it_has() {
        let temp = TempDirectory::new();
        let codex = ("npx", &["-y", "@agentclientprotocol/codex-acp"][..]);

        let recruiting = deliver(&temp, codex, true);
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
        assert!(note.contains("refuses every permission request"), "{note}");
        assert!(note.contains(&recruiting.bundle_dir()), "{note}");

        let restricted = deliver(&temp, codex, false);
        let note = restricted.translation.expect("a translation note");
        assert!(
            !note.contains("`ask`"),
            "an agent refused `ask` by `allowRecruiting: false` must not be told to call it: {note}"
        );
        assert!(note.contains("do the steps yourself"), "{note}");
    }

    /// Contract (iii): the same bytes on the harness they were written for take the short route.
    #[test]
    fn the_same_skill_on_a_claude_agent_is_native_with_a_pointer_instead_of_its_text() {
        let temp = TempDirectory::new();
        let prepared = deliver(&temp, ("npx", &["claude-agent-acp"][..]), true);
        assert_eq!(prepared.route, SkillRoute::Native);
        assert!(
            prepared.translation.is_none(),
            "nothing to translate on the harness the skill was written for"
        );
        let section = crate::memory::ComposedPrompt::default()
            .with_required_skills(std::slice::from_ref(&prepared))
            .sections
            .into_iter()
            .next()
            .expect("a required-skill section");
        assert!(section.text.contains("Design one-off HTML artifacts"));
        assert!(section.text.contains("SKILL.md in full"));
        assert!(
            !section.text.contains("Use the Task tool"),
            "the body stays on disk where the harness discovers it: {}",
            section.text
        );
        // The counterfactual for "a pointer instead of its text": the same bytes on Codex take
        // the inline route, and that section carries the whole body. Comparing the two routes is
        // the claim; comparing a section against the file would only measure this fixture's size.
        let inlined = deliver(
            &temp,
            ("npx", &["-y", "@agentclientprotocol/codex-acp"][..]),
            true,
        );
        let inline_section = crate::memory::ComposedPrompt::default()
            .with_required_skills(std::slice::from_ref(&inlined))
            .sections
            .into_iter()
            .next()
            .expect("a required-skill section");
        assert!(inline_section.text.contains("Use the Task tool"));
        assert!(
            section.text.chars().count() < inline_section.text.chars().count(),
            "native must be the shorter of the two routes over the same bytes",
        );
    }

    #[test]
    fn removing_a_capability_stops_delivering_it_on_the_next_run() {
        let temp = TempDirectory::new();
        let home = temp.path().join("home");
        for name in ["kept", "dropped"] {
            let source = home.join(".claude/skills").join(name);
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

        assert!(workspace.cwd.join(".claude/skills/kept").is_dir());
        assert!(
            !workspace.cwd.join(".claude/skills/dropped").exists(),
            "a capability taken off the canvas must stop being delivered",
        );
    }
}
