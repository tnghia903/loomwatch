import type { Evidence, PromptSection, RunEvent } from './events'

/**
 * What the agents of a run said to each other, as the archive recorded it.
 *
 * A run already shows each agent's own work; what it did not show in one place is the traffic
 * between them — a handover, a question one stage put back to the stage before it and the answer
 * it got, a task sent off to a helper, a question for you and your answer. Each of those is a
 * recorded fact somewhere in the archive (a `prompt_sections` record, a Team Bus call and its
 * update, an `awaiting_operator` note, your answer as a user message), and this collects them in
 * the order they happened.
 *
 * The same rule as the rest of the projection holds: nothing here is read out of what an agent
 * wrote. A message's text is the recorded question, task or handover, verbatim; who it went to is
 * the recorded target; who handed a stage its handover is the prompt record's `stageResultsFrom`.
 * Runs archived before the daemon recorded that leave `handedBy` null, and the surface falls back
 * to the team's connections, saying so.
 */

/** The id your answers are archived under when the team has no review step of its own (docs/TEAM_CONFIG.md). */
export const OPERATOR_ID = 'operator'

export type MessageKind =
  /** What a pipeline stage was handed by the stages before it (`stage_results`). */
  | 'handover'
  /** Your answer at a review step, handed to the next stage as direction (`direction`). */
  | 'direction'
  /** Team Bus `ask`: a question to another agent that waits for its reply. */
  | 'ask'
  /** Team Bus `dispatch`: part of the work sent to another agent. Nothing comes back. */
  | 'dispatch'
  /** Team Bus `handoff`: the work handed to another agent; the sender stops. */
  | 'handoff'
  /** `ask_user`: a question for you. */
  | 'question'
  /** Team Bus `escalate`, in older runs: something raised with you. */
  | 'escalate'
  /** Something you wrote that answered no recorded question, such as a reply to a kept-alive agent. */
  | 'note'

/**
 * `pending` — sent, and waiting for the reply its kind expects (an `ask`, a question for you, a
 * handover a review step is reading) or still being sent. `delivered` — sent, and its kind expects
 * nothing back. `answered` — the reply is in `reply`. `failed` — the Team Bus refused or lost it.
 */
export type MessageState = 'pending' | 'delivered' | 'answered' | 'failed'

export interface MessageReply {
  /** Who answered: the asked agent, or the id your answer was archived under. */
  from: string
  text: string
  eventId: string
  seq: number
  ts: string
  offsetMs: number
  /**
   * For an `ask`: `open` — the asked agent answered in the session it already had, with
   * everything it had read and written there; `fresh` — a new copy was started to answer, which
   * knew only its role and the question. `null` when the record does not say.
   */
  source: 'open' | 'fresh' | null
  /** Your answer at a review step that sent the work back: the stage it went back to. */
  sentBackTo: string | null
}

/** Who a handover or a direction came from, as the prompt record names them. */
export interface HandedBy {
  /** The stages that wrote it, or for a direction, the review steps that gave it. */
  from: string[]
  /** Review steps a handover passed through on its way, unchanged. */
  via: string[]
}

export interface TeamMessage {
  id: string
  kind: MessageKind
  /** The sender's id; `null` for a handover, whose senders are in `handedBy`. */
  from: string | null
  /** For a handover or a direction: who it came from, as recorded. `null` in runs archived before it was. */
  handedBy: HandedBy | null
  /** The recipient's id; `null` only for a `note` the record does not address. */
  to: string | null
  /** Verbatim: the question, the task, the handover, the reason, your words. */
  text: string
  /** What an `ask_user` question added as context, verbatim. */
  context: string | null
  /** The event the message was recorded in. */
  eventId: string
  /** The recorded Team Bus call behind it, for the record inspector. */
  evidenceId: string | null
  seq: number
  ts: string
  offsetMs: number
  state: MessageState
  /** Why a failed message failed, as the Team Bus said it. */
  error: string | null
  reply: MessageReply | null
  /**
   * Handed on from the work this run follows, not said in it: a follow-up or a one-agent turn is
   * given the earlier handover and your earlier review again (`replayed` on the prompt record,
   * ADR 0051). The chat says the agent picked it up rather than drawing it as a new message.
   */
  carried: boolean
}

