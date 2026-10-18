import { checkItemsOf, type CheckItemResult } from '../story/checks'
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
  /** An agent's app asked to do something its switches do not cover, and LoomWatch asked you (ADR 0040). */
  | 'permission'
  /**
   * A check step's round on the work it checks (ADR 0062): its verdict, and when it sent the work
   * back, what it found; the checked agent's revised work is the reply. One message per round.
   */
  | 'check'

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
  /**
   * For an `ask`: the asked agent stopped at the run's spending limit, or its own, before it
   * answered (ADR 0068). `text` says why; it is not an answer to the question.
   */
  stopped?: true
  /**
   * For an `ask`: the asked agent did not answer yet but asked back, needing something from the
   * asker first (`questionBack` in the record). The asker's next `ask` to it clarifies.
   */
  asksBack?: true
}

/**
 * Why the Team Bus would not put a question, as it recorded it (`refused`): the asked stage had
 * finished, the asker had asked it as many questions as the team allows, an agent answering a
 * question tried to ask back the one waiting on it or to bring someone else in, or a stage that may
 * not recruit asked an agent nobody had started.
 */
export type AskRefusal = 'finished' | 'limit' | 'asking_back' | 'cannot_start' | 'not_recruiting'

const REFUSALS: ReadonlySet<string> = new Set<AskRefusal>(['finished', 'limit', 'asking_back', 'cannot_start', 'not_recruiting'])
const isRefusal = (value: unknown): value is AskRefusal => typeof value === 'string' && REFUSALS.has(value)

/** Who a handover or a direction came from, as the prompt record names them. */
export interface HandedBy {
  /** The stages that wrote it, or for a direction, the review steps that gave it. */
  from: string[]
  /** Review steps a handover passed through on its way, unchanged. */
  via: string[]
}

/** How a permission request was settled, as the daemon recorded it (`permission_answered`). */
export type PermissionOutcome = 'allow_once' | 'allow_run' | 'allow_team' | 'deny' | 'edited' | 'answered' | 'timed_out'

const OUTCOMES: ReadonlySet<string> = new Set<PermissionOutcome>(['allow_once', 'allow_run', 'allow_team', 'deny', 'edited', 'answered', 'timed_out'])
const isOutcome = (value: unknown): value is PermissionOutcome => typeof value === 'string' && OUTCOMES.has(value)

/** What a `permission` message asked, from the daemon's `awaiting_permission` record. */
export interface PermissionAsk {
  /** The live request's id, which the run record's `permissionRequests` carries while it waits. */
  requestId: string
  /** The `allow:` switch that would have let it through: `web`, `commands` or `edits`. */
  switch: string | null
  /** For a connected tool's call (ADR 0069): which tool, by name. */
  tool?: string | null
  /** The query, command, address or path, when the request named one. */
  detail: string | null
  /** Why Auto mode left this command to you, when the team was in Auto mode (ADR 0061). */
  auto?: string | null
  /** How it was settled; `null` while it waits, or when the run ended first. */
  outcome: PermissionOutcome | null
  /** What you wrote: the command as you changed it (`edited`), or your answer (`answered`). */
  written?: string | null
  /** When it was settled. */
  settled: { eventId: string; seq: number; ts: string; offsetMs: number } | null
}

/** A check step's round, as the daemon recorded it (`check_result`, then `check_sent_back`). */
export interface CheckExchange {
  round: number
  /** Every item it checked in this round, with its verdict and evidence. */
  items: CheckItemResult[]
  /** False when its reply had no Check block LoomWatch could read: nothing in it is confirmed. */
  readable: boolean
  /** The findings went back to the checked agent, whose next turn is the reply. */
  sentBack: boolean
  /** What the check step wrote about the problems, sent back with the findings. */
  problems: string | null
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
  /** For a `permission` message: what was asked and how it was settled. */
  permission?: PermissionAsk
  /**
   * For an `ask`: it answers what the asked agent asked back, continuing an earlier question
   * rather than starting one (`clarifies` in the record).
   */
  clarifies?: true
  /** For an `ask` the Team Bus would not put: why, when it recorded a reason. */
  refused?: AskRefusal
  /** For a `check` message: the round and what it found. */
  check?: CheckExchange
}

