import type { AllowSwitch } from '../team-file/types'
import type { Evidence } from '../watch/events'

/**
 * What a run used, one row per skill or tool rather than one per call (ADR 0041).
 *
 * The recorded evidence has a card per call, and the add panel used to list most of them as if
 * each were a tool: five web searches became five "Search …" rows, and the permission answers
 * LoomWatch gave for them became five more. A row here is something an operator could connect,
 * switch on or look up in Build, named the way Build names it.
 */
export interface UsedInRun {
  key: string
  kind: 'skill' | 'tool'
  name: string
  /**
   * Where it comes from. `app`: built into the agent's AI app (web search, commands), so Build has
   * no card for it, only an "Allowed without asking" switch. `connected`: an MCP server's tool.
   * `team`: LoomWatch's own (Team Bus, team memory). `skill`: a skill Build lists by name.
   */
  origin: 'app' | 'connected' | 'team' | 'skill'
  /** The "Allowed without asking" switch that governs an app's own tool, when one does. */
  allow: AllowSwitch | null
  /** Calls, per agent id, in the order the agents first used it. */
  agents: { id: string; calls: number }[]
  calls: number
  /** Calls LoomWatch declined to permit (ADR 0037), and per agent, so the row can say whose. */
  refused: number
  refusedBy: string[]
  failed: number
  /** What it does past the run, for an outward tool an agent used without asking (ADR 0044). */
  outward: string | null
  /** The first recorded card, which a click reveals on the canvas. */
  evidenceId: string
}

/**
 * Claude Code's own tools that reach past the run, by recorded name, and what each does (ADR 0044).
 * The daemon starts every run agent without them (`WITHHELD_CLAUDE_TOOLS` in `permissions.rs`), so
 * a call to one ran without asking: its app ignored that, or the run is older than the rule.
 */
export const OUTWARD_APP_TOOLS: Readonly<Record<string, string>> = {
  Artifact: 'publishes to your claude.ai account',
  ArtifactComments: 'comments on your claude.ai artifacts',
  ArtifactData: 'writes to your claude.ai artifacts',
  ArtifactCheck: 'checks your claude.ai artifacts',
  DesignSync: 'syncs with your claude.ai designs',
  RemoteTrigger: 'changes your cloud routines',
  CronCreate: 'schedules work for later',
  CronDelete: 'removes scheduled work',
  CronList: 'reads your scheduled work',
  ScheduleWakeup: 'schedules work for later',
  PushNotification: 'sends notifications to your devices',
  SendMessage: 'messages your other Claude sessions',
  ListAgents: 'lists your other Claude sessions',
}

/** The outward tool a call used, or `null` for any other evidence. */
export function outwardTool(item: Evidence): string | null {
  if (item.kind === 'permission' || !item.callId) return null
  const name = payloadString(item, 'name')
  return name !== null && Object.hasOwn(OUTWARD_APP_TOOLS, name) ? name : null
}

/** An agent's outward calls that did not fail, by tool, in the order it first used each. */
export function outwardCalls(items: readonly Evidence[]): Map<string, Evidence[]> {
  const byTool = new Map<string, Evidence[]>()
  for (const item of items) {
    const tool = outwardTool(item)
    if (tool === null || item.status === 'failed' || item.status === 'rejected') continue
    byTool.set(tool, [...(byTool.get(tool) ?? []), item])
  }
  return byTool
}

/** Claude Code's own tools, by the name its adapter records, in the words Build uses. */
const APP_TOOLS: Readonly<Record<string, { name: string; allow?: AllowSwitch }>> = {
  WebSearch: { name: 'Web search', allow: 'web' },
  WebFetch: { name: 'Web fetch', allow: 'web' },
  Bash: { name: 'Commands', allow: 'commands' },
  BashOutput: { name: 'Commands', allow: 'commands' },
  KillShell: { name: 'Commands', allow: 'commands' },
  Edit: { name: 'Edit files', allow: 'edits' },
  MultiEdit: { name: 'Edit files', allow: 'edits' },
  Write: { name: 'Edit files', allow: 'edits' },
  NotebookEdit: { name: 'Edit files', allow: 'edits' },
  Read: { name: 'Read files' },
  Glob: { name: 'Find files' },
  Grep: { name: 'Find files' },
  ToolSearch: { name: 'Tool search' },
  Task: { name: 'Sub-agents' },
  TodoWrite: { name: 'To-do list' },
}

