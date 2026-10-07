import type { RunRecord } from '../runs/client'
import type { ChatRoute, ChatTarget } from './client'

/**
 * Where a message in the team's chat will go, said before you send it (ADR 0051).
 *
 * The rule is the daemon's (`chat::decide`), mirrored here so the message box can name the
 * destination as you type: only an @ starts work, and nothing is guessed from your words.
 *
 * - `@team` starts the whole team from its first step.
 * - `@<agent>` starts that agent alone; while it is working, it becomes a note for its next turn.
 * - No @: a note to the agent at work, or — when nobody is working — a team note, which starts
 *   nothing and is read the next time work starts.
 *
 * The daemon decides again when the message arrives, and its answer is what the chat shows: an
 * agent can finish between the label and the send.
 */

/** A member of the team as the chat can address it. */
export interface ChatAgent {
  id: string
  name: string
  /** A review step is you, so it cannot be @mentioned. */
  operator?: boolean
}

/** An @mention found in a message. */
export interface Mention {
  target: Exclude<ChatTarget, null>
  /** Where the `@` is, and where the name after it ends. */
  start: number
  end: number
}

const TEAM = 'team'

/** A name ends where a word character would carry on: "@Writer," mentions Writer, "@Writers" does not. */
const continuesWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_-]/u.test(char)

/**
 * The first @mention in `text` that names `@team` or one of the team's agents, by name or id. The
 * longest name wins where two would match ("@News Writer" over "@News"). `null` when there is none.
 */
export function findMention(text: string, agents: readonly ChatAgent[]): Mention | null {
  const candidates: { word: string; target: Exclude<ChatTarget, null> }[] = [{ word: TEAM, target: { kind: 'team' } }]
  for (const agent of agents) {
    if (agent.operator) continue
    for (const word of new Set([agent.name.trim(), agent.id])) {
      if (word) candidates.push({ word, target: { kind: 'agent', agent: agent.id } })
    }
  }
  candidates.sort((left, right) => right.word.length - left.word.length)
  const lower = text.toLowerCase()
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && !/[\s([{"'“‘]/.test(text[at - 1])) continue
    for (const candidate of candidates) {
      const word = candidate.word.toLowerCase()
      if (lower.startsWith(word, at + 1) && !continuesWord(text[at + 1 + word.length])) {
        return { target: candidate.target, start: at, end: at + 1 + word.length }
      }
    }
  }
  return null
}

/**
 * The message addressed to `agent` instead, for clicking a face: its @mention takes the place of
 * the one the message already has, which is the one that decides where it goes, or leads it.
 */
export function withMention(text: string, agent: ChatAgent, agents: readonly ChatAgent[]): string {
  const word = `@${agent.name.trim() || agent.id}`
  const found = findMention(text, agents)
  if (found) return `${text.slice(0, found.start)}${word}${text.slice(found.end)}`
  const rest = text.trimStart()
  return rest ? `${word} ${rest}` : `${word} `
}

/** The @mention being typed at the caret, for the picker: the text after the `@` so far. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/[\s([{"'“‘]/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  // A space after the name ends the mention; one inside it may be a two-word name being typed
  // ("@News W"), which the choices then narrow to.
  if (/\s$/.test(query) || /\n/.test(query) || query.length > 40) return null
  return { start: at, query }
}

/** Which of the team the picker offers for what has been typed after `@`, @team first. */
export function mentionChoices(query: string, agents: readonly ChatAgent[]): { id: string; label: string; insert: string }[] {
  const wanted = query.trim().toLowerCase()
  const all = [
    { id: TEAM, label: 'team', insert: '@team ' },
    ...agents.filter((agent) => !agent.operator).map((agent) => ({ id: agent.id, label: agent.name || agent.id, insert: `@${agent.name || agent.id} ` })),
  ]
  return all.filter((choice) => !wanted || choice.label.toLowerCase().startsWith(wanted) || choice.id.toLowerCase().startsWith(wanted))
}

/** Where a message will go, and the words the message box shows for it. */
export interface Destination {
  route: ChatRoute
  /** The agent it reaches, for a one-agent turn or a note. */
  agent: string | null
  /** The run a note joins. */
  runId: string | null
  label: string
}

/**
 * Where a message addressed to `target` goes right now. `live` is the team's unfinished runs; the
 * agent at work is the one that most recently began a turn in the newest run that has one working.
 */
export function destination(target: ChatTarget, live: readonly RunRecord[], names: ReadonlyMap<string, string>, steps: number, now = false): Destination {
  const name = (id: string) => names.get(id) ?? id
  const newestFirst = [...live].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const note = (runId: string, agent: string): Destination => ({
    route: 'note',
    agent,
    runId,
    label: now ? `Note for ${name(agent)} now · stops its current step` : `Note for ${name(agent)} · after its current step`,
  })
  if (target?.kind === 'team') {
    return { route: 'team', agent: null, runId: null, label: steps > 1 ? `Starts the team · ${steps} steps` : 'Starts the team' }
  }
  if (target?.kind === 'agent') {
    const working = newestFirst.find((run) => run.working?.includes(target.agent))
    if (working) return note(working.runId, target.agent)
    return { route: 'agent', agent: target.agent, runId: null, label: `Starts ${name(target.agent)} only` }
  }
  for (const run of newestFirst) {
    const agent = run.working?.at(-1)
    if (agent) return note(run.runId, agent)
  }
  return { route: 'team_note', agent: null, runId: null, label: 'Team note · starts nothing' }
}
