//! Read-only discovery of local skills, MCP tools and knowledge sources.
//!
//! The Library inventory deliberately returns metadata only: names, provenance and compatibility.
//! A separate, on-demand detail lookup can return a selected skill's local `SKILL.md`, or what a
//! selected knowledge source holds: a project folder's top-level listing and README, the titles of
//! `OpenCode` sessions run there, or a memory source's Brief and kept notes. Connector
//! configuration values and `OpenCode` conversation contents are never returned.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Root used for capability discovery and delivery.
///
/// Native launches normally discover capabilities below the operator's `HOME`. A container can
/// point this at an explicit read-only import containing the conventional `.codex`, `.claude`,
/// `.agents`, and `.config/opencode` trees without exposing the operator's complete home folder.
/// Harness processes still keep their actual `HOME` for credentials and mutable state.
#[must_use]
pub fn configured_home() -> Option<PathBuf> {
    select_home(
        std::env::var_os("LOOMWATCH_CAPABILITY_HOME"),
        std::env::var_os("HOME"),
    )
}

fn select_home(
    configured: Option<std::ffi::OsString>,
    runtime: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    configured
        .filter(|value| !value.is_empty())
        .or(runtime)
        .map(PathBuf::from)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityInventory {
    pub skills: Vec<DetectedCapability>,
    pub tools: Vec<DetectedCapability>,
    pub sources: Vec<DetectedCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCapability {
    pub id: String,
    pub name: String,
    pub source: String,
    pub detail: String,
    pub status: String,
    /// Present only on a knowledge source that is team memory — another team on this daemon, or
    /// an imported pack.
    ///
    /// A field rather than something the UI infers from the name, because wiring this card writes
    /// a `memory.inherits` entry and the entry needs the team id or the pack path verbatim. A
    /// client that recovered them by splitting `"<Team name> · memory"` would write the display
    /// name into executable configuration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemorySourceRef>,
}

/// What wiring a memory knowledge source writes into the team file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySourceRef {
    /// The team id for `memory.inherits[].team`. Exactly one of this and `pack` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// The folder for `memory.inherits[].pack`, relative to the teams root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
    /// Pinned Brief entries the source declares.
    pub brief: usize,
    /// Kept notes, when the source states them.
    ///
    /// A pack's manifest counts its own notes, so a pack knows. A live team's kept notes are rows
    /// in Postgres and this inventory is a filesystem scan with no pool, so a team reports `None`
    /// rather than `0` — the Memory panel reads the real count over
    /// `GET /api/memory/notes`, and a zero here would be a claim the scan cannot make.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDetails {
    pub id: String,
    pub kind: String,
    /// A skill's matching `SKILL.md` files, or what a knowledge source holds — one entry per thing
    /// read, each naming where it came from. Empty for a tool.
    pub definitions: Vec<CapabilityDefinition>,
    /// What this skill assumes about the harness running it, and what each harness will therefore
    /// do with it. Metadata derived from the skill's own text — never connector configuration and
    /// never a secret, the same rule the rest of this module keeps.
    ///
    /// `None` for a tool or a knowledge source, and for a skill with no readable definition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portability: Option<SkillPortabilityReport>,
}

/// One skill's portability facts, plus the route it would take on every harness `LoomWatch` knows.
///
/// The routes are computed by the daemon rather than re-derived in the browser: the rule lives in
/// `skill_routing::route` and a second copy of it in TypeScript would be a second rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPortabilityReport {
    pub kind: &'static str,
    pub needs: Vec<&'static str>,
    pub evidence: Vec<ReportedEvidence>,
    /// Harness id (the `HARNESSES` catalog's) to route name.
    pub routes: BTreeMap<String, &'static str>,
}

/// One need and the line that proves it, both named the way the inspector shows them.
///
/// A report-side shape rather than `skill_routing::PortabilityEvidence` serialized directly,
/// because that type's `need` is the serde name (`slash-commands`) while `needs` above is the
/// label (`slash commands`). Two vocabularies for one concept is how a client ends up matching
/// an evidence line to the wrong need — or, worse, pairing them by array index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedEvidence {
    pub need: &'static str,
    pub line: String,
}

