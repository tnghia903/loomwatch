//! What an Agent Skill assumes about the harness running it, and what to do about it.
//!
//! `docs/decisions/0019-cross-harness-skill-delivery.md` decided that a skill's discovery source
//! never constrains the harness that executes it, and its last consequence disclaimed the rest:
//! "a syntactically valid Agent Skill can be delivered cross-harness even when its own content
//! still depends on tools that only one harness exposes". Delivery was guaranteed; behaviour was
//! not, and nothing in the run record could tell the two apart.
//!
//! `docs/decisions/0021-skill-routing-by-portability.md` amends that. This module holds the facts
//! the amendment rests on, all of them derived from the skill's own text and none of them written
//! back to it:
//!
//! * [`analyse`] reads a `SKILL.md` and reports what it *needs* from its harness and what kind of
//!   thing it is;
//! * [`route`] turns those facts plus the receiving harness into one of three routes;
//! * [`translation_note`] writes the short mapping an agent on a foreign harness is given, and
//!   advertises a Team Bus tool only when that agent will actually have it.
//!
//! Everything here is a pure function over text. Nothing in this module touches the filesystem,
//! and nothing it produces is ever written into a skill: `LoomWatch` adapts placement and framing,
//! never bytes (ADR 0019 decision 2, unchanged).

use std::fmt::Write as _;

use crate::workspace::Harness;

/// One harness assumption a skill's text makes.
///
/// The first four are **execution-level**: following the instruction requires a facility the
/// receiving harness may not have, so a skill carrying one is degraded rather than merely
/// differently worded. The last two are advisory — they change what the output should look like,
/// not whether the steps can be performed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillNeed {
    /// "Use the Task tool", "spawn a subagent", "fan out".
    Subagents,
    /// Shells out to a bundled script (`scripts/build.py`, `node tools/x.js`).
    Scripts,
    /// Invokes a slash command (`/review`, `/init`).
    SlashCommands,
    /// Names a specific Claude tool (`TodoWrite`, "the Read tool").
    NamedTools,
    /// Names a Claude-only product surface (`claude.ai`, Artifacts, `.claude/…`).
    ClaudeSurface,
    /// Tells the agent to load another skill by name.
    SiblingSkills,
}

impl SkillNeed {
    /// Every need, in the order they are reported. Used by the exhaustiveness test so a variant
    /// added later cannot silently skip classification.
    pub const ALL: [Self; 6] = [
        Self::Subagents,
        Self::Scripts,
        Self::SlashCommands,
        Self::NamedTools,
        Self::ClaudeSurface,
        Self::SiblingSkills,
    ];

    /// Whether following this instruction needs a facility the harness may not have.
    ///
    /// The routing rule turns on exactly this predicate, so it lives beside the variants rather
    /// than being re-derived at each call site.
    #[must_use]
    pub const fn is_execution_level(self) -> bool {
        matches!(
            self,
            Self::Subagents | Self::Scripts | Self::SlashCommands | Self::NamedTools
        )
    }

    /// The word used in the inspector and in the translation note.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Subagents => "subagents",
            Self::Scripts => "scripts",
            Self::SlashCommands => "slash commands",
            Self::NamedTools => "named tools",
            Self::ClaudeSurface => "Claude surfaces",
            Self::SiblingSkills => "other skills",
        }
    }
}

/// What kind of thing a skill is, which decides whether its body has to be *in* the prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillKind {
    /// Produces a deliverable: a file, a deck, a report, a design.
    Artifact,
    /// Governs how the agent works: a review standard, a style, a method.
    Behavior,
    /// Makes no assumption about its harness at all.
    Portable,
}

impl SkillKind {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Artifact => "artifact",
            Self::Behavior => "behavior",
            Self::Portable => "portable",
        }
    }
}

/// How one skill reaches one agent.
///
/// A fourth route, `sidecar` — running the skill in a helper session on its own harness — is
/// phase 3 of this work and deliberately absent: an unimplemented variant would be a route the
/// router could never return and the UI would have to render anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillRoute {
    /// Bundle copied to the harness's own skill directory; the prompt carries the skill's
    /// description and a pointer to read it, not its text.
    Native,
    /// Bundle copied *and* the body inlined in the prompt, followed by a translation note.
    Inline,
    /// The harness has no project skill directory `LoomWatch` can write, so the run is refused
    /// before anything spawns. Unchanged from ADR 0019 decision 5.
    Blocked,
}

impl SkillRoute {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Inline => "inline",
            Self::Blocked => "blocked",
        }
    }
}

/// The matched line that justifies a need, so the operator can judge the classification rather
/// than trust it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortabilityEvidence {
    pub need: SkillNeed,
    /// The matched line, whitespace-collapsed and cut to [`EVIDENCE_CHARS`].
    pub line: String,
}

/// Evidence is a quotation for a human to read, not the skill's text: one line, capped.
pub const EVIDENCE_CHARS: usize = 120;

/// Everything `LoomWatch` knows about one skill's portability, computed once at detection time.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPortability {
    pub kind: SkillKind,
    pub needs: Vec<SkillNeed>,
    pub evidence: Vec<PortabilityEvidence>,
    /// Other skills this one names, lowercased. Resolved against the agent's wired capabilities
    /// when the note is written, never here — this module has no team.
    pub siblings: Vec<String>,
}

impl SkillPortability {
    /// Whether any need is execution-level, which is the half of the routing rule that is about
    /// the skill rather than about the harness.
    #[must_use]
    pub fn has_execution_coupling(&self) -> bool {
        self.needs
            .iter()
            .copied()
            .any(SkillNeed::is_execution_level)
    }

