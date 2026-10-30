// Mirrors schemas/team.schema.yaml (schemaVersion 1). Keep in sync with
// docs/TEAM_CONFIG.md's semantic rules and crates/loomwatch-backend/src/config.rs.

/**
 * Where an agent works. `cmd`, `args` and `env` are retired: they named the AI app an earlier
 * LoomWatch started, and a file written then still has them. They are read and ignored, and
 * nothing writes them again.
 */
export interface SpawnConfig {
  cwd: string
  cmd?: string
  args?: string[]
  env?: Record<string, string>
}

export interface GuardsConfig {
  maxDispatchDepth?: number
  maxConcurrentDispatches?: number
  maxHelpers?: number
  /** How many of My agents the starting agent is shown when it may bring one in (ADR 0092). `0`, the default, is off. */
  myAgents?: number
}

/** Where a run's answer goes once it succeeds. `$defs/Deliver`; ADR 0010 and ADR 0038. */
export interface DeliverConfig {
  notion?: { title?: string }
}

export interface ScheduleConfig {
  cron: string
  timezone?: string
  prompt: string
  enabled?: boolean
  deliver?: DeliverConfig
  /** Minutes to wait before each new try of a timed run that couldn't reach its AI source. */
  retryAfterMinutes?: number[]
}

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'stopped'
  | 'unavailable'

/**
 * What the daemon delivers to an agent before it runs; see `schemas/team.schema.yaml`
 * `$defs/Capability`. A skill is copied into its workspace (ADR 0012), a chosen folder or file's
 * contents are supplied in its prompt and a tool is handed to its harness as an MCP server (ADR
 * 0029). Team memory is never a capability: it is wired through `memory.inherits`.
 */
/**
 * The agent in My agents this one is (`<teams root>/.jobs/<agent>.yaml`, ADR 0094). Its own fields
 * are filled in from there when the team is read (`lib/team-file/myAgents.ts`); the team file keeps
 * only what is the team's. `version` is what an earlier LoomWatch wrote, read and ignored.
 */
export interface AgentLink {
  agent: string
  version?: number
}

export interface CapabilityRef {
  kind: 'skill' | 'knowledge' | 'tool'
  name: string
  /** Knowledge only, and required for it (ADR 0035, 0036): a folder linked where it is, or a file
      added beside the team file (`<team>.files/…`, relative to the team file's folder). `name` is
      then only a label. Knowledge without a path fails the run. */
  path?: string
  /** Knowledge only, instead of `path` (ADR 0050): a Notion page the run reads through the
      operator's own Notion connection when it starts. `name` is the page's title when chosen. */
  notion?: NotionPageRef
  /** Tool only (ADR 0069): the calls of this connected tool the agent may make without asking, by
      the tool's own name for each. Every other call asks you first. */
  alwaysAllow?: string[]
}

/** A skill or tool the agent's app has of its own, turned off for the agent (ADR 0060). A tool is
    named by its MCP server, as the app lists it. */
export interface TurnedOff {
  kind: 'skill' | 'tool'
  name: string
}

/** Which Notion page a knowledge entry or card reads (ADR 0050). */
export interface NotionPageRef {
  page: string
}

/**
 * ADR 0037: LoomWatch answers every permission request an agent's app makes, approving by itself
 * only what is switched on here; anything else waits for the operator during the run (ADR 0040).
 */
export interface AgentAllow {
  /** Search the web and read web pages. */
  web?: boolean
  /** Create and change files inside its own working folder. */
  edits?: boolean
  /** Run commands in a terminal. */
  commands?: boolean
}

export type AllowSwitch = keyof AgentAllow

/**
 * Who decides a command an agent's switches leave open (ADR 0061): `ask` puts it to you during the
 * run; `auto` runs it when it only reads files or downloads a page, and asks you about the rest.
 */
export type PermissionMode = 'ask' | 'auto'

/** The team's `permissions:` block (ADR 0061). */
export interface TeamPermissions {
  mode?: PermissionMode
}

/** What one run may spend on model calls, in US dollars (ADR 0068). */
export interface SpendConfig {
  perRun?: number
  /** How much web reading one model call may do; each figure left out is the team's, then the default. */
  web?: WebLimitsConfig
}

/** `spend.web`: what one model call may read from the web (`schemas/team.schema.yaml` `WebLimits`). */
export interface WebLimitsConfig {
  /** How much of one page is read, in tokens. Default 16000. */
  maxPageTokens?: number
  /** Pages one model call may read. Absent: OpenRouter's own limit. */
  maxPages?: number
  /** Searches one model call may run. Absent: OpenRouter's own limit. */
  maxSearches?: number
  /** Searches and page reads together in one model call. Absent: OpenRouter's 30. */
  maxSteps?: number
}

/**
 * A check step's `sendBack` (ADR 0062): send what is not met back to the checked agent up to
 * `rounds` times, checking again after each; then, if checks are still not met, show the answer
 * anyway (`answer`, the default) or stop and ask the person (`ask`).
 */
export interface SendBack {
  rounds?: number
  whenStillNotMet?: 'answer' | 'ask'
}

/**
 * An agent's part in one team (ADR 0097): a line or two of what the team needs from it, and that
 * part's own Done when items. At most 1000 characters and five items, as the schema says.
 */
export interface AgentPart {
  text?: string
  doneWhen?: string[]
}

