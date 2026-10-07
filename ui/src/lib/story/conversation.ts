import type { Evidence } from '../watch/events'
import { OPERATOR_ID, type MessageKind, type PermissionOutcome, type TeamMessage } from '../watch/messages'

/**
 * The run's messages made ready to read (components/run/AgentMessages.tsx): who sent each one and
 * who got it, by the names the run view uses, and one row per message once what merely repeats an
 * earlier one is folded into it (`fold`).
 *
 * The projection records what was said (lib/watch/messages.ts), including who handed a stage its
 * handover. Runs archived before the daemon recorded that are the one thing filled in here: the
 * daemon builds a handover from the stages connected into it (`pipeline_node_prompt`), so the
 * senders are taken from the team's connections, and the line says it was (`derived`).
 */
export interface Party {
  id: string
  name: string
  /** The review step: you. */
  operator: boolean
}

/** A party that sent or received something. Your reserved `operator` id is filed under the review step's lane. */
export type Lane = Party

export interface Line {
  message: TeamMessage
  /** Lane ids. Empty when nothing says who sent it. */
  senders: string[]
  receiver: string | null
  replier: string | null
  /** Review steps a handover passed through on its way, as lane ids. */
  via: string[]
  /** The senders were read from the team's connections, not from the run's record: an older run. */
  derived: boolean
}

export interface Conversation {
  lanes: Lane[]
  lines: Line[]
}


/**
 * `predecessors` are the team's connections into each agent. Without them, the stage before in
 * `order` is taken as the one that handed over, as the handover panel has always done.
 */
export function converse(messages: readonly TeamMessage[], order: readonly Party[], predecessors?: ReadonlyMap<string, readonly string[]>): Conversation {
  const known = new Map(order.map((party) => [party.id, party]))
  const firstOperator = order.find((party) => party.operator)
  const laneId = (id: string) => (id === OPERATOR_ID && !known.has(id) && firstOperator ? firstOperator.id : id)
  const before = (id: string): string[] => {
    const configured = predecessors?.get(id)
    if (configured) return [...configured]
    const index = order.findIndex((party) => party.id === id)
    return index > 0 ? [order[index - 1].id] : []
  }
  // A review step forwards the handover it read; the stage that wrote it is further back.
  const writers = (id: string) => {
    const senders: string[] = []
    const via: string[] = []
    const seen = new Set<string>([id])
    const walk = (current: string) => {
      for (const from of before(current)) {
        if (seen.has(from)) continue
        seen.add(from)
        if (known.get(from)?.operator) { via.push(from); walk(from) } else senders.push(from)
      }
    }
    walk(id)
    return { senders, via }
  }

  const lines: Line[] = messages.map((message) => {
    const receiver = message.to === null ? null : laneId(message.to)
    const replier = message.reply ? laneId(message.reply.from) : null
    const recorded = message.handedBy
    if ((message.kind === 'handover' || message.kind === 'direction') && recorded) {
      const senders = recorded.from.map(laneId)
      return { message, senders: senders.length > 0 || message.kind === 'handover' ? senders : [laneId(OPERATOR_ID)], receiver, replier, via: recorded.via.map(laneId), derived: false }
    }
    if (message.kind === 'handover' && message.to !== null) {
      const { senders, via } = writers(message.to)
      return { message, senders, receiver, replier, via, derived: true }
    }
    if (message.kind === 'direction' && message.to !== null) {
      const stops = before(message.to).filter((id) => known.get(id)?.operator)
      return { message, senders: stops.length > 0 ? stops : [laneId(OPERATOR_ID)], receiver, replier, via: [], derived: stops.length > 0 }
    }
    return { message, senders: message.from === null ? [] : [laneId(message.from)], receiver, replier, via: [], derived: false }
  })

  // Lanes in the team's order, then anyone the run brought in that the team file does not list.
  const involved = new Set(lines.flatMap((line) => [...line.senders, ...line.via, line.receiver, line.replier, line.message.reply?.sentBackTo ?? null].filter((id): id is string => id !== null)))
  const lanes: Lane[] = order.filter((party) => involved.has(party.id))
  for (const id of involved) {
    if (known.has(id)) continue
    lanes.push(id === OPERATOR_ID ? { id, name: 'You', operator: true } : { id, name: id, operator: false })
  }
  return { lanes, lines }
}

/** One row of the list: a message, with the messages that only repeat it folded in. */
export interface Item {
  line: Line
  /**
   * A review you approved, and where it went on to: the direction carrying your words and the
   * handover the review step passed on unchanged. Shown in the review's row rather than as two
   * more rows saying the same thing.
   */
  passedOn: { to: string; direction: Line | null; handover: Line | null }[]
  /** This message's id and the ids folded into it, so a link to any of them lands on this row. */
  ids: string[]
}

/**
 * A review step reads a handover, you approve it, and the next stage is then handed the same
 * handover and your words as direction. Those last two repeat what the review's row already says,
 * so they fold into it. Only an exact repeat folds: a direction that joins several stops, or a
 * handover that is not the one you reviewed, keeps its own row.
 */
