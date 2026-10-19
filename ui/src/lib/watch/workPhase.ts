import { WORKING_WINDOW_MS, type BenchUse, type ReadSource, type WorkPhase } from '../library/figure'
import type { RunEvent } from './events'

/** How long it reads the message it was given before, with nothing back from its model yet, it is thinking. */
export const READING_MS = 6000

/** Events that say nothing about what it is at: its spend, its app's chatter, a request to you. */
const SILENT = new Set<RunEvent['kind']>(['usage', 'session_meta', 'process', 'turn_end', 'permission'])

/**
 * What an agent is at in a live run (`WorkPhase`), from its newest events that say, `now`:
 *
 * - the message it was given (the run's prompt, or a note you sent): reading, for a few seconds;
 * - its reasoning, or its plan: thinking;
 * - a tool call (a web search, a file, a command): using the computer while the call is open or
 *   just made;
 * - its own words: typing, while they keep coming.
 *
 * Quiet a few seconds after a tool came back or its words stopped, its model is working out what
 * to do next: thinking. With nothing from it yet, it is reading what it was given. `agent` picks
 * one agent's events in a team's run; null takes them all.
 */
export function workPhase(events: readonly RunEvent[], agent: string | null, now: number): WorkPhase {
  const finished = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if ((agent !== null && event.agentId !== agent) || SILENT.has(event.kind)) continue
    const p = event.payload
    const since = now - Date.parse(event.ts)
    const recent = !(since >= WORKING_WINDOW_MS)
    switch (event.kind) {
      case 'message':
        if (p.role === 'user') return since >= READING_MS ? 'thinking' : 'reading'
        return recent ? 'typing' : 'thinking'
      case 'thought':
      case 'plan':
        return 'thinking'
      case 'tool_update':
        if (typeof p.callId === 'string' && (p.status === 'completed' || p.status === 'failed')) finished.add(p.callId)
        continue
      case 'tool_call': {
        // Updating its plan is thinking aloud, not using a tool.
        if (p.toolKind === 'think') return 'thinking'
        const open = !(p.status === 'completed' || p.status === 'failed') && !(typeof p.callId === 'string' && finished.has(p.callId))
        return open || recent ? 'tools' : 'thinking'
      }
    }
  }
  return 'reading'
}

/** What the bench holds that a tool call can use: its skills, what it reads, and its tools' names. */
export interface BenchKit {
  skills: readonly string[]
  reads: readonly ReadSource[]
  tools: readonly string[]
}

/** Only a use this recent is fetched: one from earlier in the run was fetched then, or missed. */
export const FETCH_WITHIN_MS = 8000

/**
 * What its agent used from its bench in the last few seconds (`BenchUse`), oldest first, from the
 * run's tool calls: a skill it opened, one of the folders or files it was given to read, or one of
 * its tools. Anything else (a web search, a command, its own work folder) uses its laptop.
 */
export function benchUses(events: readonly RunEvent[], agent: string | null, now: number, kit: BenchKit): BenchUse[] {
  const uses: BenchUse[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (agent !== null && event.agentId !== agent) continue
    if (now - Date.parse(event.ts) > FETCH_WITHIN_MS) break
    if (event.kind !== 'tool_call') continue
    const used = usedOnBench(event.payload, kit)
    if (used) uses.unshift({ ...used, id: event.id })
  }
  return uses
}

const flat = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')

function usedOnBench(p: RunEvent['payload'], kit: BenchKit): Omit<BenchUse, 'id'> | null {
  const name = typeof p.name === 'string' ? p.name : ''
  const title = typeof p.title === 'string' ? p.title : ''
  const paths = Array.isArray(p.locations) ? p.locations.map((location: unknown) => (location && typeof location === 'object' && 'path' in location ? String(location.path) : '')) : []
  const said = [title, name, JSON.stringify(p.rawInput ?? ''), ...paths].join('\n').toLowerCase()
  const asSkill = `${name} ${title}`.toLowerCase().includes('skill')
  for (const skill of kit.skills) {
    const lower = skill.toLowerCase()
    if (said.includes(`skills/${lower}/`) || (asSkill && said.includes(lower))) return { kind: 'skill', name: skill }
  }
  // A connected tool's calls are named for it: mcp__notion__search, or notion__search.
  const call = flat(name || title)
  for (const tool of kit.tools) {
    const own = flat(tool)
    if (own && (call.startsWith(own) || call.startsWith(`mcp${own}`))) return { kind: 'tool', name: tool }
  }
  for (const source of kit.reads) {
    if (source.kind !== 'page' && source.where && said.includes(source.where.toLowerCase())) return { kind: 'read', name: source.name }
  }
  return null
}