    /// The needs a translation note has to map, in reporting order.
    #[must_use]
    pub fn evidence_for(&self, need: SkillNeed) -> Option<&PortabilityEvidence> {
        self.evidence.iter().find(|item| item.need == need)
    }
}

/// Split a `SKILL.md` into its YAML frontmatter and its body.
///
/// The body is what may enter a prompt (A3): frontmatter is machine metadata addressed to a skill
/// loader, and pasting it into an opening prompt asks a model to read a manifest as instructions.
/// The file on disk is never touched — this borrows from the text it was handed.
#[must_use]
pub fn split_frontmatter(text: &str) -> (&str, &str) {
    let Some(rest) = text.strip_prefix("---") else {
        return ("", text);
    };
    // A document whose first line is exactly `---` opens frontmatter; `---foo` does not.
    let Some(rest) = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))
    else {
        return ("", text);
    };
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            let frontmatter = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (frontmatter, body.trim_start_matches(['\n', '\r']));
        }
        offset += line.len();
    }
    // An unterminated `---` is not frontmatter; treating it as such would swallow the whole skill.
    ("", text)
}

/// The skill's own `description:`, as one line, which is what a `native` route puts in the prompt.
#[must_use]
pub fn description(text: &str) -> Option<String> {
    let (frontmatter, _) = split_frontmatter(text);
    frontmatter_field(frontmatter, "description")
}

/// One top-level `key:` of a skill's frontmatter as one line of plain text: quotes removed, and a
/// value written over several lines — a `>-` or `|` block, or an indented continuation — joined
/// with spaces.
///
/// Not a YAML parser, on purpose: frontmatter is read for a name and a description, and a skill
/// whose frontmatter does not parse as YAML must still be listed. Reading only the first line
/// handed the literal `>-` to the Library and to every prompt that quoted the description.
#[must_use]
pub fn frontmatter_field(frontmatter: &str, key: &str) -> Option<String> {
    let mut lines = frontmatter.lines().peekable();
    while let Some(line) = lines.next() {
        // An indented `name:` belongs to a nested map, not to the skill.
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((found, value)) = line.split_once(':') else {
            continue;
        };
        if found.trim() != key {
            continue;
        }
        let first = value.trim();
        let block = first.starts_with(['>', '|'])
            && first[1..]
                .chars()
                .all(|c| matches!(c, '-' | '+') || c.is_ascii_digit());
        let mut parts = Vec::new();
        if !block && !first.is_empty() {
            parts.push(first);
        }
        while let Some(next) = lines.peek() {
            if !next.trim().is_empty() && !next.starts_with([' ', '\t']) {
                break;
            }
            if !next.trim().is_empty() {
                parts.push(next.trim());
            }
            lines.next();
        }
        let joined = parts.join(" ");
        let value = joined.trim_matches(['\'', '"']).trim();
        return (!value.is_empty()).then(|| value.to_owned());
    }
    None
}

/// Read one skill's text and report what it assumes about its harness.
#[must_use]
pub fn analyse(text: &str) -> SkillPortability {
    let (frontmatter, body) = split_frontmatter(text);
    let mut evidence: Vec<PortabilityEvidence> = Vec::new();
    let mut siblings: Vec<String> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        for need in SkillNeed::ALL {
            if evidence.iter().any(|item| item.need == need) {
                continue;
            }
            if matches(need, trimmed) {
                evidence.push(PortabilityEvidence {
                    need,
                    line: quote(trimmed),
                });
            }
        }
        collect_siblings(trimmed, &mut siblings);
    }
    evidence.sort_by_key(|item| item.need);
    siblings.sort_unstable();
    siblings.dedup();
    let needs = evidence.iter().map(|item| item.need).collect::<Vec<_>>();
    let kind = if needs.is_empty() {
        SkillKind::Portable
    } else {
        classify(description(text).as_deref().unwrap_or(frontmatter), body)
    };
    SkillPortability {
        kind,
        needs,
        evidence,
        siblings,
    }
}

/// Decide the route for one skill on one harness.
///
/// The rule, and only the rule:
///
/// * a harness that loads no skills from a project folder (Hermes, an unknown app) is `inline`
///   before anything else is considered: nothing would discover the bundle on disk, so its
///   instructions travel in the prompt (ADR 0031, replacing ADR 0019 decision 5's refusal);
/// * Claude Code is `native` for everything, because every coupling this module detects is a
///   Claude facility and Claude has it;
/// * on any other harness, execution-level coupling or a behaviour-governing skill is `inline`,
///   because those are the two cases where the body has to be *in* the prompt to have any effect;
/// * everything else is `native`: the bundle is on disk and the prompt says to read it.
///
/// No harness is `blocked` any more; the variant stays because archived runs recorded it.
#[must_use]
pub fn route(portability: &SkillPortability, harness: Harness) -> SkillRoute {
    if harness.skill_directory().is_none() {
        return SkillRoute::Inline;
    }
    if harness == Harness::Claude {
        return SkillRoute::Native;
    }
    if portability.has_execution_coupling() || portability.kind == SkillKind::Behavior {
        return SkillRoute::Inline;
    }
    SkillRoute::Native
}

/// Which Team Bus surface a run gives an agent.
///
/// Mirrors `team_bus::TeamBusMode` plus the absence of a bus. A separate type because
/// `TeamBusMode` is private to the bus and because "no bus at all" is a third case the bus itself
/// never represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BusMode {
    Team,
    Pipeline,
    None,
}

