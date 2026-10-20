// Who has the work right now. A live piece of work says it on its own line in the chat — "Writer is
// asking Researcher" — and once that line is scrolled out of view, the face of the agent with the
// work grows into a pill in the chat's header that says it — "Asking Researcher…". A pass is named
// for a moment, then settles to who is working. Read only from what a live run recorded: its
// messages (lib/watch/messages.ts) and who is mid-turn.
import { useEffect, useState } from 'react'

import { OPERATOR_ID, type TeamMessage } from '../watch/messages'

/**
 * One time the work moved to an agent: a Team Bus `ask`, `dispatch` or `handoff`, an ask's answer
 * going back to the agent that asked, or a pipeline stage's handover.
 */
export interface Pass {
  kind: 'ask' | 'answer' | 'dispatch' | 'handoff' | 'handover'
  /** The agent the work moved to. */
  agent: string
  /** Who moved it there; `null` for a handover whose senders were not recorded. */
  from: string | null
  /** When it moved, in the run's own order. */
  seq: number
  ts: string
}

/** What the header shows: the agent with the work, and how it came to have it. */
export interface Baton {
  agent: string
  /** A pass still fresh enough to name; `working` once it is not; `you` while the agent waits on you. */
  kind: Pass['kind'] | 'working' | 'you'
  from: string | null
}

/** How long a pass is named before the pill settles to who is working. An open ask is named until it is answered. */
export const PASS_BEAT_MS = 3200

/**
 * Finds the team's agent a message names, as the Team Bus does: by id, then by exact name, then by
 * either ignoring case. A name two agents share names neither. A pending `ask` carries what the
 * agent wrote; only once it settles does the record carry the id the bus resolved.
 */
export function agentResolver(names: ReadonlyMap<string, string>, operators: ReadonlySet<string>): (written: string | null) => string | null {
  const agents = [...names].filter(([id]) => id !== OPERATOR_ID && !operators.has(id))
  const one = (found: (readonly [string, string])[]) => (found.length === 1 ? found[0][0] : null)
  return (written) => {
    const text = written?.trim()
    if (!text) return null
    if (agents.some(([id]) => id === text)) return text
    const lower = text.toLowerCase()
    return one(agents.filter(([, name]) => name === text))
      ?? one(agents.filter(([id, name]) => id.toLowerCase() === lower || name.toLowerCase() === lower))
  }
}

/**
 * Every pass in a run's messages, oldest first. Talk carried over from earlier work, a call the
 * Team Bus refused, and anything to or from you (whose face is not in the row) are not passes.
 */
export function passesOf(messages: readonly TeamMessage[], resolve: (written: string | null) => string | null): Pass[] {
  const passes: Pass[] = []
  for (const message of messages) {
    if (message.carried || message.state === 'failed') continue
    const from = message.kind === 'handover' ? resolve(message.handedBy?.from.at(-1) ?? null) : resolve(message.from)
    if (message.kind === 'ask' || message.kind === 'dispatch' || message.kind === 'handoff' || message.kind === 'handover') {
      const agent = resolve(message.to)
      if (agent) passes.push({ kind: message.kind, agent, from, seq: message.seq, ts: message.ts })
    }
    if (message.kind === 'ask' && message.reply && from) {
      passes.push({ kind: 'answer', agent: from, from: resolve(message.reply.from), seq: message.reply.seq, ts: message.reply.ts })
    }
  }
  return passes.sort((left, right) => left.seq - right.seq)
}

/** What two lists of passes would show alike: a run's report changes the header only when this does. */
export function passesKey(passes: readonly Pass[]): string {
  return passes.map((pass) => `${pass.kind}:${pass.agent}:${pass.seq}`).join('|')
}

/**
 * Who has the work now. An agent waiting on you comes first; then the newest pass, while the agent
 * it went to is still working — named for `PASS_BEAT_MS` after it moved (an ask for as long as it
 * is open), then as that agent working; then whoever is working, the one the work reached last
 * first. Nobody working: no one has it.
 *
 * An agent answering from the session it kept open is not counted as working — the one that asked
 * is, mid-call — so an open ask holds while its asker works.
 */