impl SkillPortabilityReport {
    fn of(text: &str) -> Self {
        let portability = crate::skill_routing::analyse(text);
        let routes = crate::workspace::Harness::ALL
            .into_iter()
            .filter_map(|harness| {
                Some((
                    harness.id()?.to_owned(),
                    crate::skill_routing::route(&portability, harness).label(),
                ))
            })
            .collect();
        Self {
            kind: portability.kind.label(),
            needs: portability
                .needs
                .iter()
                .map(|need| need.label())
                .collect::<Vec<_>>(),
            evidence: portability
                .evidence
                .into_iter()
                .map(|item| ReportedEvidence {
                    need: item.need.label(),
                    line: item.line,
                })
                .collect(),
            routes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDefinition {
    pub source: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug)]
struct CapabilityBuilder {
    display_name: String,
    providers: BTreeSet<String>,
    detail: String,
    /// Listing order within a group: what the operator installed themselves comes before what a
    /// plugin brought along. A capability found in several places keeps its closest rank.
    rank: u8,
    memory: Option<MemorySourceRef>,
}

impl Default for CapabilityBuilder {
    fn default() -> Self {
        Self {
            display_name: String::new(),
            providers: BTreeSet::new(),
            detail: String::new(),
            rank: u8::MAX,
            memory: None,
        }
    }
}

impl CapabilityBuilder {
    fn add(&mut self, name: &str, provider: &str, detail: &str, rank: u8) {
        if self.display_name.is_empty() {
            name.clone_into(&mut self.display_name);
        }
        self.providers.insert(provider.to_owned());
        if self.detail.is_empty() {
            detail.clone_into(&mut self.detail);
        }
        self.rank = self.rank.min(rank);
    }

    fn finish(self, kind: &str) -> DetectedCapability {
        let source = self.providers.into_iter().collect::<Vec<_>>().join(" + ");
        let is_node_repl = kind == "tool" && self.display_name == "Node REPL";
        DetectedCapability {
            id: stable_id(kind, &self.display_name, &source),
            name: self.display_name,
            source,
            detail: self.detail,
            status: if is_node_repl {
                "Local only"
            } else if kind == "tool" {
                "Compatible"
            } else {
                "Ready"
            }
            .to_owned(),
            memory: self.memory,
        }
    }
}

#[must_use]
pub fn detect_capabilities(home: Option<&Path>, teams_root: &Path) -> CapabilityInventory {
    let mut skills = BTreeMap::<String, CapabilityBuilder>::new();
    let mut tools = BTreeMap::<String, CapabilityBuilder>::new();
    let mut sources = BTreeMap::<String, CapabilityBuilder>::new();

    for root in skill_roots(home, teams_root) {
        match root.layout {
            SkillLayout::Skills => scan_skill_root(&root, &mut skills),
            SkillLayout::Plugins => scan_plugin_skill_root(&root, &mut skills),
        }
    }

    if let Some(home) = home {
        scan_codex_mcp(&home.join(".codex/config.toml"), &mut tools);
        scan_json_connectors(
            &home.join(".claude.json"),
            "Claude Code",
            "mcpServers",
            &mut tools,
        );
        scan_json_connectors(
            &home.join(".claude/settings.json"),
            "Claude Code",
            "mcpServers",
            &mut tools,
        );
        scan_json_connectors(
            &home.join(".config/opencode/opencode.json"),
            "OpenCode",
            "mcp",
            &mut tools,
        );

        scan_opencode_sources(home, &mut sources);
    }

    // Every team with memory, and every imported pack. A team's Brief plus its kept Notebook is a
    // knowledge source in exactly the Library's sense — something an agent reads — which is why it
    // belongs here rather than in a second inventory nobody would think to look in.
    scan_team_memory_sources(teams_root, &mut sources);

    if let Some(name) = project_folder(teams_root)
        .as_deref()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
    {
        add_capability(
            &mut sources,
            &project_label(name),
            "LoomWatch",
            "The folder containing this team's files",
            RANK_PERSONAL,
        );
    }

    CapabilityInventory {
        skills: finish_map(skills, "skill"),
        tools: finish_map(tools, "tool"),
        sources: finish_map(sources, "source"),
    }
}

/// Load the definition of one already-detected capability. Skill bodies are read only for the
/// selected row; the inventory remains small and never exposes every installed instruction file.
#[must_use]
pub fn detect_capability_details(
    home: Option<&Path>,
    teams_root: &Path,
    id: &str,
) -> Option<CapabilityDetails> {
    let inventory = detect_capabilities(home, teams_root);
    let (kind, item) = inventory
        .skills
        .iter()
        .find(|item| item.id == id)
        .map(|item| ("skill", item))
        .or_else(|| {
            inventory
                .tools
                .iter()
                .find(|item| item.id == id)
                .map(|item| ("tool", item))
        })
        .or_else(|| {
            inventory
                .sources
                .iter()
                .find(|item| item.id == id)
                .map(|item| ("knowledge", item))
        })?;

    let definitions = match kind {
        "skill" => skill_definitions(home, teams_root, item),
        "knowledge" => knowledge_contents(home, teams_root, item),
        _ => Vec::new(),
    };
    // The first definition is the one `workspace::materialise` would copy, so its text is the one
    // the route must be computed from. Reading a second copy from another provider would report a
    // classification for bytes no run would ever deliver.
    let portability = (kind == "skill")
        .then(|| definitions.first())
        .flatten()
        .map(|definition| SkillPortabilityReport::of(&definition.content));
    Some(CapabilityDetails {
        id: id.to_owned(),
        kind: kind.to_owned(),
        definitions,
        portability,
    })
}

/// Where a discovered skill actually lives, per provider. `workspace.rs` needs this to copy a
/// wired skill into an agent's workspace; `detect_capability_details` needs it to show the source.
/// Every installed copy of `item`, best first: the copy `workspace::materialise` delivers is the
/// first one. Reads the same folders as the inventory, in [`skill_roots`] order.
#[must_use]
pub fn skill_definitions_for(
    home: Option<&Path>,
    teams_root: &Path,
    item: &DetectedCapability,
) -> Vec<CapabilityDefinition> {
    skill_definitions(home, teams_root, item)
}

fn skill_definitions(
    home: Option<&Path>,
    teams_root: &Path,
    item: &DetectedCapability,
) -> Vec<CapabilityDefinition> {
    let mut definitions = Vec::new();
    let mut seen = BTreeSet::new();
    // Root order is preference order. Sorting the copies by source name instead once delivered a
    // trashed plugin generation, because `/.trash/` sorts before `/synced/`.
    for root in skill_roots(home, teams_root) {
        collect_matching_definitions(&root, item, &mut seen, &mut definitions);
    }
    definitions
}

fn collect_matching_definitions(
    root: &SkillRoot,
    item: &DetectedCapability,
    seen: &mut BTreeSet<PathBuf>,
    definitions: &mut Vec<CapabilityDefinition>,
) {
    let mut paths = find_skill_files(&root.path, root.depth, root.exclude);
    paths.sort();
    for path in paths {
        let directory = path.parent().unwrap_or(&root.path);
        let fallback = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Unnamed skill");
        let (name, _) = read_skill_metadata(&path, fallback);
        let source = if root.layout == SkillLayout::Plugins {
            plugin_name(directory).map_or_else(
                || root.provider.clone(),
                |plugin| format!("{} · {plugin}", root.provider),
            )
        } else {
            root.provider.clone()
        };
        // Rows merge copies by lowercased name, so a copy spelled `PDF` beside `pdf` is the same
        // skill and must be offered for delivery too.
        if !name.eq_ignore_ascii_case(&item.name) || !capability_has_source(&item.source, &source) {
            continue;
        }
        let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen.insert(canonical) {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        definitions.push(CapabilityDefinition {
            source,
            path: path.to_string_lossy().into_owned(),
            content,
        });
    }
}

fn capability_has_source(combined: &str, candidate: &str) -> bool {
    combined == candidate || combined.split(" + ").any(|source| source == candidate)
}

/// A skill or source the operator set up themselves.
const RANK_PERSONAL: u8 = 0;
/// `review-agent` is pinned just under the personal Claude Code skills by the approved design.
const RANK_PINNED: u8 = 1;
/// Installed for one of the other harnesses `LoomWatch` drives.
const RANK_HARNESS: u8 = 2;
const RANK_SHARED: u8 = 3;
/// Anything a plugin or another project brought along.
const RANK_INSTALLED: u8 = 4;

fn finish_map(map: BTreeMap<String, CapabilityBuilder>, kind: &str) -> Vec<DetectedCapability> {
    let mut items = map
        .into_values()
        .map(|item| (item.rank, item.finish(kind)))
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        let key = |(rank, item): &(u8, DetectedCapability)| {
            let rank = if kind == "skill" && item.name == "review-agent" {
                RANK_PINNED
            } else {
                *rank
            };
            (rank, item.name.to_ascii_lowercase())
        };
        key(left).cmp(&key(right))
    });
    items.into_iter().map(|(_, item)| item).collect()
}

fn add_capability(
    map: &mut BTreeMap<String, CapabilityBuilder>,
    name: &str,
    provider: &str,
    detail: &str,
    rank: u8,
) {
    add_keyed_capability(
        map,
        &name.to_ascii_lowercase(),
        name,
        provider,
        detail,
        rank,
    );
}

/// Same, but with an explicit dedup key. Plugin skills key on `plugin/name`: two marketplaces
/// both ship a skill called `index`, and merging them into one row hid one of them.
fn add_keyed_capability(
    map: &mut BTreeMap<String, CapabilityBuilder>,
    key: &str,
    name: &str,
    provider: &str,
    detail: &str,
    rank: u8,
) {
    map.entry(key.to_owned())
        .or_default()
        .add(name, provider, detail, rank);
}

/// List every team with memory, and every imported pack, as knowledge sources.
///
/// Read from the filesystem, not from Postgres: this inventory is what the Library shows before
/// anything has run, and a source that only appeared once the archive was up would look like a
/// bug. The consequence is that a live team's kept-note count is not stated here — see
/// [`MemorySourceRef::kept`].
fn scan_team_memory_sources(teams_root: &Path, sources: &mut BTreeMap<String, CapabilityBuilder>) {
    let Ok(root) = std::fs::canonicalize(teams_root) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `symlink_metadata`: a symlinked team or pack is not followed, the same rule the Brief
        // loader enforces by canonicalising and checking the prefix.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(crate::memory::PACK_SUFFIX))
            {
                add_pack_source(&root, &path, sources);
            }
            continue;
        }
        if !matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("yaml" | "yml")
        ) {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(team) = crate::config::TeamConfig::parse(&source) else {
            continue;
        };
        let Some(memory) = team.memory.as_ref().filter(|memory| memory.enabled) else {
            continue;
        };
        if memory.brief.is_empty() && !memory.notebook.enabled {
            continue;
        }
        let team_id = crate::memory::scope_id(&team.id, &path);
        let label = if team.name.trim().is_empty() {
            team_id.clone()
        } else {
            team.name.trim().to_owned()
        };
        let brief = memory.brief.len();
        add_memory_source(
            sources,
            &format!("memory:team:{team_id}"),
            &format!("{label} · memory"),
            "LoomWatch",
            &format!(
                "{brief} brief {} · this team's kept notes travel with it",
                if brief == 1 { "entry" } else { "entries" }
            ),
            MemorySourceRef {
                team: Some(team_id),
                pack: None,
                brief,
                kept: None,
            },
        );
    }
}