/// The Team Bus tools this agent will actually be offered.
///
/// Read off `team_bus::tool_definitions` and `team_bus::refuse_by_mode`, not guessed: `dispatch`
/// and `handoff` exist only in team mode; `ask` exists in both but pipeline mode refuses it for an
/// agent with `allowRecruiting: false` unless the target is a live predecessor, which a note
/// written before the run cannot promise; `ask_user` exists in both modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusTools {
    pub ask: bool,
    pub delegate: bool,
    pub ask_user: bool,
}

impl BusTools {
    /// Whether the agent has any way at all to reach another agent or the operator.
    #[must_use]
    pub const fn reachable(self) -> bool {
        self.ask || self.delegate || self.ask_user
    }
}

/// What Team Bus tools an agent on `harness` will have in `mode`.
#[must_use]
pub fn bus_tools(harness: Harness, mode: BusMode, allow_recruiting: bool) -> BusTools {
    // A harness that does not advertise HTTP MCP gets `team_bus_unavailable` at negotiation and no
    // tools at all (`acp.rs::start_recorder`). Only the rows `docs/ARCHITECTURE.md` records as ACP
    // verified *with* HTTP MCP may be promised tools; anything else is told it has none, because
    // naming a tool that turns out not to exist is the exact failure this note is written to stop.
    if mode == BusMode::None || !harness.advertises_http_mcp() {
        return BusTools {
            ask: false,
            delegate: false,
            ask_user: false,
        };
    }
    let team = mode == BusMode::Team;
    BusTools {
        ask: team || allow_recruiting,
        delegate: team,
        ask_user: true,
    }
}

/// Everything the note is written from. A struct because seven positional arguments in a row is
/// how a `siblings_wired`/`siblings_missing` pair gets swapped.
#[derive(Debug, Clone, Copy)]
pub struct TranslationRequest<'a> {
    pub skill: &'a str,
    pub harness: Harness,
    pub needs: &'a [SkillNeed],
    /// The delivered bundle's directory, so "the scripts are here" names a real path.
    pub bundle_dir: &'a str,
    pub bus: BusTools,
    /// Skills this one names that ARE wired to the same agent.
    pub siblings_wired: &'a [String],
    /// Skills this one names that are not.
    pub siblings_missing: &'a [String],
}

/// The sentence every note ends with, and the only thing that makes the self-report lane possible.
///
/// A constant because the archive's `skill_self_report` reader looks for the phrase the agent was
/// asked for; two copies of it would drift and the evidence would quietly stop being found.
pub const SELF_REPORT_REQUEST: &str = "List, at the end of your reply, every required-skill instruction you could not follow and why.";

/// The phrase a reply is searched for to find the agent's own account of what it skipped.
pub const SELF_REPORT_MARKER: &str = "could not follow";

/// How much of a reply a self-report may claim. Past this it is not a list, it is the answer.
const SELF_REPORT_CHARS: usize = 2_000;

/// Find the agent's own account of what it could not follow, if it wrote one.
///
/// **Not provenance, and this function is why it cannot be mistaken for it.** It reads the
/// agent's prose, which `docs/RUN_PROVENANCE_CONTRACT.md` §8.2 excludes from the evidence graph
/// outright — "no inference from prose can label a skill, command, or source as used". What it
/// produces is archived under its own `skill_self_report` phase and shown as the agent's claim.
///
/// The extract starts at the line carrying [`SELF_REPORT_MARKER`] and runs to the end of the
/// reply or [`SELF_REPORT_CHARS`], whichever comes first. A heading is included when it is the
/// line the marker is on, which is the shape the note asks for.
#[must_use]
pub fn self_report(reply: &str) -> Option<String> {
    let lower = reply.to_ascii_lowercase();
    let at = lower.find(SELF_REPORT_MARKER)?;
    // Back up to the start of the line the phrase is on, so a heading is not cut in half.
    let start = reply[..at].rfind('\n').map_or(0, |index| index + 1);
    let extract = reply[start..].trim();
    if extract.is_empty() {
        return None;
    }
    Some(
        extract
            .chars()
            .take(SELF_REPORT_CHARS)
            .collect::<String>()
            .trim_end()
            .to_owned(),
    )
}

/// Write the mapping an agent on a foreign harness is given beside an inlined skill.
///
/// It is a mapping, never a rewrite: it quotes nothing from the skill and says only what to do
/// where the skill assumes a facility this agent does not have. It also tells the truth about
/// bundled scripts — `LoomWatch` refuses every `session/request_permission`
/// (`acp.rs::build_client_response`), so a script may simply not run, and promising otherwise
/// would be the same false assurance ADR 0019's last consequence left in place.
#[must_use]
pub fn translation_note(request: &TranslationRequest<'_>) -> String {
    let mut note = if request.harness.skill_directory().is_some() {
        format!(
            "This skill was written for Claude Code; you are running on {}. Its instructions are above, unchanged, and its files are in {}. Where it assumes something you do not have, use this mapping.\n",
            request.harness.label(),
            request.bundle_dir,
        )
    } else if request.needs.is_empty() {
        // Inline only because this app loads no skills from a folder; the skill itself assumes
        // nothing, so there is no mapping to give and no claim about who it was written for.
        format!(
            "You are running on {}, which does not load skills from a project folder, so this skill's instructions are above, unchanged. Its files are in {}.\n",
            request.harness.label(),
            request.bundle_dir,
        )
    } else {
        format!(
            "This skill was written for Claude Code; you are running on {}, which does not load skills from a project folder, so its instructions are above, unchanged, and its files are in {}. Where it assumes something you do not have, use this mapping.\n",
            request.harness.label(),
            request.bundle_dir,
        )
    };
    for need in SkillNeed::ALL {
        if !request.needs.contains(&need) {
            continue;
        }
        let _ = writeln!(note, "- {}", mapping(need, request));
    }
    let _ = write!(note, "\n{SELF_REPORT_REQUEST}");
    note
}

