use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Local, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Deserialize;

/// What [`is_identifier`] requires, worded to follow an id in an error message.
const IDENTIFIER_RULE: &str = "must start with a letter or digit and use only letters, digits, \
     '.', '_' and '-' (at most 128 characters)";

/// The team schema's `Identifier` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, at most 128 characters).
///
/// Such an id is one plain folder name: it cannot be empty, `.` or `..`, or contain a separator.
#[must_use]
pub fn is_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    value.len() <= 128
        && characters
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

/// Runtime-relevant fields from a version-1 team configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub schema_version: u64,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub entrypoint: String,
    /// Agent whose reply becomes the canonical output. Absent preserves the original inference:
    /// the entrypoint in team mode and the last topological stage in pipeline mode.
    #[serde(default)]
    pub responder: Option<String>,
    #[serde(default)]
    pub guards: GuardsConfig,
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub edges: Vec<EdgeConfig>,
    /// Optional routine: run this team on a cron schedule with a fixed prompt and deliver
    /// the canonical reply (see `docs/decisions/0010-routines-and-notion-delivery.md`).
    #[serde(default)]
    pub schedule: Option<ScheduleConfig>,
    /// Where every successful run's canonical reply goes, whoever started it (see
    /// `docs/decisions/0038-send-the-team-response-to-notion.md`). A routine prefers its own
    /// `schedule.deliver`.
    #[serde(default)]
    pub deliver: Option<DeliverConfig>,
    /// How much a stage pushes to the next one, and how much it may pull back.
    #[serde(default)]
    pub conversation: ConversationConfig,
    /// What the team knows before a run starts, and how it reaches an agent.
    ///
    /// `None` — the block is absent — is the only default, and it keeps every prompt
    /// byte-for-byte what it was before memory existed. See `docs/TEAM_MEMORY.md`.
    #[serde(default)]
    pub memory: Option<MemoryConfig>,
    /// How the agents' permission requests are answered beyond their own `allow:` switches
    /// (ADR 0061). Absent asks the operator, as before Auto mode existed.
    #[serde(default)]
    pub permissions: TeamPermissions,
    /// What one run may spend (ADR 0068). Absent: no limit, though spend is still counted.
    #[serde(default)]
    pub spend: crate::spend::SpendConfig,
}

/// The `permissions:` block (ADR 0061).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TeamPermissions {
    pub mode: PermissionMode,
}

/// Who decides a command an agent's switches leave open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// The operator, during the run (ADR 0040).
    #[default]
    Ask,
    /// Commands that only read or download run without asking; the rest still ask the operator.
    Auto,
}

/// The `memory:` block: the Brief, its budget, and how it is delivered.
///
/// This is executable configuration in ADR 0012's sense — it changes what the daemon sends to a
/// harness — so it lives in the team file rather than the layout sidecar, as a sibling of
/// `conversation`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryConfig {
    /// An explicit off switch, so an operator can stop supplying memory without deleting the
    /// block they spent time writing. `false` is byte-identical to no block at all.
    pub enabled: bool,
    /// Markdown files beside the team YAML, in the order they are supplied.
    pub brief: Vec<BriefEntryConfig>,
    /// Other teams' memory this team reads. Read-only by construction: no token issued for this
    /// team carries a write grant for an inherited scope.
    pub inherits: Vec<InheritConfig>,
    pub notebook: NotebookConfig,
    pub packet: PacketConfig,
    pub deliver_as: DeliverAs,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            brief: Vec::new(),
            inherits: Vec::new(),
            notebook: NotebookConfig::default(),
            packet: PacketConfig::default(),
            deliver_as: DeliverAs::default(),
        }
    }
}

/// Whether agents may write to the Notebook, and what may outlive a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotebookConfig {
    /// Whether the four memory tools are offered on the Team Bus at all. `false` withdraws them
    /// from `tools/list` *and* refuses a call, so a harness that cached the list cannot write.
    pub enabled: bool,
    pub keep: KeepPolicy,
}

impl Default for NotebookConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            keep: KeepPolicy::default(),
        }
    }
}

/// How a note outlives its run.
///
/// `auto` is deliberately absent (decision 3): a run's notes becoming the team's standing memory
/// without anyone reading them is how a team accumulates confident nonsense.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeepPolicy {
    /// The operator reviews a finished run's notes and keeps what is worth keeping.
    #[default]
    Review,
    /// Nothing is ever kept: notes are evidence for their own run and nothing else.
    Never,
}

/// One inherited memory: another team on this daemon, or a pack imported under the teams root.
///
/// Exactly one of `team` and `pack` is set, which the loader enforces — a schema `oneOf` states
/// it, and the loader refuses the invalid combinations rather than picking one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritConfig {
    /// The `id` of another team under the same teams root.
    #[serde(default)]
    pub team: Option<String>,
    /// A `<team>.memory/` folder under the teams root, exported by [`crate::memory::Pack`].
    #[serde(default)]
    pub pack: Option<PathBuf>,
    /// What to take. Defaults to both.
    #[serde(default)]
    pub include: Option<Vec<InheritInclude>>,
    /// Agents this inherited memory reaches. Absent means the whole team.
    #[serde(default)]
    pub applies_to: Option<Vec<String>>,
    /// Inherited Brief entries to leave out, by the path the origin team spells them with. This is
    /// what the panel's "Exclude" writes — the receiving team cannot edit another team's Brief, so
    /// declining one entry is the only control it gets.
    #[serde(default)]
    pub exclude: Option<Vec<String>>,
}

impl InheritConfig {
    /// Whether this entry contributes Brief entries.
    #[must_use]
    pub fn includes_brief(&self) -> bool {
        self.include.as_ref().is_none_or(|include| {
            include
                .iter()
                .any(|part| matches!(part, InheritInclude::Brief | InheritInclude::Both))
        })
    }

    /// Whether this entry contributes kept Notebook entries.
    #[must_use]
    pub fn includes_kept(&self) -> bool {
        self.include.as_ref().is_none_or(|include| {
            include
                .iter()
                .any(|part| matches!(part, InheritInclude::Kept | InheritInclude::Both))
        })
    }

    /// Whether this inherited memory reaches `agent_id`.
    #[must_use]
    pub fn applies(&self, agent_id: &str) -> bool {
        self.applies_to
            .as_ref()
            .is_none_or(|agents| agents.iter().any(|id| id == agent_id))
    }
}

/// Which half of another team's memory to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InheritInclude {
    Brief,
    Kept,
    Both,
}

/// One Brief file and who it applies to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefEntryConfig {
    /// Relative to the team file. Read only from under the teams root, symlinks included.
    pub path: PathBuf,
    /// Agents this entry is supplied to. Absent means every agent.
    #[serde(default)]
    pub applies_to: Option<Vec<String>>,
}

/// Memory's share of an opening prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PacketConfig {
    /// Characters, not tokens: adapters do not report live context occupancy, so a character
    /// budget is the only figure `LoomWatch` can state honestly (and it matches
    /// `conversation.brief.summaryChars`).
    pub max_chars: u32,
}

impl Default for PacketConfig {
    fn default() -> Self {
        Self { max_chars: 8000 }
    }
}

/// How the Brief is delivered to a harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliverAs {
    /// Write the Brief as the harness's own project memory file in a managed workspace, *and*
    /// render it into the packet. The file is the one channel a harness-side compaction cannot
    /// reach, which is why it is the default (decision 2).
    #[default]
    NativeFile,
    /// Packet only: the agent keeps its declared `cwd`, so nothing is written beside its code and
    /// the Brief does not survive a compaction.
    PacketOnly,
}

/// Per-agent memory overrides. Both fields exist because an agent that must run inside a
/// repository cannot be moved into a managed workspace, and an agent whose job is unrelated to
/// the team's standing notes should not pay for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentMemoryConfig {
    /// Whether this agent is supplied the Brief at all.
    pub brief: bool,
    /// Overrides the team's `deliverAs` for this agent only.
    pub deliver_as: Option<DeliverAs>,
}

impl Default for AgentMemoryConfig {
    fn default() -> Self {
        Self {
            brief: true,
            deliver_as: None,
        }
    }
}

/// The token/quality dial for pipeline handovers.
///
/// Push everything and the receiving stage pays for a transcript it mostly does not need; push a
/// summary alone and it cannot recover what was cut. These bounds set how much is pushed, and the
/// live `ask` channel covers the rest on demand.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConversationConfig {
    pub brief: BriefConfig,
    pub ask: AskConfig,
    pub check: CheckConfig,
    /// Bounds on a review stop or a parked `ask_user`, kept so older team files still load.
    pub stop: StopConfig,
}

/// Bounds on a review stop or a parked `ask_user`. Kept so older team files still load, and read
/// by nothing: an agent waiting for the operator is parked in the database with nothing running,
/// so no window applies to it (`docs/TEAM_CONFIG.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StopConfig {
    /// Minutes a third-party app's session could idle before it was checkpointed and let go.
    /// Accepted, and no longer limits a wait.
    pub keep_alive_minutes: u32,
}

impl Default for StopConfig {
    fn default() -> Self {
        // The default the schema documents.
        Self {
            keep_alive_minutes: 15,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BriefConfig {
    /// Character budget for the brief's summary section.
    pub summary_chars: u32,
    /// How many standalone findings a stage may carry forward.
    pub max_findings: u32,
    /// The longest reply, in characters, handed to the stages after it as written. A longer one is
    /// summarised in a handover turn first. Shared between the stages that feed one stage, and
    /// never more than the prompt's section cap (`SECTION_CAP_CHARS`), which would cut it anyway.
    pub as_written_up_to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AskConfig {
    /// How many questions one agent may put to another in a run. Clarifying what the other asked
    /// back continues a question, so it is not counted (`rounds_per_question` bounds that).
    pub max_per_stage: u32,
    /// The most of one answer, in characters, the asker is handed. A longer one is cut in the
    /// middle, keeping its start and its conclusion.
    pub reply_chars: u32,
    /// How many times an asked agent may ask back about one question before it must answer with
    /// its best assumption. The asker's clarifications continue the question, so they are not
    /// counted against `max_per_stage`.
    pub rounds_per_question: u32,
}

impl Default for BriefConfig {
    fn default() -> Self {
        // Roughly 300 tokens of summary plus eight findings: enough for a stage to start work
        // without the transcript, small enough that a long pipeline does not accumulate one.
        // Replies up to the prompt's section cap go on as written: a handover re-reads the
        // stage's whole conversation to save the next stage a few thousand tokens, and loses the
        // links and dates the next stage needs.
        Self {
            summary_chars: 1200,
            max_findings: 8,
            as_written_up_to: 24_000,
        }
    }
}

/// What a check step is shown besides the work it checks (ADR 0062).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckConfig {
    /// The most of what the checked agent was given that its check step is shown, in characters:
    /// what lets it trace a claim without opening the claim's source. 0 shows none of it.
    pub given_chars: u32,
}

impl Default for CheckConfig {
    fn default() -> Self {
        // About 2,000 tokens: a research handover's findings and its sources, whole, in most runs.
        Self { given_chars: 8_000 }
    }
}

impl Default for AskConfig {
    fn default() -> Self {
        // Three is enough to recover what a brief cut, and few enough that a stage cannot turn the
        // predecessor into a search engine. An answer stays under the 24,000 characters at which
        // LoomWatch's own engine sets a tool result aside and shows only its start.
        // Three rounds: enough to settle what was unclear about one question, and an end the
        // asked agent knows about, so the last round is an answer with its assumption named.
        Self {
            max_per_stage: 3,
            reply_chars: 20_000,
            rounds_per_question: 3,
        }
    }
}

/// The `schedule` block of a team file.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfig {
    /// Standard 5-field cron (minute resolution, `0` or `7` = Sunday), or the `cron`
    /// crate's 6/7-field seconds form (`1` = Sunday).
    pub cron: String,
    /// IANA zone the cron fields are read in; the daemon's local zone when absent.
    #[serde(default)]
    pub timezone: Option<String>,
    /// Prompt template; `{{date}}`, `{{weekday}}` and `{{team}}` expand at fire time.
    pub prompt: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub deliver: Option<DeliverConfig>,
}

/// Where a run's canonical reply goes once the run succeeds: a routine's (`schedule.deliver`)
/// or every run's (the top-level `deliver`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverConfig {
    #[serde(default)]
    pub notion: Option<NotionDeliverConfig>,
}

impl DeliverConfig {
    /// The Notion title template, or `default` when the block names none; `None` when this
    /// block does not deliver to Notion.
    #[must_use]
    pub fn notion_title<'a>(&'a self, default: &'a str) -> Option<&'a str> {
        self.notion
            .as_ref()
            .map(|notion| notion.title.as_deref().unwrap_or(default))
    }
}

/// Notion delivery: a child page of the connected destination, titled from a template.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDeliverConfig {
    /// Page title template; defaults to [`DEFAULT_NOTION_TITLE`].
    #[serde(default)]
    pub title: Option<String>,
}

