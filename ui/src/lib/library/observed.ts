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

/** LoomWatch's own MCP server, which every agent is handed (`RESERVED_SERVER` in `delivery.rs`). */
export const TEAM_BUS_SERVER = 'loomwatch-team-bus'

/**
 * What the MCP servers an AI app brings by itself do past the run, for the ones seen so far
 * (ADR 0047). The daemon starts a Codex run agent without the plugins and the `ChatGPT` apps they
 * come from. The rule is whose server it is, not this list: a call to any server LoomWatch did not
 * connect, made without asking, is flagged, and one not listed here is flagged in general words.
 */
export const OUTWARD_APP_SERVERS: Readonly<Record<string, string>> = {
  cua_repl: 'controls the browser and apps on your computer',
  node_repl: 'runs code that can control your browser',
  codex_apps: 'uses the apps on your ChatGPT account',
}

/** What a row says a server LoomWatch did not connect does, when nothing more is known. */
export const UNCONNECTED_SERVER = 'came with the app, not from LoomWatch'

/** A tool an agent reached past the run with, without asking (ADR 0044, ADR 0047). */
export interface OutwardUse {
  /** The app tool's name (`Artifact`), or the MCP server's (`cua_repl`). */
  tool: string
  /** What it does past the run, or `null` for a server nothing more is known about. */
  does: string | null
}

/** The MCP server and tool a call or a request was about, or `null` for anything else. */
function mcpCall(item: Evidence): { server: string; tool: string } | null {
  // `mcp__<server>__<tool>` from Claude Code; Codex titles the same call `mcp.<server>.<tool>`.
  const match = /^mcp__(.+?)__(.+)$/.exec(payloadString(item, 'name') ?? '') ?? /^mcp\.([\w-]+)\.(.+)$/.exec(payloadString(item, 'title') ?? item.name)
  return match ? { server: match[1], tool: match[2] } : null
}

/** Whether a call's MCP server is one LoomWatch handed its agent: the Team Bus, or `connected`. */
function handedOver(server: string, connected: readonly string[]): boolean {
  return server === TEAM_BUS_SERVER || connected.includes(server)
}

/**
 * The outward tool a call used, or `null` for any other evidence. `connected` names the servers
 * LoomWatch connected to the call's agent; `asked` holds `agentId:callId` for every call its app
 * asked about.
 *
 * One of Claude Code's withheld tools counts unless it failed. A server LoomWatch did not connect
 * counts unless its app asked first: Codex runs a tool that calls itself read-only without asking,
 * and a call to a code runner that failed may still have acted before it failed.
 */
export function outwardTool(item: Evidence, connected: readonly string[] = [], asked: ReadonlySet<string> = new Set()): OutwardUse | null {
  if (item.kind === 'permission' || !item.callId || item.status === 'rejected') return null
  const name = payloadString(item, 'name')
  if (name !== null && Object.hasOwn(OUTWARD_APP_TOOLS, name)) return item.status === 'failed' ? null : { tool: name, does: OUTWARD_APP_TOOLS[name] }
  const server = mcpCall(item)?.server ?? null
  if (server === null || handedOver(server, connected) || asked.has(`${item.agentId}:${item.callId}`)) return null
  return { tool: server, does: Object.hasOwn(OUTWARD_APP_SERVERS, server) ? OUTWARD_APP_SERVERS[server] : null }
}

/** `agentId:callId` for every call an app asked about, so a call that asked is not outward. */
function askedCalls(items: readonly Evidence[]): Set<string> {
  return new Set(items.flatMap((item) => (item.kind === 'permission' && item.callId ? [`${item.agentId}:${item.callId}`] : [])))
}

/** One outward tool's calls, and whether any of them finished. */
export interface OutwardCalls extends OutwardUse {
  calls: Evidence[]
  completed: boolean
}

/**
 * An agent's outward calls, by tool, in the order it first used each. `connected` names the
 * servers LoomWatch connected to it, from its run record (`ProjectedAgent.connectedServers`).
 */