fn mapping(need: SkillNeed, request: &TranslationRequest<'_>) -> String {
    match need {
        SkillNeed::Subagents => {
            let fallback = "otherwise do the steps yourself, in sequence";
            if request.bus.ask {
                format!(
                    "Subagents: where it says to use the Task tool, a subagent, or to fan work out, call the Team Bus `ask` tool to put the step to another agent on this team{}; {fallback}.",
                    if request.bus.delegate {
                        ", or `dispatch` when you do not need to wait for the answer"
                    } else {
                        ""
                    }
                )
            } else if request.bus.reachable() {
                format!(
                    "Subagents: you may not recruit helpers on this step, so where it says to use the Task tool, a subagent, or to fan work out, {fallback}."
                )
            } else {
                format!(
                    "Subagents: you have no way to delegate here, so where it says to use the Task tool, a subagent, or to fan work out, {fallback}."
                )
            }
        }
        SkillNeed::Scripts => format!(
            "Scripts: the bundled scripts are in {}. LoomWatch refuses every permission request your harness makes, so a script may simply not run. If one does not, do that step by hand and say so in your reply.",
            request.bundle_dir,
        ),
        SkillNeed::SlashCommands => {
            "Slash commands: there are none here. Perform the steps the command describes, directly."
                .to_owned()
        }
        SkillNeed::NamedTools => {
            let mut text = "Named tools: where it names Read, Write, Edit, Glob, Grep, Bash, WebFetch or WebSearch, use your own file-reading, file-writing, search, shell or web tool. TodoWrite: keep your own plan in your reply.".to_owned();
            if request.bus.ask_user {
                text.push_str(" AskUserQuestion: call the Team Bus `ask_user` tool.");
            } else {
                text.push_str(
                    " AskUserQuestion: you cannot reach the operator, so state the question in your reply and proceed on your best reading.",
                );
            }
            text
        }
        SkillNeed::ClaudeSurface => {
            "Claude surfaces: where it says Artifact or claude.ai, write a standalone file in your working directory and name its path in your reply."
                .to_owned()
        }
        SkillNeed::SiblingSkills => {
            let mut text = "Other skills: ".to_owned();
            if request.siblings_wired.is_empty() {
                text.push_str("none of the skills it names is connected to you");
            } else {
                let _ = write!(
                    text,
                    "connected to you: {}",
                    request.siblings_wired.join(", ")
                );
            }
            if !request.siblings_missing.is_empty() {
                let _ = write!(
                    text,
                    "; not connected: {}",
                    request.siblings_missing.join(", ")
                );
            }
            text.push_str(". Proceed without what is not connected, and say so.");
            text
        }
    }
}

// ---------------------------------------------------------------------------
// Detection. Hand-written rather than regex: this crate has no regex dependency and every rule
// below is a decision about what counts as evidence, which reads better as a named predicate than
// as a character class.
// ---------------------------------------------------------------------------

fn matches(need: SkillNeed, line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    match need {
        SkillNeed::Subagents => SUBAGENT_MARKERS.iter().any(|marker| lower.contains(marker)),
        SkillNeed::Scripts => names_a_script(&lower),
        SkillNeed::SlashCommands => lower.contains("slash command") || names_a_slash_command(line),
        SkillNeed::NamedTools => names_a_claude_tool(line),
        SkillNeed::ClaudeSurface => names_a_claude_surface(&lower),
        SkillNeed::SiblingSkills => {
            let mut found = Vec::new();
            collect_siblings(line, &mut found);
            !found.is_empty()
        }
    }
}

const SUBAGENT_MARKERS: &[&str] = &[
    "task tool",
    "subagent",
    "sub-agent",
    "sub agent",
    "spawn an agent",
    "spawn agent",
    "fan out",
    "fan-out",
    "parallel agents",
    "launch agents",
    "agent tool",
    "in parallel, one agent",
];

/// Interpreters whose first path-shaped argument is a script the bundle ships.
const INTERPRETERS: &[&str] = &["python", "python3", "node", "bash", "sh", "deno", "ruby"];
const SCRIPT_EXTENSIONS: &[&str] = &[".py", ".sh", ".js", ".mjs", ".ts", ".rb"];

fn names_a_script(lower: &str) -> bool {
    let stripped = lower.trim_start_matches(['-', '*', '>', '#', '`', '$', ' ', '\t', '+']);
    if stripped.starts_with("./") {
        return true;
    }
    let mut tokens = stripped.split_whitespace();
    let Some(first) = tokens.next() else {
        return false;
    };
    // `scripts/foo.py` anywhere on the line, with or without an interpreter in front of it.
    if lower.contains("scripts/")
        && SCRIPT_EXTENSIONS
            .iter()
            .any(|extension| lower.contains(extension))
    {
        return true;
    }
    if first == "npx" {
        return true;
    }
    if first == "uv" {
        return tokens.next() == Some("run");
    }
    if !INTERPRETERS.contains(&first) {
        return false;
    }
    tokens.any(|token| {
        token.contains('/')
            || SCRIPT_EXTENSIONS
                .iter()
                .any(|extension| token.ends_with(extension))
    })
}

/// Directory names a leading `/` makes look like a command when it is really an absolute path.
const PATH_ROOTS: &[&str] = &[
    "usr",
    "etc",
    "opt",
    "var",
    "bin",
    "tmp",
    "home",
    "users",
    "dev",
    "mnt",
    "srv",
    "proc",
    "lib",
    "sbin",
    "root",
    "private",
    "applications",
    "library",
    "system",
    "volumes",
];