/// Title a routine's delivered page gets when the team file names none. One page a day: the
/// duplicate-title guard turns a second fire on the same date into `skipped`.
pub const DEFAULT_NOTION_TITLE: &str = "{{team}} — {{date}}";

/// Title every run's delivered page gets (the top-level `deliver`) when the team file names
/// none. It carries the minute, because a person running a team twice in a day means two
/// answers, not a duplicate.
pub const DEFAULT_RUN_NOTION_TITLE: &str = "{{team}} — {{date}} {{time}}";

/// What kind of node an `agents[]` entry is.
///
/// `operator` is the person at the keyboard standing in the pipeline (`docs/TEAM_MEMORY.md`, "The
/// operator is a node"): it has an id, it sits on edges, it takes part in the topological order,
/// and instead of a model it has a **question** — its `role` — which is what the panel shows
/// when the pipeline reaches it. `spawn` and `model` are absent for this kind, because there is
/// no folder to work in and no model to select.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    /// An agent `LoomWatch` runs on a model. The default, and what every team file written before
    /// Canvas C is.
    #[default]
    Harness,
    /// A review stop: the operator as a stage.
    Operator,
}

/// The name an operator node takes when its entry does not spell one.
pub const OPERATOR_NODE_NAME: &str = "You";

/// The id an operator answer is archived under when the team file has **no** operator node — an
/// `ask_user` from a team-mode run, or from a pipeline with no designed stop.
///
/// `RunEvent.agentId` otherwise names an agent in the team document (`docs/TEAM_CONFIG.md`); this is
/// the one reserved id beside it, because the operator's own words have to be archived somewhere
/// and inventing an agent to hold them would be worse.
pub const RESERVED_OPERATOR_ID: &str = "operator";

/// What an agent may do without asking (ADR 0037). `LoomWatch` cannot ask the operator in the
/// middle of a run, so it answers every permission request an app makes itself, and approves only
/// what is switched on here. Everything defaults to off, and absent means all off.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AgentAllow {
    /// Search the web and read web pages.
    pub web: bool,
    /// Create and change files inside the agent's own working folder.
    pub edits: bool,
    /// Run commands in a terminal.
    pub commands: bool,
}

impl AgentAllow {
    /// Nothing is switched on.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        !self.web && !self.edits && !self.commands
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "RawAgent")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub role: String,
    /// `harness` unless the entry says otherwise. See [`AgentKind`].
    pub kind: AgentKind,
    /// Where the agent works. The team file's own folder when the entry names none, and always for
    /// an operator node, which works nowhere.
    pub spawn: SpawnConfig,
    pub model: String,
    pub thinking_effort: Option<String>,
    pub allow_recruiting: bool,
    pub capabilities: Vec<CapabilityRef>,
    /// Per-agent memory overrides; the team's `memory:` block applies when absent.
    pub memory: Option<AgentMemoryConfig>,
    /// What this agent may do without asking. All off for an operator node, which runs no app.
    pub allow: AgentAllow,
    /// Skills and tools the operator turned off for this agent (ADR 0060): its app would otherwise
    /// load them itself. Empty for an operator node.
    pub turned_off: Vec<TurnedOff>,
    /// What the finished result must satisfy (ADR 0062), trimmed, blanks dropped. Rendered under
    /// the role as `## Done when`. Empty for an operator node and for most hand-written agents.
    pub done_when: Vec<String>,
    /// Set on a check step (ADR 0062): the agent whose work this one checks, its direct
    /// predecessor. It is handed that agent's work as written and its Done when, and when it is the
    /// last stage the checked agent's reply stays the team's answer.
    pub checks: Option<String>,
    /// A check step may send the work back once when a check is not met: the findings go to the
    /// checked agent's still-open session, and the checks run once more. Off unless set.
    pub send_back_once: bool,
    /// The agent's own guard on what one run may spend on it (ADR 0068). No guard unless set.
    pub spend: crate::spend::SpendConfig,
}

/// At most this many `doneWhen` items, each at most [`DONE_WHEN_CHARS`] characters: the schema's
/// limits, enforced where the file is read too, so a hand-edited file cannot hand an agent a
/// requirements document. Agents follow every requirement they are given, needed or not.
pub const DONE_WHEN_ITEMS: usize = 5;
pub const DONE_WHEN_CHARS: usize = 160;

/// A skill or tool an agent's app has of its own that the operator turned off for the agent by
/// taking it off the canvas (ADR 0060). Everything else the app has stays the agent's to choose.
/// Something `LoomWatch` gives the agent is never turned off by this: the canvas wins.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnedOff {
    /// `skill` or `tool`. Knowledge is only ever what `LoomWatch` gives, so it has nothing to turn
    /// off.
    pub kind: CapabilityKind,
    /// A skill's name, or a tool's MCP server name as the app lists it (`claude.ai Notion`).
    pub name: String,
}

/// The wire shape of one `agents[]` entry, before the per-kind rules are applied.
///
/// A separate type rather than `#[serde(default)]` on [`AgentConfig`]'s own fields, because the
/// rules are *conditional*: a harness agent that omits `model` is a broken team file and must say
/// so, while an operator node that omits it is correct. Defaulting the fields silently would turn
/// the first case into a run that spawns `""`, and `Option` everywhere would push the same check
/// out to twenty call sites. `try_from` keeps it in one place and reports through serde, so a bad
/// entry is a parse error with the agent's id in it — which is what `PUT /api/team` shows as a 422.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgent {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    kind: AgentKind,
    #[serde(default)]
    spawn: Option<SpawnConfig>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    thinking_effort: Option<String>,
    #[serde(default = "default_allow_recruiting")]
    allow_recruiting: bool,
    #[serde(default)]
    capabilities: Vec<CapabilityRef>,
    #[serde(default)]
    memory: Option<AgentMemoryConfig>,
    #[serde(default)]
    allow: Option<AgentAllow>,
    #[serde(default)]
    turned_off: Vec<TurnedOff>,
    #[serde(default)]
    done_when: Vec<String>,
    #[serde(default)]
    checks: Option<String>,
    #[serde(default)]
    send_back_once: bool,
    #[serde(default)]
    spend: Option<crate::spend::SpendConfig>,
    /// Runtime annotation. Accepted and discarded: writers must not persist it and readers must
    /// ignore it (`docs/TEAM_CONFIG.md`).
    #[serde(default, rename = "status")]
    _status: Option<String>,
}

impl TryFrom<RawAgent> for AgentConfig {
    type Error = String;

    fn try_from(raw: RawAgent) -> Result<Self, Self::Error> {
        let id = raw.id;
        match raw.kind {
            AgentKind::Operator => {
                // An operator node with a harness attached is a contradiction, not a shorthand:
                // ignoring the field would make the file say something the daemon does not do.
                for (field, present) in [
                    ("spawn", raw.spawn.is_some()),
                    ("model", raw.model.is_some()),
                    ("allow", raw.allow.is_some()),
                    ("turnedOff", !raw.turned_off.is_empty()),
                    ("doneWhen", !raw.done_when.is_empty()),
                    ("checks", raw.checks.is_some()),
                    ("sendBackOnce", raw.send_back_once),
                    ("spend", raw.spend.is_some()),
                ] {
                    if present {
                        return Err(format!(
                            "agent {id:?} is `kind: operator`, so it has no {field}: the stop is \
                             answered by the person at the keyboard and spawns nothing. Remove \
                             {field}, or drop `kind: operator` to make it a harness agent."
                        ));
                    }
                }
                let role = raw.role.unwrap_or_default();
                if role.trim().is_empty() {
                    return Err(format!(
                        "operator node {id:?} needs a `role`: it is the question the person at the \
                         keyboard is shown when the pipeline reaches this stop."
                    ));
                }
                Ok(Self {
                    id,
                    // "`name` defaults to \"You\"" — the node is the operator, and every card in
                    // the design reads "You · <name>".
                    name: raw
                        .name
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or_else(|| OPERATOR_NODE_NAME.to_owned()),
                    role,
                    kind: AgentKind::Operator,
                    spawn: SpawnConfig::default(),
                    model: String::new(),
                    thinking_effort: None,
                    allow_recruiting: false,
                    capabilities: raw.capabilities,
                    memory: raw.memory,
                    allow: AgentAllow::default(),
                    turned_off: Vec::new(),
                    done_when: Vec::new(),
                    checks: None,
                    send_back_once: false,
                    spend: crate::spend::SpendConfig::default(),
                })
            }
            AgentKind::Harness => {
                let spawn = raw.spawn.unwrap_or_default();
                let model = raw.model.ok_or_else(|| {
                    format!("agent {id:?} is missing `model`, the model it runs on.")
                })?;
                for entry in &raw.turned_off {
                    check_turned_off(&id, entry)?;
                }
                let done_when = done_when(&id, raw.done_when)?;
                Ok(Self {
                    id,
                    name: raw.name.unwrap_or_default(),
                    role: raw.role.unwrap_or_default(),
                    kind: AgentKind::Harness,
                    spawn,
                    model,
                    thinking_effort: raw.thinking_effort,
                    allow_recruiting: raw.allow_recruiting,
                    capabilities: raw.capabilities,
                    memory: raw.memory,
                    allow: raw.allow.unwrap_or_default(),
                    turned_off: raw.turned_off,
                    done_when,
                    checks: raw
                        .checks
                        .map(|checked| checked.trim().to_owned())
                        .filter(|checked| !checked.is_empty()),
                    send_back_once: raw.send_back_once,
                    spend: raw.spend.unwrap_or_default(),
                })
            }
        }
    }
}

