import type { Evidence, RunEvent } from '../watch/events'

/**
 * Helpers (ADR 0079): an agent working alone brings in copies of itself for the parts of a big
 * task. Each one runs under an id of its own — the agent's id, `~`, its number (`writer~2`) — which
 * no agent of a team file can have, so a helper is told apart from an agent by its id alone, and
 * named, coloured and drawn after the agent it helps.
 *
 * Everything here is read off the run's record: the agent's `start_helper` call (the part's title
 * and brief), the bus's answer (which helper it started), the helper's own steps, and the
 * `delegated_result` the bus writes when the helper comes back (what it sent, or why it failed).
 */

export const HELPER_SEPARATOR = '~'

/**
 * LoomWatch's own check of an answer (ADR 0098): it checks the work against what the person's
 * message said done looks like when no checker is on the team. No team file can give an agent this
 * id, so it is told apart by its id alone, and named and drawn as LoomWatch.
 */
export const LOOMWATCH_CHECK_ID = 'loomwatch:check'
export const LOOMWATCH_NAME = 'LoomWatch'

/** Whose helper `id` is, and its number; `null` for an agent of the team or you. */
export function helperOf(id: string): { lead: string; number: number } | null {
  const at = id.lastIndexOf(HELPER_SEPARATOR)
  if (at <= 0) return null
  const number = Number(id.slice(at + 1))
  return Number.isInteger(number) && number > 0 && /^\d+$/.test(id.slice(at + 1)) ? { lead: id.slice(0, at), number } : null
}

/** A helper's name where its agent is already in view: "Helper 2". */
export function helperShortName(number: number): string {
  return `Helper ${number}`
}

/**
 * `id`'s name, from the names of the team's agents: an agent's own, or for a helper, "Ada's helper
 * 2", after the agent it helps. `null` when neither is known.
 */
export function nameWithHelpers(names: ReadonlyMap<string, string>, id: string): string | null {
  const own = names.get(id)
  if (own) return own
  if (id === LOOMWATCH_CHECK_ID) return LOOMWATCH_NAME
  const helper = helperOf(id)
  if (!helper) return null
  const lead = names.get(helper.lead) ?? helper.lead
  return `${lead}’s helper ${helper.number}`
}

/**
 * Who is working, for the line under a piece: each agent by name, and its helpers counted rather
 * than listed — "Ada and 2 helpers", or "Ada’s 3 helpers" while Ada waits for them. A part with
 * `helpers` is the helpers of `agent`, said after its name; one without `agent` is plain words.
 */
export function whoWorks(working: readonly string[]): { agent?: string; text: string; helpers?: true }[] {
  const agents = working.filter((id) => !helperOf(id))
  const helped = new Map<string, number>()
  for (const id of working) {
    const helper = helperOf(id)
    if (helper) helped.set(helper.lead, (helped.get(helper.lead) ?? 0) + 1)
  }
  const parts: { agent?: string; text: string; helpers?: true }[] = agents.map((id) => ({ agent: id, text: id }))
  for (const [lead, count] of helped) {
    const words = `${count} ${count === 1 ? 'helper' : 'helpers'}`
    parts.push(agents.includes(lead) ? { text: words } : { agent: lead, text: words, helpers: true })
  }
  return parts
}

/** The id whose colour and figure `id` wears: a helper wears its agent's. */
export function wearerOf(id: string): string {
  return helperOf(id)?.lead ?? id
}

/** `stopped`: you stopped it, or the run's spending limit did, and it sent back what it had. */
export type HelperState = 'working' | 'done' | 'stopped' | 'failed'