/// Words that turn a `/name` into an instruction rather than a mention.
///
/// A skill that says "adapted from the `/gsd-sketch` workflow" is citing its source, not telling
/// the agent to type anything, and treating that as execution-level coupling inlines a skill that
/// did not need it. The brief's rule for this module is to be conservative: a cosmetic mention is
/// not a need.
const COMMAND_VERBS: &[&str] = &[
    "run", "runs", "use", "uses", "using", "invoke", "call", "type", "execute", "start", "then",
    "first", "next", "finish", "rerun", "re-run", "trigger", "issue",
];

fn names_a_slash_command(line: &str) -> bool {
    let body = line.trim_start_matches(['-', '*', '>', '#', '`', ' ', '\t', '+', '1', '2', '.']);
    let mut preceding = String::new();
    for token in line.split(|character: char| character.is_whitespace()) {
        for candidate in token.split(['(', '`', '"', '\'', '[']) {
            let Some(name) = candidate.strip_prefix('/') else {
                continue;
            };
            let name = name.trim_end_matches([')', '`', ',', '.', '"', '\'', ']', ':', ';']);
            if !looks_like_a_command(name) {
                continue;
            }
            // Either the line opens with it — a command header or a usage line — or something
            // earlier on the line tells the agent to run it.
            if body.starts_with(candidate) || body.starts_with(token) {
                return true;
            }
            if preceding
                .split(|character: char| !character.is_ascii_alphanumeric() && character != '-')
                .any(|word| COMMAND_VERBS.contains(&word.to_ascii_lowercase().as_str()))
            {
                return true;
            }
        }
        preceding.push(' ');
        preceding.push_str(token);
    }
    false
}

fn looks_like_a_command(name: &str) -> bool {
    if name.len() < 3 || name.contains('/') || name.contains('.') {
        return false;
    }
    if PATH_ROOTS.contains(&name.to_ascii_lowercase().as_str()) {
        return false;
    }
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '-'
                || character == ':'
        })
}

/// Tool names that are Claude's and no one else's, so naming one at all is the evidence.
const CLAUDE_TOOL_NAMES: &[&str] = &[
    "TodoWrite",
    "AskUserQuestion",
    "ExitPlanMode",
    "NotebookEdit",
    "MultiEdit",
    "SlashCommand",
    "WebFetch",
    "WebSearch",
    "BashOutput",
    "KillShell",
];

/// Tool names that are also ordinary English, so only the "`Read` tool" form counts.
const AMBIGUOUS_TOOL_NAMES: &[&str] = &[
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task", "Skill", "Agent", "Search",
];

fn names_a_claude_tool(line: &str) -> bool {
    if CLAUDE_TOOL_NAMES
        .iter()
        .any(|name| contains_word(line, name))
    {
        return true;
    }
    AMBIGUOUS_TOOL_NAMES.iter().any(|name| {
        line.match_indices(name).any(|(index, _)| {
            is_boundary(line[..index].chars().next_back())
                && line[index + name.len()..]
                    .trim_start_matches(['`', '\'', '"', ')'])
                    .trim_start()
                    .starts_with("tool")
        })
    })
}

const CLAUDE_SURFACES: &[&str] = &[
    "claude.ai",
    "window.claude",
    ".claude/skills",
    ".claude/settings",
    ".claude/plugins",
    ".claude/agents",
    ".claude/commands",
    "claude code",
    "claude.md",
];

fn names_a_claude_surface(lower: &str) -> bool {
    if CLAUDE_SURFACES.iter().any(|name| lower.contains(name)) {
        return true;
    }
    // "Artifact" is only a Claude surface when it is the publishing one. A design artifact, a
    // build artifact and an artifact of a measurement are all ordinary English.
    lower.contains("artifact")
        && ["publish", "render", "html", "react", "inline"]
            .iter()
            .any(|word| lower.contains(word))
}

/// Skill names this line refers to.
///
/// Deliberately narrow: the previous token must be backticked or hyphenated. "the skill" and "this
/// skill" are the overwhelmingly common phrasings and neither names anything, so a rule that
/// accepted a bare preceding word would report a sibling on almost every skill in the corpus.
fn collect_siblings(line: &str, found: &mut Vec<String>) {
    for (index, _) in line.match_indices("skills/") {
        let rest = &line[index + "skills/".len()..];
        let name = rest
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
            })
            .collect::<String>();
        if name.len() >= 3 {
            found.push(name.to_ascii_lowercase());
        }
    }
    let tokens = line.split_whitespace().collect::<Vec<_>>();
    for window in tokens.windows(2) {
        let [candidate, noun] = window else { continue };
        let noun = noun
            .trim_matches(|character: char| !character.is_ascii_alphabetic())
            .to_ascii_lowercase();
        if noun != "skill" && noun != "skills" {
            continue;
        }
        let backticked = candidate.starts_with('`') && candidate.ends_with('`');
        let name = candidate
            .trim_matches(|character: char| {
                !character.is_ascii_alphanumeric() && character != '-' && character != '_'
            })
            .to_ascii_lowercase();
        if name.len() < 3 || (!backticked && !name.contains('-')) {
            continue;
        }
        if name
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_digit())
        {
            continue;
        }
        found.push(name);
    }
}

const ARTIFACT_WORDS: &[&str] = &[
    "file",
    "deck",
    "slide",
    "report",
    "html",
    "pdf",
    "spreadsheet",
    "xlsx",
    "docx",
    "pptx",
    "design",
    "diagram",
    "dashboard",
    "document",
    "chart",
    "poster",
    "artifact",
    "mockup",
    "presentation",
    "visualization",
    "visualisation",
    "image",
    "png",
    "svg",
    "landing",
    "prototype",
];

