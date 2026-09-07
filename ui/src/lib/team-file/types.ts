// Mirrors schemas/team.schema.yaml (schemaVersion 1). Keep in sync with
// docs/TEAM_CONFIG.md's semantic rules and crates/loomwatch-backend/src/config.rs.

export interface SpawnConfig {
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export interface BudgetConfig {
  limitUsd: number
  warnAtPercent?: number
}

export interface GuardsConfig {
  maxDispatchDepth?: number
  maxConcurrentDispatches?: number
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

export interface AgentConfig {
  id: string
  name: string
  role: string
  spawn: SpawnConfig
  model: string
  budget: BudgetConfig
  allowRecruiting?: boolean
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

export interface TeamDocument {
  schemaVersion: 1
  id: string
  name: string
  entrypoint: string
  budget?: BudgetConfig
  guards?: GuardsConfig
  agents: AgentConfig[]
  edges: EdgeConfig[]
}