fn add_pack_source(root: &Path, path: &Path, sources: &mut BTreeMap<String, CapabilityBuilder>) {
    let Some(folder) = path
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
    else {
        return;
    };
    let Ok(pack) = crate::memory::Pack::load(root, Path::new(folder)) else {
        // A pack whose hashes no longer match is not listed as something to wire. It is not
        // silently repaired either: `Pack::load` says exactly what is wrong when the operator
        // references it from a team file, which is where they can act on it.
        return;
    };
    let brief = pack.brief.len();
    let kept = pack.notes.len();
    add_memory_source(
        sources,
        &format!("memory:pack:{folder}"),
        &pack.manifest.name,
        "imported",
        &format!(
            "{brief} brief {} · {kept} kept · from {}",
            if brief == 1 { "entry" } else { "entries" },
            pack.manifest.origin_team_id
        ),
        MemorySourceRef {
            team: None,
            pack: Some(folder.to_owned()),
            brief,
            kept: Some(kept),
        },
    );
}

fn add_memory_source(
    map: &mut BTreeMap<String, CapabilityBuilder>,
    key: &str,
    name: &str,
    provider: &str,
    detail: &str,
    reference: MemorySourceRef,
) {
    let builder = map.entry(key.to_owned()).or_default();
    builder.add(name, provider, detail, RANK_PERSONAL);
    builder.memory = Some(reference);
}

fn stable_id(kind: &str, name: &str, source: &str) -> String {
    let mut hasher = DefaultHasher::new();
    (kind, name, source).hash(&mut hasher);
    format!("{kind}-{:016x}", hasher.finish())
}

/// Directories that never hold an installed skill: build output and package caches that can hold
/// thousands of files, and the folders apps park superseded or half-written copies in. Claude Code
/// keeps every earlier plugin generation in `.trash/` and stages downloads in `.staging/`; reading
/// them listed old copies beside live ones and, worse, delivered the trashed copy.
const SKIP_DIRECTORIES: [&str; 7] = [
    "node_modules",
    ".git",
    "dist",
    "target",
    ".trash",
    ".staging",
    ".tmp",
];

/// How a skill folder is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillLayout {
    /// `<root>/…/<skill>/SKILL.md`: skills the operator or an app installed directly.
    Skills,
    /// `<root>/…/<plugin>[/<version>]/skills/<skill>/SKILL.md`: skills a plugin brought along.
    Plugins,
}

/// One folder skills are read from.
#[derive(Debug, Clone)]
struct SkillRoot {
    path: PathBuf,
    /// Who installed them, as the Library names the source.
    provider: String,
    depth: usize,
    rank: u8,
    layout: SkillLayout,
    /// Folder names skipped directly below `path`, beyond [`SKIP_DIRECTORIES`].
    exclude: &'static [&'static str],
}

impl SkillRoot {
    fn new(path: PathBuf, provider: &str, rank: u8, layout: SkillLayout) -> Self {
        Self {
            path,
            provider: provider.to_owned(),
            depth: if layout == SkillLayout::Plugins {
                10
            } else {
                5
            },
            rank,
            layout,
            exclude: &[],
        }
    }
}

/// Every folder skills are read from, in the order a copy is preferred when several folders hold
/// a skill of the same name.
///
/// Detection and delivery both read this one list (ADR 0031). They used to keep a copy each, and a
/// folder added to one but not the other would list a skill that no agent could then be given.
///
/// A skill's source never limits where it runs: `workspace::materialise` copies the chosen bundle
/// into whatever folder the receiving app reads, and `skill_routing` decides whether its text also
/// travels in the prompt.
fn skill_roots(home: Option<&Path>, teams_root: &Path) -> Vec<SkillRoot> {
    use SkillLayout::Skills;
    let mut roots = home_skill_roots(home);
    // Skills kept in the project the teams live in, the way Claude Code and Codex read a
    // repository's own `.claude/skills` and `.agents/skills`. Second in preference, after the
    // operator's own Claude Code skills. A project folder that is the home folder adds nothing:
    // its skills are already listed under the app that owns them.
    if let Some(project) = project_folder(teams_root)
        && let Some(name) = project.file_name().and_then(|name| name.to_str())
    {
        let label = project_label(name);
        let home_paths = roots
            .iter()
            .map(|root| fs::canonicalize(&root.path).unwrap_or_else(|_| root.path.clone()))
            .collect::<BTreeSet<_>>();
        let position = usize::from(home.is_some()).min(roots.len());
        let project_roots = [".claude/skills", ".agents/skills"]
            .into_iter()
            .map(|relative| SkillRoot::new(project.join(relative), &label, RANK_PERSONAL, Skills))
            .filter(|root| {
                let path = fs::canonicalize(&root.path).unwrap_or_else(|_| root.path.clone());
                !home_paths.contains(&path)
            })
            .collect::<Vec<_>>();
        roots.splice(position..position, project_roots);
    }
    roots
}

/// The skill folders under the home directory, best first; [`skill_roots`] adds the project's.
fn home_skill_roots(home: Option<&Path>) -> Vec<SkillRoot> {
    use SkillLayout::{Plugins, Skills};
    let Some(home) = home else {
        return Vec::new();
    };
    let mut roots = vec![SkillRoot::new(
        home.join(".claude/skills"),
        "Claude Code",
        RANK_PERSONAL,
        Skills,
    )];
    roots.push(SkillRoot::new(
        home.join(".codex/skills"),
        "Codex",
        RANK_HARNESS,
        Skills,
    ));
    // OpenCode documents `skill/`; `skills/` is what most installers write.
    for relative in [".config/opencode/skills", ".config/opencode/skill"] {
        roots.push(SkillRoot::new(
            home.join(relative),
            "OpenCode",
            RANK_HARNESS,
            Skills,
        ));
    }
    roots.push(SkillRoot::new(
        home.join(".gemini/skills"),
        "Gemini",
        RANK_HARNESS,
        Skills,
    ));
    // Hermes files skills by category (`<category>/<skill>/SKILL.md`) and keeps a set per profile.
    // Its own source checkout and optional-skills catalog are not installed skills, so they are
    // not read.
    roots.push(SkillRoot::new(
        home.join(".hermes/skills"),
        "Hermes",
        RANK_HARNESS,
        Skills,
    ));
    for profile in subfolders(&home.join(".hermes/profiles")) {
        roots.push(SkillRoot::new(
            profile.join("skills"),
            "Hermes",
            RANK_HARNESS,
            Skills,
        ));
    }
    for relative in [
        ".openclaw/skills",
        ".openclaw/workspace/skills",
        ".openclaw/plugin-skills",
    ] {
        roots.push(SkillRoot::new(
            home.join(relative),
            "OpenClaw",
            RANK_HARNESS,
            Skills,
        ));
    }
    roots.push(SkillRoot::new(
        home.join(".pi/agent/skills"),
        "pi",
        RANK_HARNESS,
        Skills,
    ));
    roots.push(SkillRoot::new(
        home.join(".agents/skills"),
        "Shared",
        RANK_SHARED,
        Skills,
    ));
    // Plugins last. Claude Code's `marketplaces/` is the catalog of every plugin a marketplace
    // offers, installed or not; listing it showed uninstalled plugins as ready to use.
    roots.push(SkillRoot::new(
        home.join(".codex/plugins/cache"),
        "Codex",
        RANK_INSTALLED,
        Plugins,
    ));
    let mut claude_plugins = SkillRoot::new(
        home.join(".claude/plugins"),
        "Claude Code",
        RANK_INSTALLED,
        Plugins,
    );
    claude_plugins.exclude = &["marketplaces"];
    roots.push(claude_plugins);
    roots.push(SkillRoot::new(
        home.join(".gemini/extensions"),
        "Gemini",
        RANK_INSTALLED,
        Plugins,
    ));
    roots
}

/// The plain folders directly inside `path`, sorted; none when it is missing.
fn subfolders(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };
    let mut folders = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    folders.sort();
    folders
}

fn scan_skill_root(root: &SkillRoot, skills: &mut BTreeMap<String, CapabilityBuilder>) {
    for skill in find_skill_files(&root.path, root.depth, root.exclude) {
        let fallback = skill
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or("Unnamed skill");
        let (name, description) = read_skill_metadata(&skill, fallback);
        add_capability(skills, &name, &root.provider, &description, root.rank);
    }
}