export function outwardCalls(items: readonly Evidence[], connected: readonly string[] = []): Map<string, OutwardCalls> {
  const asked = askedCalls(items)
  const byTool = new Map<string, OutwardCalls>()
  for (const item of items) {
    const use = outwardTool(item, connected, asked)
    if (use === null) continue
    const entry = byTool.get(use.tool) ?? { ...use, calls: [], completed: false }
    entry.calls.push(item)
    entry.completed ||= item.status !== 'failed'
    byTool.set(use.tool, entry)
  }
  return byTool
}

/** The servers LoomWatch connected to each agent, from the run's projection, for `usedInRun`. */
export function connectedServersByAgent(agents: readonly { id: string; connectedServers?: readonly string[] }[]): Map<string, readonly string[]> {
  return new Map(agents.map((agent) => [agent.id, agent.connectedServers ?? []]))
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
function toolIdentity(item: Evidence, connected: readonly string[]): Pick<UsedInRun, 'key' | 'name' | 'origin' | 'allow'> {
  const rawName = payloadString(item, 'name')
  const title = payloadString(item, 'title') ?? item.name
  // A permission request carries the ACP kind on its tool call; a call carries it as toolKind.
  const toolKind = item.toolKind ?? payloadString(item, 'kind')
  if (rawName && MEMORY_TOOLS.has(rawName)) return { key: 'team:memory', name: 'Team memory', origin: 'team', allow: null }
  const mcp = mcpCall(item)
  if (mcp) {
    const [server, tool] = [mcp.server, mcp.tool.replace(/_/g, ' ')]
    const team = server === TEAM_BUS_SERVER
    // A server LoomWatch did not connect came with the agent's app (ADR 0047): not a connected tool.
    const origin = team ? 'team' : handedOver(server, connected) ? 'connected' : 'app'
    return { key: `mcp:${server}:${tool}`.toLowerCase(), name: team ? `Team Bus · ${tool}` : `${server} · ${tool}`, origin, allow: null }
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

/**
 * `connected` names, per agent id, the servers LoomWatch connected to it (`connectedServersByAgent`).
 * An agent missing from it was connected none.
 */
export function usedInRun(evidence: readonly Evidence[], connected: ReadonlyMap<string, readonly string[]> = new Map()): UsedInRun[] {
  const rows = new Map<string, UsedInRun>()
  const rowOfCall = new Map<string, UsedInRun>()
  const asked = askedCalls(evidence)
  const serversOf = (item: Evidence) => connected.get(item.agentId) ?? []
  const add = (identity: Pick<UsedInRun, 'key' | 'name' | 'origin' | 'allow'>, kind: UsedInRun['kind'], item: Evidence) => {
    let row = rows.get(identity.key)
    if (!row) {
      row = { ...identity, kind, agents: [], calls: 0, refused: 0, refusedBy: [], failed: 0, outward: null, evidenceId: item.id }
      rows.set(identity.key, row)
    }
    const outward = outwardTool(item, serversOf(item), asked)
    if (outward !== null) row.outward = outward.does ?? UNCONNECTED_SERVER
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
    const row = add(toolIdentity(item, serversOf(item)), 'tool', item)
    rowOfCall.set(`${item.agentId}:${item.callId}`, row)
  }
  for (const item of evidence) {
    if (item.kind !== 'permission' || !refusedPermission(item)) continue
    const row = (item.callId ? rowOfCall.get(`${item.agentId}:${item.callId}`) : undefined) ?? rows.get(toolIdentity(item, serversOf(item)).key)
    if (row) { refuse(row, item.agentId); continue }
    // Asked and refused before any call was recorded: the request is the only trace of the tool.
    const added = add(toolIdentity(item, serversOf(item)), 'tool', item)
    refuse(added, item.agentId)
  }
  return [...rows.values()]
}
