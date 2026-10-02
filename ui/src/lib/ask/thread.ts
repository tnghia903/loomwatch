// An Ask conversation as the panel shows it, projected from the conversation's archived events
// (ADR 0033). The archive is the one source: the panel never keeps its own copy of what was said,
// so a reload, a second tab and the transcript all read the same thing.
//
// The person's words come from LoomWatch's own `ask_message` record, never from the prompt the app
// was sent, which also carries the instructions. Proposals, run requests and review notes are
// LoomWatch records too. They are placed with the turn they were made in rather than at their
// sequence number: the tool server records a proposal the moment it is made, while the app's own
// report of the call can still be on its way, so the two orders are not the same.
import { ACTIVITY_KINDS, ReplyText } from '../watch/replyText'
import { eventText, type RunEvent } from '../watch/events'
import type { AskState, ProposalOutcome } from './client'

export type StepStatus = 'running' | 'done' | 'failed'

export interface AskStep {
  id: string
  label: string
  status: StepStatus
  /** What went wrong, in the tool's own words, when the step failed. */
  detail: string | null
}

export interface ProposalCard {
  kind: 'proposal'
  id: string
  /** When it was proposed, as the archive recorded it. */
  at: string
  file: string
  name: string
  isNew: boolean
  summary: string
  yaml: string
  outcome: ProposalOutcome | null
  /** A later proposal for the same file replaced this one. */
  superseded: boolean
}

export interface RunRequestCard {
  kind: 'run-request'
  id: string
  file: string
  name: string
  request: string
  apps: string[]
  steps: number
  decision: 'started' | 'declined' | null
  runId: string | null
}

export interface RunStartedCard {
  kind: 'run-started'
  id: string
  runId: string
  file: string
  request: string
}

export interface ReviewNoteCard {
  kind: 'review-note'
  id: string
  runId: string
  file: string
  name: string
  question: string
  text: string
}

export type AskCard = ProposalCard | RunRequestCard | RunStartedCard | ReviewNoteCard

export interface PersonTurn {
  kind: 'person'
  id: string
  text: string
}

export interface AssistantTurn {
  kind: 'assistant'
  id: string
  steps: AskStep[]
  text: string
  cards: AskCard[]
  /** The app finished this turn. */
  done: boolean
  /** The app reasoned without saying anything yet. */
  thinking: boolean
}

export type AskItem = PersonTurn | AssistantTurn

export interface AskThread {
  items: AskItem[]
  state: AskState | null
  error: string | null
  appName: string | null
}

export const EMPTY_THREAD: AskThread = { items: [], state: null, error: null, appName: null }

/** The tools LoomWatch's tool server offers, by the words the panel uses for them. */
const STEP_WORDS: Record<string, { running: string; done: string; failed: string }> = {
  list_teams: { running: 'Looking at your teams', done: 'Looked at your teams', failed: 'Couldn’t list your teams' },
  read_team: { running: 'Reading the team', done: 'Read the team', failed: 'Couldn’t read the team' },
  list_apps: { running: 'Checking your AI apps', done: 'Checked your AI apps', failed: 'Couldn’t check your AI apps' },
  propose_team: { running: 'Drafting the team', done: 'Drafted the team', failed: 'Found a problem in the draft' },
  start_run: { running: 'Getting the run ready', done: 'Got the run ready', failed: 'Couldn’t start the run' },
  get_run: { running: 'Checking the run', done: 'Checked the run', failed: 'Couldn’t read the run' },
  draft_review_note: { running: 'Drafting a review note', done: 'Drafted a review note', failed: 'Couldn’t draft the note' },
}
const TOOL_NAME = new RegExp(`(?:^|[^a-z0-9])(${Object.keys(STEP_WORDS).join('|')})(?![a-z0-9_])`)

/**
 * The LoomWatch tool a reported call used. Apps spell the call differently — Claude Code as
 * `mcp__loomwatch__list_teams`, Codex as `loomwatch.list_teams`, OpenCode with the server in
 * brackets — and the tool's own name is the part they share.
 */
export function toolOf(title: string, name: string | null = null): string | null {
  for (const candidate of [name, title]) {
    const match = candidate?.toLowerCase().match(TOOL_NAME)
    if (match) return match[1]
  }
  return null
}

function stepLabel(tool: string | null, title: string, status: StepStatus, input: unknown): string {
  const words = tool ? STEP_WORDS[tool] : null
  if (!words) return status === 'running' ? `Using ${shorten(title, 48)}` : `Used ${shorten(title, 48)}`
  const file = object(input) && typeof input.file === 'string' ? input.file : null
  if (tool === 'read_team' && file && status !== 'failed') return `${status === 'running' ? 'Reading' : 'Read'} ${file}`
  return words[status]
}

