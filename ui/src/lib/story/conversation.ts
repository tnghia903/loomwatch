import type { Evidence } from '../watch/events'
import { OPERATOR_ID, type MessageKind, type TeamMessage } from '../watch/messages'

/**
 * The run's messages laid out for reading (components/run/AgentMessages.tsx): one lane per party
 * that sent or received something, and each message placed between its lanes, like a sequence
 * diagram read top to bottom.
 *
 * The projection records what was said (lib/watch/messages.ts). The one thing added here is who
 * wrote a pipeline handover, which the record does not name: the daemon builds a stage's handover
 * from the stages connected into it (`pipeline_node_prompt`), so the senders are those
 * connections, and a review step it passed through is named as the way it came.
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
}

export interface Conversation {
  lanes: Lane[]
  lines: Line[]
}

export type MessageGroup = 'questions' | 'handovers'

export const GROUP_OF: Record<MessageKind, MessageGroup> = {
  ask: 'questions', question: 'questions', escalate: 'questions',
  handover: 'handovers', direction: 'handovers', handoff: 'handovers', dispatch: 'handovers', note: 'handovers',
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
    if (message.kind === 'handover' && message.to !== null) {
      const { senders, via } = writers(message.to)
      return { message, senders, receiver, replier, via }
    }
    if (message.kind === 'direction' && message.to !== null) {
      const stops = before(message.to).filter((id) => known.get(id)?.operator)
      return { message, senders: stops.length > 0 ? stops : [laneId(OPERATOR_ID)], receiver, replier, via: [] }
    }
    return { message, senders: message.from === null ? [] : [laneId(message.from)], receiver, replier, via: [] }
  })

  // Lanes in the team's order, then anyone the run brought in that the team file does not list.
  const involved = new Set(lines.flatMap((line) => [...line.senders, ...line.via, line.receiver, line.replier].filter((id): id is string => id !== null)))
  const lanes: Lane[] = order.filter((party) => involved.has(party.id))
  for (const id of involved) {
    if (known.has(id)) continue
    lanes.push(id === OPERATOR_ID ? { id, name: 'You', operator: true } : { id, name: id, operator: false })
  }
  return { lanes, lines }
}

/** The parties a line touches, for "show only the messages with this agent". */
export function touches(line: Line, laneId: string): boolean {
  return line.senders.includes(laneId) || line.via.includes(laneId) || line.receiver === laneId || line.replier === laneId
}

/** Whether a message went back up the line: to a lane before its sender's. */
export function goesBack(line: Line, lanes: readonly Lane[]): boolean {
  if (line.receiver === null || line.senders.length !== 1) return false
  const index = (id: string) => lanes.findIndex((lane) => lane.id === id)
  return index(line.receiver) < index(line.senders[0])
}

/** Names joined as a person would say them: "Writer", "Writer and Editor", "A, B and C". */
export function nameList(names: readonly string[]): string {
  return names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * What happened, as a sentence a newcomer can read. `name` resolves a lane id to what the run view
 * calls it; you are "you".
 */
export function lineSentence(line: Line, name: (laneId: string) => string, operator: (laneId: string) => boolean): string {
  const to = line.receiver === null ? '' : operator(line.receiver) ? 'you' : name(line.receiver)
  const from = nameList(line.senders.map(name))
  switch (line.message.kind) {
    case 'handover': {
      const via = line.via.length > 0 ? ', through your review' : ''
      if (!from) return `${to === 'you' ? 'You were' : `${to} was`} handed the work${via}`
      return to === 'you' ? `${from} handed over to you for review` : `${from} handed over to ${to}${via}`
    }
    case 'direction': return `You gave ${to} direction`
    case 'ask': return `${from} asked ${to}`
    case 'dispatch': return `${from} sent part of the work to ${to}`
    case 'handoff': return `${from} handed the work to ${to}`
    case 'question': return `${from} asked you`
    case 'escalate': return `${from} raised something with you`
    case 'note': return 'You wrote to the team'
  }
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