/** Whether a check round found nothing missing: every item met, from a reply that could be read. */
export function allMet(check: CheckExchange): boolean {
  return check.readable && check.items.length > 0 && check.items.every((item) => item.verdict === 'met')
}

/**
 * A check round's words, from what it recorded: the check step's own account of the problems when
 * it sent the work back, then the items it did not find met, each with its evidence.
 */
export function checkText(check: CheckExchange): string {
  if (!check.readable) return 'Its reply had no Check block LoomWatch could read, so nothing it checked is confirmed.'
  if (allMet(check)) return `All ${check.items.length} met.`
  const list = (verdict: CheckItemResult['verdict'], heading: string) => {
    const items = check.items.filter((item) => item.verdict === verdict)
    return items.length ? [`**${heading}**`, ...items.map((item) => `- ${item.item}${item.evidence ? ` — ${item.evidence}` : ''}`)].join('\n') : ''
  }
  return [check.problems ?? '', list('not_met', 'Not met'), list('not_sure', 'Not sure')].filter(Boolean).join('\n\n')
}

/** Team Bus tools that carry a message from one agent to another. */
const BUS_KINDS: Record<string, MessageKind> = { ask: 'ask', dispatch: 'dispatch', handoff: 'handoff', escalate: 'escalate' }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The connected tool a recorded ask names (`{server, call}`), by name. */
function toolOf(value: unknown): string | null {
  return value && typeof value === 'object' ? words((value as { server?: unknown }).server) : null
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
  /** Each agent's last ended turn, for a send-back recorded after the turn that answered it. */
  private readonly lastTurn = new Map<string, { reply: string; event: RunEvent }>()
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
      if (message.kind === 'ask' && isRefusal(output.refused)) message.refused = output.refused
      return
    }
    // The bus accepts a name where the id belongs and answers with the id it resolved.
    if (message.kind !== 'escalate') message.to = words(output.agent) ?? message.to
    if (message.kind !== 'ask') { message.state = 'delivered'; return }
    message.state = 'answered'
    if (output.clarifies === true) message.clarifies = true
    message.reply = {
      from: message.to ?? item.agentId,
      text: typeof output.reply === 'string' ? output.reply : '',
      ...this.at(event),
      source: output.live === true ? 'open' : typeof output.sessionId === 'string' ? 'fresh' : null,
      sentBackTo: null,
      ...(output.stopped === 'spend_limit' ? { stopped: true as const } : {}),
      ...(typeof output.questionBack === 'string' ? { asksBack: true as const } : {}),
    }
  }

  /**
   * `awaiting_permission`: the agent's app is paused on a request, waiting for you. Its text is the
   * app's own name for the action, verbatim; `evidenceId` is the recorded request.
   */
  permissionAsked(event: RunEvent, evidenceId: string | null) {
    const p = event.payload
    const requestId = words(p.requestId)
    if (!requestId) return
    this.add(event, {
      id: `permission:${requestId}`, kind: 'permission', from: event.agentId, to: OPERATOR_ID, text: words(p.title) ?? 'An action',
      evidenceId, state: 'pending',
      permission: { requestId, switch: words(p.switch), tool: toolOf(p.tool), detail: words(p.detail), auto: words(p.autoNote), outcome: null, settled: null },
    })
  }

  /**
   * `permission_answered`. Your answer closes the request as answered by you; the clock running out
   * closes it with nobody's answer. A request let through by an earlier "Allow for this run" was
   * never asked (no `requestId`), so it has no message to close.
   */
  permissionAnswered(event: RunEvent) {
    const requestId = words(event.payload.requestId)
    const outcome = event.payload.outcome
    const message = requestId ? this.messages.find((candidate) => candidate.permission?.requestId === requestId) : undefined
    if (!message?.permission || !isOutcome(outcome)) return
    message.permission.outcome = outcome
    message.permission.settled = this.at(event)
    message.permission.written = outcome === 'edited' ? words(event.payload.edited) : outcome === 'answered' ? words(event.payload.answer) : null
    if (outcome === 'timed_out') { message.state = 'delivered'; return }
    message.state = 'answered'
    message.reply = { from: OPERATOR_ID, text: message.permission.written ?? '', ...this.at(event), source: null, sentBackTo: null }
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
   * `check_result`: a check step's verdict on a round of the work it checks (ADR 0062). Every round
   * is a message of its own, so a loop of any length reads as one exchange after another.
   */
  checkResult(event: RunEvent) {
    const p = event.payload
    const to = words(p.checked)
    if (!to || !Array.isArray(p.items)) return
    const check: CheckExchange = { round: typeof p.round === 'number' ? p.round : 1, items: checkItemsOf(p.items), readable: p.readable !== false, sentBack: false, problems: null }
    this.add(event, { id: `check:${event.id}`, kind: 'check', from: event.agentId, to, text: checkText(check), state: 'delivered', check })
  }

  /**
   * `check_sent_back`: the round's findings went back to the checked agent, with what the check
   * step wrote about them. The daemon records it before the turn it starts, so the turn that agent
   * ends next is the reply. Older runs recorded it after that turn, and named no round: there, the
   * turn the agent ended last is the reply.
   */
  checkSentBack(event: RunEvent) {
    const p = event.payload
    const to = words(p.to)
    const message = this.messages.findLast((candidate) => candidate.kind === 'check' && candidate.from === event.agentId && candidate.to === to && !candidate.check?.sentBack)
    if (!to || !message?.check) return
    message.check.sentBack = true
    message.check.problems = words(p.problems)
    message.text = checkText(message.check)
    if (typeof p.round === 'number') { message.state = 'pending'; return }
    const last = this.lastTurn.get(to)
    if (!last || last.event.seq < message.seq) return
    message.state = 'answered'
    message.reply = { from: to, text: last.reply, ...this.at(last.event), source: 'open', sentBackTo: null }
  }

  /** `check_send_back_skipped`: the checked agent was no longer open, so nothing went back. */
  checkSendBackSkipped(event: RunEvent) {
    const to = words(event.payload.to)
    const message = this.messages.findLast((candidate) => candidate.kind === 'check' && candidate.from === event.agentId && candidate.to === to && candidate.state === 'pending')
    if (!message) return
    message.state = 'failed'
    message.error = 'it had already finished, so the work was not revised'
  }

  /**
   * An agent's turn ended with this reply. The daemon prompts a kept-alive agent with your note, or
   * a check step's findings, in the turn right after archiving it, so the first turn to end on that
   * agent after one is the one that answered it.
   */
  turnEnded(event: RunEvent, reply: string) {
    this.lastTurn.set(event.agentId, { reply, event })
    const owed = this.messages.find((message) => (message.kind === 'note' || message.kind === 'check') && message.to === event.agentId && message.state === 'pending')
    if (!owed) return
    owed.state = 'answered'
    owed.reply = { from: event.agentId, text: reply, ...this.at(event), source: owed.kind === 'check' ? 'open' : null, sentBackTo: null }
  }

  /** An agent's turn ended in an error its app reported, so the note or findings that turn was for failed. */
  turnFailed(event: RunEvent, error: string) {
    const note = this.messages.find((message) => (message.kind === 'note' || message.kind === 'check') && message.to === event.agentId && message.state === 'pending')
    if (!note) return
    note.state = 'failed'
    note.error = error
  }

  list(): TeamMessage[] {
    return this.messages.map((message) => ({
      ...message,
      reply: message.reply ? { ...message.reply } : null,
      ...(message.permission ? { permission: { ...message.permission } } : {}),
      ...(message.check ? { check: { ...message.check, items: [...message.check.items] } } : {}),
    }))
  }
}

/** A recorded list of ids, or `null` when the record has none (an older run). */
function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}