export function batonOf({ passes, working, waitingOn, now }: { passes: readonly Pass[]; working: readonly string[]; waitingOn: string | null; now: number }): Baton | null {
  if (waitingOn) return { agent: waitingOn, kind: 'you', from: null }
  const busy = new Set(working)
  const newest = passes.at(-1)
  if (newest?.kind === 'ask' && (busy.has(newest.agent) || (newest.from !== null && busy.has(newest.from)))) {
    return { agent: newest.agent, kind: 'ask', from: newest.from }
  }
  if (newest && newest.kind !== 'ask' && busy.has(newest.agent)) {
    const fresh = now - Date.parse(newest.ts) < PASS_BEAT_MS
    return fresh ? { agent: newest.agent, kind: newest.kind, from: newest.from } : { agent: newest.agent, kind: 'working', from: null }
  }
  const holder = passes.findLast((pass) => busy.has(pass.agent))?.agent ?? working[0]
  return holder ? { agent: holder, kind: 'working', from: null } : null
}

/** When the newest pass stops being named, so the header knows when to look again; `null` when nothing will change by itself. */
export function batonSettlesAt(baton: Baton | null, passes: readonly Pass[]): number | null {
  const newest = passes.at(-1)
  if (!baton || !newest || newest.kind === 'ask' || baton.kind !== newest.kind || baton.agent !== newest.agent) return null
  return Date.parse(newest.ts) + PASS_BEAT_MS
}

/**
 * Who has the work in one live run, kept current: a pass that is named for a moment is looked at
 * again when its moment is over.
 */
export function useBaton({ passes, working, waitingOn }: { passes: readonly Pass[]; working: readonly string[]; waitingOn: string | null }): Baton | null {
  const [now, setNow] = useState(() => Date.now())
  const baton = batonOf({ passes, working, waitingOn, now })
  const settles = batonSettlesAt(baton, passes)
  useEffect(() => {
    if (settles === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(PASS_BEAT_MS, Math.max(0, settles - Date.now())) + 40)
    return () => window.clearTimeout(timer)
  }, [settles, now])
  return baton
}

/** Whether two holders would be said alike, so a report that changes nothing redraws nothing. */
export function sameBaton(left: Baton | null, right: Baton | null): boolean {
  return left === right || (left !== null && right !== null && left.agent === right.agent && left.kind === right.kind && left.from === right.from)
}

/** One run of the line's words: an agent's name, with its id so it is drawn in the agent's colour, or the words between them. */
export type LinePart = { text: string; agent?: string }

export interface BatonWords {
  /**
   * On the pill, which grows from the agent's face: "Asking Researcher…". The face says who it is,
   * so the pill does not say the agent's own name again where it does not have to.
   */
  pill: string
  /** Beside the agent's name in the open list, in place of "working": "asked by Writer". */
  row: string
  /** The piece's own line, with the names to draw as names: "Writer is asking Researcher". */
  line: LinePart[]
  /** The line as one sentence, for a screen reader. */
  sentence: string
}

export function batonWords(baton: Baton, name: (id: string) => string): BatonWords {
  const to: LinePart = { text: name(baton.agent), agent: baton.agent }
  const from: LinePart | null = baton.from ? { text: name(baton.from), agent: baton.from } : null
  const say = (pill: string, row: string, line: LinePart[]): BatonWords => ({ pill, row, line, sentence: line.map((part) => part.text).join('') })
  switch (baton.kind) {
    case 'ask':
      return say(`Asking ${to.text}…`, from ? `asked by ${from.text}` : 'asked a question', from ? [from, { text: ' is asking ' }, to] : [to, { text: ' was asked a question' }])
    case 'answer':
      return say(`Back to ${to.text}…`, from ? `has ${from.text}'s answer` : 'has its answer', from ? [from, { text: ' answered ' }, to] : [to, { text: ' has its answer' }])
    case 'dispatch':
      return say(`Giving ${to.text} a task…`, from ? `on a task from ${from.text}` : 'on a task', from ? [from, { text: ' gave ' }, to, { text: ' part of the work' }] : [to, { text: ' was given part of the work' }])
    case 'handoff':
      return say(`Handing off to ${to.text}…`, from ? `took over from ${from.text}` : 'took over', from ? [from, { text: ' handed the work to ' }, to] : [{ text: 'The work was handed to ' }, to])
    case 'handover':
      return say(`Passing to ${to.text}…`, from ? `picked up from ${from.text}` : 'picked up the work', from ? [from, { text: ' passed the work to ' }, to] : [{ text: 'The work passed to ' }, to])
    case 'you':
      return say('needs you', 'waiting for you', [to, { text: ' is waiting for you' }])
    case 'working':
      return say('working…', 'working', [to, { text: ' is working' }])
  }
}
