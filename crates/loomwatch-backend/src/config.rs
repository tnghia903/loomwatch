use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Local, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Deserialize;

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
    pub budget: Option<BudgetConfig>,
    #[serde(default)]
    pub guards: GuardsConfig,
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub edges: Vec<EdgeConfig>,
    /// Optional routine: run this team on a cron schedule with a fixed prompt and deliver
    /// the canonical reply (see `docs/decisions/0010-routines-and-notion-delivery.md`).
    #[serde(default)]
    pub schedule: Option<ScheduleConfig>,
    /// How much a stage pushes to the next one, and how much it may pull back.
    #[serde(default)]
    pub conversation: ConversationConfig,
    /// What the team knows before a run starts, and how it reaches an agent.
    ///
    /// `None` — the block is absent — is the only default, and it keeps every prompt
    /// byte-for-byte what it was before memory existed. See `docs/TEAM_MEMORY.md`.
    #[serde(default)]
    pub memory: Option<MemoryConfig>,
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
    /// How long a session may idle while the person at the keyboard decides.
    pub stop: StopConfig,
}

/// Bounds on a review stop or a parked `ask_user` (`docs/TEAM_MEMORY.md`, "Rules that keep this
/// safe"). Only the second tier of decision 7 reads this: a harness that advertises
/// `loadSession` is closed while the operator thinks and costs no process at all, so no window
/// applies to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StopConfig {
    /// Minutes a kept-alive session idles before `LoomWatch` asks it for a checkpoint and releases
    /// it. A live process at zero token cost is still a live process.
    pub keep_alive_minutes: u32,
}

impl Default for StopConfig {
    fn default() -> Self {
        // Decision 7 settled on 15, down from 30: long enough to answer a question you meant to
        // answer, short enough that a stop you walked away from does not hold a harness all day.
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
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AskConfig {
    /// How many questions one stage may put to the stage before it.
    pub max_per_stage: u32,
}

impl Default for BriefConfig {
    fn default() -> Self {
        // Roughly 300 tokens of summary plus eight findings: enough for a stage to start work
        // without the transcript, small enough that a long pipeline does not accumulate one.
        Self {
            summary_chars: 1200,
            max_findings: 8,
        }
    }
}

impl Default for AskConfig {
    fn default() -> Self {
        // Three is enough to recover what a brief cut, and few enough that a stage cannot turn the
        // predecessor into a search engine.
        Self { max_per_stage: 3 }
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

/// Where a routine's canonical reply goes once the run succeeds.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverConfig {
    #[serde(default)]
    pub notion: Option<NotionDeliverConfig>,
}

/// Notion delivery: a child page of the connected destination, titled from a template.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDeliverConfig {
    /// Page title template; defaults to [`DEFAULT_NOTION_TITLE`].
    #[serde(default)]
    pub title: Option<String>,
}

/// Title a delivered page gets when the team file names none.
pub const DEFAULT_NOTION_TITLE: &str = "{{team}} — {{date}}";

/// What kind of node an `agents[]` entry is.
///
/// `operator` is the person at the keyboard standing in the pipeline (`docs/TEAM_MEMORY.md`, "The
/// operator is a node"): it has an id, it sits on edges, it takes part in the topological order,
/// and instead of a harness it has a **question** — its `role` — which is what the panel shows
/// when the pipeline reaches it. `spawn`, `model` and `budget` are absent for this kind, because
/// there is nothing to spawn, no model to select and no provider to bill.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    /// An ACP harness. The default, and what every team file written before Canvas C is.
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

#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "RawAgent")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub role: String,
    /// `harness` unless the entry says otherwise. See [`AgentKind`].
    pub kind: AgentKind,
    /// Empty `cmd` for an operator node, which spawns nothing. Every read of this is behind a
    /// `kind` check or behind the loader's refusal of a harness agent that declared none.
    pub spawn: SpawnConfig,
    pub model: String,
    pub thinking_effort: Option<String>,
    pub budget: BudgetConfig,
    pub allow_recruiting: bool,
    pub capabilities: Vec<CapabilityRef>,
    /// Per-agent memory overrides; the team's `memory:` block applies when absent.
    pub memory: Option<AgentMemoryConfig>,
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
    #[serde(default)]
    budget: Option<BudgetConfig>,
    #[serde(default = "default_allow_recruiting")]
    allow_recruiting: bool,
    #[serde(default)]
    capabilities: Vec<CapabilityRef>,
    #[serde(default)]
    memory: Option<AgentMemoryConfig>,
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
                    ("budget", raw.budget.is_some()),
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
                    budget: BudgetConfig::unbilled(),
                    allow_recruiting: false,
                    capabilities: raw.capabilities,
                    memory: raw.memory,
                })
            }
            AgentKind::Harness => {
                let spawn = raw.spawn.ok_or_else(|| {
                    format!("agent {id:?} is missing `spawn`, which says how to start its harness.")
                })?;
                let model = raw.model.ok_or_else(|| {
                    format!("agent {id:?} is missing `model`, the harness's model selector.")
                })?;
                let budget = raw.budget.ok_or_else(|| {
                    format!(
                        "agent {id:?} is missing `budget`, the pre-delegation admission threshold."
                    )
                })?;
                Ok(Self {
                    id,
                    name: raw.name.unwrap_or_default(),
                    role: raw.role.unwrap_or_default(),
                    kind: AgentKind::Harness,
                    spawn,
                    model,
                    thinking_effort: raw.thinking_effort,
                    budget,
                    allow_recruiting: raw.allow_recruiting,
                    capabilities: raw.capabilities,
                    memory: raw.memory,
                })
            }
        }
    }
}

