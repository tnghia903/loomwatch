// The daemon's Ask LoomWatch surface (crates/loomwatch-backend/src/control, ADR 0033): one
// conversation with LoomWatch's assistant, on the person's OpenRouter key and the model they chose,
// the proposals it makes and the runs it asks to start.
import { daemonFetch } from '../daemonFetch'

export type AskState = 'starting' | 'ready' | 'working' | 'ended' | 'failed'

export interface ConversationInfo {
  id: string
  app: string
  appName: string
  /** The model this conversation runs on. */
  model?: string | null
  state: AskState
  error?: string | null
  askBeforeRun?: boolean
  lastRun?: string | null
}

/** Where the person is, sent with every message so the assistant never has to ask. */
export interface AskContext {
  view: 'home' | 'build' | 'run'
  teamPath: string | null
  runId: string | null
}

/** A team file the assistant proposed. Nothing is saved until the person applies it. */
export interface Proposal {
  id: string
  /** The conversation that proposed it. */
  source: string
  file: string
  name: string
  isNew: boolean
  yaml: string
  baseRevision: string | null
  summary: string
  createdAt: string
}

export type ProposalOutcome = 'applied' | 'discarded' | 'undone'

export class AskApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function read<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const body = (await response.json().catch(() => null)) as T | { error?: string } | null
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && body.error ? String(body.error) : `${response.status} ${response.statusText}`
    throw new AskApiError(message, response.status)
  }
  return body as T
}

/** How long a write may go unanswered before the panel says the server isn't answering. */
const WRITE_TIMEOUT_MS = 90_000

function post(url: string, body?: unknown): Promise<Response> {
  return daemonFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
}

const conversationUrl = (id: string) => `/api/ask/conversations/${encodeURIComponent(id)}`

/** Starts a conversation on `model`, else the agents' default model. */
export async function startConversation(askBeforeRun: boolean, model?: string | null): Promise<ConversationInfo> {
  return read(await post('/api/ask/conversations', { askBeforeRun, ...(model ? { model } : {}) }))
}

/** The conversation's current state, or null once the daemon no longer has it (ended, or restarted). */
export async function fetchConversation(id: string, signal?: AbortSignal): Promise<ConversationInfo | null> {
  const response = await daemonFetch(conversationUrl(id), { signal, cache: 'no-store' })
  if (response.status === 404) return null
  return read(response)
}

export async function sendAskMessage(id: string, text: string, context: AskContext): Promise<void> {
  await read(await post(`${conversationUrl(id)}/messages`, { text, context }))
}

export async function endConversation(id: string): Promise<void> {
  await read(await daemonFetch(conversationUrl(id), { method: 'DELETE', cache: 'no-store' }))
}

export async function setAskBeforeRun(id: string, askBeforeRun: boolean): Promise<void> {
  await read(await post(`${conversationUrl(id)}/settings`, { askBeforeRun }))
}

export async function decideRunRequest(id: string, requestId: string, decision: 'started' | 'declined', runId?: string): Promise<void> {
  await read(await post(`${conversationUrl(id)}/run-requests/${encodeURIComponent(requestId)}`, { decision, ...(runId ? { runId } : {}) }))
}

export async function fetchProposal(id: string, signal?: AbortSignal): Promise<Proposal> {
  return read(await daemonFetch(`/api/ask/proposals/${encodeURIComponent(id)}`, { signal, cache: 'no-store' }))
}

export async function reportProposalOutcome(id: string, outcome: ProposalOutcome): Promise<void> {
  await read(await post(`/api/ask/proposals/${encodeURIComponent(id)}/outcome`, { outcome }))
}

export interface InstructionsRewrite {
  /** The model to ask; absent is the faster model. */
  model?: string | null
  /** What was taken off the canvas, as its card showed it. */
  removed: { name: string; kind: string }
  agents: { id: string; name: string; role: string }[]
}

/** The daemon gives the model three minutes; this waits a little longer so its own answer arrives. */
const REWRITE_TIMEOUT_MS = 200_000

/**
 * The named agents' instructions without the removed source (ADR 0059), from one turn of the
 * assistant with no tools. Only agents it answered for come back; nothing is saved.
 */
export async function rewriteInstructions(request: InstructionsRewrite): Promise<{ id: string; role: string }[]> {
  const body = await read<{ agents?: { id: string; role: string }[] }>(await daemonFetch('/api/ask/instructions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      removed: request.removed, agents: request.agents, ...(request.model ? { model: request.model } : {}),
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
  }))
  return Array.isArray(body?.agents) ? body.agents : []
}
