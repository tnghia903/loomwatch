//! Read-only discovery of the skills and team memory the Library lists.
//!
//! Skills come from `LoomWatch`'s own skills folder (`<state dir>/skills`, filled by the Skills
//! page) and from the project the teams live in (`.agents/skills`, `.claude/skills`), which travel
//! with the team files. Other AI apps' folders and settings are never read here: the Skills page
//! brings an app's skills in when the person asks.
//!
//! The Library inventory deliberately returns metadata only: names, provenance and compatibility.
//! A separate, on-demand detail lookup can return a selected skill's local `SKILL.md`, or a memory
//! source's Brief and kept notes.
//!
//! Team memory is the only knowledge the Library lists. Other knowledge is a folder or file the
//! operator chooses (`chosen_knowledge`, ADR 0035); the Library no longer infers it from other
//! apps' session history (ADR 0036).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// `LoomWatch`'s own skills folder, where the Library lists skills from first and runs copy wired
/// skills from. `None` before the daemon has set up its state folder (`ai::install`).
#[must_use]
pub fn skills_folder() -> Option<PathBuf> {
    crate::ai::installed().map(crate::ai::Ai::skills_folder)
}

/// Where `LoomWatch`'s own skills folder is listed as coming from.
pub const LOOMWATCH_SOURCE: &str = "LoomWatch";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityInventory {
    pub skills: Vec<DetectedCapability>,
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
    /// in the database and this inventory is a filesystem scan that never opens it, so a team
    /// reports `None` rather than `0` — the Memory panel reads the real count over
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
    /// What this skill assumes about the agent running it, and how it will therefore reach the
    /// agent. Metadata derived from the skill's own text — never connector configuration and never
    /// a secret, the same rule the rest of this module keeps.
    ///
    /// `None` for a tool or a knowledge source, and for a skill with no readable definition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portability: Option<SkillPortabilityReport>,
}

/// One skill's portability facts, plus the route it takes to an agent.
///
/// The route is computed by the daemon rather than re-derived in the browser: the rule lives in
/// `skill_routing::route` and a second copy of it in TypeScript would be a second rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPortabilityReport {
    pub kind: &'static str,
    pub needs: Vec<&'static str>,
    pub evidence: Vec<ReportedEvidence>,
    /// `native` or `inline` (`skill_routing::SkillRoute`).
    pub route: &'static str,
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
        let route = crate::skill_routing::route(&portability).label();
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
            route,
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
        DetectedCapability {
            id: stable_id(kind, &self.display_name, &source),
            name: self.display_name,
            source,
            detail: self.detail,
            status: "Ready".to_owned(),
            memory: self.memory,
        }
    }
}

/// Everything the Library lists. `skills` is `LoomWatch`'s skills folder ([`skills_folder`]).
#[must_use]
pub fn detect_capabilities(skills: Option<&Path>, teams_root: &Path) -> CapabilityInventory {
    let mut found = BTreeMap::<String, CapabilityBuilder>::new();
    let mut sources = BTreeMap::<String, CapabilityBuilder>::new();
    for root in skill_roots(skills, teams_root) {
        scan_skill_root(&root, &mut found);
    }
    // Every team with memory, and every imported pack. A team's Brief plus its kept Notebook is a
    // knowledge source in exactly the Library's sense — something an agent reads — which is why it
    // belongs here rather than in a second inventory nobody would think to look in.
    scan_team_memory_sources(teams_root, &mut sources);
    CapabilityInventory {
        skills: finish_map(found, "skill"),
        sources: finish_map(sources, "source"),
    }
}