/// A capability the operator wired to an agent on the canvas. Naming one grants nothing on its
/// own (TNG122 §8 item 4): the daemon materialises it into the agent's workspace and the harness
/// still authorises every use.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRef {
    pub kind: CapabilityKind,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityKind {
    Skill,
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
    matches!(
        effort,
        "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
    .then_some(base)
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpawnConfig {
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

impl Default for SpawnConfig {
    /// What an operator node carries: nothing to run, and the team file's own directory. Only
    /// reachable through [`AgentConfig`]'s `kind: operator` branch — a harness agent that omits
    /// `spawn` is refused rather than defaulted.
    fn default() -> Self {
        Self {
            cmd: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: PathBuf::from("."),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetConfig {
    pub limit_usd: f64,
    #[serde(default = "default_warn_at_percent")]
    pub warn_at_percent: u8,
}

impl BudgetConfig {
    /// The budget of a node that cannot spend: an operator stop. Zero rather than infinity,
    /// because a zero limit is already the team file's way of saying "never admit this through
    /// delegation", and an operator node is exactly that.
    #[must_use]
    pub const fn unbilled() -> Self {
        Self {
            limit_usd: 0.0,
            warn_at_percent: 100,
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

const fn default_warn_at_percent() -> u8 {
    80
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
        self.deliver
            .as_ref()?
            .notion
            .as_ref()
            .map(|notion| notion.title.as_deref().unwrap_or(DEFAULT_NOTION_TITLE))
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

    /// Expand `{{date}}`, `{{weekday}}` and `{{team}}` for a fire at `at`, reading the
    /// calendar in the schedule's zone. A zone that does not parse falls back to local.
    #[must_use]
    pub fn expand(&self, template: &str, team_name: &str, at: DateTime<Utc>) -> String {
        let (date, weekday) = match self.zone().ok().flatten() {
            Some(zone) => calendar_stamp(&at.with_timezone(&zone)),
            None => calendar_stamp(&at.with_timezone(&Local)),
        };
        template
            .replace("{{date}}", &date)
            .replace("{{weekday}}", &weekday)
            .replace("{{team}}", team_name)
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

fn calendar_stamp<Z: TimeZone>(at: &DateTime<Z>) -> (String, String)
where
    Z::Offset: Display,
{
    (
        at.format("%Y-%m-%d").to_string(),
        at.format("%A").to_string(),
    )
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
        let team: Self = serde_yaml::from_str(source).context("invalid team YAML")?;
        if team.schema_version != 1 {
            bail!("unsupported team schema version {}", team.schema_version);
        }
        team.entrypoint_agent()?;
        // Before `pipeline_order`, so "the entrypoint is a stop" is reported as what it is rather
        // than as the incoming-edge violation it also happens to be.
        team.validate_operator_nodes()?;
        team.responder_id()?;
        if let Some(schedule) = &team.schedule {
            schedule.validate()?;
        }
        Ok(team)
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
        Ok(self
            .pipeline_order()?
            .last()
            .cloned()
            .unwrap_or_else(|| self.entrypoint.clone()))
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
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
        )
        .expect("valid config");
        assert_eq!(team.entrypoint_agent().expect("entrypoint").id, "a");
    }

    #[test]
    fn resolves_an_explicit_pipeline_responder() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nresponder: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n  - id: b\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\nedges:\n  - {from: a, to: b, layer: configured, kind: sequence, ts: \"2026-09-10T00:00:00Z\"}\n",
        )
        .expect("explicit pipeline responder is valid");
        assert_eq!(team.responder_id().expect("responder"), "a");
    }

    #[test]
    fn rejects_an_unknown_or_non_entrypoint_team_responder() {
        let unknown = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nresponder: ghost\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\nedges: []\n",
        )
        .expect_err("unknown responder must be rejected");
        assert!(
            unknown
                .to_string()
                .contains("responder agent \"ghost\" does not exist")
        );

        let mismatch = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nresponder: b\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n  - id: b\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\nedges: []\n",
        )
        .expect_err("team-mode responder must be the entrypoint");
        assert!(mismatch.to_string().contains("must match entrypoint"));
    }

    #[test]
    fn stores_thinking_effort_separately_and_builds_the_acp_selector() {
        let team: TeamConfig = serde_yaml::from_str(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: vendor/deep\n    thinkingEffort: high\n    budget:\n      limitUsd: 1\n",
        )
        .expect("valid config");
        assert_eq!(team.agents[0].thinking_effort.as_deref(), Some("high"));
        assert_eq!(team.agents[0].model_selector(), "vendor/deep[high]");

        let mut legacy = team.agents[0].clone();
        legacy.model = "vendor/deep[low]".into();
        legacy.thinking_effort = Some("xhigh".into());
        assert_eq!(legacy.model_selector(), "vendor/deep[xhigh]");
    }

    #[test]
    fn parses_team_and_agent_budgets_and_edges() {
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
edges:
  - from: a
    to: b
    layer: configured
    kind: sequence
    ts: "2026-09-06T00:00:00Z"
"#,
        )
        .expect("valid config");

        assert_eq!(team.budget.expect("team budget").warn_at_percent, 80);
        assert_eq!(team.guards.max_dispatch_depth, 8);
        assert_eq!(team.guards.max_concurrent_dispatches, 8);
        assert!((team.agents[0].budget.limit_usd - 3.0).abs() < f64::EPSILON);
        assert_eq!(team.agents[0].budget.warn_at_percent, 70);
        assert!(team.agents[0].allow_recruiting);
        assert_eq!(team.edges[0].from, "a");
        assert_eq!(team.edges[0].to, "b");
    }

    fn pipeline_team(entrypoint: &str, edges_yaml: &str) -> TeamConfig {
        serde_yaml::from_str(&format!(
            "schemaVersion: 1\nentrypoint: {entrypoint}\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n  - id: b\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n  - id: c\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\nedges:\n{edges_yaml}\n"
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
            "schemaVersion: 1\nentrypoint: a\nguards:\n  maxDispatchDepth: 3\n  maxConcurrentDispatches: 5\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
        )
        .expect("valid config");

        assert_eq!(team.guards.max_dispatch_depth, 3);
        assert_eq!(team.guards.max_concurrent_dispatches, 5);
    }

    const SOLO_AGENT: &str = "agents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n";

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

    /// The shape of the daily-news routine: a daily fire in a named zone, delivered to Notion.
    /// Team files are operator data kept under each operator's own teams root, outside this
    /// repository, so the routine is pinned here rather than read from a live file.
    #[test]
    fn a_daily_routine_in_a_named_zone_parses() {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nschedule:\n  cron: \"0 8 * * *\"\n  timezone: Asia/Singapore\n  prompt: \"Prepare the {{date}} digest.\"\n  enabled: true\n  deliver:\n    notion:\n      title: \"AI, tech & business news — {{date}}\"\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
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
}