export interface HelperWork {
  id: string
  /** The talk's message that briefed it (`lib/watch/messages.ts`), where its brief and reply are read. */
  messageId: string
  lead: string
  number: number
  /** The part, in the few words the agent gave it for you. */
  title: string
  /** What the agent asked it to do: its part, and what to send back. */
  brief: string
  state: HelperState
  /** What it sent back, once it has. */
  reply: string | null
  /** Why it couldn't finish, when it couldn't. */
  error: string | null
  startedAt: string
  finishedAt: string | null
  /** The tools it has used so far: each search, page, file or command. */
  steps: number
  /** What it is doing right now, while it works: its newest step, in the run's own words. */
  now: string | null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The brief as the bus composed it: the part, then what to send back. */
function briefOf(input: Record<string, unknown>): string {
  const task = text(input.task) ?? ''
  const back = text(input.send_back)
  return back ? `${task}\n\n## What to send back\n${back}` : task
}

/**
 * Every helper a run's agents brought in, in the order they were started, as far as the record
 * goes: a helper the bus refused never started and isn't one. A helper works until what it sent
 * back is on the record; `evidence` gives its steps.
 */
export function helpersOf(events: readonly RunEvent[], evidence: readonly Evidence[] = []): HelperWork[] {
  const asked = new Map<string, { id: string; lead: string; title: string | null; brief: string; ts: string }>()
  const helpers = new Map<string, HelperWork>()
  for (const event of events) {
    const payload = event.payload
    if (event.kind === 'tool_call' && payload.name === 'start_helper' && payload.title === 'Team Bus: start_helper') {
      const input = object(payload.rawInput) ? payload.rawInput : {}
      const callId = text(payload.callId) ?? event.id
      asked.set(`${event.agentId}:${callId}`, { id: `${event.agentId}:${callId}`, lead: event.agentId, title: text(input.title), brief: briefOf(input), ts: event.ts })
      continue
    }
    if (event.kind === 'tool_update' && payload.status === 'completed') {
      const start = asked.get(`${event.agentId}:${text(payload.callId) ?? ''}`)
      const output = object(payload.rawOutput) ? payload.rawOutput : {}
      const id = text(output.agent)
      const helper = id ? helperOf(id) : null
      if (!start || !id || !helper || helpers.has(id)) continue
      helpers.set(id, {
        id, messageId: start.id, lead: helper.lead, number: helper.number,
        title: start.title ?? text(output.title) ?? helperShortName(helper.number),
        brief: start.brief, state: 'working', reply: null, error: null,
        startedAt: start.ts, finishedAt: null, steps: 0, now: null,
      })
      continue
    }
    if (event.kind === 'session_meta' && payload.phase === 'delegated_result' && payload.mode === 'helper') {
      const helper = helpers.get(event.agentId)
      if (!helper) continue
      helper.finishedAt = event.ts
      if (payload.status === 'succeeded') {
        helper.state = payload.stopped === true ? 'stopped' : 'done'
        helper.reply = typeof payload.reply === 'string' ? payload.reply : ''
      } else {
        helper.state = 'failed'
        helper.error = text(payload.error) ?? 'It stopped before it finished.'
      }
      helper.brief = text(payload.task) ?? helper.brief
    }
  }
  for (const helper of helpers.values()) {
    const steps = evidence.filter((item) => item.agentId === helper.id && item.kind !== 'delegation' && item.kind !== 'plan' && item.kind !== 'permission')
    helper.steps = steps.length
    const newest = steps.at(-1)
    helper.now = helper.state === 'working' && newest ? stepWords(newest) : null
  }
  return [...helpers.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.number - b.number)
}

/** A step in a few words, for the line under a working helper: "Searching: rent Hanoi studio". */
function stepWords(step: Evidence): string {
  // A file or folder by its own name: where on the disk it is says nothing at a glance.
  const detail = step.detail.trim().replace(/^(?:[A-Za-z]:)?[\\/](?:.*[\\/])?([^\\/]+)[\\/]?$/, '$1')
  const name = step.name.trim()
  if (!detail || detail === name) return name
  return `${name}: ${detail}`
}

/** How long a helper took, or has been at it: "45s", "2m 05s". */
export function took(fromIso: string, toIso: string | null, now: number = Date.now()): string {
  const from = Date.parse(fromIso)
  const to = toIso ? Date.parse(toIso) : now
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** The card's one line about all of them: "3 helpers · 2 working", "3 helpers · 1 stopped". */
export function helpersLine(helpers: readonly HelperWork[]): string {
  const count = `${helpers.length} ${helpers.length === 1 ? 'helper' : 'helpers'}`
  const working = helpers.filter((helper) => helper.state === 'working').length
  const failed = helpers.filter((helper) => helper.state === 'failed').length
  const stopped = helpers.filter((helper) => helper.state === 'stopped').length
  if (working > 0) return `${count} · ${working} working`
  const short = [failed > 0 ? `${failed} couldn’t finish` : '', stopped > 0 ? `${stopped} stopped` : ''].filter(Boolean)
  return `${count} · ${short.length ? short.join(', ') : 'done'}`
}