export interface AgentConfig {
  id: string
  name: string
  role: string
  kind?: 'harness' | 'operator'
  spawn?: SpawnConfig
  model?: string
  /** Its `model` follows the model suggested for it (ADR 0072): when its configuration changes,
      the app moves it to the new suggestion. Picking any other model takes this out. Absent: the
      model is the one picked. The daemon never reads it; a run uses `model`. */
  followsSuggestion?: boolean
  thinkingEffort?: string
  /** What the finished result must satisfy (ADR 0062): checked before it replies, and anything
      it could not meet is listed under "Not met". At most five short lines. */
  doneWhen?: string[]
  /** What this team needs from it (ADR 0097): the team's, never the agent's, so it stays in the
      team file when the agent is saved to My agents. Its items come first in the Done when a run
      reads. */
  part?: AgentPart
  /** Makes it a check step (ADR 0062): the agent whose work it checks, its direct predecessor. */
  checks?: string
  /** With `checks`: what happens when a check is not met. Read it through `sendBackOf`. */
  sendBack?: SendBack
  /** The older form of `sendBack: { rounds: 1, whenStillNotMet: 'answer' }`, still read. The
      editor writes `sendBack` and removes this when the setting is changed. */
  sendBackOnce?: boolean
  allowRecruiting?: boolean
  /** `false`: as the starting agent, or working alone, it brings in none of the person's other
      agents from My agents (ADR 0092). The agent's own switch, filled in from My agents. */
  allowMyAgents?: boolean
  /** Capabilities the daemon delivers into this agent's workspace before the run. Executable, so
      it lives in the team file and saves explicitly — unlike the card positions in the sidecar. */
  capabilities?: CapabilityRef[]
  /** Per-agent memory overrides; the team's `memory:` block applies when absent. */
  memory?: { brief?: boolean; deliverAs?: 'native-file' | 'packet-only' }
  /** What it may do without asking (ADR 0037). Absent, or a switch left out, means off. */
  allow?: AgentAllow
  /** Its own guard on what one run may spend on it (ADR 0068). Absent: no guard. */
  spend?: SpendConfig
  /** Skills and tools the operator turned off for it by taking them off the canvas (ADR 0060).
      Absent means none: the agent chooses from every skill in LoomWatch's library. */
  turnedOff?: TurnedOff[]
  /** The agent in My agents this one is. Absent only on a team not yet saved since ADR 0094, or
      one from elsewhere: saving it makes each of its agents one of My agents. */
  from?: AgentLink
  // Runtime-only annotation. Team-file writers must never set this field;
  // it is exposed here only because readers must tolerate it on load.
  status?: AgentStatus
}

export type EdgeLayer = 'configured' | 'observed'
export type EdgeKind = 'sequence' | 'dispatch' | 'ask' | 'handoff'

export interface EdgeConfig {
  from: string
  to: string
  layer: EdgeLayer
  kind: EdgeKind
  ts: string
}

/** One Brief file and who it is supplied to. `schemas/team.schema.yaml` `$defs/BriefEntry`. */
export interface BriefEntryConfig {
  /** Markdown file, relative to the team file. */
  path: string
  /** Agent ids this entry is supplied to; absent means the whole team. */
  appliesTo?: string[]
}

/** The `memory:` block. See docs/TEAM_MEMORY.md and ADR 0014. */
export interface MemoryConfig {
  enabled?: boolean
  brief?: BriefEntryConfig[]
  /** Other teams' memory this team reads. Read-only by construction; cycles refused at load. */
  inherits?: InheritConfig[]
  notebook?: { enabled?: boolean; keep?: 'review' | 'never' }
  packet?: { maxChars?: number }
  deliverAs?: 'native-file' | 'packet-only'
}

/** One inherited memory: another team by id, or an imported pack folder. Exactly one of the two. */
export interface InheritConfig {
  team?: string
  pack?: string
  include?: ('brief' | 'kept' | 'both')[]
  appliesTo?: string[]
  /** Inherited Brief entries this team declines, by the path the origin spells them with. */
  exclude?: string[]
}

export interface TeamDocument {
  schemaVersion: 1
  id: string
  name: string
  /** The project this team works in (ADR 0097): `<teams root>/.projects/<id>.yaml`. */
  project?: string
  /** The team this file is one place of (ADR 0103): every file naming the same id shares its
      setup, and keeps its own id, project, schedule, delivery and Brief. */
  shares?: string
  entrypoint: string
  /** Optional explicit owner of the canonical team output. */
  responder?: string
  guards?: GuardsConfig
  /** `stop.keepAliveMinutes` is accepted from older team files and read by nothing. */
  conversation?: { stop?: { keepAliveMinutes?: number }; [key: string]: unknown }
  schedule?: ScheduleConfig
  /** Where every successful run's answer goes, whoever started it (ADR 0038). */
  deliver?: DeliverConfig
  /** What the team knows before a run starts. Executable configuration, so it lives here. */
  memory?: MemoryConfig
  /** Who decides what the agents' switches leave open (ADR 0061). Absent asks you. */
  permissions?: TeamPermissions
  /** What one run may spend (ADR 0068). Absent: no limit; new teams are written with $1.00. */
  spend?: SpendConfig
  agents: AgentConfig[]
  edges: EdgeConfig[]
}
