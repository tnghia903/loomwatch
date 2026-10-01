// Mirrors schemas/team.schema.yaml (schemaVersion 1). Keep in sync with
// docs/TEAM_CONFIG.md's semantic rules and crates/loomwatch-backend/src/config.rs.

export interface SpawnConfig {
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export interface GuardsConfig {
  maxDispatchDepth?: number
  maxConcurrentDispatches?: number
}

export interface ScheduleConfig {
  cron: string
  timezone?: string
  prompt: string
  enabled?: boolean
  deliver?: { notion?: { title?: string } }
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

/** Only `skill` is executable today; see `schemas/team.schema.yaml` `$defs/Capability`. */
export interface CapabilityRef {
  kind: 'skill'
  name: string
}

export interface AgentConfig {
  id: string
  name: string
  role: string
  kind?: 'harness' | 'operator'
  spawn?: SpawnConfig
  model?: string
  thinkingEffort?: string
  allowRecruiting?: boolean
  /** Capabilities the daemon delivers into this agent's workspace before the run. Executable, so
      it lives in the team file and saves explicitly — unlike the card positions in the sidecar. */
  capabilities?: CapabilityRef[]
  /** Per-agent memory overrides; the team's `memory:` block applies when absent. */
  memory?: { brief?: boolean; deliverAs?: 'native-file' | 'packet-only' }
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
  entrypoint: string
  /** Optional explicit owner of the canonical team output. */
  responder?: string
  guards?: GuardsConfig
  conversation?: { stop?: { keepAliveMinutes?: number }; [key: string]: unknown }
  schedule?: ScheduleConfig
  /** What the team knows before a run starts. Executable configuration, so it lives here. */
  memory?: MemoryConfig
  agents: AgentConfig[]
  edges: EdgeConfig[]
}