const BEHAVIOR_WORDS: &[&str] = &[
    "review",
    "standard",
    "rule",
    "style",
    "method",
    "debug",
    "convention",
    "guideline",
    "checklist",
    "workflow",
    "process",
    "practice",
    "principle",
    "audit",
    "critique",
    "how to work",
    "policy",
    "triage",
];

/// Artifact or behaviour, from the description first and the body only if the description is
/// silent. The description is the sentence the skill's author wrote to say what it is for; the
/// body contains both kinds of word in almost every skill, so consulting it first would classify
/// nearly everything the same way.
fn classify(description: &str, body: &str) -> SkillKind {
    for haystack in [description, body] {
        let lower = haystack.to_ascii_lowercase();
        let artifact = ARTIFACT_WORDS.iter().any(|word| lower.contains(word));
        let behavior = BEHAVIOR_WORDS.iter().any(|word| lower.contains(word));
        match (artifact, behavior) {
            (true, false) => return SkillKind::Artifact,
            (false, true) => return SkillKind::Behavior,
            // Both, or neither: the description did not settle it, so fall through to the body.
            _ => {}
        }
    }
    // A coupled skill whose own words settle nothing is treated as behaviour-governing, which
    // routes it `inline`. That is the conservative direction: an unnecessary inline costs prompt
    // characters, while an unnecessary `native` silently drops instructions the agent needed.
    SkillKind::Behavior
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    haystack.match_indices(needle).any(|(index, _)| {
        is_boundary(haystack[..index].chars().next_back())
            && is_boundary(haystack[index + needle.len()..].chars().next())
    })
}

fn is_boundary(character: Option<char>) -> bool {
    character.is_none_or(|character| !character.is_alphanumeric() && character != '_')
}