/** Team Bus tools that carry a message from one agent to another. */
const BUS_KINDS: Record<string, MessageKind> = { ask: 'ask', dispatch: 'dispatch', handoff: 'handoff', escalate: 'escalate' }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function words(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Collects messages while `projectRun` reads the archive, so they obey everything the projection
 * obeys: the replay cursor, the skipped `session/load` history, and the Team Bus echo dedup.
 */
export class Correspondence {
  private readonly messages: TeamMessage[] = []
  private readonly byEvidence = new Map<string, TeamMessage>()
  /** Each agent's latest `ask_user` call, so its question can open the call that asked it. */
  private readonly askedUser = new Map<string, string>()
  /** Agents the record shows as review steps, which pass a handover through rather than write one. */
  private readonly reviewSteps = new Set<string>()
  private readonly startMs: number

  constructor(startMs: number) {
    this.startMs = startMs
  }

  private at(event: RunEvent) {
    return { eventId: event.id, seq: event.seq, ts: event.ts, offsetMs: Date.parse(event.ts) - this.startMs }
  }

  private add(event: RunEvent, message: Omit<TeamMessage, 'eventId' | 'seq' | 'ts' | 'offsetMs' | 'context' | 'evidenceId' | 'error' | 'reply' | 'handedBy' | 'carried'> & Partial<Pick<TeamMessage, 'context' | 'evidenceId' | 'handedBy' | 'carried'>>): TeamMessage {
    const added: TeamMessage = { context: null, evidenceId: null, error: null, reply: null, handedBy: null, carried: false, ...message, ...this.at(event) }
    this.messages.push(added)
    return added
  }

  /**
   * An opening prompt's record: what the stage was handed, and the direction you gave at the
   * review step before it. Every record counts — a review step that sent work back reads a second
   * handover, and that is a second message.
   */
  promptRecord(event: RunEvent, sections: readonly PromptSection[]) {
    const find = (kind: PromptSection['kind']) => words(sections.find((section) => section.kind === kind)?.text?.trim())
    const carried = event.payload.replayed === true
    const direction = find('direction')
    const stops = ids(event.payload.directionFrom)
    if (direction) this.add(event, { id: `direction:${event.id}`, kind: 'direction', from: OPERATOR_ID, to: event.agentId, text: direction, state: 'delivered', handedBy: stops && { from: stops, via: [] }, carried })
    const handover = find('stage_results')
    const senders = ids(event.payload.stageResultsFrom)
    if (handover) this.add(event, { id: `handover:${event.id}`, kind: 'handover', from: null, to: event.agentId, text: handover, state: 'delivered', handedBy: senders && this.writers(senders), carried })
  }

  /**
   * A review step passes on the handover it read, unchanged, so the stages that wrote it are the
   * ones that handed it to the review step — which that step's own record names.
   */
  private writers(senders: readonly string[]): HandedBy {
    const from: string[] = []
    const via: string[] = []
    for (const sender of senders) {
      const read = this.reviewSteps.has(sender) ? this.messages.findLast((message) => message.kind === 'handover' && message.to === sender) : undefined
      if (!read?.handedBy) { from.push(sender); continue }
      via.push(...read.handedBy.via, sender)
      from.push(...read.handedBy.from)
    }
    return { from: [...new Set(from)], via: [...new Set(via)] }
  }

  /** The pre-record fallback: a handover split out of an archived opening prompt. */
  legacyHandover(event: RunEvent, text: string) {
    this.add(event, { id: `handover:${event.id}`, kind: 'handover', from: null, to: event.agentId, text, state: 'delivered' })
  }

  /** A projected tool call. Only the bus-authored call of a messaging tool becomes a message. */
  toolCall(item: Evidence, busName: string | null, toolName: string | null, title: string) {
    if (toolName === 'ask_user' && title === 'Team Bus: ask_user') this.askedUser.set(item.agentId, item.id)
    const kind = busName ? BUS_KINDS[busName] : undefined
    if (!kind) return
    const input = object(item.rawInput) ? item.rawInput : {}
    const text = words(kind === 'ask' ? input.question : kind === 'escalate' ? input.reason : input.task) ?? ''
    const to = kind === 'escalate' ? OPERATOR_ID : words(input.agent)
    const message = this.add(item.events[0], { id: item.id, kind, from: item.agentId, to, text, evidenceId: item.id, state: item.status === 'failed' ? 'failed' : 'pending' })
    this.byEvidence.set(item.id, message)
  }

  /** A terminal update on a call `toolCall` turned into a message. */
  toolSettled(item: Evidence, event: RunEvent, status: 'completed' | 'failed') {
    const message = this.byEvidence.get(item.id)
    if (!message) return
    const output = object(event.payload.rawOutput) ? event.payload.rawOutput : {}
    if (status === 'failed') {
      message.state = 'failed'
      message.error = words(output.error)
      return
    }
    if (message.kind !== 'ask') { message.state = 'delivered'; return }
    message.state = 'answered'
    message.reply = {
      from: message.to ?? item.agentId,
      text: typeof output.reply === 'string' ? output.reply : '',
      ...this.at(event),
      source: output.live === true ? 'open' : typeof output.sessionId === 'string' ? 'fresh' : null,
      sentBackTo: null,
    }
  }

  /** `awaiting_operator`: an agent's question for you, or a review step starting to read its handover. */
  awaiting(event: RunEvent) {
    const p = event.payload
    if (p.kind === 'question') {
      this.add(event, {
        id: `question:${event.id}`, kind: 'question', from: event.agentId, to: OPERATOR_ID, text: words(p.question) ?? '',
        context: words(p.context), evidenceId: this.askedUser.get(event.agentId) ?? null, state: 'pending',
      })
      this.askedUser.delete(event.agentId)
    } else if (p.kind === 'review_stop') {
      this.reviewSteps.add(event.agentId)
      const handover = this.messages.findLast((message) => message.kind === 'handover' && message.to === event.agentId)
      if (handover && handover.state === 'delivered' && !handover.reply) handover.state = 'pending'
    }
  }

  /**
   * Your answer. The daemon records whose question or review it closes (`askedBy`), whether it
   * sent the work back (`sendBack`), and for a follow-up to a kept-alive agent, who it went to
   * (`to`). Older runs record none of these: there it answers the earliest thing still waiting on
   * whoever it was archived under, then the earliest open question, and is otherwise a note.
   */
  operatorAnswer(event: RunEvent, text: string) {
    const raw = object(event.raw) ? event.raw : {}
    const askedBy = words(raw.askedBy)
    const waiting = (message: TeamMessage) => message.state === 'pending' && !message.reply
    const answered = askedBy
      ? this.messages.find((message) => waiting(message) && ((message.kind === 'handover' && message.to === askedBy) || (message.kind === 'question' && message.from === askedBy)))
      : this.messages.find((message) => waiting(message) && message.kind === 'handover' && message.to === event.agentId)
        ?? this.messages.find((message) => waiting(message) && message.kind === 'question')
    if (!answered) {
      const to = words(raw.to)
      // A follow-up to a kept-alive agent: its next turn is the answer (`turnEnded`).
      this.add(event, { id: `note:${event.id}`, kind: 'note', from: event.agentId, to, text, state: to ? 'pending' : 'delivered' })
      return
    }
    answered.state = 'answered'
    answered.reply = { from: event.agentId, text, ...this.at(event), source: null, sentBackTo: words(raw.sendBack) }
  }

  /**
   * An agent's turn ended with this reply. The daemon prompts a kept-alive agent with your note in
   * the turn right after archiving it, so the first turn to end on that agent after a note is the
   * one that answered it.
   */
  turnEnded(event: RunEvent, reply: string) {
    const note = this.messages.find((message) => message.kind === 'note' && message.to === event.agentId && message.state === 'pending')
    if (!note) return
    note.state = 'answered'
    note.reply = { from: event.agentId, text: reply, ...this.at(event), source: null, sentBackTo: null }
  }

  list(): TeamMessage[] {
    return this.messages.map((message) => ({ ...message, reply: message.reply ? { ...message.reply } : null }))
  }
}

/** A recorded list of ids, or `null` when the record has none (an older run). */
function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}
