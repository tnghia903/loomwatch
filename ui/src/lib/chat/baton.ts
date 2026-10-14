// Who has the work right now, for the team's chat header: as work passes between agents, the face
// of the agent it passed to grows into a pill that says so — "Asking Researcher…", "Passing to
// Writer…" — and settles to "Writer is working…" once the pass is a moment old. Read only from
// what a live run recorded: its messages (lib/watch/messages.ts) and who is mid-turn.
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

export interface BatonWords {
  /** On the pill, which grows from the agent's face: "Asking Researcher…". */
  pill: string
  /** Beside the agent's name in the open list, in place of "working": "asked by Writer". */
  row: string
  /** The whole of it, for a screen reader: "Writer is asking Researcher". */
  sentence: string
}

export function batonWords(baton: Baton, name: (id: string) => string): BatonWords {
  const to = name(baton.agent)
  const from = baton.from ? name(baton.from) : null
  switch (baton.kind) {
    case 'ask':
      return { pill: `Asking ${to}…`, row: from ? `asked by ${from}` : 'asked a question', sentence: from ? `${from} is asking ${to}` : `${to} was asked a question` }
    case 'answer':
      return { pill: `Back to ${to}…`, row: from ? `has ${from}'s answer` : 'has its answer', sentence: from ? `${from} answered ${to}` : `${to} has its answer` }
    case 'dispatch':
      return { pill: `Giving ${to} a task…`, row: from ? `on a task from ${from}` : 'on a task', sentence: from ? `${from} gave ${to} part of the work` : `${to} was given part of the work` }
    case 'handoff':
      return { pill: `Handing off to ${to}…`, row: from ? `took over from ${from}` : 'took over', sentence: from ? `${from} handed the work to ${to}` : `The work was handed to ${to}` }
    case 'handover':
      return { pill: `Passing to ${to}…`, row: from ? `picked up from ${from}` : 'picked up the work', sentence: from ? `${from} passed the work to ${to}` : `The work passed to ${to}` }
    case 'you':
      return { pill: `${to} needs you`, row: 'waiting for you', sentence: `${to} is waiting for you` }
    case 'working':
      return { pill: `${to} is working…`, row: 'working', sentence: `${to} is working` }
  }
}