/// A plugin cache holds `…/<plugin>[/<version>]/skills/<skill>/SKILL.md`. The plugin is what tells
/// two identically named skills apart, so it becomes both the dedup key and the visible source.
fn scan_plugin_skill_root(root: &SkillRoot, skills: &mut BTreeMap<String, CapabilityBuilder>) {
    for skill in find_skill_files(&root.path, root.depth, root.exclude) {
        let directory = skill.parent().unwrap_or(&root.path);
        let fallback = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Unnamed skill");
        let (name, description) = read_skill_metadata(&skill, fallback);
        let plugin = plugin_name(directory);
        let source = plugin.as_deref().map_or_else(
            || root.provider.clone(),
            |plugin| format!("{} · {plugin}", root.provider),
        );
        let key = plugin.as_deref().map_or_else(
            || name.to_ascii_lowercase(),
            |plugin| {
                format!(
                    "{}/{}",
                    plugin.to_ascii_lowercase(),
                    name.to_ascii_lowercase()
                )
            },
        );
        add_keyed_capability(skills, &key, &name, &source, &description, root.rank);
    }
}

/// Every `SKILL.md` under `root`, following symlinks — the harnesses install skills by linking
/// them in (5 of the 6 in `~/.claude/skills` here), so skipping links hid most of them.
/// `exclude` names folders skipped directly below `root` only.
fn find_skill_files(root: &Path, max_depth: usize, exclude: &[&str]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut seen = BTreeSet::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > max_depth {
            continue;
        }
        // Symlinks can point back up their own tree; canonical paths end the loop.
        let canonical = fs::canonicalize(&directory).unwrap_or_else(|_| directory.clone());
        if !seen.insert(canonical) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            // `DirEntry::metadata` lstats, so it reports a linked-in skill directory as "not a
            // directory". Only a link needs the extra stat; `None` means it dangles.
            let resolved = if file_type.is_symlink() {
                fs::metadata(&path).ok().map(|metadata| metadata.is_dir())
            } else {
                Some(file_type.is_dir())
            };
            let Some(is_directory) = resolved else {
                continue;
            };
            if is_directory {
                let name = entry.file_name();
                if SKIP_DIRECTORIES.iter().any(|skip| name == *skip)
                    || (depth == 0 && exclude.iter().any(|skip| name == *skip))
                {
                    continue;
                }
                pending.push((path, depth + 1));
            } else if entry.file_name() == "SKILL.md" {
                found.push(path);
            }
        }
    }
    found
}

fn plugin_name(skill_directory: &Path) -> Option<String> {
    let skills = skill_directory.parent()?;
    if skills.file_name()? != "skills" {
        return None;
    }
    let owner = skills.parent()?;
    let name = owner.file_name()?.to_str()?;
    if looks_like_a_version(name) {
        return owner
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .map(|name| without_generation(name).to_owned());
    }
    Some(without_generation(name).to_owned())
}

/// `engineering~g3` → `engineering`: Claude Code's synced plugins carry a generation suffix that
/// changes on every update, which showed one plugin as three.
fn without_generation(name: &str) -> &str {
    match name.rsplit_once("~g") {
        Some((plugin, generation))
            if !plugin.is_empty()
                && !generation.is_empty()
                && generation.chars().all(|c| c.is_ascii_digit()) =>
        {
            plugin
        }
        _ => name,
    }
}

/// `1.1.0-alpha.2`, `26.904.11930` — a cache directory named for the release, not the plugin.
fn looks_like_a_version(name: &str) -> bool {
    name.starts_with(|first: char| first.is_ascii_digit()) && name.contains('.')
}

fn read_skill_metadata(path: &Path, fallback: &str) -> (String, String) {
    let Ok(source) = fs::read_to_string(path) else {
        return (humanize(fallback), "Local skill".to_owned());
    };
    let (frontmatter, _) = crate::skill_routing::split_frontmatter(&source);
    let name = crate::skill_routing::frontmatter_field(frontmatter, "name");
    let description = crate::skill_routing::frontmatter_field(frontmatter, "description");
    (
        name.unwrap_or_else(|| humanize(fallback)),
        description.unwrap_or_else(|| "Local skill".to_owned()),
    )
}

fn scan_codex_mcp(path: &Path, tools: &mut BTreeMap<String, CapabilityBuilder>) {
    let Ok(source) = fs::read_to_string(path) else {
        return;
    };
    for line in source.lines() {
        let trimmed = line.trim();
        let Some(section) = trimmed.strip_prefix("[mcp_servers.") else {
            continue;
        };
        let Some(name) = section.strip_suffix(']') else {
            continue;
        };
        let name = name.trim();
        let root_name = if let Some(quoted) = name.strip_prefix('"') {
            quoted.split('"').next().unwrap_or(quoted)
        } else {
            name.split('.')
                .next()
                .unwrap_or(name)
                .trim_matches(['\'', '"'])
        };
        let name = humanize(root_name);
        add_capability(tools, &name, "Codex", "Local MCP connector", RANK_PERSONAL);
    }
}

fn scan_json_connectors(
    path: &Path,
    provider: &str,
    collection_key: &str,
    tools: &mut BTreeMap<String, CapabilityBuilder>,
) {
    let Ok(source) = fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&source) else {
        return;
    };
    collect_json_connector_keys(&value, collection_key, provider, tools);
}

