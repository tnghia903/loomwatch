// The daemon's Ask LoomWatch surface (crates/loomwatch-backend/src/control, ADR 0033): one
// conversation with an AI app on this computer, the proposals it makes, the runs it asks to start,
// and the apps connected to the same tools from outside LoomWatch.
import { daemonFetch } from '../daemonFetch'

export type AskState = 'starting' | 'ready' | 'working' | 'ended' | 'failed'

export interface AskApp {
  id: string
  name: string
  available: boolean
  reason: string | null
}

export interface AskApps {
  apps: AskApp[]
  /** The app a new conversation uses when none is named; null when none can. */
  defaultApp: string | null
}

export interface ConversationInfo {
  id: string
  app: string
  appName: string
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
  /** The conversation id, or `connection:<app>` for a connected app. */
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

/** Something a connected app did with LoomWatch's tools, newest last. */
export interface InboxItem {
  phase: 'ask_proposal' | 'ask_run_started' | 'ask_review_note' | 'ask_proposal_outcome' | string
  app: string
  appName: string
  at: string
  proposalId?: string
  file?: string
  name?: string
  summary?: string
  isNew?: boolean
  runId?: string
  request?: string
  question?: string
  text?: string
}

export interface ConnectableApp {
  id: string
  name: string
  detected: boolean
  connected: boolean
  connectedAt: string | null
  method: 'command' | 'snippet'
  /** The command LoomWatch runs, with the token masked. */
  command: string | null
  canRemove: boolean
  snippetPlace: string | null
  /** Only in the answer to a connect, for an app the person has to paste into themselves. */
  snippet?: unknown
}

export interface Connections {
  url: string
  apps: ConnectableApp[]
}

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

/** How long a write may go unanswered before the panel says the server isn't answering. Starting
    an app or connecting one can take a while; nothing here should take longer than this. */
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

export async function fetchAskApps(signal?: AbortSignal): Promise<AskApps> {
  return read(await daemonFetch('/api/ask/apps', { signal, cache: 'no-store' }))
}

export async function startConversation(askBeforeRun: boolean, app?: string): Promise<ConversationInfo> {
  return read(await post('/api/ask/conversations', { askBeforeRun, ...(app ? { app } : {}) }))
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

export async function fetchInbox(signal?: AbortSignal): Promise<InboxItem[]> {
  const body = await read<{ items?: InboxItem[] }>(await daemonFetch('/api/ask/inbox', { signal, cache: 'no-store' }))
  return Array.isArray(body?.items) ? body.items : []
}

export async function fetchConnections(signal?: AbortSignal): Promise<Connections> {
  return read(await daemonFetch('/api/ask/connections', { signal, cache: 'no-store' }))
}

export async function connectApp(id: string): Promise<ConnectableApp> {
  return read(await post(`/api/ask/connections/${encodeURIComponent(id)}`))
}

export async function disconnectApp(id: string): Promise<{ removedFromApp: boolean; note: string | null }> {
  return read(await daemonFetch(`/api/ask/connections/${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store' }))
}
