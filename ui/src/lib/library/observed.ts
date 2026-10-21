import type { Evidence } from '../watch/events'

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

function payloadString(item: Evidence, key: string): string | null {
  for (const event of item.events) {
    const value = event.payload[key]
    if (typeof value === 'string') return value
    const call = event.payload.toolCall
    if (call && typeof call === 'object' && typeof (call as Record<string, unknown>)[key] === 'string') return (call as Record<string, string>)[key]
  }
  return null
}