fn collect_json_connector_keys(
    value: &Value,
    collection_key: &str,
    provider: &str,
    tools: &mut BTreeMap<String, CapabilityBuilder>,
) {
    match value {
        Value::Object(object) => {
            if let Some(Value::Object(connectors)) = object.get(collection_key) {
                for name in connectors.keys() {
                    add_capability(
                        tools,
                        &humanize(name),
                        provider,
                        "Local MCP connector",
                        RANK_PERSONAL,
                    );
                }
            }
            for child in object.values() {
                collect_json_connector_keys(child, collection_key, provider, tools);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_json_connector_keys(child, collection_key, provider, tools);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Deserialize)]
struct OpenCodeProject {
    worktree: String,
    name: Option<String>,
}

fn scan_opencode_sources(home: &Path, sources: &mut BTreeMap<String, CapabilityBuilder>) {
    let database = home.join(".local/share/opencode/opencode.db");
    if !database.is_file() {
        return;
    }
    add_capability(
        sources,
        OPENCODE_HISTORY,
        "OpenCode",
        "Previous sessions and tool sources",
        RANK_PINNED,
    );

    let Some(projects) = query_opencode::<OpenCodeProject>(
        &database,
        "SELECT worktree, name FROM project ORDER BY time_updated DESC;",
    ) else {
        return;
    };
    for project in projects {
        let Some(label) = opencode_project_label(home, &project.worktree, project.name) else {
            continue;
        };
        add_capability(
            sources,
            &label,
            "OpenCode",
            "Previously used project context",
            RANK_INSTALLED,
        );
    }
}

/// The name `OpenCode`'s whole session history is listed under.
const OPENCODE_HISTORY: &str = "OpenCode history";

/// The Library name for one `OpenCode` project, or `None` for a row that is not a project.
fn opencode_project_label(home: &Path, worktree: &str, name: Option<String>) -> Option<String> {
    // OpenCode records a row for every directory a session ever ran in, including `/` and the
    // home directory. Those listed as "Project project" and "tnghia project" — neither is a
    // knowledge source anyone would drag onto a canvas.
    let worktree = Path::new(worktree);
    if worktree.parent().is_none() || worktree == home {
        return None;
    }
    let fallback = worktree.file_name().and_then(|name| name.to_str())?;
    let name = name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| fallback.to_owned());
    Some(project_label(&name))
}

/// Run one read-only query against `OpenCode`'s database. `None` when `sqlite3` is missing, the
/// database cannot be opened, or the rows do not have the expected shape.
fn query_opencode<T: serde::de::DeserializeOwned>(database: &Path, sql: &str) -> Option<Vec<T>> {
    let uri = format!("file:{}?mode=ro", database.to_string_lossy());
    let output = Command::new("sqlite3")
        .args(["-readonly", "-json", &uri, sql])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // `sqlite3 -json` prints nothing at all for a query with no rows.
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Some(Vec::new());
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// The folder the Library lists as "<name> project": the teams root's parent when the root is a
/// plain `teams` folder inside a project, and the root itself otherwise.
fn project_folder(teams_root: &Path) -> Option<PathBuf> {
    if teams_root.file_name().and_then(|name| name.to_str()) == Some("teams") {
        teams_root.parent().map(Path::to_path_buf)
    } else {
        Some(teams_root.to_path_buf())
    }
}

/// Entries listed from a project folder before the listing says how many more there are.
const FOLDER_LISTING_LIMIT: usize = 200;
/// Lines of a README shown before it is cut off.
const README_LINE_LIMIT: usize = 120;
/// `OpenCode` sessions listed for one project, or across the whole history.
const SESSION_LIMIT: usize = 30;

/// What one knowledge source holds, read on demand: the inspector's Contents, and — since ADR 0029
/// — exactly what an agent wired to the source is handed in its opening prompt.
///
/// One function serves both on purpose. "What you see in the panel is what the agent gets" holds
/// only while there is one reader.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KnowledgeSnapshot {
    pub contents: Vec<CapabilityDefinition>,
    /// The folders the source is, for a source that is one: a project folder, or the worktree an
    /// `OpenCode` project ran in. Canonical, existing and de-duplicated. Empty for `OpenCode`
    /// history and for memory, which are records rather than places.
    pub folders: Vec<PathBuf>,
}

/// Read one knowledge source. See [`KnowledgeSnapshot`].
#[must_use]
pub fn knowledge_snapshot(
    home: Option<&Path>,
    teams_root: &Path,
    item: &DetectedCapability,
) -> KnowledgeSnapshot {
    if let Some(reference) = &item.memory {
        return KnowledgeSnapshot {
            contents: memory_contents(teams_root, reference),
            folders: Vec::new(),
        };
    }
    let mut snapshot = KnowledgeSnapshot::default();
    let mut folders = Vec::new();
    if capability_has_source(&item.source, "LoomWatch")
        && let Some(folder) = project_folder(teams_root)
        && folder
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| project_label(name) == item.name)
    {
        snapshot
            .contents
            .extend(folder_contents(&folder, "LoomWatch"));
        folders.push(folder);
    }
    if let Some(home) = home
        && capability_has_source(&item.source, "OpenCode")
    {
        let sessions = opencode_contents(home, &item.name);
        if item.name != OPENCODE_HISTORY {
            // A project's sessions are filed under the worktree they ran in, which is the folder.
            folders.extend(
                sessions
                    .iter()
                    .map(|definition| PathBuf::from(&definition.path)),
            );
        }
        snapshot.contents.extend(sessions);
    }
    for folder in folders {
        if let Ok(canonical) = fs::canonicalize(&folder)
            && canonical.is_dir()
            && !snapshot.folders.contains(&canonical)
        {
            snapshot.folders.push(canonical);
        }
    }
    snapshot
}

fn knowledge_contents(
    home: Option<&Path>,
    teams_root: &Path,
    item: &DetectedCapability,
) -> Vec<CapabilityDefinition> {
    knowledge_snapshot(home, teams_root, item).contents
}

/// Which config format a [`ToolDefinition`] is written in. The three name the same facts
/// differently, so the format travels with the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolFormat {
    /// `mcpServers` in `~/.claude.json` or `~/.claude/settings.json`.
    Claude,
    /// `[mcp_servers.<name>]` in `~/.codex/config.toml`.
    Codex,
    /// `mcp` in `~/.config/opencode/opencode.json`.
    OpenCode,
}

/// One MCP server definition exactly as the operator wrote it, found where a tool was discovered.
///
/// Holds values — tokens, environment — so it is deliberately neither `Serialize` nor `Debug`:
/// `tool_delivery` turns it into something that can be recorded.
#[derive(Clone, PartialEq)]
pub struct ToolDefinition {
    /// `Claude Code`, `Codex` or `OpenCode`.
    pub provider: String,
    pub config_path: PathBuf,
    /// The server's key in that file, which is also the name a harness lists its tools under.
    pub server: String,
    pub format: ToolFormat,
    pub value: Value,
}