export function fold(lines: readonly Line[], lanes: readonly Lane[]): Item[] {
  const you = new Set(lanes.filter((lane) => lane.operator).map((lane) => lane.id))
  const folded = new Set<string>()
  const items: Item[] = []
  lines.forEach((line, index) => {
    if (folded.has(line.message.id)) return
    const item: Item = { line, passedOn: [], ids: [line.message.id] }
    const { message } = line
    const stop = line.receiver
    const reply = message.reply
    if (message.kind === 'handover' && stop !== null && you.has(stop) && reply && !reply.sentBackTo) {
      for (const later of lines.slice(index + 1)) {
        const repeat = later.message
        if (folded.has(repeat.id) || repeat.seq < reply.seq || later.receiver === null) continue
        const direction = repeat.kind === 'direction' && later.senders.includes(stop) && repeat.text.trim() === reply.text.trim()
        const forwarded = repeat.kind === 'handover' && later.via.includes(stop) && repeat.text.trim() === message.text.trim()
        if (!direction && !forwarded) continue
        folded.add(repeat.id)
        item.ids.push(repeat.id)
        let passed = item.passedOn.find((entry) => entry.to === later.receiver)
        if (!passed) {
          passed = { to: later.receiver, direction: null, handover: null }
          item.passedOn.push(passed)
        }
        if (direction) passed.direction = later
        else passed.handover = later
      }
    }
    items.push(item)
  })
  return items
}

/**
 * One speech bubble: who says it, to whom, in what words. A message makes one, its answer a
 * second, and an answer still owed a third that says so — the "typing…" of a chat.
 */
export interface Bubble {
  key: string
  item: Item
  part: 'said' | 'reply' | 'waiting'
  /** Lane ids. A handover built from two stages has two speakers. */
  from: string[]
  to: string[]
  /** What kind of thing was said, in a word: "handover", "question", "answer", "sent back"… */
  word: string
  /** Verbatim. Empty for a plain approval and for an answer still owed. */
  text: string
  offsetMs: number
  ts: string
}

const WORD: Record<MessageKind, string> = {
  handover: 'handover', direction: 'direction', ask: 'question', question: 'question',
  escalate: 'needs you', dispatch: 'task', handoff: 'handover', note: 'note', permission: 'asks permission',
}

/** Kinds that expect an answer, so an answer not yet given shows as one owed. */
const ANSWERED: ReadonlySet<MessageKind> = new Set(['ask', 'question', 'escalate', 'note', 'permission'])

/** How a permission request was settled, in a word for the bubble that says so. */
const SETTLED: Record<PermissionOutcome, string> = { allow_once: 'allowed once', allow_run: 'allowed for this run', deny: 'denied', timed_out: 'declined, no answer' }

/**
 * The bubbles of a run, in order: each message, then its answer right after it — so a question and
 * its answer read as one exchange even when other work happened in between.
 *
 * `approval` is the text a plain approval is sent as; such an answer says "approved" and nothing
 * more, rather than quoting words nobody typed.
 */
export function bubbles(items: readonly Item[], lanes: readonly Lane[], live: boolean, approval: string): Bubble[] {
  const you = new Set(lanes.filter((lane) => lane.operator).map((lane) => lane.id))
  const out: Bubble[] = []
  for (const item of items) {
    const { line, passedOn } = item
    const { message } = line
    const key = message.id
    const to = line.receiver === null ? [] : [line.receiver]
    out.push({ key: `${key}:said`, item, part: 'said', from: line.senders, to, word: WORD[message.kind], text: message.text, offsetMs: message.offsetMs, ts: message.ts })
    const reviewing = message.kind === 'handover' && line.receiver !== null && you.has(line.receiver)
    const reply = message.reply
    const permission = message.permission
    if (permission?.outcome && permission.settled) {
      // Your answer to a permission request, or the clock's when nobody gave one: a word, not words.
      out.push({
        key: `${key}:reply`, item, part: 'reply', from: line.replier === null ? [] : [line.replier], to: line.senders.slice(0, 1),
        word: SETTLED[permission.outcome], text: '', offsetMs: permission.settled.offsetMs, ts: permission.settled.ts,
      })
    } else if (reply && line.replier !== null) {
      const back = reply.sentBackTo
      const plain = reviewing && !back && reply.text.trim() === approval
      out.push({
        key: `${key}:reply`, item, part: 'reply', from: [line.replier],
        // An answer goes back to whoever asked; your review goes back where you sent it, or on.
        to: back ? [back] : reviewing ? passedOn.map((passed) => passed.to) : line.senders.slice(0, 1),
        word: back ? 'sent back' : reviewing ? (plain ? 'approved' : 'approved, with a note') : 'answer',
        text: plain ? '' : reply.text, offsetMs: reply.offsetMs, ts: reply.ts,
      })
    } else if (message.state === 'pending' && line.receiver !== null && (ANSWERED.has(message.kind) || reviewing)) {
      const owedByYou = you.has(line.receiver)
      out.push({
        key: `${key}:waiting`, item, part: 'waiting', from: [line.receiver], to: line.senders.slice(0, 1),
        word: live ? (reviewing ? 'waiting for your review' : owedByYou ? 'waiting for you' : 'thinking…') : (reviewing ? 'not reviewed' : 'no answer'),
        text: '', offsetMs: message.offsetMs, ts: message.ts,
      })
    }
  }
  return out
}

/**
 * What the agent that answered recorded between the question and its answer.
 *
 * Only what the archive puts between those two events, on that agent's own lane: the answer may
 * have drawn on it, and the record cannot say more than that.
 */
export function callsWhileWaiting(message: TeamMessage, evidence: readonly Evidence[]): Evidence[] {
  const reply = message.reply
  if (!reply || message.kind !== 'ask') return []
  return evidence.filter((item) => item.agentId === reply.from && item.seq > message.seq && item.seq < reply.seq && item.kind !== 'plan')
}

/** "18 seconds", "2 minutes": how long a reply took. */
export function waited(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}