/** The same tools from an app that records no name, only an ACP kind and a title (Codex, Gemini). */
function byKind(toolKind: string | null, title: string): { name: string; allow?: AllowSwitch } {
  if (/^web search\b/i.test(title) || /^search\s+["“]/i.test(title)) return { name: 'Web search', allow: 'web' }
  switch (toolKind) {
    case 'fetch': return /^fetch\b|https?:\/\//i.test(title) ? { name: 'Web fetch', allow: 'web' } : { name: 'Web search', allow: 'web' }
    case 'execute': return { name: 'Commands', allow: 'commands' }
    case 'edit': case 'delete': case 'move': return { name: 'Edit files', allow: 'edits' }
    case 'read': return { name: 'Read files' }
    case 'search': return { name: 'Find files' }
    default: return { name: title || 'Tool' }
  }
}

const MEMORY_TOOLS = new Set(['memory_search', 'memory_read', 'memory_write', 'checkpoint'])

function payloadString(item: Evidence, key: string): string | null {
  for (const event of item.events) {
    const value = event.payload[key]
    if (typeof value === 'string') return value
    const call = event.payload.toolCall
    if (call && typeof call === 'object' && typeof (call as Record<string, unknown>)[key] === 'string') return (call as Record<string, string>)[key]
  }
  return null
}

/** What a tool call or a permission request was about, as a row identity. */
function toolIdentity(item: Evidence): Pick<UsedInRun, 'key' | 'name' | 'origin' | 'allow'> {
  const rawName = payloadString(item, 'name')
  const title = payloadString(item, 'title') ?? item.name
  // A permission request carries the ACP kind on its tool call; a call carries it as toolKind.
  const toolKind = item.toolKind ?? payloadString(item, 'kind')
  if (rawName && MEMORY_TOOLS.has(rawName)) return { key: 'team:memory', name: 'Team memory', origin: 'team', allow: null }
  // `mcp__<server>__<tool>` from Claude Code; Codex titles the same call `mcp.<server>.<tool>`.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(rawName ?? '') ?? /^mcp\.([\w-]+)\.(.+)$/.exec(title)
  if (mcp) {
    const [server, tool] = [mcp[1], mcp[2].replace(/_/g, ' ')]
    const team = server === 'loomwatch-team-bus'
    return { key: `mcp:${server}:${tool}`.toLowerCase(), name: team ? `Team Bus · ${tool}` : `${server} · ${tool}`, origin: team ? 'team' : 'connected', allow: null }
  }
  const known = (rawName && APP_TOOLS[rawName]) || (rawName ? { name: rawName } : byKind(toolKind, title))
  return { key: `app:${known.name}`.toLowerCase(), name: known.name, origin: 'app', allow: known.allow ?? null }
}

/** A permission answer is a refusal unless an allow option was selected (ADR 0037 picks allow_once). */
function refusedPermission(item: Evidence): boolean {
  if (item.status === 'rejected') return true
  const outcome = item.rawOutput && typeof item.rawOutput === 'object' ? (item.rawOutput as Record<string, unknown>) : null
  const option = typeof outcome?.optionId === 'string' ? outcome.optionId : ''
  return item.status === 'succeeded' && !/^allow/i.test(option)
}

export function usedInRun(evidence: readonly Evidence[]): UsedInRun[] {
  const rows = new Map<string, UsedInRun>()
  const rowOfCall = new Map<string, UsedInRun>()
  const add = (identity: Pick<UsedInRun, 'key' | 'name' | 'origin' | 'allow'>, kind: UsedInRun['kind'], item: Evidence) => {
    let row = rows.get(identity.key)
    if (!row) {
      row = { ...identity, kind, agents: [], calls: 0, refused: 0, refusedBy: [], failed: 0, outward: null, evidenceId: item.id }
      rows.set(identity.key, row)
    }
    const outward = outwardTool(item)
    if (outward !== null && item.status !== 'failed' && item.status !== 'rejected') row.outward = OUTWARD_APP_TOOLS[outward]
    row.calls += 1
    const agent = row.agents.find((entry) => entry.id === item.agentId)
    if (agent) agent.calls += 1
    else row.agents.push({ id: item.agentId, calls: 1 })
    if (item.status === 'failed') row.failed += 1
    return row
  }
  const refuse = (row: UsedInRun, agentId: string) => {
    row.refused += 1
    if (!row.refusedBy.includes(agentId)) row.refusedBy.push(agentId)
  }

  // Calls first, so each permission answer lands on the call it was asked for.
  for (const item of evidence) {
    if (item.kind === 'permission' || item.kind === 'plan' || item.kind === 'delegation') continue
    if (item.kind === 'skill') { add({ key: `skill:${item.name}`.toLowerCase(), name: item.name, origin: 'skill', allow: null }, 'skill', item); continue }
    // Evidence without a call is what the run was handed — the operator's own answer, today — not
    // something an agent used. A folder it read or a page it fetched is a call: Read files, Web fetch.
    if (!item.callId) continue
    const row = add(toolIdentity(item), 'tool', item)
    rowOfCall.set(`${item.agentId}:${item.callId}`, row)
  }
  for (const item of evidence) {
    if (item.kind !== 'permission' || !refusedPermission(item)) continue
    const row = (item.callId ? rowOfCall.get(`${item.agentId}:${item.callId}`) : undefined) ?? rows.get(toolIdentity(item).key)
    if (row) { refuse(row, item.agentId); continue }
    // Asked and refused before any call was recorded: the request is the only trace of the tool.
    const added = add(toolIdentity(item), 'tool', item)
    refuse(added, item.agentId)
  }
  return [...rows.values()]
}