function shorten(text: string, limit: number): string {
  const line = text.split('\n')[0].trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** What a failed call said, in one line. Tool results arrive as text or as `{ error }`. */
function failureDetail(output: unknown): string | null {
  if (typeof output === 'string' && output.trim()) return shorten(output, 220)
  if (object(output) && typeof output.error === 'string') return shorten(output.error, 220)
  return null
}

interface Building {
  turn: AssistantTurn
  reply: ReplyText
  calls: Map<string, { step: AskStep; tool: string | null; title: string; input: unknown }>
}

export function projectAskThread(events: readonly RunEvent[]): AskThread {
  const items: AskItem[] = []
  let state: AskState | null = null
  let error: string | null = null
  let appName: string | null = null
  let current: Building | null = null
  const proposals = new Map<string, ProposalCard>()
  const requests = new Map<string, RunRequestCard>()

  const open = (id: string): Building => {
    const building: Building = { turn: { kind: 'assistant', id, steps: [], text: '', cards: [], done: false, thinking: false }, reply: new ReplyText(), calls: new Map() }
    items.push(building.turn)
    return building
  }
  const active = (id: string): Building => {
    if (!current || current.turn.done) current = open(id)
    return current
  }
  const finish = () => {
    if (!current) return
    current.turn.done = true
    current.turn.thinking = false
    for (const { step } of current.calls.values()) if (step.status === 'running') step.status = 'done'
  }

  for (const event of events) {
    const payload = event.payload
    switch (event.kind) {
      case 'session_meta': {
        const phase = text(payload.phase)
        if (phase === 'ask_status') {
          state = (text(payload.state) || state) as AskState
          if (object(payload.app) && typeof payload.app.name === 'string') appName = payload.app.name
          error = state === 'failed' ? text(payload.error) || 'The assistant stopped.' : null
          if (state === 'failed' || state === 'ended') finish()
        } else if (phase === 'ask_message') {
          finish()
          items.push({ kind: 'person', id: event.id, text: text(payload.text) })
          current = open(`${event.id}:reply`)
        } else if (phase === 'ask_proposal') {
          const card: ProposalCard = {
            kind: 'proposal', id: text(payload.proposalId), at: event.ts, file: text(payload.file), name: text(payload.name) || text(payload.file),
            isNew: payload.isNew === true, summary: text(payload.summary), yaml: text(payload.yaml), outcome: null, superseded: false,
          }
          for (const earlier of proposals.values()) if (earlier.file === card.file) earlier.superseded = true
          proposals.set(card.id, card)
          active(event.id).turn.cards.push(card)
        } else if (phase === 'ask_proposal_outcome') {
          const card = proposals.get(text(payload.proposalId))
          const outcome = text(payload.outcome)
          if (card && (outcome === 'applied' || outcome === 'discarded' || outcome === 'undone')) card.outcome = outcome
        } else if (phase === 'ask_run_request') {
          const card: RunRequestCard = {
            kind: 'run-request', id: text(payload.requestId), file: text(payload.file), name: text(payload.name) || text(payload.file),
            request: text(payload.request), apps: Array.isArray(payload.apps) ? payload.apps.filter((app): app is string => typeof app === 'string') : [],
            steps: typeof payload.steps === 'number' ? payload.steps : 0, decision: null, runId: null,
          }
          requests.set(card.id, card)
          active(event.id).turn.cards.push(card)
        } else if (phase === 'ask_run_started') {
          const request = requests.get(text(payload.requestId))
          if (request) {
            request.decision = 'started'
            request.runId = text(payload.runId) || null
          } else {
            active(event.id).turn.cards.push({ kind: 'run-started', id: event.id, runId: text(payload.runId), file: text(payload.file), request: text(payload.request) })
          }
        } else if (phase === 'ask_run_declined') {
          const request = requests.get(text(payload.requestId))
          if (request) request.decision = 'declined'
        } else if (phase === 'ask_review_note') {
          active(event.id).turn.cards.push({
            kind: 'review-note', id: event.id, runId: text(payload.runId), file: text(payload.file),
            name: text(payload.name), question: text(payload.question), text: text(payload.text),
          })
        }
        break
      }
      case 'message': {
        if (payload.role !== 'agent') break
        const building = active(event.id)
        building.reply.push(eventText(event), typeof payload.messageId === 'string' ? payload.messageId : null)
        building.turn.text = building.reply.text
        building.turn.thinking = false
        break
      }
      case 'thought': {
        if (current && !current.turn.done && !current.turn.text) current.turn.thinking = true
        break
      }
      case 'tool_call': {
        const building = active(event.id)
        const callId = text(payload.callId) || event.id
        const title = text(payload.title) || text(payload.name) || 'a tool'
        const tool = toolOf(title, typeof payload.name === 'string' ? payload.name : null)
        const status: StepStatus = payload.status === 'completed' ? 'done' : payload.status === 'failed' ? 'failed' : 'running'
        const step: AskStep = { id: `${building.turn.id}:${callId}`, label: stepLabel(tool, title, status, payload.rawInput), status, detail: status === 'failed' ? failureDetail(payload.rawOutput) : null }
        building.calls.set(callId, { step, tool, title, input: payload.rawInput })
        building.turn.steps.push(step)
        building.turn.thinking = false
        building.reply.noteActivity()
        break
      }
      case 'tool_update': {
        const call = current?.calls.get(text(payload.callId))
        if (!call) break
        if (payload.status === 'completed' || payload.status === 'failed') {
          call.step.status = payload.status === 'completed' ? 'done' : 'failed'
          call.step.label = stepLabel(call.tool, call.title, call.step.status, call.input)
          call.step.detail = call.step.status === 'failed' ? failureDetail(payload.rawOutput) : null
        }
        current?.reply.noteActivity()
        break
      }
      case 'plan':
      case 'permission': {
        if (ACTIVITY_KINDS.has(event.kind)) current?.reply.noteActivity()
        break
      }
      case 'turn_end':
        finish()
        break
      default:
        break
    }
  }
  return { items, state, error, appName }
}

/** What the assistant is doing right now, in a few words, or null when it is not working. */
export function currentActivity(thread: AskThread): string | null {
  if (thread.state !== 'working' && thread.state !== 'starting') return null
  if (thread.state === 'starting' && !thread.items.some((item) => item.kind === 'person')) return `Starting ${thread.appName ?? 'the assistant'}`
  const last = thread.items.at(-1)
  if (!last || last.kind !== 'assistant' || last.done) return 'Reading your message'
  const running = [...last.steps].reverse().find((step) => step.status === 'running')
  if (running) return running.label
  if (last.thinking) return 'Thinking'
  return last.text ? 'Writing' : 'Reading your message'
}