/// `doneWhen` as the prompt will state it: each item trimmed, blank ones dropped, within the
/// schema's limits.
fn done_when(id: &str, items: Vec<String>) -> Result<Vec<String>, String> {
    let items: Vec<String> = items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect();
    if items.len() > DONE_WHEN_ITEMS {
        return Err(format!(
            "agent {id:?} has {} `doneWhen` items; keep it to {DONE_WHEN_ITEMS}, the ones the \
             result must meet.",
            items.len()
        ));
    }
    if let Some(long) = items
        .iter()
        .find(|item| item.chars().count() > DONE_WHEN_CHARS)
    {
        return Err(format!(
            "agent {id:?} has a `doneWhen` item longer than {DONE_WHEN_CHARS} characters: {long:?}. \
             Say it in one short sentence."
        ));
    }
    Ok(items)
}

/// A turned-off entry names a skill or a tool, and never the Team Bus, which is how a team hands
/// work on.
fn check_turned_off(id: &str, entry: &TurnedOff) -> Result<(), String> {
    if entry.kind == CapabilityKind::Knowledge {
        return Err(format!(
            "agent {id:?} turns off knowledge {:?}: only skills and tools can be turned off. Take \
             the folder, file or page off the canvas instead.",
            entry.name
        ));
    }
    if entry.name.trim().is_empty() {
        return Err(format!(
            "agent {id:?} turns off a {} with no name.",
            entry.kind.as_str()
        ));
    }
    if entry.name == crate::delivery::RESERVED_SERVER {
        return Err(format!(
            "agent {id:?} turns off {:?}, the Team Bus, which is how a team hands work on.",
            entry.name
        ));
    }
    Ok(())
}

/// A capability the operator wired to an agent on the canvas. Naming one grants nothing on its
/// own (TNG122 §8 item 4): the daemon materialises it into the agent's workspace and the harness
/// still authorises every use.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRef {
    pub kind: CapabilityKind,
    pub name: String,
    /// A folder or file the operator chose, for `knowledge` only (ADR 0035). `name` is then only
    /// its label. A relative path resolves against the team file's directory, which is where an
    /// added file is copied to. Knowledge without a path fails the run with what to do instead:
    /// the Library no longer lists folders a name could point at (ADR 0036).
    #[serde(default)]
    pub path: Option<PathBuf>,
    /// A Notion page the operator chose, for `knowledge` only and instead of `path` (ADR 0050).
    /// `name` is then the page's title as it was when chosen.
    #[serde(default)]
    pub notion: Option<NotionRef>,
    /// Calls of a connected tool the operator always allows this agent to make without asking
    /// (ADR 0069), by the tool's own name for each: `create_issue`. For `tool` only; every other
    /// call of the tool asks first.
    #[serde(default)]
    pub always_allow: Vec<String>,
}

/// The most calls of one tool an agent may always be allowed.
const MAX_ALWAYS_ALLOWED: usize = 200;