/// Load the definition of one already-detected capability. Skill bodies are read only for the
/// selected row; the inventory remains small and never exposes every installed instruction file.
#[must_use]
pub fn detect_capability_details(
    skills: Option<&Path>,
    teams_root: &Path,
    id: &str,
) -> Option<CapabilityDetails> {
    let inventory = detect_capabilities(skills, teams_root);
    let (kind, item) = inventory
        .skills
        .iter()
        .find(|item| item.id == id)
        .map(|item| ("skill", item))
        .or_else(|| {
            inventory
                .sources
                .iter()
                .find(|item| item.id == id)
                .map(|item| ("knowledge", item))
        })?;

    let definitions = match kind {
        "skill" => skill_definitions(skills, teams_root, item),
        "knowledge" => knowledge_contents(teams_root, item),
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
    skills: Option<&Path>,
    teams_root: &Path,
    item: &DetectedCapability,
) -> Vec<CapabilityDefinition> {
    skill_definitions(skills, teams_root, item)
}

fn skill_definitions(
    skills: Option<&Path>,
    teams_root: &Path,
    item: &DetectedCapability,
) -> Vec<CapabilityDefinition> {
    let mut definitions = Vec::new();
    let mut seen = BTreeSet::new();
    // Root order is preference order. Sorting the copies by source name instead once delivered a
    // trashed plugin generation, because `/.trash/` sorts before `/synced/`.
    for root in skill_roots(skills, teams_root) {
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
        let source = root.provider.clone();
        // Rows merge copies by lowercased name, so a copy spelled `PDF` beside `pdf` is the same
        // skill and must be offered for delivery too.
        if !name.eq_ignore_ascii_case(&item.name) || !capability_has_source(&item.source, &source) {
            continue;
        }
        let canonical = crate::platform::canonicalize(&path).unwrap_or_else(|_| path.clone());
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
/// `review-agent` is pinned just under the operator's own skills by the approved design.
const RANK_PINNED: u8 = 1;
/// A skill kept in the project the teams live in.
const RANK_PROJECT: u8 = 2;

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
    map.entry(name.to_ascii_lowercase())
        .or_default()
        .add(name, provider, detail, rank);
}

/// List every team with memory, and every imported pack, as knowledge sources.
///
/// Read from the filesystem, not from the database: this inventory is what the Library shows before
/// anything has run, and a source that only appeared once the archive was up would look like a
/// bug. The consequence is that a live team's kept-note count is not stated here — see
/// [`MemorySourceRef::kept`].
fn scan_team_memory_sources(teams_root: &Path, sources: &mut BTreeMap<String, CapabilityBuilder>) {
    let Ok(root) = crate::platform::canonicalize(teams_root) else {
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

/// One folder skills are read from.
#[derive(Debug, Clone)]
struct SkillRoot {
    path: PathBuf,
    /// Where they are kept, as the Library names the source.
    provider: String,
    depth: usize,
    rank: u8,
    /// Folder names skipped directly below `path`, beyond [`SKIP_DIRECTORIES`].
    exclude: &'static [&'static str],
}

impl SkillRoot {
    fn new(path: PathBuf, provider: &str, rank: u8) -> Self {
        Self {
            path,
            provider: provider.to_owned(),
            depth: 5,
            rank,
            // The Skills page keeps what it took away, and what it is still unpacking, here.
            exclude: &[".removed", ".staging"],
        }
    }
}

/// Every folder skills are read from, in the order a copy is preferred when several folders hold
/// a skill of the same name: `LoomWatch`'s own folder, then the project's.
///
/// Detection and delivery both read this one list (ADR 0031). They used to keep a copy each, and a
/// folder added to one but not the other would list a skill that no agent could then be given.
fn skill_roots(skills: Option<&Path>, teams_root: &Path) -> Vec<SkillRoot> {
    let mut roots: Vec<SkillRoot> = skills
        .map(|folder| SkillRoot::new(folder.to_path_buf(), LOOMWATCH_SOURCE, RANK_PERSONAL))
        .into_iter()
        .collect();
    // Skills kept in the project the teams live in: a repository's own `.agents/skills` and
    // `.claude/skills`, which travel with its team files.
    if let Some(project) = project_folder(teams_root)
        && let Some(name) = project.file_name().and_then(|name| name.to_str())
    {
        let label = project_label(name);
        let canonical = |path: &Path| {
            crate::platform::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
        };
        let own = roots
            .iter()
            .map(|root| canonical(&root.path))
            .collect::<BTreeSet<_>>();
        roots.extend(
            [".agents", ".claude"]
                .into_iter()
                .map(|app| SkillRoot::new(project.join(app).join("skills"), &label, RANK_PROJECT))
                .filter(|root| !own.contains(&canonical(&root.path))),
        );
    }
    roots
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

/// Every `SKILL.md` under `root`, following symlinks: a project may link a shared skill in.
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
        let canonical =
            crate::platform::canonicalize(&directory).unwrap_or_else(|_| directory.clone());
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

/// The project the teams live in, whose own skill folders the Library lists: the teams root's
/// parent when the root is a plain `teams` folder inside a project, and the root itself otherwise.
fn project_folder(teams_root: &Path) -> Option<PathBuf> {
    if teams_root.file_name().and_then(|name| name.to_str()) == Some("teams") {
        teams_root.parent().map(Path::to_path_buf)
    } else {
        Some(teams_root.to_path_buf())
    }
}

/// Entries listed from a linked folder before the listing says how many more there are.
const FOLDER_LISTING_LIMIT: usize = 200;
/// Lines of a README shown before it is cut off.
const README_LINE_LIMIT: usize = 120;

/// What one chosen folder or file holds (ADR 0035): the inspector's Contents, and exactly what an
/// agent wired to it is handed in its opening prompt.
///
/// One reader serves both on purpose. "What you see in the panel is what the agent gets" holds
/// only while there is one reader.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KnowledgeSnapshot {
    pub contents: Vec<CapabilityDefinition>,
    /// The folder the source is, for a linked folder. Canonical and existing.
    pub folders: Vec<PathBuf>,
    /// Single files the agent may read: a file the operator added (ADR 0035). Canonical.
    pub files: Vec<PathBuf>,
    /// A file's full text when the prompt carries only its opening, to be written into the agent's
    /// working folder so any app can read the rest (ADR 0035).
    pub text_copy: Option<TextCopy>,
}

/// The full text of one added file, written into the agent's working folder as
/// `knowledge/<file_name>` when its prompt section is only an excerpt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextCopy {
    pub file_name: String,
    pub text: String,
}

/// What a Library knowledge source holds. Every one is team memory (ADR 0036), which reaches an
/// agent through `memory.inherits`, so this is the inspector's view of it and never a prompt.
fn knowledge_contents(teams_root: &Path, item: &DetectedCapability) -> Vec<CapabilityDefinition> {
    item.memory
        .as_ref()
        .map(|reference| memory_contents(teams_root, reference))
        .unwrap_or_default()
}

/// A project folder's top-level listing, folders first, and its README when it has one.
///
/// Names only for the listing: a file's contents are never read here, so a `.env` beside the
/// teams shows as a name and nothing more.
pub(crate) fn folder_contents(folder: &Path, provider: &str) -> Vec<CapabilityDefinition> {
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

/// A memory source's pinned Brief and, for a pack, its kept notes.
///
/// A live team's kept notes are rows in the database and this module never opens it, which is why
/// the inspector points at the Memory panel for those rather than claiming there are none.
fn memory_contents(teams_root: &Path, reference: &MemorySourceRef) -> Vec<CapabilityDefinition> {
    let Ok(root) = crate::platform::canonicalize(teams_root) else {
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

    /// The Library lists `LoomWatch`'s own skills folder and the project the teams live in, one row
    /// for a skill in both, and never reads another app's folders or settings.
    #[test]
    fn lists_loomwatchs_skills_and_the_projects_and_no_apps() {
        let home = TempDirectory::new();
        let skills = home.0.join("state/skills");
        let project = home.0.join("demo");
        let teams = project.join("teams");
        fs::create_dir_all(&teams).expect("teams");
        for folder in [
            skills.join("notebooklm"),
            project.join(".agents/skills/notebooklm"),
        ] {
            fs::create_dir_all(&folder).expect("skill directory");
            fs::write(
                folder.join("SKILL.md"),
                "---\nname: notebooklm\ndescription: Research notebooks\n---\nsecret body",
            )
            .expect("write skill");
        }
        write_skill(&project.join(".claude/skills/house-style"), "house-style");
        write_skill(&skills.join(".removed/old-skill"), "old-skill");
        // What another app keeps is not LoomWatch's to list.
        write_skill(&home.0.join(".claude/skills/claude-only"), "claude-only");
        fs::create_dir_all(home.0.join(".codex")).expect("codex directory");
        fs::write(
            home.0.join(".codex/config.toml"),
            "[mcp_servers.agentmemory]\ncommand = \"secret-command\"\n",
        )
        .expect("write config");

        let inventory = detect_capabilities(Some(&skills), &teams);
        let listed = inventory
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.source.as_str()))
            .collect::<BTreeMap<_, _>>();
        let project_name = project_label("demo");
        let both = format!("{LOOMWATCH_SOURCE} + {project_name}");
        assert_eq!(listed.get("notebooklm"), Some(&both.as_str()));
        assert_eq!(listed.get("house-style"), Some(&project_name.as_str()));
        assert_eq!(listed.len(), 2, "{listed:?}");
        assert!(
            !serde_json::to_string(&inventory)
                .expect("serialize")
                .contains("secret-command")
        );

        let notebook = inventory
            .skills
            .iter()
            .find(|skill| skill.name == "notebooklm")
            .expect("listed");
        let details = detect_capability_details(Some(&skills), &teams, &notebook.id)
            .expect("detected skill details");
        assert_eq!(details.kind, "skill");
        assert_eq!(details.definitions.len(), 2);
        assert_eq!(
            details.definitions[0].source, LOOMWATCH_SOURCE,
            "LoomWatch's own copy is the one a run delivers"
        );
        assert!(detect_capability_details(Some(&skills), &teams, "skill-missing").is_none());
        // Delivery reads the same folders: each listed skill can be handed to an agent.
        for skill in &inventory.skills {
            assert!(
                !skill_definitions(Some(&skills), &teams, skill).is_empty(),
                "{} is listed but could not be delivered",
                skill.name
            );
        }
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

    /// A linked folder's contents are its names and its README — and never the bytes of anything
    /// else in it, a `.env` least of all.
    #[test]
    fn a_folder_shows_its_names_and_readme_but_no_other_file() {
        let directory = TempDirectory::new();
        let project = directory.0.join("demo");
        fs::create_dir_all(project.join("src")).expect("source folder");
        fs::write(project.join("README.md"), "# Demo\nWhat this project is.\n").expect("readme");
        fs::write(project.join(".env"), "TOKEN=do-not-show\n").expect("env file");

        let contents = folder_contents(&project, "Linked");

        let [listing, readme] = contents.as_slice() else {
            panic!("a listing and a README: {contents:?}");
        };
        assert_eq!(listing.source, "Linked · folder");
        assert_eq!(listing.path, project.to_string_lossy());
        assert_eq!(listing.content, "src/\n.env\nREADME.md");
        assert_eq!(readme.source, "Linked · README.md");
        assert_eq!(readme.content, "# Demo\nWhat this project is.");
        assert!(
            contents
                .iter()
                .all(|definition| !definition.content.contains("do-not-show")),
            "{contents:?}"
        );
    }

    /// ADR 0036: the Library lists team memory as knowledge and nothing else — not the project the
    /// teams live in, and not another app's session history — however much of either is on disk.
    #[test]
    fn the_library_lists_no_project_folder_or_app_history_as_knowledge() {
        let directory = TempDirectory::new();
        let home = directory.0.join("home");
        let project = directory.0.join("demo");
        let root = project.join("teams");
        fs::create_dir_all(&root).expect("teams root");
        fs::write(project.join("README.md"), "# Demo\n").expect("readme");
        fs::create_dir_all(home.join(".local/share/opencode")).expect("opencode data");
        fs::write(home.join(".local/share/opencode/opencode.db"), "").expect("opencode database");

        let inventory = detect_capabilities(Some(&home), &root);

        assert!(inventory.sources.is_empty(), "{:?}", inventory.sources);
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

    #[test]
    fn names_a_project_without_repeating_the_word_project() {
        assert_eq!(project_label("loomwatch"), "loomwatch project");
        assert_eq!(
            project_label("Optimization Group Project"),
            "Optimization Group Project"
        );
        assert_eq!(project_label("  paperclip  "), "paperclip project");
    }
}