/// Every definition behind one Library tool, in the order the Library scan found them: Claude
/// Code's (top-level before per-project), then Codex's, then `OpenCode`'s.
#[must_use]
pub fn tool_definitions_for(home: &Path, item: &DetectedCapability) -> Vec<ToolDefinition> {
    let mut found = Vec::new();
    let mut add =
        |provider: &str, format: ToolFormat, path: PathBuf, servers: Vec<(String, Value)>| {
            if !capability_has_source(&item.source, provider) {
                return;
            }
            for (server, value) in servers {
                if humanize(&server) == item.name {
                    found.push(ToolDefinition {
                        provider: provider.to_owned(),
                        config_path: path.clone(),
                        server,
                        format,
                        value,
                    });
                }
            }
        };
    for path in [
        home.join(".claude.json"),
        home.join(".claude/settings.json"),
    ] {
        let servers = read_json(&path)
            .map(|value| json_definitions(&value, "mcpServers"))
            .unwrap_or_default();
        add("Claude Code", ToolFormat::Claude, path, servers);
    }
    let codex = home.join(".codex/config.toml");
    let servers = fs::read_to_string(&codex)
        .ok()
        .and_then(|source| source.parse::<toml::Table>().ok())
        .and_then(|mut table| table.remove("mcp_servers"))
        .and_then(|servers| serde_json::to_value(servers).ok())
        .and_then(|value| match value {
            Value::Object(servers) => Some(servers.into_iter().collect()),
            _ => None,
        })
        .unwrap_or_default();
    add("Codex", ToolFormat::Codex, codex, servers);
    let opencode = home.join(".config/opencode/opencode.json");
    let servers = read_json(&opencode)
        .map(|value| json_definitions(&value, "mcp"))
        .unwrap_or_default();
    add("OpenCode", ToolFormat::OpenCode, opencode, servers);
    found
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Every `collection_key` table in a JSON config, the outermost first — the same walk
/// [`collect_json_connector_keys`] makes for the Library, so delivery finds what the Library listed.
fn json_definitions(value: &Value, collection_key: &str) -> Vec<(String, Value)> {
    let mut found = Vec::new();
    let mut pending = std::collections::VecDeque::from([value]);
    while let Some(value) = pending.pop_front() {
        match value {
            Value::Object(object) => {
                if let Some(Value::Object(servers)) = object.get(collection_key) {
                    found.extend(
                        servers
                            .iter()
                            .map(|(key, server)| (key.clone(), server.clone())),
                    );
                }
                pending.extend(object.values());
            }
            Value::Array(values) => pending.extend(values),
            _ => {}
        }
    }
    found
}

/// A project folder's top-level listing, folders first, and its README when it has one.
///
/// Names only for the listing: a file's contents are never read here, so a `.env` beside the
/// teams shows as a name and nothing more.
fn folder_contents(folder: &Path, provider: &str) -> Vec<CapabilityDefinition> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut names = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let is_file = !entry.file_type().is_ok_and(|kind| kind.is_dir());
            Some((is_file, name.to_lowercase(), name))
        })
        .collect::<Vec<_>>();
    names.sort();
    let mut listing = names
        .iter()
        .take(FOLDER_LISTING_LIMIT)
        .map(|(is_file, _, name)| {
            if *is_file {
                name.clone()
            } else {
                format!("{name}/")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if names.is_empty() {
        listing.push_str("This folder is empty.");
    } else if names.len() > FOLDER_LISTING_LIMIT {
        let _ = write!(
            listing,
            "\n… and {} more",
            names.len() - FOLDER_LISTING_LIMIT
        );
    }
    let mut contents = vec![CapabilityDefinition {
        source: format!("{provider} · folder"),
        path: folder.to_string_lossy().into_owned(),
        content: listing,
    }];
    let readme = names
        .iter()
        .filter(|(is_file, lowered, _)| {
            *is_file && matches!(lowered.as_str(), "readme.md" | "readme" | "readme.txt")
        })
        .find_map(|(_, _, name)| {
            let path = folder.join(name);
            fs::read_to_string(&path)
                .ok()
                .map(|text| (name, path, text))
        });
    if let Some((name, path, text)) = readme {
        let lines = text.lines().count();
        let mut content = text
            .lines()
            .take(README_LINE_LIMIT)
            .collect::<Vec<_>>()
            .join("\n");
        if lines > README_LINE_LIMIT {
            let _ = write!(
                content,
                "\n\n… {} more lines in the file",
                lines - README_LINE_LIMIT
            );
        }
        contents.push(CapabilityDefinition {
            source: format!("{provider} · {name}"),
            path: path.to_string_lossy().into_owned(),
            content,
        });
    }
    contents
}

#[derive(Debug, Deserialize)]
struct OpenCodeSession {
    worktree: String,
    name: Option<String>,
    title: Option<String>,
    directory: Option<String>,
    time_updated: Option<i64>,
}

/// The titles of the `OpenCode` sessions behind one source, newest first. Titles and dates only —
/// never a message from the conversation.
fn opencode_contents(home: &Path, name: &str) -> Vec<CapabilityDefinition> {
    let database = home.join(".local/share/opencode/opencode.db");
    if !database.is_file() {
        return Vec::new();
    }
    let Some(rows) = query_opencode::<OpenCodeSession>(
        &database,
        "SELECT p.worktree, p.name, s.title, s.directory, s.time_updated \
         FROM project p LEFT JOIN session s ON s.project_id = p.id AND s.parent_id IS NULL \
         ORDER BY s.time_updated DESC;",
    ) else {
        return Vec::new();
    };
    session_contents(home, name, &database, &rows)
}

/// `rows` is every project, joined to its top-level sessions newest first.
fn session_contents(
    home: &Path,
    name: &str,
    database: &Path,
    rows: &[OpenCodeSession],
) -> Vec<CapabilityDefinition> {
    if name == OPENCODE_HISTORY {
        let lines = rows
            .iter()
            .filter(|row| row.title.is_some())
            .take(SESSION_LIMIT)
            .map(|row| {
                let mut line = session_line(row);
                if let Some(directory) = &row.directory {
                    let _ = write!(line, "\n    {directory}");
                }
                line
            })
            .collect::<Vec<_>>();
        return vec![CapabilityDefinition {
            source: "OpenCode · recent sessions".to_owned(),
            path: database.to_string_lossy().into_owned(),
            content: if lines.is_empty() {
                "No sessions recorded yet.".to_owned()
            } else {
                lines.join("\n")
            },
        }];
    }
    let mut projects = BTreeMap::<String, Vec<String>>::new();
    for row in rows {
        if opencode_project_label(home, &row.worktree, row.name.clone()).as_deref() != Some(name) {
            continue;
        }
        let sessions = projects.entry(row.worktree.clone()).or_default();
        if row.title.is_some() && sessions.len() < SESSION_LIMIT {
            sessions.push(session_line(row));
        }
    }
    projects
        .into_iter()
        .map(|(worktree, sessions)| CapabilityDefinition {
            source: "OpenCode · sessions in this project".to_owned(),
            path: worktree,
            content: if sessions.is_empty() {
                "No sessions recorded for this project.".to_owned()
            } else {
                sessions.join("\n")
            },
        })
        .collect()
}

fn session_line(row: &OpenCodeSession) -> String {
    let when = row
        .time_updated
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_default();
    let title = row.title.as_deref().unwrap_or_default();
    format!("{when}  {title}").trim().to_owned()
}

/// A memory source's pinned Brief and, for a pack, its kept notes.
///
/// A live team's kept notes are rows in Postgres and this module never opens a pool, which is why
/// the inspector points at the Memory panel for those rather than claiming there are none.
fn memory_contents(teams_root: &Path, reference: &MemorySourceRef) -> Vec<CapabilityDefinition> {
    let Ok(root) = fs::canonicalize(teams_root) else {
        return Vec::new();
    };
    if let Some(folder) = &reference.pack {
        let Ok(pack) = crate::memory::Pack::load(&root, Path::new(folder)) else {
            return Vec::new();
        };
        let mut contents = brief_contents(&pack.brief);
        if !pack.notes.is_empty() {
            contents.push(CapabilityDefinition {
                source: format!("Kept notes · {}", pack.notes.len()),
                path: root
                    .join(folder)
                    .join("notebook.jsonl")
                    .to_string_lossy()
                    .into_owned(),
                content: pack
                    .notes
                    .iter()
                    .map(|note| {
                        format!(
                            "{} · {} · {}\n{}",
                            note.title,
                            note.kind.as_str(),
                            note.created_at,
                            note.body.trim()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n"),
            });
        }
        return contents;
    }
    let Some(team_id) = &reference.team else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        if !matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("yaml" | "yml")
        ) || fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_symlink())
        {
            continue;
        }
        let Ok(team) = fs::read_to_string(&path)
            .map_err(|_| ())
            .and_then(|source| crate::config::TeamConfig::parse(&source).map_err(|_| ()))
        else {
            continue;
        };
        if crate::memory::scope_id(&team.id, &path) != *team_id {
            continue;
        }
        let roots = crate::memory::MemoryRoots::for_team(&path, Some(&root));
        return match crate::memory::TeamMemory::load(&roots, &path, team.memory.as_ref()) {
            Ok(memory) => brief_contents(&memory.brief),
            Err(error) => vec![CapabilityDefinition {
                source: "Brief".to_owned(),
                path: path.to_string_lossy().into_owned(),
                content: format!("This team's Brief could not be read: {error}"),
            }],
        };
    }
    Vec::new()
}

fn brief_contents(brief: &[crate::memory::BriefEntry]) -> Vec<CapabilityDefinition> {
    brief
        .iter()
        .map(|entry| CapabilityDefinition {
            source: format!("Brief · {}", entry.title),
            path: entry.path.clone(),
            content: entry.body.clone(),
        })
        .collect()
}

/// "loomwatch" → "loomwatch project", but "Optimization Group Project" stays as it is.
fn project_label(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.to_ascii_lowercase().ends_with("project") {
        trimmed.to_owned()
    } else {
        format!("{trimmed} project")
    }
}

fn humanize(raw: &str) -> String {
    if raw.eq_ignore_ascii_case("agentmemory") {
        return "Agent Memory".to_owned();
    }
    raw.split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let lowered = part.to_ascii_lowercase();
            match lowered.as_str() {
                "mcp" => "MCP".to_owned(),
                "repl" => "REPL".to_owned(),
                "ai" => "AI".to_owned(),
                _ => {
                    let mut chars = part.chars();
                    chars.next().map_or_else(String::new, |first| {
                        first.to_uppercase().collect::<String>() + chars.as_str()
                    })
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("loomwatch-capabilities-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).expect("create temp directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove temp directory");
        }
    }

    /// A team's memory is a knowledge source, and the row carries the ids wiring it will write —
    /// not a display name a client would have to parse back apart.
    #[test]
    fn a_team_with_memory_is_listed_as_a_knowledge_source_with_the_ids_wiring_needs() {
        let directory = TempDirectory::new();
        let root = directory.0.join("teams");
        fs::create_dir_all(root.join("brief")).expect("teams root");
        fs::write(
            root.join("brief/constraints.md"),
            "# Constraints\nACP v1 only.\n",
        )
        .expect("brief");
        fs::write(
            root.join("research.yaml"),
            "schemaVersion: 1\nid: research-team\nname: Research team\nentrypoint: lead\nmemory:\n  brief:\n    - path: brief/constraints.md\nagents:\n  - id: lead\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n",
        )
        .expect("team with memory");
        // A team with no memory block is not a knowledge source.
        fs::write(
            root.join("plain.yaml"),
            "schemaVersion: 1\nid: plain\nname: Plain\nentrypoint: lead\nagents:\n  - id: lead\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n",
        )
        .expect("team without memory");

        let inventory = detect_capabilities(None, &root);
        let memory_rows: Vec<&DetectedCapability> = inventory
            .sources
            .iter()
            .filter(|source| source.memory.is_some())
            .collect();
        assert_eq!(
            memory_rows
                .iter()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>(),
            ["Research team · memory"],
            "{:?}",
            inventory.sources
        );
        let reference = memory_rows[0].memory.as_ref().expect("a memory reference");
        assert_eq!(reference.team.as_deref(), Some("research-team"));
        assert_eq!(reference.pack, None);
        assert_eq!(reference.brief, 1);
        assert_eq!(
            reference.kept, None,
            "a filesystem scan cannot count kept notes, and must not claim zero"
        );
        assert_eq!(memory_rows[0].source, "LoomWatch");
        assert!(
            memory_rows[0].detail.contains("1 brief entry"),
            "{:?}",
            memory_rows[0]
        );
    }

    #[test]
    fn discovers_and_deduplicates_skills_and_connectors_without_reading_secrets() {
        let home = TempDirectory::new();
        fs::create_dir_all(home.0.join(".claude/skills/notebooklm")).expect("skill directory");
        fs::create_dir_all(home.0.join(".codex/skills/notebooklm")).expect("skill directory");
        fs::create_dir_all(home.0.join(".codex")).expect("codex directory");
        fs::write(
            home.0.join(".claude/skills/notebooklm/SKILL.md"),
            "---\nname: notebooklm\ndescription: Research notebooks\n---\nsecret body",
        )
        .expect("write skill");
        fs::write(
            home.0.join(".codex/skills/notebooklm/SKILL.md"),
            "---\nname: notebooklm\ndescription: Research notebooks\n---\n",
        )
        .expect("write skill");
        fs::write(
            home.0.join(".codex/config.toml"),
            "[mcp_servers.agentmemory]\ncommand = \"secret-command\"\n",
        )
        .expect("write config");

        let inventory = detect_capabilities(Some(&home.0), &home.0);

        assert_eq!(inventory.skills.len(), 1);
        assert_eq!(inventory.skills[0].name, "notebooklm");
        assert_eq!(inventory.skills[0].source, "Claude Code + Codex");
        assert_eq!(inventory.tools.len(), 1);
        assert_eq!(inventory.tools[0].name, "Agent Memory");
        assert!(
            !serde_json::to_string(&inventory)
                .expect("serialize")
                .contains("secret-command")
        );

        let details = detect_capability_details(Some(&home.0), &home.0, &inventory.skills[0].id)
            .expect("detected skill details");
        assert_eq!(details.kind, "skill");
        assert_eq!(details.definitions.len(), 2);
        assert!(
            details
                .definitions
                .iter()
                .any(|definition| definition.content.contains("secret body"))
        );
        assert!(detect_capability_details(Some(&home.0), &home.0, "skill-missing").is_none());
    }

    fn write_skill(path: &Path, name: &str) {
        fs::create_dir_all(path).expect("skill directory");
        fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {name} skill\n---\n"),
        )
        .expect("write skill");
    }

    /// Harnesses install skills by symlinking them in: 5 of the 6 in a real `~/.claude/skills`
    /// are links, and skipping links listed exactly one of them.
    #[test]
    #[cfg(unix)]
    fn follows_symlinked_skills_without_looping() {
        let home = TempDirectory::new();
        write_skill(&home.0.join(".claude/skills/notebooklm"), "notebooklm");
        write_skill(&home.0.join("elsewhere/sketch"), "sketch");
        std::os::unix::fs::symlink(
            home.0.join("elsewhere/sketch"),
            home.0.join(".claude/skills/sketch"),
        )
        .expect("symlink the skill");
        // A link back to the root would walk forever without the visited set.
        std::os::unix::fs::symlink(
            home.0.join(".claude/skills"),
            home.0.join(".claude/skills/notebooklm/self"),
        )
        .expect("symlink the root");

        eprintln!(
            "DBG link meta: {:?}",
            fs::metadata(home.0.join(".claude/skills/sketch")).map(|m| m.is_dir())
        );
        eprintln!(
            "DBG read_dir sketch: {:?}",
            fs::read_dir(home.0.join(".claude/skills/sketch"))
                .map(|it| it.flatten().map(|e| e.file_name()).collect::<Vec<_>>())
        );
        let inventory = detect_capabilities(Some(&home.0), &home.0);

        let names = inventory
            .skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["notebooklm", "sketch"]);
    }

    /// Both harnesses ship plugin skills. Scanning only Codex's cache listed 123 Codex plugin
    /// skills against a single Claude Code one, which reads as a broken scan.
    #[test]
    fn lists_plugin_skills_from_both_harnesses_and_keeps_same_named_ones_apart() {
        let home = TempDirectory::new();
        write_skill(
            &home.0.join(
                ".codex/plugins/cache/openai-curated-remote/sales/1.1.0-alpha.2/skills/index",
            ),
            "index",
        );
        write_skill(
            &home.0.join(
                ".codex/plugins/cache/openai-curated-remote/data-analytics/1.0.2/skills/index",
            ),
            "index",
        );
        // Claude Code's synced plugins carry a generation suffix and park earlier generations in
        // `.trash/`; its `marketplaces/` folder is a catalog of plugins that are not installed.
        let synced = ".claude/plugins/synced/account";
        write_skill(
            &home
                .0
                .join(format!("{synced}/engineering~g3/skills/code-review")),
            "code-review",
        );
        write_skill(
            &home
                .0
                .join(".claude/plugins/.trash/old/engineering~g2/skills/code-review"),
            "code-review",
        );
        write_skill(
            &home
                .0
                .join(format!("{synced}/.staging/1/design/skills/half-written")),
            "half-written",
        );
        write_skill(
            &home.0.join(
                ".claude/plugins/marketplaces/official/plugins/uninstalled/skills/catalog-only",
            ),
            "catalog-only",
        );

        let inventory = detect_capabilities(Some(&home.0), &home.0);

        let listed = inventory
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.source.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            vec![
                ("code-review", "Claude Code · engineering"),
                ("index", "Codex · data-analytics"),
                ("index", "Codex · sales"),
            ]
        );
        let code_review = &inventory.skills[0];
        let definitions = skill_definitions(Some(&home.0), &home.0, code_review);
        assert_eq!(
            definitions.len(),
            1,
            "the trashed generation is never offered for delivery"
        );
        assert!(
            definitions[0].path.contains("engineering~g3"),
            "{:?}",
            definitions[0].path
        );
    }

    /// Every app `LoomWatch` drives keeps its own skills somewhere; each folder is listed under the
    /// app that owns it, and a skill several apps share is one row.
    #[test]
    fn lists_skills_from_every_app_and_the_project_the_teams_live_in() {
        let home = TempDirectory::new();
        let project = TempDirectory::new();
        let teams = project.0.join("teams");
        fs::create_dir_all(&teams).expect("teams folder");
        write_skill(&home.0.join(".hermes/skills/research/arxiv"), "arxiv");
        write_skill(
            &home.0.join(".hermes/profiles/hannah/skills/writing/memo"),
            "memo",
        );
        write_skill(
            &home.0.join(".hermes/hermes-agent/skills/source-checkout"),
            "source-checkout",
        );
        write_skill(&home.0.join(".openclaw/skills/notion"), "notion");
        write_skill(&home.0.join(".openclaw/workspace/skills/canvas"), "canvas");
        write_skill(&home.0.join(".gemini/skills/gemini-only"), "gemini-only");
        write_skill(
            &home.0.join(".gemini/extensions/maps/skills/directions"),
            "directions",
        );
        write_skill(&home.0.join(".pi/agent/skills/pi-only"), "pi-only");
        write_skill(
            &home.0.join(".config/opencode/skill/opencode-only"),
            "opencode-only",
        );
        write_skill(&home.0.join(".agents/skills/notion"), "notion");
        write_skill(&project.0.join(".claude/skills/house-style"), "house-style");

        let inventory = detect_capabilities(Some(&home.0), &teams);
        let listed = inventory
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.source.as_str()))
            .collect::<BTreeMap<_, _>>();
        let project_name = project_label(&project.0.file_name().expect("name").to_string_lossy());
        assert_eq!(listed.get("arxiv"), Some(&"Hermes"));
        assert_eq!(listed.get("memo"), Some(&"Hermes"));
        assert_eq!(listed.get("notion"), Some(&"OpenClaw + Shared"));
        assert_eq!(listed.get("canvas"), Some(&"OpenClaw"));
        assert_eq!(listed.get("gemini-only"), Some(&"Gemini"));
        assert_eq!(listed.get("directions"), Some(&"Gemini · maps"));
        assert_eq!(listed.get("pi-only"), Some(&"pi"));
        assert_eq!(listed.get("opencode-only"), Some(&"OpenCode"));
        assert_eq!(listed.get("house-style"), Some(&project_name.as_str()));
        assert_eq!(
            listed.get("source-checkout"),
            None,
            "an app's own source tree is not installed skills"
        );

        // Delivery reads the same folders: each of these can be handed to an agent.
        for skill in &inventory.skills {
            assert!(
                !skill_definitions(Some(&home.0), &teams, skill).is_empty(),
                "{} is listed but could not be delivered",
                skill.name
            );
        }
    }

    #[test]
    fn a_multi_line_description_reaches_the_library_whole() {
        let home = TempDirectory::new();
        let directory = home.0.join(".claude/skills/slides");
        fs::create_dir_all(&directory).expect("skill directory");
        fs::write(
            directory.join("SKILL.md"),
            "---\nname: slides\ndescription: >-\n  Turns notes\n  into slides.\n---\nBody\n",
        )
        .expect("write skill");
        let inventory = detect_capabilities(Some(&home.0), &home.0);
        assert_eq!(inventory.skills[0].detail, "Turns notes into slides.");
    }

    /// Personal skills lead the list; a plugin's payload follows, however many there are.
    #[test]
    fn ranks_personally_installed_skills_above_plugin_payloads() {
        let home = TempDirectory::new();
        write_skill(&home.0.join(".claude/skills/zzz-personal"), "zzz-personal");
        write_skill(
            &home.0.join(".codex/skills/.system/review-agent"),
            "review-agent",
        );
        write_skill(&home.0.join(".agents/skills/shared-one"), "shared-one");
        write_skill(
            &home
                .0
                .join(".codex/plugins/cache/mkt/aaa-plugin/1.0.0/skills/aaa-from-plugin"),
            "aaa-from-plugin",
        );

        let inventory = detect_capabilities(Some(&home.0), &home.0);

        let names = inventory
            .skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "zzz-personal",
                "review-agent",
                "shared-one",
                "aaa-from-plugin"
            ]
        );
    }

    /// The card the operator clicks on is a folder, so its contents are the folder's names and its
    /// README — and never the bytes of anything else in it, a `.env` least of all.
    #[test]
    fn a_project_knowledge_source_shows_its_folder_and_readme_but_no_other_file() {
        let directory = TempDirectory::new();
        let project = directory.0.join("demo");
        let root = project.join("teams");
        fs::create_dir_all(&root).expect("teams root");
        fs::create_dir_all(project.join("src")).expect("source folder");
        fs::write(project.join("README.md"), "# Demo\nWhat this project is.\n").expect("readme");
        fs::write(project.join(".env"), "TOKEN=do-not-show\n").expect("env file");

        let inventory = detect_capabilities(None, &root);
        let source = inventory
            .sources
            .iter()
            .find(|source| source.name == "demo project")
            .expect("the project folder is a knowledge source");
        let details =
            detect_capability_details(None, &root, &source.id).expect("details for the source");

        assert_eq!(details.kind, "knowledge");
        let [listing, readme] = details.definitions.as_slice() else {
            panic!("a listing and a README: {:?}", details.definitions);
        };
        assert_eq!(listing.source, "LoomWatch · folder");
        assert_eq!(listing.path, project.to_string_lossy());
        assert_eq!(listing.content, "src/\nteams/\n.env\nREADME.md");
        assert_eq!(readme.source, "LoomWatch · README.md");
        assert_eq!(readme.content, "# Demo\nWhat this project is.");
        assert!(
            details
                .definitions
                .iter()
                .all(|definition| !definition.content.contains("do-not-show")),
            "{:?}",
            details.definitions
        );
    }

    #[test]
    fn a_team_memory_knowledge_source_shows_its_brief() {
        let directory = TempDirectory::new();
        let root = directory.0.join("teams");
        fs::create_dir_all(root.join("brief")).expect("teams root");
        fs::write(
            root.join("brief/constraints.md"),
            "# Constraints\nACP v1 only.\n",
        )
        .expect("brief");
        fs::write(
            root.join("research.yaml"),
            "schemaVersion: 1\nid: research-team\nname: Research team\nentrypoint: lead\nmemory:\n  brief:\n    - path: brief/constraints.md\nagents:\n  - id: lead\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n",
        )
        .expect("team with memory");

        let inventory = detect_capabilities(None, &root);
        let source = inventory
            .sources
            .iter()
            .find(|source| source.memory.is_some())
            .expect("a memory source");
        let details =
            detect_capability_details(None, &root, &source.id).expect("details for the source");

        let [entry] = details.definitions.as_slice() else {
            panic!("one Brief entry: {:?}", details.definitions);
        };
        assert_eq!(entry.source, "Brief · Constraints");
        assert_eq!(entry.path, "brief/constraints.md");
        assert!(entry.content.contains("ACP v1 only."), "{entry:?}");
    }

    /// A project lists its own sessions and nobody else's; the history lists everyone's. Titles
    /// and dates only — the rows never carry a message to leak.
    #[test]
    fn opencode_sources_list_session_titles_for_their_own_project() {
        let home = PathBuf::from("/home/operator");
        let row = |worktree: &str, title: Option<&str>, time: i64| OpenCodeSession {
            worktree: worktree.to_owned(),
            name: None,
            title: title.map(str::to_owned),
            directory: Some(worktree.to_owned()),
            time_updated: Some(time),
        };
        let rows = [
            row("/work/loomwatch", Some("Fix the canvas"), 1_790_000_000_000),
            row(
                "/work/paperclip",
                Some("Paperclip session"),
                1_789_000_000_000,
            ),
            row(
                "/work/loomwatch",
                Some("Plan the release"),
                1_788_000_000_000,
            ),
            row("/work/empty", None, 0),
            row("/", Some("A global session"), 1_787_000_000_000),
        ];
        let database = Path::new("/home/operator/opencode.db");

        let project = session_contents(&home, "loomwatch project", database, &rows);
        let [sessions] = project.as_slice() else {
            panic!("one project: {project:?}");
        };
        assert_eq!(sessions.path, "/work/loomwatch");
        let titles = sessions
            .content
            .lines()
            .map(|line| line.split("  ").nth(1).unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(titles, ["Fix the canvas", "Plan the release"]);

        let empty = session_contents(&home, "empty project", database, &rows);
        assert_eq!(empty[0].content, "No sessions recorded for this project.");

        let history = session_contents(&home, OPENCODE_HISTORY, database, &rows);
        assert_eq!(history[0].source, "OpenCode · recent sessions");
        assert!(
            history[0].content.contains("A global session"),
            "{history:?}"
        );
        assert!(
            history[0].content.contains("Paperclip session"),
            "{history:?}"
        );
    }

    #[test]
    fn names_a_project_source_without_repeating_the_word_project() {
        assert_eq!(project_label("loomwatch"), "loomwatch project");
        assert_eq!(
            project_label("Optimization Group Project"),
            "Optimization Group Project"
        );
        assert_eq!(project_label("  paperclip  "), "paperclip project");
    }

    #[test]
    fn an_explicit_capability_home_is_independent_from_the_runtime_home() {
        assert_eq!(
            select_home(Some("/imports".into()), Some("/home/runner".into())),
            Some(PathBuf::from("/imports"))
        );
        assert_eq!(
            select_home(Some("".into()), Some("/home/runner".into())),
            Some(PathBuf::from("/home/runner"))
        );
    }
}
