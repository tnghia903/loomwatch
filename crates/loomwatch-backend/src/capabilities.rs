//! Read-only discovery of local skills, MCP tools and knowledge sources.
//!
//! The Library inventory deliberately returns metadata only: names, provenance and compatibility.
//! A separate, on-demand detail lookup can return a selected skill's local `SKILL.md`; connector
//! configuration values and `OpenCode` conversation contents are never returned.

use std::collections::{BTreeMap, BTreeSet};
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

    if let Some(home) = home {
        // Ranks order the list: what the operator installed themselves first, plugin payloads last.
        scan_skill_root(
            &home.join(".claude/skills"),
            "Claude Code",
            4,
            RANK_PERSONAL,
            &mut skills,
        );
        scan_skill_root(
            &home.join(".codex/skills"),
            "Codex",
            5,
            RANK_HARNESS,
            &mut skills,
        );
        scan_skill_root(
            &home.join(".agents/skills"),
            "Shared",
            4,
            RANK_SHARED,
            &mut skills,
        );
        // OpenCode is one of the three harnesses the Library offers, but its skills root was the
        // one never scanned.
        scan_skill_root(
            &home.join(".config/opencode/skills"),
            "OpenCode",
            4,
            RANK_HARNESS,
            &mut skills,
        );
        // Both harnesses install plugins that carry skills. Scanning only Codex's cache listed 123
        // Codex plugin skills beside a single Claude Code one, which read as a broken scan.
        scan_plugin_skill_root(&home.join(".codex/plugins/cache"), "Codex", 10, &mut skills);
        scan_plugin_skill_root(
            &home.join(".claude/plugins"),
            "Claude Code",
            10,
            &mut skills,
        );

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

    let team_directory_name = teams_root.file_name().and_then(|name| name.to_str());
    let project_name = if team_directory_name == Some("teams") {
        teams_root
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
    } else {
        team_directory_name
    };
    if let Some(name) = project_name {
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

    let definitions = if kind == "skill" {
        home.map_or_else(Vec::new, |home| skill_definitions(home, item))
    } else {
        Vec::new()
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
#[must_use]
pub fn skill_definitions_for(home: &Path, item: &DetectedCapability) -> Vec<CapabilityDefinition> {
    skill_definitions(home, item)
}

fn skill_definitions(home: &Path, item: &DetectedCapability) -> Vec<CapabilityDefinition> {
    let mut definitions = Vec::new();
    let mut seen = BTreeSet::new();
    for (root, source, depth) in [
        (home.join(".claude/skills"), "Claude Code", 4),
        (home.join(".codex/skills"), "Codex", 5),
        (home.join(".agents/skills"), "Shared", 4),
        (home.join(".config/opencode/skills"), "OpenCode", 4),
    ] {
        collect_matching_definitions(
            &root,
            source,
            depth,
            false,
            item,
            &mut seen,
            &mut definitions,
        );
    }
    for (root, source) in [
        (home.join(".codex/plugins/cache"), "Codex"),
        (home.join(".claude/plugins"), "Claude Code"),
    ] {
        collect_matching_definitions(&root, source, 10, true, item, &mut seen, &mut definitions);
    }
    definitions
        .sort_by(|left, right| (&left.source, &left.path).cmp(&(&right.source, &right.path)));
    definitions
}

fn collect_matching_definitions(
    root: &Path,
    provider: &str,
    max_depth: usize,
    plugin_source: bool,
    item: &DetectedCapability,
    seen: &mut BTreeSet<PathBuf>,
    definitions: &mut Vec<CapabilityDefinition>,
) {
    for path in find_skill_files(root, max_depth) {
        let directory = path.parent().unwrap_or(root);
        let fallback = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Unnamed skill");
        let (name, _) = read_skill_metadata(&path, fallback);
        let source = if plugin_source {
            plugin_name(directory).map_or_else(
                || provider.to_owned(),
                |plugin| format!("{provider} · {plugin}"),
            )
        } else {
            provider.to_owned()
        };
        if name != item.name || !capability_has_source(&item.source, &source) {
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

/// Directories that never hold a SKILL.md but can hold thousands of files.
const SKIP_DIRECTORIES: [&str; 4] = ["node_modules", ".git", "dist", "target"];

fn scan_skill_root(
    root: &Path,
    provider: &str,
    max_depth: usize,
    rank: u8,
    skills: &mut BTreeMap<String, CapabilityBuilder>,
) {
    for skill in find_skill_files(root, max_depth) {
        let fallback = skill
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or("Unnamed skill");
        let (name, description) = read_skill_metadata(&skill, fallback);
        add_capability(skills, &name, provider, &description, rank);
    }
}

/// A plugin cache holds `…/<plugin>[/<version>]/skills/<skill>/SKILL.md`. The plugin is what tells
/// two identically named skills apart, so it becomes both the dedup key and the visible source.
fn scan_plugin_skill_root(
    root: &Path,
    provider: &str,
    max_depth: usize,
    skills: &mut BTreeMap<String, CapabilityBuilder>,
) {
    for skill in find_skill_files(root, max_depth) {
        let directory = skill.parent().unwrap_or(root);
        let fallback = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Unnamed skill");
        let (name, description) = read_skill_metadata(&skill, fallback);
        let plugin = plugin_name(directory);
        let source = plugin.as_deref().map_or_else(
            || provider.to_owned(),
            |plugin| format!("{provider} · {plugin}"),
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
        add_keyed_capability(skills, &key, &name, &source, &description, RANK_INSTALLED);
    }
}

/// Every `SKILL.md` under `root`, following symlinks — the harnesses install skills by linking
/// them in (5 of the 6 in `~/.claude/skills` here), so skipping links hid most of them.
fn find_skill_files(root: &Path, max_depth: usize) -> Vec<PathBuf> {
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
                if SKIP_DIRECTORIES.iter().any(|skip| name == *skip) {
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
            .map(str::to_owned);
    }
    Some(name.to_owned())
}

/// `1.1.0-alpha.2`, `26.904.11930` — a cache directory named for the release, not the plugin.
fn looks_like_a_version(name: &str) -> bool {
    name.starts_with(|first: char| first.is_ascii_digit()) && name.contains('.')
}

fn read_skill_metadata(path: &Path, fallback: &str) -> (String, String) {
    let Ok(source) = fs::read_to_string(path) else {
        return (humanize(fallback), "Local skill".to_owned());
    };
    let mut name = None;
    let mut description = None;
    if source.starts_with("---") {
        for line in source
            .lines()
            .skip(1)
            .take_while(|line| line.trim() != "---")
        {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim().trim_matches(['\'', '"']);
            match key.trim() {
                "name" if !value.is_empty() => name = Some(value.to_owned()),
                "description" if !value.is_empty() => description = Some(value.to_owned()),
                _ => {}
            }
        }
    }
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
        "OpenCode history",
        "OpenCode",
        "Previous sessions and tool sources",
        RANK_PINNED,
    );

    let uri = format!("file:{}?mode=ro", database.to_string_lossy());
    let output = Command::new("sqlite3")
        .args([
            "-readonly",
            "-json",
            &uri,
            "SELECT worktree, name FROM project ORDER BY time_updated DESC;",
        ])
        .output();
    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let Ok(projects) = serde_json::from_slice::<Vec<OpenCodeProject>>(&output.stdout) else {
        return;
    };
    for project in projects {
        // OpenCode records a row for every directory a session ever ran in, including `/` and the
        // home directory. Those listed as "Project project" and "tnghia project" — neither is a
        // knowledge source anyone would drag onto a canvas.
        let worktree = PathBuf::from(&project.worktree);
        if worktree.parent().is_none() || worktree == home {
            continue;
        }
        let Some(fallback) = worktree.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let name = project
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| fallback.to_owned());
        add_capability(
            sources,
            &project_label(&name),
            "OpenCode",
            "Previously used project context",
            RANK_INSTALLED,
        );
    }
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
            "schemaVersion: 1\nid: research-team\nname: Research team\nentrypoint: lead\nmemory:\n  brief:\n    - path: brief/constraints.md\nagents:\n  - id: lead\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
        )
        .expect("team with memory");
        // A team with no memory block is not a knowledge source.
        fs::write(
            root.join("plain.yaml"),
            "schemaVersion: 1\nid: plain\nname: Plain\nentrypoint: lead\nagents:\n  - id: lead\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
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
        write_skill(
            &home.0.join(
                ".claude/plugins/marketplaces/official/plugins/engineering/skills/code-review",
            ),
            "code-review",
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