impl CapabilityRef {
    /// Where a path or a Notion page may appear, and that a Notion page is named by its id.
    fn validate(&self) -> Result<(), String> {
        let (name, kind) = (&self.name, self.kind.as_str());
        if !self.always_allow.is_empty() {
            if self.kind != CapabilityKind::Tool {
                return Err(format!(
                    "{name} is a {kind} with `alwaysAllow`, but only a tool's actions can be always allowed"
                ));
            }
            if self.always_allow.len() > MAX_ALWAYS_ALLOWED {
                return Err(format!(
                    "{name} always allows {} actions; keep it to {MAX_ALWAYS_ALLOWED}",
                    self.always_allow.len()
                ));
            }
            if let Some(bad) = self
                .always_allow
                .iter()
                .find(|call| call.trim().is_empty() || call.chars().count() > 128)
            {
                return Err(format!(
                    "{name} always allows {bad:?}, which isn't the name of an action"
                ));
            }
        }
        if self.path.is_some() && self.kind != CapabilityKind::Knowledge {
            return Err(format!(
                "{name} is a {kind} with a path, but only knowledge can be read from a path"
            ));
        }
        let Some(notion) = &self.notion else {
            return Ok(());
        };
        if self.kind != CapabilityKind::Knowledge {
            return Err(format!(
                "{name} is a {kind} with a Notion page, but only knowledge can be read from Notion"
            ));
        }
        if self.path.is_some() {
            return Err(format!(
                "{name} names both a path and a Notion page; a knowledge entry reads one of them"
            ));
        }
        if uuid::Uuid::parse_str(&notion.page).is_err() {
            return Err(format!(
                "{name} names the Notion page {:?}, which is not a Notion page id",
                notion.page
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionRef {
    pub page: String,
    /// The page as this run read it. Never in the team file: the run reads every page once,
    /// before anything spawns, so each stage and helper is given the same text (`lib.rs`,
    /// `read_notion_pages`).
    #[serde(skip)]
    pub read: Option<std::sync::Arc<NotionPage>>,
}

/// One Notion page's text, read from the operator's own Notion connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotionPage {
    pub title: String,
    /// The page's address, as Notion gave it.
    pub url: String,
    /// The page in Notion's Markdown.
    pub text: String,
    /// Notion said it left part of the page out.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityKind {
    /// Copied into the workspace and required in the prompt (ADR 0012, 0019, 0021).
    Skill,
    /// A folder or file the operator chose (ADR 0035, 0036): its contents are supplied in the
    /// prompt, and it is a read grant for that folder or file (ADR 0029). Memory is wired through
    /// `memory.inherits`, not here.
    Knowledge,
    /// A tool the operator connected in `LoomWatch` (ADR 0069), by its name: its calls are offered
    /// to the agent, each asking first unless `alwaysAllow` names it. A name with no connected tool
    /// is told to the agent as unavailable.
    Tool,
}

impl CapabilityKind {
    /// The word the team file uses, which is also how the prompt names the kind.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Knowledge => "knowledge",
            Self::Tool => "tool",
        }
    }
}

impl AgentConfig {
    /// Whether this entry is a review stop rather than a harness.
    #[must_use]
    pub fn is_operator(&self) -> bool {
        self.kind == AgentKind::Operator
    }

    /// ACP adapters commonly expose reasoning effort as a separate config option, while the
    /// process driver accepts one selector. Keep old combined selectors readable and synthesize
    /// one for the driver when the team file stores the fields separately.
    /// Whether this agent is supplied the team's Brief. Default is yes.
    #[must_use]
    pub fn reads_brief(&self) -> bool {
        self.memory.is_none_or(|memory| memory.brief)
    }

    /// How the Brief is delivered to this agent, given the team's setting.
    #[must_use]
    pub fn deliver_as(&self, team: DeliverAs) -> DeliverAs {
        self.memory
            .and_then(|memory| memory.deliver_as)
            .unwrap_or(team)
    }

    #[must_use]
    pub fn model_selector(&self) -> String {
        self.thinking_effort.as_deref().map_or_else(
            || self.model.clone(),
            |effort| {
                let base = split_known_effort(&self.model).unwrap_or(&self.model);
                format!("{base}[{effort}]")
            },
        )
    }
}

fn split_known_effort(model: &str) -> Option<&str> {
    let (base, suffix) = model.rsplit_once('[')?;
    let effort = suffix.strip_suffix(']')?;
    is_known_effort(effort).then_some(base)
}

/// Whether `effort` is a reasoning effort a team file may name.
pub(crate) fn is_known_effort(effort: &str) -> bool {
    matches!(
        effort,
        "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

/// An agent's `spawn`: the folder it works in, relative to the team file.
///
/// `cmd`, `args` and `env` named the AI app an earlier `LoomWatch` started for the agent. Files
/// written then still have them, so they are read and ignored: every agent runs on `LoomWatch`'s
/// own engine now.
#[derive(Debug, Clone, Deserialize)]
pub struct SpawnConfig {
    #[serde(default)]
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "team_folder")]
    pub cwd: PathBuf,
}

fn team_folder() -> PathBuf {
    PathBuf::from(".")
}

impl Default for SpawnConfig {
    /// The team file's own folder.
    fn default() -> Self {
        Self {
            cmd: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: team_folder(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardsConfig {
    #[serde(default = "default_max_dispatch_depth")]
    pub max_dispatch_depth: u32,
    #[serde(default = "default_max_concurrent_dispatches")]
    pub max_concurrent_dispatches: u32,
}

impl Default for GuardsConfig {
    fn default() -> Self {
        Self {
            max_dispatch_depth: default_max_dispatch_depth(),
            max_concurrent_dispatches: default_max_concurrent_dispatches(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EdgeConfig {
    pub from: String,
    pub to: String,
    pub layer: String,
    pub kind: String,
    pub ts: String,
}

const fn default_max_dispatch_depth() -> u32 {
    8
}

const fn default_max_concurrent_dispatches() -> u32 {
    8
}

const fn default_allow_recruiting() -> bool {
    true
}

const fn default_true() -> bool {
    true
}

impl ScheduleConfig {
    /// Check every field the way `TeamConfig::parse` does. Each message is complete on its
    /// own so `PUT /api/team` and `POST /api/runs` can surface it verbatim as a 422.
    ///
    /// # Errors
    ///
    /// Returns an error when the cron expression or the time zone does not parse, or the
    /// prompt is blank.
    pub fn validate(&self) -> Result<()> {
        self.cron_schedule()?;
        self.zone()?;
        if self.prompt.trim().is_empty() {
            bail!("schedule.prompt must not be empty");
        }
        if let Some(title) = self.notion_title()
            && title.trim().is_empty()
        {
            bail!("schedule.deliver.notion.title must not be empty");
        }
        Ok(())
    }

    /// The parsed cron schedule, in the `cron` crate's own numbering.
    ///
    /// # Errors
    ///
    /// Returns an error when the expression has the wrong number of fields or a field is
    /// out of range.
    pub fn cron_schedule(&self) -> Result<cron::Schedule> {
        let normalized = normalize_cron(&self.cron)?;
        cron::Schedule::from_str(&normalized).map_err(|error| {
            anyhow::anyhow!(
                "schedule.cron {:?} is not a valid cron expression: {error}",
                self.cron
            )
        })
    }

    /// The configured IANA zone, or `None` for the daemon's local zone.
    ///
    /// # Errors
    ///
    /// Returns an error when the name is not a known IANA zone.
    pub fn zone(&self) -> Result<Option<Tz>> {
        self.timezone
            .as_deref()
            .map(|name| {
                Tz::from_str(name).map_err(|_| {
                    anyhow::anyhow!("schedule.timezone {name:?} is not an IANA time zone")
                })
            })
            .transpose()
    }

    /// The Notion title template when Notion delivery is configured (the default template
    /// when the block names none); `None` when the routine delivers nowhere.
    #[must_use]
    pub fn notion_title(&self) -> Option<&str> {
        self.deliver.as_ref()?.notion_title(DEFAULT_NOTION_TITLE)
    }

    /// The first instant strictly after `after` at which the schedule fires, in UTC.
    /// `None` when the expression never fires again (a year field in the past).
    ///
    /// # Errors
    ///
    /// Returns an error when the cron expression or the zone does not parse.
    pub fn next_fire(&self, after: DateTime<Utc>) -> Result<Option<DateTime<Utc>>> {
        let schedule = self.cron_schedule()?;
        Ok(match self.zone()? {
            Some(zone) => next_in_zone(&schedule, &zone, after),
            None => next_in_zone(&schedule, &Local, after),
        })
    }

    /// Expand `{{date}}`, `{{weekday}}`, `{{time}}` and `{{team}}` for a fire at `at`, reading
    /// the calendar in the schedule's zone. A zone that does not parse falls back to local.
    #[must_use]
    pub fn expand(&self, template: &str, team_name: &str, at: DateTime<Utc>) -> String {
        expand_template(template, team_name, at, self.zone().ok().flatten())
    }

    /// A one-line human summary — `daily at 08:00 Asia/Singapore`, `weekdays at 09:30
    /// local time`, `every Monday at 07:00 Europe/Berlin` — or the cron text itself when
    /// the expression is not one of those simple shapes.
    #[must_use]
    pub fn describe(&self) -> String {
        let zone = self.timezone.as_deref().unwrap_or("local time");
        describe_cron(&self.cron).map_or_else(
            || format!("{} {zone}", self.cron.trim()),
            |summary| format!("{summary} {zone}"),
        )
    }
}

/// `after`'s successor in `zone`, as UTC. The iteration happens in the zone so daylight
/// saving changes move the wall-clock fire time, not the UTC one.
fn next_in_zone<Z: TimeZone>(
    schedule: &cron::Schedule,
    zone: &Z,
    after: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let local = zone.from_utc_datetime(&after.naive_utc());
    schedule
        .after(&local)
        .next()
        .map(|next| next.with_timezone(&Utc))
}

fn calendar_stamp<Z: TimeZone>(at: &DateTime<Z>) -> (String, String, String)
where
    Z::Offset: Display,
{
    (
        at.format("%Y-%m-%d").to_string(),
        at.format("%A").to_string(),
        at.format("%H:%M").to_string(),
    )
}

/// Expand a schedule prompt or page-title template for `at`: `{{date}}` (YYYY-MM-DD),
/// `{{weekday}}` (the day name), `{{time}}` (24-hour HH:MM) in `zone` — the daemon's local zone
/// when `None` — and `{{team}}`.
#[must_use]
pub fn expand_template(
    template: &str,
    team_name: &str,
    at: DateTime<Utc>,
    zone: Option<Tz>,
) -> String {
    let (date, weekday, time) = match zone {
        Some(zone) => calendar_stamp(&at.with_timezone(&zone)),
        None => calendar_stamp(&at.with_timezone(&Local)),
    };
    template
        .replace("{{date}}", &date)
        .replace("{{weekday}}", &weekday)
        .replace("{{time}}", &time)
        .replace("{{team}}", team_name)
}

/// Turn the accepted forms into the `cron` crate's 6/7-field form. A 5-field expression
/// gains a `0` seconds field, and its day-of-week numbers move from the standard `0`/`7`
/// = Sunday numbering to the crate's `1` = Sunday; names pass through unchanged.
///
/// # Errors
///
/// Returns an error when the field count is not 5, 6 or 7 (`@daily`-style shorthands
/// are one field and pass through).
pub fn normalize_cron(expression: &str) -> Result<String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    match fields.as_slice() {
        [shorthand] if shorthand.starts_with('@') => Ok((*shorthand).to_owned()),
        [minute, hour, day_of_month, month, day_of_week] => Ok(format!(
            "0 {minute} {hour} {day_of_month} {month} {}",
            shift_day_of_week(day_of_week)
        )),
        [_, _, _, _, _, _] | [_, _, _, _, _, _, _] => Ok(fields.join(" ")),
        _ => bail!(
            "schedule.cron {expression:?} must have 5 fields (minute hour day month weekday) or the 6/7-field seconds form"
        ),
    }
}

/// Renumber a standard cron day-of-week field (`0`/`7` = Sunday … `6` = Saturday) into
/// the crate's `1` = Sunday … `7` = Saturday. Lists, ranges and steps are preserved; a
/// range that wraps past Saturday after the shift is split.
fn shift_day_of_week(field: &str) -> String {
    field
        .split(',')
        .map(shift_day_of_week_item)
        .collect::<Vec<_>>()
        .join(",")
}

fn shift_day_of_week_item(item: &str) -> String {
    let (range, step) = match item.split_once('/') {
        Some((range, step)) => (range, Some(step)),
        None => (item, None),
    };
    let shifted = match range.split_once('-') {
        Some((start, end)) => match (shift_day_number(start), shift_day_number(end)) {
            (Some(start), Some(end)) if start > end && end == 1 => format!("{start}-7,1"),
            (Some(start), Some(end)) if start > end => format!("{start}-7,1-{end}"),
            (Some(start), Some(end)) => format!("{start}-{end}"),
            _ => range.to_owned(),
        },
        None => shift_day_number(range).map_or_else(|| range.to_owned(), |day| day.to_string()),
    };
    match step {
        Some(step) => format!("{shifted}/{step}"),
        None => shifted,
    }
}

fn shift_day_number(token: &str) -> Option<u32> {
    let day: u32 = token.parse().ok()?;
    (day <= 7).then_some(day % 7 + 1)
}

/// Summarise the simple daily / weekday / single-weekday / hourly shapes; `None` for
/// anything else.
fn describe_cron(expression: &str) -> Option<String> {
    let normalized = normalize_cron(expression).ok()?;
    let fields: Vec<&str> = normalized.split_whitespace().collect();
    let [
        seconds,
        minute,
        hour,
        day_of_month,
        month,
        day_of_week,
        rest @ ..,
    ] = fields.as_slice()
    else {
        return None;
    };
    if *seconds != "0" || *day_of_month != "*" || *month != "*" || rest.iter().any(|y| *y != "*") {
        return None;
    }
    let minute: u32 = minute.parse().ok()?;
    if *hour == "*" {
        return (*day_of_week == "*").then(|| format!("hourly at :{minute:02}"));
    }
    let hour: u32 = hour.parse().ok()?;
    let time = format!("{hour:02}:{minute:02}");
    let lowered = day_of_week.to_ascii_lowercase();
    match lowered.as_str() {
        "*" => Some(format!("daily at {time}")),
        "2-6" | "mon-fri" => Some(format!("weekdays at {time}")),
        "1,7" | "7,1" | "sat,sun" | "sun,sat" => Some(format!("weekends at {time}")),
        single => weekday_name(single).map(|day| format!("every {day} at {time}")),
    }
}

fn weekday_name(token: &str) -> Option<&'static str> {
    const NAMES: [&str; 7] = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ];
    if let Ok(number) = token.parse::<usize>() {
        return (1..=7).contains(&number).then(|| NAMES[number - 1]);
    }
    NAMES
        .iter()
        .find(|name| name.to_ascii_lowercase().starts_with(token) && token.len() >= 3)
        .copied()
}

impl TeamConfig {
    /// The key this team's chat is filed under (ADR 0051): its `id`, so renaming or moving the
    /// file keeps the chat; or, for a file with no `id`, its path relative to the teams root,
    /// prefixed so it can never collide with an `id`.
    #[must_use]
    pub fn chat_key(&self, relative_path: &str) -> String {
        let id = self.id.trim();
        if id.is_empty() {
            format!("path:{relative_path}")
        } else {
            id.to_owned()
        }
    }

    /// Read and minimally validate a Phase-02 team file.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read, parsed, or uses an unknown version.
    pub fn load(path: &Path) -> Result<Self> {
        let source = fs::read_to_string(path)
            .with_context(|| format!("failed to read team file {}", path.display()))?;
        Self::parse(&source)
            .with_context(|| format!("failed to parse team file {}", path.display()))
    }

    /// Parse and minimally validate a team document in memory.
    ///
    /// This is the in-memory counterpart to [`Self::load`]. It lets the configuration API
    /// validate an edited document before replacing its file.
    ///
    /// # Errors
    ///
    /// Returns an error when the document cannot be parsed, uses an unknown version, or
    /// fails the runtime's semantic checks.
    pub fn parse(source: &str) -> Result<Self> {
        let mut team: Self = serde_yaml::from_str(source).context("invalid team YAML")?;
        if team.schema_version != 1 {
            bail!("unsupported team schema version {}", team.schema_version);
        }
        // `spend.web` on an agent is the team's with the agent's own figures over it, settled here
        // once so every place that runs the agent holds it to the same limits.
        team.spend
            .web
            .validate("the team's")
            .map_err(anyhow::Error::msg)?;
        let team_web = team.spend.web;
        for agent in &mut team.agents {
            agent
                .spend
                .web
                .validate(&format!("agent {:?}'s", agent.id))
                .map_err(anyhow::Error::msg)?;
            agent.spend.web = agent.spend.web.over(team_web);
        }
        // The schema's `Identifier`, enforced here too and not only in the editor: ids name the
        // agents' folders under `.loomwatch/`, and a team file can come from anyone. An agent id of
        // `../../../..` would otherwise put the folder LoomWatch clears at the home folder.
        if !team.id.is_empty() && !is_identifier(&team.id) {
            bail!("team id {:?} {IDENTIFIER_RULE}", team.id);
        }
        for agent in &team.agents {
            if !is_identifier(&agent.id) {
                bail!("agent id {:?} {IDENTIFIER_RULE}", agent.id);
            }
        }
        team.entrypoint_agent()?;
        // Before `pipeline_order`, so "the entrypoint is a stop" is reported as what it is rather
        // than as the incoming-edge violation it also happens to be.
        team.validate_operator_nodes()?;
        team.validate_check_steps()?;
        team.responder_id()?;
        for agent in &team.agents {
            for capability in &agent.capabilities {
                capability
                    .validate()
                    .map_err(|reason| anyhow::anyhow!("agent {:?}: {reason}", agent.id))?;
            }
        }
        if let Some(schedule) = &team.schedule {
            schedule.validate()?;
        }
        if let Some(title) = team
            .deliver
            .as_ref()
            .and_then(|deliver| deliver.notion_title(DEFAULT_RUN_NOTION_TITLE))
            && title.trim().is_empty()
        {
            bail!("deliver.notion.title must not be empty");
        }
        Ok(team)
    }

    /// The Notion page title a run's reply is published under, expanded for `at`; `None` when
    /// the run delivers nowhere. A routine (`scheduled`) uses its own `schedule.deliver` when it
    /// has one; every run falls back to the top-level `deliver`. Dates are read in the schedule's
    /// zone when the team has one, so a routine and a hand-started run name the same day alike.
    #[must_use]
    pub fn notion_delivery_title(
        &self,
        scheduled: bool,
        team_name: &str,
        at: DateTime<Utc>,
    ) -> Option<String> {
        let routine = scheduled
            .then(|| self.schedule.as_ref()?.notion_title())
            .flatten();
        let template = routine.or_else(|| {
            self.deliver
                .as_ref()?
                .notion_title(DEFAULT_RUN_NOTION_TITLE)
        })?;
        let zone = self
            .schedule
            .as_ref()
            .and_then(|schedule| schedule.zone().ok().flatten());
        Some(expand_template(template, team_name, at, zone))
    }

    /// Where a review stop may and may not sit (`docs/TEAM_MEMORY.md`, "Rules that keep this safe").
    ///
    /// Two rules, and one deliberate non-rule:
    ///
    /// * **Not the entrypoint.** The Prompt node already *is* the operator at the head of the
    ///   pipeline; a second card asking the same person the same question at the same moment is
    ///   noise, and a stop with no predecessor has no work to review.
    /// * **Not in team mode.** `edges: []` means the entrypoint self-organizes, so there is no
    ///   configured order for a stop to sit in. The operator is still reachable there — an agent
    ///   calls `ask_user` — but the file cannot place a stop.
    /// * **Two in a row is allowed**, and is not checked: "approve the findings" then "approve the
    ///   plan" are two decisions, and collapsing them would be this loader inventing a rule the
    ///   design does not have.
    ///
    /// # Errors
    ///
    /// Returns an error when an operator node is the entrypoint or when a team-mode file has one.
    pub fn validate_operator_nodes(&self) -> Result<()> {
        let operators: Vec<&str> = self
            .agents
            .iter()
            .filter(|agent| agent.is_operator())
            .map(|agent| agent.id.as_str())
            .collect();
        if operators.is_empty() {
            return Ok(());
        }
        if let Some(entrypoint) = operators.iter().find(|id| **id == self.entrypoint) {
            bail!(
                "entrypoint {entrypoint:?} is an operator node. The Prompt node is already your \
                 input at the head of a run, so a stop needs a stage before it to review. Point \
                 `entrypoint` at the agent that starts the work."
            );
        }
        if self.edges.is_empty() {
            bail!(
                "this team has no configured edges, so it runs in team mode and has no order for \
                 a stop to sit in. Remove the operator node{} ({}), or draw the pipeline edges \
                 that place {}.",
                if operators.len() == 1 { "" } else { "s" },
                operators.join(", "),
                if operators.len() == 1 { "it" } else { "them" },
            );
        }
        Ok(())
    }

    /// A check step names the agent it checks, and that agent is its direct predecessor in the
    /// pipeline (ADR 0062). An attribute, not an edge: the pipeline stays a DAG.
    ///
    /// # Errors
    ///
    /// When a check step is in team mode, names itself, an unknown agent, a review stop, or an
    /// agent that does not hand work straight to it; or when `sendBackOnce` is set without `checks`.
    pub fn validate_check_steps(&self) -> Result<()> {
        for agent in &self.agents {
            let Some(checked) = agent.checks.as_deref() else {
                if agent.send_back_once {
                    bail!(
                        "agent {:?} sets sendBackOnce but checks no agent. Add `checks: <agent \
                         id>`, or remove sendBackOnce.",
                        agent.id
                    );
                }
                continue;
            };
            if self.edges.is_empty() {
                bail!(
                    "agent {:?} checks {checked:?}, but this team has no configured edges, so it \
                     runs in team mode. Connect {checked:?} to {:?} so the work is handed to it.",
                    agent.id,
                    agent.id
                );
            }
            if checked == agent.id {
                bail!("agent {:?} cannot check its own work.", agent.id);
            }
            let Some(target) = self.agents.iter().find(|other| other.id == checked) else {
                bail!(
                    "agent {:?} checks {checked:?}, which is not an agent of this team.",
                    agent.id
                );
            };
            if target.is_operator() {
                bail!(
                    "agent {:?} checks {checked:?}, a review stop: only an agent's work can be \
                     checked.",
                    agent.id
                );
            }
            if !self
                .edges
                .iter()
                .any(|edge| edge.from == checked && edge.to == agent.id)
            {
                bail!(
                    "agent {:?} checks {checked:?}, but {checked:?} does not hand its work \
                     straight to it. Connect {checked:?} to {:?}.",
                    agent.id,
                    agent.id
                );
            }
        }
        Ok(())
    }

    /// Resolve the entrypoint to its configured agent.
    ///
    /// # Errors
    ///
    /// Returns an error when no agent has the configured entrypoint ID.
    pub fn entrypoint_agent(&self) -> Result<&AgentConfig> {
        self.agents
            .iter()
            .find(|agent| agent.id == self.entrypoint)
            .with_context(|| format!("entrypoint agent {:?} does not exist", self.entrypoint))
    }

    /// Resolve the configured canonical responder, retaining the version-1 inferred default when
    /// the root `responder` key is absent.
    ///
    /// # Errors
    ///
    /// Returns an error when an explicit responder is unknown, is outside the configured pipeline,
    /// or differs from the entrypoint in self-organizing team mode.
    pub fn responder_id(&self) -> Result<String> {
        if let Some(responder) = &self.responder {
            if !self.agents.iter().any(|agent| agent.id == *responder) {
                bail!("responder agent {responder:?} does not exist");
            }
            if self.edges.is_empty() {
                if responder != &self.entrypoint {
                    bail!(
                        "team-mode responder {responder:?} must match entrypoint {:?}; create a pipeline to choose a different responder",
                        self.entrypoint
                    );
                }
                return Ok(responder.clone());
            }
            let order = self.pipeline_order()?;
            if !order.contains(responder) {
                bail!("responder agent {responder:?} is not in the configured pipeline");
            }
            return Ok(responder.clone());
        }

        if self.edges.is_empty() {
            return Ok(self.entrypoint.clone());
        }
        let mut last = self
            .pipeline_order()?
            .last()
            .cloned()
            .unwrap_or_else(|| self.entrypoint.clone());
        // A pipeline that ends on a review stop answers with the work the person approved, not
        // with what they typed to approve it ("Approved"): the stage that feeds the stop, through
        // any stops before it. A stop fed by several stages has no one such stage, and keeps
        // answering itself.
        while self.is_operator_node(&last) {
            let mut feeding = self.edges.iter().filter(|edge| edge.to == last);
            match (feeding.next(), feeding.next()) {
                (Some(only), None) => last.clone_from(&only.from),
                _ => break,
            }
        }
        // A pipeline that ends on a check step answers with the work it checked, not with the
        // check (ADR 0062): the checks are shown beside the answer.
        Ok(self
            .agents
            .iter()
            .find(|agent| agent.id == last)
            .and_then(|agent| agent.checks.clone())
            .unwrap_or(last))
    }

    fn is_operator_node(&self, id: &str) -> bool {
        self.agents
            .iter()
            .any(|agent| agent.id == id && agent.is_operator())
    }

    /// Topological run order for pipeline mode (non-empty `edges`).
    ///
    /// Team mode (`edges` empty) has no backend-driven order, so this returns an empty
    /// vector without inspecting agents.
    ///
    /// # Errors
    ///
    /// Returns an error when an edge names an unknown agent, is a self-edge, duplicates
    /// another configured edge, the entrypoint has an incoming configured edge, or the
    /// configured edges are not a single DAG reachable from the entrypoint (including a
    /// cycle).
    pub fn pipeline_order(&self) -> Result<Vec<String>> {
        if self.edges.is_empty() {
            return Ok(Vec::new());
        }
        let agent_ids: BTreeSet<&str> = self.agents.iter().map(|agent| agent.id.as_str()).collect();
        let mut adjacency: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut indegree: BTreeMap<String, usize> = BTreeMap::new();
        let mut seen_edges: BTreeSet<(&str, &str)> = BTreeSet::new();

        for edge in &self.edges {
            if !agent_ids.contains(edge.from.as_str()) {
                bail!("configured edge references unknown agent {:?}", edge.from);
            }
            if !agent_ids.contains(edge.to.as_str()) {
                bail!("configured edge references unknown agent {:?}", edge.to);
            }
            if edge.from == edge.to {
                bail!(
                    "configured edge cannot connect agent {:?} to itself",
                    edge.from
                );
            }
            if !seen_edges.insert((edge.from.as_str(), edge.to.as_str())) {
                bail!("duplicate configured edge {:?} -> {:?}", edge.from, edge.to);
            }
            adjacency
                .entry(edge.from.clone())
                .or_default()
                .push(edge.to.clone());
            indegree.entry(edge.from.clone()).or_insert(0);
            *indegree.entry(edge.to.clone()).or_insert(0) += 1;
        }

        if indegree.get(&self.entrypoint).copied().unwrap_or(0) != 0 {
            bail!(
                "pipeline entrypoint {:?} has an incoming configured edge; it must be a source node",
                self.entrypoint
            );
        }

        let total_nodes = indegree.len();
        let mut remaining = indegree;
        let mut ready: BTreeSet<String> = BTreeSet::from([self.entrypoint.clone()]);
        let mut order = Vec::with_capacity(total_nodes);

        while let Some(node) = ready.iter().next().cloned() {
            ready.remove(&node);
            order.push(node.clone());
            for next in adjacency.get(&node).into_iter().flatten() {
                let entry = remaining
                    .get_mut(next)
                    .context("pipeline edge endpoint missing from indegree map")?;
                *entry -= 1;
                if *entry == 0 {
                    ready.insert(next.clone());
                }
            }
        }

        if order.len() != total_nodes {
            bail!(
                "configured edges contain a cycle, or a node unreachable from entrypoint {:?}",
                self.entrypoint
            );
        }
        Ok(order)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_entrypoint_agent() {
        let team: TeamConfig = serde_yaml::from_str(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n",
        )
        .expect("valid config");
        assert_eq!(team.entrypoint_agent().expect("entrypoint").id, "a");
    }

    /// ADR 0060: an agent's turned-off list names skills and tools of its app's own, never
    /// knowledge (only ever what `LoomWatch` gives) and never the Team Bus.
    #[test]
    fn a_tools_always_allowed_calls_are_read_and_belong_to_tools_only() {
        let team = |capability: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    capabilities:\n      - {capability}\n",
            ))
        };
        let parsed = team("{kind: tool, name: Linear, alwaysAllow: [create_issue]}")
            .expect("a tool's actions can be always allowed");
        assert_eq!(
            parsed.agents[0].capabilities[0].always_allow,
            ["create_issue"]
        );
        for (capability, says) in [
            (
                "{kind: skill, name: notes, alwaysAllow: [x]}",
                "only a tool's actions",
            ),
            (
                "{kind: tool, name: Linear, alwaysAllow: [' ']}",
                "isn't the name of an action",
            ),
        ] {
            let error = format!("{:#}", team(capability).expect_err(says));
            assert!(error.contains(says), "{error}");
        }
    }

    #[test]
    fn reads_an_agents_turned_off_skills_and_tools_and_refuses_the_rest() {
        let team = |entries: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    turnedOff:\n{entries}",
            ))
        };
        let parsed = team("      - {kind: skill, name: notebooklm}\n      - {kind: tool, name: claude.ai Notion}\n")
            .expect("skills and tools can be turned off");
        assert_eq!(
            parsed.agents[0].turned_off,
            vec![
                TurnedOff {
                    kind: CapabilityKind::Skill,
                    name: "notebooklm".to_owned()
                },
                TurnedOff {
                    kind: CapabilityKind::Tool,
                    name: "claude.ai Notion".to_owned()
                },
            ]
        );
        for (entries, says) in [
            (
                "      - {kind: knowledge, name: notes}\n",
                "only skills and tools",
            ),
            (
                "      - {kind: tool, name: loomwatch-team-bus}\n",
                "the Team Bus",
            ),
            ("      - {kind: skill, name: ' '}\n", "with no name"),
        ] {
            let error = format!("{:#}", team(entries).expect_err(says));
            assert!(error.contains(says), "{error}");
        }
        let operator = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n  - id: you\n    kind: operator\n    role: Check it.\n    turnedOff:\n      - {kind: skill, name: x}\nedges:\n  - {from: a, to: you, layer: configured, kind: sequence, ts: \"2026-09-10T00:00:00Z\"}\n",
        )
        .expect_err("an operator node runs no app");
        assert!(
            format!("{operator:#}").contains("no turnedOff"),
            "{operator:#}"
        );
    }

    /// ADR 0062: `doneWhen` is a short list a harness agent checks its result against. Blank items
    /// are dropped, the schema's limits hold for a hand-edited file too, and a review stop has none.
    #[test]
    fn done_when_is_trimmed_bounded_and_only_for_an_agent_that_runs() {
        let team = |items: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    doneWhen: [{items}]\nedges: []\n"
            ))
        };
        let parsed = team("'  Every claim has a link  ', ' ', 'Under 300 words'").expect("valid");
        assert_eq!(
            parsed.agents[0].done_when,
            ["Every claim has a link", "Under 300 words"]
        );
        let six = team("a, b, c, d, e, f").expect_err("six items");
        assert!(format!("{six:#}").contains("keep it to 5"), "{six:#}");
        let long = team(&format!("'{}'", "x".repeat(161))).expect_err("an essay");
        assert!(format!("{long:#}").contains("longer than 160"), "{long:#}");
        let operator = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n  - id: you\n    kind: operator\n    role: Check it.\n    doneWhen: [Approved]\nedges:\n  - {from: a, to: you, layer: configured, kind: sequence, ts: \"2026-09-10T00:00:00Z\"}\n",
        )
        .expect_err("a review stop is answered by the person");
        assert!(
            format!("{operator:#}").contains("no doneWhen"),
            "{operator:#}"
        );
    }

    /// ADR 0062: a check step names its direct predecessor, a harness agent, in a pipeline; a
    /// pipeline that ends on one answers with the work it checked.
    #[test]
    fn a_check_step_checks_its_direct_predecessor_and_its_answer_is_that_work() {
        const AGENT: &str = "spawn: {cmd: acp, cwd: .}\n    model: test/model";
        let team = |checks: &str, edges: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: writer\nagents:\n  - id: writer\n    {AGENT}\n  - id: checker\n    {AGENT}\n    {checks}\nedges:{edges}\n"
            ))
        };
        let edge = "\n  - {from: writer, to: checker, layer: configured, kind: sequence, ts: \"2026-10-15T00:00:00Z\"}";
        let ok = team("checks: writer\n    sendBackOnce: true", edge).expect("a check step");
        assert_eq!(ok.agents[1].checks.as_deref(), Some("writer"));
        assert!(ok.agents[1].send_back_once);
        assert_eq!(ok.responder_id().expect("responder"), "writer");
        for (checks, edges, says) in [
            ("checks: writer", " []", "team mode"),
            ("checks: checker", edge, "its own work"),
            ("checks: ghost", edge, "not an agent"),
            ("sendBackOnce: true", edge, "checks no agent"),
        ] {
            let error = format!("{:#}", team(checks, edges).expect_err(says));
            assert!(error.contains(says), "{error}");
        }
        let skip = "\n  - {from: writer, to: middle, layer: configured, kind: sequence, ts: \"2026-10-15T00:00:00Z\"}\n  - {from: middle, to: checker, layer: configured, kind: sequence, ts: \"2026-10-15T00:00:00Z\"}";
        let far = TeamConfig::parse(&format!(
            "schemaVersion: 1\nentrypoint: writer\nagents:\n  - id: writer\n    {AGENT}\n  - id: middle\n    {AGENT}\n  - id: checker\n    {AGENT}\n    checks: writer\nedges:{skip}\n"
        ))
        .expect_err("a check step must be handed the work it checks");
        assert!(format!("{far:#}").contains("straight to it"), "{far:#}");
    }

    #[test]
    fn resolves_an_explicit_pipeline_responder() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nresponder: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n  - id: b\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\nedges:\n  - {from: a, to: b, layer: configured, kind: sequence, ts: \"2026-09-10T00:00:00Z\"}\n",
        )
        .expect("explicit pipeline responder is valid");
        assert_eq!(team.responder_id().expect("responder"), "a");
    }

    /// A pipeline that ends on a review stop answers with the work approved there: the stage
    /// feeding the stop, through stops in a row, then by the check-step rule. A final stop fed by
    /// several stages has no one such stage and keeps answering itself; a file's own `responder`
    /// always wins. Older files that ended on a stop load as they did.
    #[test]
    fn a_pipeline_ending_on_a_review_stop_answers_with_the_work_it_approved() {
        const AGENT: &str = "spawn: {cmd: acp, cwd: .}\n    model: test/model";
        let team = |agents: &[(&str, &str)], edges: &[(&str, &str)], responder: &str| {
            let agents: String = agents
                .iter()
                .map(|(id, extra)| format!("\n  - id: {id}\n    {extra}"))
                .collect::<Vec<_>>()
                .concat();
            let edges: String = edges
                .iter()
                .map(|(from, to)| {
                    format!(
                        "\n  - {{from: {from}, to: {to}, layer: configured, kind: sequence, ts: \"2026-10-18T00:00:00Z\"}}"
                    )
                })
                .collect::<Vec<_>>()
                .concat();
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: a\n{responder}agents:{agents}\nedges:{edges}\n"
            ))
            .expect("a valid pipeline")
        };
        let stop = "kind: operator\n    role: Approve it.";
        let answers = |team: TeamConfig| team.responder_id().expect("a responder");
        assert_eq!(
            answers(team(
                &[("a", AGENT), ("review", stop)],
                &[("a", "review")],
                ""
            )),
            "a"
        );
        assert_eq!(
            answers(team(
                &[("a", AGENT), ("s1", stop), ("s2", stop)],
                &[("a", "s1"), ("s1", "s2")],
                ""
            )),
            "a"
        );
        let checked = format!("{AGENT}\n    checks: a");
        assert_eq!(
            answers(team(
                &[("a", AGENT), ("checker", &checked), ("review", stop)],
                &[("a", "checker"), ("checker", "review")],
                ""
            )),
            "a"
        );
        assert_eq!(
            answers(team(
                &[("a", AGENT), ("b", AGENT), ("c", AGENT), ("review", stop)],
                &[("a", "b"), ("a", "c"), ("b", "review"), ("c", "review")],
                ""
            )),
            "review"
        );
        assert_eq!(
            answers(team(
                &[("a", AGENT), ("review", stop)],
                &[("a", "review")],
                "responder: review\n"
            )),
            "review"
        );
        // A stop in the middle changes nothing: the last stage answers.
        assert_eq!(
            answers(team(
                &[("a", AGENT), ("review", stop), ("b", AGENT)],
                &[("a", "review"), ("review", "b")],
                ""
            )),
            "b"
        );
    }

    #[test]
    fn rejects_an_unknown_or_non_entrypoint_team_responder() {
        let unknown = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nresponder: ghost\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\nedges: []\n",
        )
        .expect_err("unknown responder must be rejected");
        assert!(
            unknown
                .to_string()
                .contains("responder agent \"ghost\" does not exist")
        );

        let mismatch = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nresponder: b\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n  - id: b\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\nedges: []\n",
        )
        .expect_err("team-mode responder must be the entrypoint");
        assert!(mismatch.to_string().contains("must match entrypoint"));
    }

    /// Files written for an earlier `LoomWatch` named the AI app each agent ran in. They still load:
    /// the app is ignored, and an agent with no `spawn` at all works in the team file's folder.
    #[test]
    fn old_app_fields_are_ignored_and_spawn_may_be_left_out() {
        let old = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: claude-agent-acp\n      args: [--x]\n      env:\n        NODE_OPTIONS: --require evil.js\n      cwd: work\n    model: sonnet\n",
        )
        .expect("an old file still loads");
        assert_eq!(old.agents[0].spawn.cwd, PathBuf::from("work"));
        let new = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    name: Writer\n    model: anthropic/claude-sonnet-5.5\n",
        )
        .expect("an agent needs only a name and a model");
        assert_eq!(new.agents[0].spawn.cwd, PathBuf::from("."));
        assert!(new.agents[0].spawn.cmd.is_empty());
        let only_cwd = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn: {cwd: notes}\n    model: x/y\n",
        )
        .expect("spawn may name only the folder");
        assert_eq!(only_cwd.agents[0].spawn.cwd, PathBuf::from("notes"));
        let no_model =
            TeamConfig::parse("schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    name: A\n")
                .expect_err("an agent without a model");
        assert!(
            format!("{no_model:#}").contains("missing `model`"),
            "{no_model:#}"
        );
    }

    /// Ids name folders under `.loomwatch/`, and `materialise` clears `.claude/skills` and
    /// `.claude/settings.json` inside an agent's folder. An id that climbs out of `.loomwatch/`
    /// must be refused when the file is read, whoever wrote it.
    #[test]
    fn rejects_team_and_agent_ids_that_are_not_plain_names() {
        let team = |team_id: &str, agent_id: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nid: '{team_id}'\nentrypoint: '{agent_id}'\nagents:\n  - id: '{agent_id}'\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n",
            ))
        };
        for bad in [
            "../../../..",
            "..",
            ".",
            "a/b",
            "a\\b",
            "/abs",
            "-flag",
            " a",
            "",
        ] {
            let error = team("team", bad).expect_err(bad).to_string();
            assert!(error.contains("agent id"), "{bad:?}: {error}");
            assert!(
                error.contains("must start with a letter or digit"),
                "{error}"
            );
        }
        for bad in ["../..", "a/b", ".hidden"] {
            let error = team(bad, "a").expect_err(bad).to_string();
            assert!(error.contains("team id"), "{bad:?}: {error}");
        }
        assert!(team("team", &"a".repeat(129)).is_err());

        let longest = "a".repeat(128);
        for good in ["a", "Writer", "writer-2", "v1.2_b", longest.as_str()] {
            team("my-team", good).unwrap_or_else(|error| panic!("{good:?}: {error:#}"));
        }
        // A file that predates the required `id` still loads.
        TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n",
        )
        .expect("a team without an id still loads");
    }

    #[test]
    fn stores_thinking_effort_separately_and_builds_the_acp_selector() {
        let team: TeamConfig = serde_yaml::from_str(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: vendor/deep\n    thinkingEffort: high\n",
        )
        .expect("valid config");
        assert_eq!(team.agents[0].thinking_effort.as_deref(), Some("high"));
        assert_eq!(team.agents[0].model_selector(), "vendor/deep[high]");

        let mut legacy = team.agents[0].clone();
        legacy.model = "vendor/deep[low]".into();
        legacy.thinking_effort = Some("xhigh".into());
        assert_eq!(legacy.model_selector(), "vendor/deep[xhigh]");
    }

    /// ADR 0068: `spend.perRun` on the team and on an agent. A team that says nothing has no limit
    /// and its agents no guard; an operator node spends nothing, so it may not say.
    #[test]
    fn spend_limits_load_at_team_and_agent_level() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nspend:\n  perRun: 2.5\nagents:\n  - id: a\n    model: m\n    spend:\n      perRun: 0.3\n  - id: b\n    model: m\n",
        )
        .expect("valid config");
        assert_eq!(team.spend.per_run, Some(2.5));
        assert_eq!(team.agents[0].spend.per_run, Some(0.3));
        assert_eq!(team.agents[1].spend.per_run, None);
        let spool = crate::spend::RunSpend::for_team(&team);
        assert_eq!(spool.limit_usd, Some(2.5));
        assert_eq!(spool.agents["a"].limit_usd, Some(0.3));
        assert!(!spool.agents.contains_key("b"));

        let silent = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    model: m\n",
        )
        .expect("valid config");
        assert_eq!(crate::spend::RunSpend::for_team(&silent).limit_usd, None);

        let error = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    model: m\n  - id: stop\n    kind: operator\n    role: Approve.\n    spend:\n      perRun: 1\n",
        )
        .expect_err("an operator node spends nothing");
        assert!(format!("{error:#}").contains("no spend"), "{error:#}");
    }

    /// `spend.web` on the team, and on an agent figure by figure over it; a team that says nothing
    /// reads the web within the built-in limits, as every team file written before them does.
    #[test]
    fn web_limits_load_at_team_and_agent_level() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nspend:\n  perRun: 1\n  web:\n    maxPageTokens: 12000\n    maxSteps: 6\nagents:\n  - id: a\n    model: m\n    spend:\n      web:\n        maxPages: 2\n  - id: b\n    model: m\n",
        )
        .expect("valid config");
        let a = team.agents[0].spend.web.limits();
        assert_eq!(
            (a.page_tokens, a.pages, a.searches, a.steps),
            (12_000, Some(2), None, Some(6))
        );
        let b = team.agents[1].spend.web.limits();
        assert_eq!((b.page_tokens, b.pages, b.steps), (12_000, None, Some(6)));
        assert_eq!(
            team.agents[0].spend.per_run, None,
            "only the web figures are the team's"
        );

        let silent = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    model: m\n",
        )
        .expect("valid config");
        assert_eq!(
            silent.agents[0].spend.web.limits(),
            crate::agent::WebLimits::default()
        );

        for (block, said) in [
            (
                "spend:\n  web:\n    maxPages: 0\n",
                "the team's spend.web.maxPages is 0",
            ),
            ("spend:\n  web:\n    maxSteps: 31\n", "between 1 and 30"),
            (
                "spend:\n  web:\n    maxPageTokens: 100\n",
                "maxPageTokens is 100",
            ),
        ] {
            let error = TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: a\n{block}agents:\n  - id: a\n    model: m\n"
            ))
            .expect_err(said);
            assert!(format!("{error:#}").contains(said), "{error:#}");
        }
        let error = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    model: m\n    spend:\n      web:\n        maxSearches: 99\n",
        )
        .expect_err("out of range on an agent");
        assert!(format!("{error:#}").contains("agent \"a\"'s spend.web.maxSearches is 99"));
        let error = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nspend:\n  web:\n    pages: 3\nagents:\n  - id: a\n    model: m\n",
        )
        .expect_err("an unknown figure is a mistake, not a default");
        assert!(format!("{error:#}").contains("pages"), "{error:#}");
    }

    /// Budgets were retired by ADR 0027. A team file written before then still says `budget:` at
    /// team and agent level, and on a review stop, where the loader used to refuse it; all three
    /// must still load, so nobody has to edit a working team to keep running it.
    #[test]
    fn a_retired_budget_block_still_loads_and_is_ignored() {
        let team: TeamConfig = serde_yaml::from_str(
            r#"schemaVersion: 1
id: example
name: Example
entrypoint: a
budget:
  limitUsd: 12.5
agents:
  - id: a
    name: Agent A
    role: Lead
    spawn:
      cmd: acp
      cwd: .
    model: test/model
    budget:
      limitUsd: 3
      warnAtPercent: 70
  - id: review
    kind: operator
    role: Approve the findings.
    budget:
      limitUsd: 0
edges:
  - from: a
    to: b
    layer: configured
    kind: sequence
    ts: "2026-09-06T00:00:00Z"
"#,
        )
        .expect("valid config");

        assert_eq!(team.guards.max_dispatch_depth, 8);
        assert_eq!(team.guards.max_concurrent_dispatches, 8);
        assert_eq!(team.agents[1].kind, AgentKind::Operator);
        assert!(team.agents[0].allow_recruiting);
        assert_eq!(team.edges[0].from, "a");
        assert_eq!(team.edges[0].to, "b");
    }

    fn pipeline_team(entrypoint: &str, edges_yaml: &str) -> TeamConfig {
        serde_yaml::from_str(&format!(
            "schemaVersion: 1\nentrypoint: {entrypoint}\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n  - id: b\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n  - id: c\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\nedges:\n{edges_yaml}\n"
        ))
        .expect("valid config")
    }

    #[test]
    fn pipeline_order_follows_declared_edges() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: b\n    to: c\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        assert_eq!(
            team.pipeline_order().expect("acyclic pipeline"),
            vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
        );
    }

    #[test]
    fn pipeline_order_is_empty_in_team_mode() {
        let team = pipeline_team("a", "");
        assert!(team.pipeline_order().expect("team mode").is_empty());
    }

    #[test]
    fn pipeline_order_rejects_a_cycle() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: b\n    to: a\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team.pipeline_order().expect_err("cycle must be rejected");
        assert!(
            error
                .to_string()
                .contains("has an incoming configured edge"),
            "{error}"
        );
    }

    #[test]
    fn pipeline_order_rejects_a_longer_cycle_not_touching_the_entrypoint() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: b\n    to: c\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: c\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team.pipeline_order().expect_err("cycle must be rejected");
        assert!(error.to_string().contains("cycle"), "{error}");
    }

    #[test]
    fn pipeline_order_rejects_a_self_edge() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: a\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("self-edge must be rejected");
        assert!(error.to_string().contains("itself"), "{error}");
    }

    #[test]
    fn pipeline_order_rejects_a_duplicate_edge() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("duplicate edge must be rejected");
        assert!(
            error.to_string().contains("duplicate configured edge"),
            "{error}"
        );
    }

    #[test]
    fn pipeline_order_rejects_an_edge_to_an_unknown_agent() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: nobody\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("unknown agent must be rejected");
        assert!(error.to_string().contains("unknown agent"), "{error}");
    }

    #[test]
    fn pipeline_order_rejects_an_entrypoint_with_an_incoming_edge() {
        let team = pipeline_team(
            "b",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("entrypoint must be a source node");
        assert!(
            error.to_string().contains("must be a source node"),
            "{error}"
        );
    }

    #[test]
    fn parses_dispatch_guards() {
        let team: TeamConfig = serde_yaml::from_str(
            "schemaVersion: 1\nentrypoint: a\nguards:\n  maxDispatchDepth: 3\n  maxConcurrentDispatches: 5\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n",
        )
        .expect("valid config");

        assert_eq!(team.guards.max_dispatch_depth, 3);
        assert_eq!(team.guards.max_concurrent_dispatches, 5);
    }

    const SOLO_AGENT: &str =
        "agents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n";

    /// ADR 0037: `allow:` is read as written and absent means all off; an unknown switch is a
    /// typo to report, not a permission to guess at; and a review stop, which runs no app, has
    /// nothing to allow.
    #[test]
    fn allow_switches_parse_default_off_and_refuse_typos_and_review_stops() {
        let with = |allow: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: a\n{SOLO_AGENT}{allow}"
            ))
        };
        let plain = with("").expect("no allow block");
        assert!(plain.agents[0].allow.is_empty());
        let web = with("    allow:\n      web: true\n").expect("web only");
        assert_eq!(
            web.agents[0].allow,
            AgentAllow {
                web: true,
                edits: false,
                commands: false,
            }
        );
        assert!(with("    allow:\n      internet: true\n").is_err());

        let stop = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n  - id: you\n    kind: operator\n    role: Approve?\n    allow:\n      web: true\n",
        );
        let error = format!("{:#}", stop.expect_err("a review stop allows nothing"));
        assert!(error.contains("has no allow"), "{error}");
    }

    fn scheduled_team(schedule_yaml: &str) -> Result<TeamConfig> {
        TeamConfig::parse(&format!(
            "schemaVersion: 1\nname: Daily news\nentrypoint: a\nschedule:\n{schedule_yaml}{SOLO_AGENT}"
        ))
    }

    fn utc(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .expect("valid instant")
            .with_timezone(&Utc)
    }

    #[test]
    fn parses_a_schedule_block_with_defaults_applied() {
        let team = scheduled_team(
            "  cron: \"0 8 * * *\"\n  timezone: Asia/Singapore\n  prompt: \"Digest for {{date}}\"\n  deliver:\n    notion: {}\n",
        )
        .expect("valid schedule");
        let schedule = team.schedule.expect("schedule present");
        assert!(schedule.enabled, "enabled defaults to true");
        assert_eq!(schedule.timezone.as_deref(), Some("Asia/Singapore"));
        assert_eq!(schedule.notion_title(), Some(DEFAULT_NOTION_TITLE));
        assert_eq!(schedule.describe(), "daily at 08:00 Asia/Singapore");

        let plain = TeamConfig::parse(&format!("schemaVersion: 1\nentrypoint: a\n{SOLO_AGENT}"))
            .expect("team without a schedule");
        assert!(plain.schedule.is_none());
    }

    #[test]
    fn accepts_five_six_and_seven_field_cron_and_shorthands() {
        for cron in ["0 8 * * *", "0 0 8 * * *", "0 0 8 * * * 2027", "@daily"] {
            let team = scheduled_team(&format!("  cron: \"{cron}\"\n  prompt: go\n"))
                .unwrap_or_else(|error| panic!("{cron:?} should parse: {error:#}"));
            assert!(team.schedule.unwrap().cron_schedule().is_ok());
        }
    }

    #[test]
    fn five_field_weekdays_use_standard_numbering() {
        assert_eq!(normalize_cron("30 9 * * 1-5").unwrap(), "0 30 9 * * 2-6");
        assert_eq!(normalize_cron("0 7 * * 0").unwrap(), "0 0 7 * * 1");
        assert_eq!(normalize_cron("0 7 * * 7").unwrap(), "0 0 7 * * 1");
        assert_eq!(normalize_cron("0 7 * * 5-7").unwrap(), "0 0 7 * * 6-7,1");
        assert_eq!(normalize_cron("0 7 * * 1,3,5").unwrap(), "0 0 7 * * 2,4,6");
        assert_eq!(normalize_cron("0 7 * * 1-5/2").unwrap(), "0 0 7 * * 2-6/2");
        assert_eq!(
            normalize_cron("0 7 * * Mon-Fri").unwrap(),
            "0 0 7 * * Mon-Fri"
        );
        assert_eq!(normalize_cron("0 0 7 * * 1").unwrap(), "0 0 7 * * 1");

        // Monday 09:30 Berlin: the standard "1-5" fires on a Monday, not a Sunday.
        let schedule =
            scheduled_team("  cron: \"30 9 * * 1-5\"\n  timezone: Europe/Berlin\n  prompt: go\n")
                .unwrap()
                .schedule
                .unwrap();
        assert_eq!(schedule.describe(), "weekdays at 09:30 Europe/Berlin");
        // Saturday 2026-09-12 10:00 CEST → next weekday fire is Monday 2026-09-14 09:30 CEST.
        assert_eq!(
            schedule.next_fire(utc("2026-09-12T08:00:00Z")).unwrap(),
            Some(utc("2026-09-14T07:30:00Z"))
        );
    }

    #[test]
    fn rejects_bad_cron_bad_timezone_and_blank_prompt() {
        let error = scheduled_team("  cron: \"61 8 * * *\"\n  prompt: go\n")
            .expect_err("minute 61 is out of range");
        assert!(
            error
                .to_string()
                .contains("schedule.cron \"61 8 * * *\" is not a valid cron expression"),
            "{error}"
        );

        let error = scheduled_team("  cron: \"8 * *\"\n  prompt: go\n").expect_err("3 fields");
        assert!(error.to_string().contains("must have 5 fields"), "{error}");

        let error =
            scheduled_team("  cron: \"0 8 * * *\"\n  timezone: Mars/Olympus\n  prompt: go\n")
                .expect_err("unknown zone");
        assert_eq!(
            error.to_string(),
            "schedule.timezone \"Mars/Olympus\" is not an IANA time zone"
        );

        let error = scheduled_team("  cron: \"0 8 * * *\"\n  prompt: \"  \\n \"\n")
            .expect_err("blank prompt");
        assert_eq!(error.to_string(), "schedule.prompt must not be empty");

        let error = scheduled_team(
            "  cron: \"0 8 * * *\"\n  prompt: go\n  deliver:\n    notion:\n      title: \" \"\n",
        )
        .expect_err("blank title");
        assert_eq!(
            error.to_string(),
            "schedule.deliver.notion.title must not be empty"
        );
    }

    #[test]
    fn next_fire_and_templates_follow_the_schedule_zone() {
        let schedule = scheduled_team(
            "  cron: \"0 8 * * *\"\n  timezone: Asia/Singapore\n  prompt: \"{{weekday}} {{date}} digest for {{team}}\"\n  deliver:\n    notion:\n      title: \"News — {{date}}\"\n",
        )
        .unwrap()
        .schedule
        .unwrap();
        // 08:00 SGT is 00:00 UTC; from 23:00 UTC on the 10th the next fire is the 11th.
        let next = schedule.next_fire(utc("2026-09-10T23:00:00Z")).unwrap();
        assert_eq!(next, Some(utc("2026-09-11T00:00:00Z")));
        // Exactly at a fire time, the next fire is the following day (strictly after).
        assert_eq!(
            schedule.next_fire(utc("2026-09-11T00:00:00Z")).unwrap(),
            Some(utc("2026-09-12T00:00:00Z"))
        );
        // 23:30 UTC on Thursday the 10th is already Friday the 11th in Singapore.
        let at = utc("2026-09-10T23:30:00Z");
        assert_eq!(
            schedule.expand(&schedule.prompt, "Daily news", at),
            "Friday 2026-09-11 digest for Daily news"
        );
        assert_eq!(
            schedule.expand(schedule.notion_title().unwrap(), "Daily news", at),
            "News — 2026-09-11"
        );

        let past = scheduled_team("  cron: \"0 0 8 * * * 2020\"\n  prompt: go\n")
            .unwrap()
            .schedule
            .unwrap();
        assert_eq!(past.next_fire(utc("2026-09-11T00:00:00Z")).unwrap(), None);
    }

    /// ADR 0038: the top-level `deliver` covers every run, with a per-minute default title; a
    /// routine's own `schedule.deliver` wins for scheduled runs only; dates follow the schedule's
    /// zone when there is one; and a blank title is refused like the routine's.
    #[test]
    fn team_delivery_covers_every_run_and_a_routine_keeps_its_own_title() {
        let at = utc("2026-09-10T23:30:00Z");
        let team = |extra: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nentrypoint: a\n{extra}agents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n"
            ))
        };
        let plain = team("").expect("no deliver block");
        assert_eq!(plain.deliver, None);
        assert_eq!(plain.notion_delivery_title(false, "Desk", at), None);
        assert_eq!(plain.notion_delivery_title(true, "Desk", at), None);

        let every = team("deliver:\n  notion: {}\nschedule:\n  cron: \"0 8 * * *\"\n  timezone: Asia/Singapore\n  prompt: go\n")
            .expect("team-level delivery");
        // 23:30 UTC on the 10th is 07:30 on the 11th in Singapore, for both kinds of run.
        assert_eq!(
            every.notion_delivery_title(false, "Desk", at).as_deref(),
            Some("Desk — 2026-09-11 07:30")
        );
        assert_eq!(
            every.notion_delivery_title(true, "Desk", at).as_deref(),
            Some("Desk — 2026-09-11 07:30"),
            "a routine without its own deliver uses the team's"
        );

        let both = team("deliver:\n  notion:\n    title: \"Answer {{weekday}} {{time}}\"\nschedule:\n  cron: \"0 8 * * *\"\n  timezone: Asia/Singapore\n  prompt: go\n  deliver:\n    notion:\n      title: \"Digest — {{date}}\"\n")
            .expect("both blocks");
        assert_eq!(
            both.notion_delivery_title(true, "Desk", at).as_deref(),
            Some("Digest — 2026-09-11")
        );
        assert_eq!(
            both.notion_delivery_title(false, "Desk", at).as_deref(),
            Some("Answer Friday 07:30")
        );

        let routine_only =
            team("schedule:\n  cron: \"0 8 * * *\"\n  prompt: go\n  deliver:\n    notion: {}\n")
                .expect("routine-only delivery");
        assert!(
            routine_only
                .notion_delivery_title(true, "Desk", at)
                .is_some()
        );
        assert_eq!(
            routine_only.notion_delivery_title(false, "Desk", at),
            None,
            "a routine's delivery is not every run's"
        );

        let blank = team("deliver:\n  notion:\n    title: \" \"\n").expect_err("blank title");
        assert!(format!("{blank:#}").contains("deliver.notion.title must not be empty"));
    }

    /// The shape of the daily-news routine: a daily fire in a named zone, delivered to Notion.
    /// Team files are operator data kept under each operator's own teams root, outside this
    /// repository, so the routine is pinned here rather than read from a live file.
    #[test]
    fn a_daily_routine_in_a_named_zone_parses() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nschedule:\n  cron: \"0 8 * * *\"\n  timezone: Asia/Singapore\n  prompt: \"Prepare the {{date}} digest.\"\n  enabled: true\n  deliver:\n    notion:\n      title: \"AI, tech & business news — {{date}}\"\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n",
        )
        .expect("a daily routine is a valid team");
        let schedule = team.schedule.expect("the routine declares a schedule");
        assert_eq!(schedule.describe(), "daily at 08:00 Asia/Singapore");
        assert_eq!(
            schedule.notion_title(),
            Some("AI, tech & business news — {{date}}")
        );
        assert!(schedule.enabled);
        assert!(schedule.next_fire(Utc::now()).unwrap().is_some());
    }

    #[test]
    fn describes_simple_shapes_and_falls_back_to_the_expression() {
        let describe = |cron: &str, timezone: Option<&str>| {
            ScheduleConfig {
                cron: cron.to_owned(),
                timezone: timezone.map(str::to_owned),
                prompt: "go".to_owned(),
                enabled: true,
                deliver: None,
            }
            .describe()
        };
        assert_eq!(describe("0 8 * * *", None), "daily at 08:00 local time");
        assert_eq!(
            describe("15 18 * * 1-5", Some("America/New_York")),
            "weekdays at 18:15 America/New_York"
        );
        assert_eq!(
            describe("0 7 * * 1", None),
            "every Monday at 07:00 local time"
        );
        assert_eq!(
            describe("0 7 * * Fri", None),
            "every Friday at 07:00 local time"
        );
        assert_eq!(
            describe("0 7 * * 0,6", None),
            "weekends at 07:00 local time"
        );
        assert_eq!(describe("30 * * * *", None), "hourly at :30 local time");
        assert_eq!(describe("*/5 * * * *", None), "*/5 * * * * local time");
        assert_eq!(describe("0 8 1 * *", Some("UTC")), "0 8 1 * * UTC");
    }

    /// ADR 0050: a Notion page is knowledge read from the operator's Notion instead of a path, and
    /// is named by its page id.
    #[test]
    fn a_notion_page_is_knowledge_named_by_its_page_id() {
        let team = |capability: &str| {
            TeamConfig::parse(&format!(
                "schemaVersion: 1\nid: t\nname: T\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: claude-agent-acp\n      cwd: .\n    model: test/model\n    capabilities:\n{capability}"
            ))
        };
        let page = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
        let parsed = team(&format!(
            "      - kind: knowledge\n        name: Roadmap\n        notion:\n          page: {page}\n"
        ))
        .expect("a Notion page");
        let notion = parsed.agents[0].capabilities[0]
            .notion
            .as_ref()
            .expect("notion");
        assert_eq!((notion.page.as_str(), notion.read.is_none()), (page, true));
        for (capability, expected) in [
            (
                format!("      - kind: skill\n        name: Roadmap\n        notion:\n          page: {page}\n"),
                "only knowledge can be read from Notion",
            ),
            (
                format!("      - kind: knowledge\n        name: Roadmap\n        path: notes.md\n        notion:\n          page: {page}\n"),
                "names both a path and a Notion page",
            ),
            (
                "      - kind: knowledge\n        name: Roadmap\n        notion:\n          page: roadmap\n".to_owned(),
                "not a Notion page id",
            ),
        ] {
            let error = team(&capability).expect_err(expected).to_string();
            assert!(error.contains(expected) && error.contains("agent \"a\""), "{error}");
        }
    }
}