/// One line, whitespace collapsed, cut to [`EVIDENCE_CHARS`] on a character boundary.
fn quote(line: &str) -> String {
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= EVIDENCE_CHARS {
        return collapsed;
    }
    collapsed
        .chars()
        .take(EVIDENCE_CHARS - 1)
        .chain(std::iter::once('…'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note_for(needs: &[SkillNeed], bus: BusTools) -> String {
        translation_note(&TranslationRequest {
            skill: "claude-design",
            harness: Harness::Codex,
            needs,
            bundle_dir: "/w/.agents/skills/claude-design",
            bus,
            siblings_wired: &[],
            siblings_missing: &[],
        })
    }

    const FULL_BUS: BusTools = BusTools {
        ask: true,
        delegate: true,
        ask_user: true,
    };

    #[test]
    fn frontmatter_is_split_off_and_the_file_is_left_alone() {
        let text = "---\nname: x\ndescription: Design a deck\n---\n\nBody line one.\nBody two.\n";
        let (frontmatter, body) = split_frontmatter(text);
        assert!(frontmatter.contains("description: Design a deck"));
        assert_eq!(body, "Body line one.\nBody two.\n");
        assert_eq!(description(text).as_deref(), Some("Design a deck"));
    }

    #[test]
    fn a_document_without_frontmatter_keeps_all_of_its_text_as_body() {
        let text = "# Heading\n\nNo frontmatter here.\n";
        assert_eq!(split_frontmatter(text), ("", text));
        assert_eq!(description(text), None);
        // An opening `---` that never closes is a horizontal rule, not a manifest.
        let ruled = "---\nstill a body\nwith no closing marker\n";
        assert_eq!(split_frontmatter(ruled), ("", ruled));
    }

    #[test]
    fn a_skill_that_assumes_nothing_is_portable_with_no_needs() {
        let portability = analyse(
            "---\nname: tone\ndescription: Keep replies short\n---\nPrefer short sentences.\nAnswer the question that was asked.\n",
        );
        assert_eq!(portability.needs, Vec::new());
        assert_eq!(portability.kind, SkillKind::Portable);
        assert!(portability.evidence.is_empty());
    }

    #[test]
    fn each_execution_level_need_is_detected_from_the_line_that_proves_it() {
        for (line, expected) in [
            (
                "Use the Task tool to fan out across three reviewers.",
                SkillNeed::Subagents,
            ),
            (
                "Run `python3 scripts/validate.py --strict` first.",
                SkillNeed::Scripts,
            ),
            (
                "Start with /review before touching anything.",
                SkillNeed::SlashCommands,
            ),
            (
                "Track your steps with TodoWrite as you go.",
                SkillNeed::NamedTools,
            ),
        ] {
            let portability = analyse(&format!("---\nname: x\ndescription: d\n---\n{line}\n"));
            assert!(
                portability.needs.contains(&expected),
                "{line} should report {expected:?}, got {:?}",
                portability.needs
            );
            let evidence = portability.evidence_for(expected).expect("evidence");
            assert_eq!(evidence.line, line);
            assert!(expected.is_execution_level());
        }
    }

    #[test]
    fn prose_that_merely_mentions_a_harness_is_not_execution_coupling() {
        // Each of these was a false positive in an earlier rule: a bare English word, an absolute
        // path read as a command, and the word "artifact" in its ordinary sense.
        for line in [
            "Read the brief before you write anything.",
            "Write the summary, then edit it down.",
            "Configuration lives under /usr/local/etc on this machine.",
            "Measurement artifacts are expected at this sample size.",
            "Consider the skill of the reader.",
        ] {
            let portability = analyse(&format!("---\nname: x\ndescription: d\n---\n{line}\n"));
            assert!(
                !portability.has_execution_coupling(),
                "{line} must not be execution-level, got {:?}",
                portability.needs
            );
        }
    }

    #[test]
    fn claude_surface_and_sibling_skills_are_advisory_not_execution_level() {
        let portability = analyse(
            "---\nname: x\ndescription: Publish a report\n---\nPublish the HTML as an Artifact on claude.ai.\nCombine with the `design-md` skill when tokens matter.\n",
        );
        assert!(portability.needs.contains(&SkillNeed::ClaudeSurface));
        assert!(portability.needs.contains(&SkillNeed::SiblingSkills));
        assert!(!portability.has_execution_coupling());
        assert_eq!(portability.siblings, vec!["design-md".to_owned()]);
    }

    #[test]
    fn evidence_is_one_collapsed_line_within_the_cap() {
        let long = format!("Use the Task tool {}", "and then again ".repeat(30));
        let portability = analyse(&format!("---\nname: x\ndescription: d\n---\n{long}\n"));
        let evidence = portability
            .evidence_for(SkillNeed::Subagents)
            .expect("evidence");
        assert_eq!(evidence.line.chars().count(), EVIDENCE_CHARS);
        assert!(evidence.line.ends_with('…'));
        assert!(!evidence.line.contains('\n'));
    }

    #[test]
    fn an_artifact_skill_and_a_behaviour_skill_are_told_apart_by_their_description() {
        let artifact = analyse(
            "---\nname: a\ndescription: Design one-off HTML decks and posters.\n---\nUse the Task tool.\n",
        );
        assert_eq!(artifact.kind, SkillKind::Artifact);
        let behaviour = analyse(
            "---\nname: b\ndescription: Our code review standard and its rules.\n---\nUse the Task tool.\n",
        );
        assert_eq!(behaviour.kind, SkillKind::Behavior);
    }

    #[test]
    fn a_harness_with_no_skill_directory_gets_every_skill_inline() {
        let portable = analyse("---\nname: x\ndescription: d\n---\nNothing special.\n");
        for harness in [Harness::Hermes, Harness::Other] {
            assert_eq!(route(&portable, harness), SkillRoute::Inline);
        }
        let note = translation_note(&TranslationRequest {
            skill: "x",
            harness: Harness::Hermes,
            needs: &portable.needs,
            bundle_dir: ".agents/skills/x",
            bus: bus_tools(Harness::Hermes, BusMode::None, false),
            siblings_wired: &[],
            siblings_missing: &[],
        });
        assert!(
            note.starts_with("You are running on Hermes, which does not load skills"),
            "{note}"
        );
        assert!(
            !note.contains("written for Claude Code"),
            "a portable skill makes no such claim: {note}"
        );
    }

    #[test]
    fn a_multi_line_description_is_read_whole() {
        for frontmatter in [
            "name: x\ndescription: >-\n  Turns notes\n  into slides.\nlicense: MIT",
            "name: x\ndescription: |\n  Turns notes\n\n  into slides.\n",
            "name: x\ndescription: Turns notes\n  into slides.\n",
            "name: x\ndescription: \"Turns notes into slides.\"\n",
        ] {
            assert_eq!(
                frontmatter_field(frontmatter, "description").as_deref(),
                Some("Turns notes into slides."),
                "{frontmatter}"
            );
        }
        assert_eq!(
            frontmatter_field("metadata:\n  name: nested\n", "name"),
            None
        );
        assert_eq!(
            frontmatter_field("description: >-\nname: x\n", "description"),
            None
        );
    }

    #[test]
    fn a_coupled_skill_is_inline_off_claude_and_native_on_it() {
        let coupled = analyse(
            "---\nname: x\ndescription: Design a deck\n---\nUse the Task tool to fan out.\n",
        );
        assert_eq!(route(&coupled, Harness::Codex), SkillRoute::Inline);
        assert_eq!(route(&coupled, Harness::Gemini), SkillRoute::Inline);
        assert_eq!(route(&coupled, Harness::Claude), SkillRoute::Native);
    }

    #[test]
    fn a_behaviour_governing_skill_is_inline_off_claude_even_without_execution_coupling() {
        let behaviour = analyse(
            "---\nname: x\ndescription: The review standard every change is held to.\n---\nSee `house-style` skill.\n",
        );
        assert!(!behaviour.has_execution_coupling());
        assert_eq!(behaviour.kind, SkillKind::Behavior);
        assert_eq!(route(&behaviour, Harness::Codex), SkillRoute::Inline);
    }

    #[test]
    fn an_uncoupled_skill_is_native_everywhere_it_can_be_delivered() {
        let portable = analyse("---\nname: x\ndescription: d\n---\nAnswer briefly.\n");
        for harness in [
            Harness::Claude,
            Harness::Codex,
            Harness::Gemini,
            Harness::OpenCode,
            Harness::OpenClaw,
            Harness::Pi,
        ] {
            assert_eq!(route(&portable, harness), SkillRoute::Native, "{harness:?}");
        }
    }

    #[test]
    fn team_mode_offers_every_delegation_tool_and_pipeline_mode_withdraws_two() {
        let team = bus_tools(Harness::Codex, BusMode::Team, false);
        assert_eq!(
            team,
            BusTools {
                ask: true,
                delegate: true,
                ask_user: true
            },
            "team mode offers ask even to an agent that may not recruit",
        );
        let recruiting = bus_tools(Harness::Codex, BusMode::Pipeline, true);
        assert!(recruiting.ask && !recruiting.delegate && recruiting.ask_user);
        let restricted = bus_tools(Harness::Codex, BusMode::Pipeline, false);
        assert!(!restricted.ask && !restricted.delegate && restricted.ask_user);
    }

    #[test]
    fn a_harness_without_http_mcp_is_promised_no_bus_tools_at_all() {
        // OpenClaw is ACP-verified with `loadSession`, and has no HTTP MCP
        // (`docs/ARCHITECTURE.md`), so the run archives `team_bus_unavailable` for it.
        let openclaw = bus_tools(Harness::OpenClaw, BusMode::Team, true);
        assert_eq!(
            openclaw,
            BusTools {
                ask: false,
                delegate: false,
                ask_user: false
            }
        );
        assert!(!openclaw.reachable());
        assert_eq!(
            bus_tools(Harness::Codex, BusMode::None, true),
            BusTools {
                ask: false,
                delegate: false,
                ask_user: false
            }
        );
    }

    #[test]
    fn the_note_names_ask_only_when_this_agent_may_actually_call_it() {
        let allowed = note_for(
            &[SkillNeed::Subagents],
            bus_tools(Harness::Codex, BusMode::Pipeline, true),
        );
        assert!(allowed.contains("`ask`"), "{allowed}");
        assert!(
            !allowed.contains("`dispatch`"),
            "pipeline mode has no dispatch: {allowed}"
        );

        let refused = note_for(
            &[SkillNeed::Subagents],
            bus_tools(Harness::Codex, BusMode::Pipeline, false),
        );
        assert!(
            !refused.contains("`ask`"),
            "an agent that may not recruit must not be told to call ask: {refused}"
        );
        assert!(refused.contains("do the steps yourself"), "{refused}");

        let busless = note_for(
            &[SkillNeed::Subagents],
            bus_tools(Harness::OpenClaw, BusMode::Team, true),
        );
        assert!(busless.contains("no way to delegate"), "{busless}");
        assert!(!busless.contains("`ask`"), "{busless}");
    }

    #[test]
    fn the_note_tells_the_truth_about_bundled_scripts() {
        let note = note_for(&[SkillNeed::Scripts], FULL_BUS);
        assert!(note.contains("/w/.agents/skills/claude-design"), "{note}");
        assert!(
            note.contains("refuses every permission request"),
            "the note must not promise a script will run: {note}"
        );
        assert!(note.contains("do that step by hand and say so"), "{note}");
    }

    #[test]
    fn the_note_maps_named_tools_and_routes_the_operator_question_to_the_bus() {
        let note = note_for(&[SkillNeed::NamedTools], FULL_BUS);
        assert!(note.contains("your own file-reading"), "{note}");
        assert!(note.contains("`ask_user`"), "{note}");
        let busless = note_for(
            &[SkillNeed::NamedTools],
            bus_tools(Harness::OpenClaw, BusMode::Team, true),
        );
        assert!(!busless.contains("`ask_user`"), "{busless}");
        assert!(
            busless.contains("state the question in your reply"),
            "{busless}"
        );
    }

    #[test]
    fn the_note_names_which_referenced_skills_are_connected_and_which_are_not() {
        let wired = ["design-md".to_owned()];
        let missing = ["sketch".to_owned()];
        let note = translation_note(&TranslationRequest {
            skill: "claude-design",
            harness: Harness::Codex,
            needs: &[SkillNeed::SiblingSkills],
            bundle_dir: "/w/.agents/skills/claude-design",
            bus: FULL_BUS,
            siblings_wired: &wired,
            siblings_missing: &missing,
        });
        assert!(note.contains("connected to you: design-md"), "{note}");
        assert!(note.contains("not connected: sketch"), "{note}");
    }

    #[test]
    fn every_need_gets_a_mapping_and_the_note_stays_short() {
        let note = note_for(&SkillNeed::ALL, FULL_BUS);
        let lines = note
            .lines()
            .filter(|line| line.starts_with("- "))
            .collect::<Vec<_>>();
        assert_eq!(
            lines.len(),
            SkillNeed::ALL.len(),
            "one mapping line per need, no more: {note}"
        );
        let lowered = note.to_ascii_lowercase();
        for need in SkillNeed::ALL {
            assert!(
                lowered.contains(&need.label().to_ascii_lowercase()),
                "{need:?} has no mapping line: {note}"
            );
        }
        // A note for one need carries one line: the generator maps what was detected, not
        // everything it knows how to map.
        assert_eq!(
            note_for(&[SkillNeed::Scripts], FULL_BUS)
                .lines()
                .filter(|line| line.starts_with("- "))
                .count(),
            1,
        );
        assert!(note.ends_with(SELF_REPORT_REQUEST), "{note}");
        assert!(
            note.chars().count() <= 1_800,
            "the note is a mapping, not a rewrite: {} chars",
            note.chars().count()
        );
    }

    #[test]
    fn slash_commands_and_scripts_survive_the_markdown_they_are_written_in() {
        for line in [
            "- `npx tsx scripts/check.ts`",
            "1. python3 scripts/build.py",
            "> Run ./scripts/setup.sh once.",
            "* uv run report.py",
        ] {
            assert!(matches(SkillNeed::Scripts, line), "{line}");
        }
        for line in [
            "Run `/review` on the diff.",
            "Then /deploy-staging.",
            "# /code-review",
            "/competitive-brief $ARGUMENTS",
            "- Use /init to start.",
        ] {
            assert!(matches(SkillNeed::SlashCommands, line), "{line}");
        }
        // A citation is not an instruction. Each of these named a real command and told the agent
        // to do nothing with it; counting them inlined skills that had no need of it.
        for line in [
            "Adapted from the GSD project's `/gsd-sketch` workflow — MIT © 2025.",
            "Ported from the /old-thing plugin.",
            "Artifacts live under /projects/<projectId>/assets.",
        ] {
            assert!(!matches(SkillNeed::SlashCommands, line), "{line}");
        }
    }
}
