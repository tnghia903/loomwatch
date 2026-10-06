import { daemonFetch } from '../daemonFetch'
import { readRun, type RunRecord } from '../runs/client'

/**
 * A team's chat (ADR 0051): its runs and what you wrote to it, read as one conversation.
 *
 * The daemon decides where each message goes, by a fixed rule this file mirrors in `route.ts` so
 * the message box can say it before you send: `@team` starts the whole team, `@<agent>` starts
 * that agent alone (or, while it works, becomes a note for its next turn), and anything without an
 * @ is a note — to the agent at work, or to the whole team for next time.
 */

/** How a message was routed. */
export type ChatRoute = 'team' | 'agent' | 'note' | 'team_note'

/** One thing you typed into a team's chat. */
export interface ChatMessage {
  id: string
  teamKey: string
  teamPath: string
  text: string
  createdAt: string
  route: ChatRoute
  /** The run it started, or the run it joined as a note. */
  runId: string | null
  /** The agent it was addressed to: a one-agent turn, or a note. */
  agentId: string | null
  /** When the agent's next turn took this note. */
  deliveredAt: string | null
  /** "Send now": it stopped the agent's turn rather than waiting for it. */
  now: boolean
}

/** One item of the chat, newest first from the daemon. */
export type ChatItem =
  /** A piece of work: a run, the message that started it, and the notes you sent into it. */
  | { kind: 'work'; run: RunRecord; request: ChatMessage | null; notes: ChatMessage[] }
  /** A team note: it started nothing, and the next work reads it. */
  | { kind: 'note'; message: ChatMessage }

export interface ChatPage {
  teamKey: string
  teamPath: string
  items: ChatItem[]
  more: boolean
}

/** Who a message is addressed to. `null` is a message with no @. */
export type ChatTarget = { kind: 'team' } | { kind: 'agent'; agent: string } | null

export interface SendOptions {
  teamPath: string
  text: string
  to: ChatTarget
  /** "Send now": a note that stops the agent's turn instead of waiting for it. */
  now?: boolean
  /** The revision the save just returned, for a message that starts work. */
  expectedRevision?: string | null
  /** One key for the life of one send attempt, so a lost answer never starts work twice. */
  startKey?: string
  signal?: AbortSignal
}

/** What the daemon did with a message. */
export interface SendResult {
  route: ChatRoute
  message: ChatMessage
  /** The run it started or joined; absent for a team note. */
  run?: RunRecord | null
}

/** Every item the key identifies, so a refreshed page can replace what an older one showed. */
export const itemKey = (item: ChatItem): string => (item.kind === 'work' ? `run:${item.run.runId}` : `note:${item.message.id}`)

/** When an item happened, for ordering pages and asking for the next one. */
export const itemAt = (item: ChatItem): string => (item.kind === 'work' ? item.run.createdAt : item.message.createdAt)

export async function fetchChatPage(teamPath: string, before?: string | null, limit?: number, signal?: AbortSignal, search?: string): Promise<ChatPage> {
  const query = new URLSearchParams({ teamPath })
  if (before) query.set('before', before)
  if (limit) query.set('limit', String(limit))
  if (search?.trim()) query.set('q', search.trim())
  const response = await daemonFetch(`/api/chat?${query.toString()}`, { signal, cache: 'no-store' })
  return readRun<ChatPage>(response)
}

export async function sendChatMessage({ teamPath, text, to, now, expectedRevision, startKey, signal }: SendOptions): Promise<SendResult> {
  const response = await daemonFetch('/api/chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamPath,
      text,
      to,
      ...(now ? { now } : {}),
      ...(expectedRevision ? { expectedRevision } : {}),
      ...(startKey ? { startKey } : {}),
    }),
    signal,
    cache: 'no-store',
  })
  return readRun<SendResult>(response)
}

/** "Start the team on this" on a team note: the note becomes the request of the work it starts. */
export async function startFromNote(messageId: string, expectedRevision?: string | null): Promise<SendResult> {
  const response = await daemonFetch(`/api/chat/messages/${encodeURIComponent(messageId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expectedRevision ? { expectedRevision } : {}),
    cache: 'no-store',
  })
  return readRun<SendResult>(response)
}

/** "Continue with the team" under a one-agent turn's new version. */
export async function continueWithTeam(runId: string, expectedRevision?: string | null): Promise<{ route: 'team'; run: RunRecord }> {
  const response = await daemonFetch('/api/chat/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, ...(expectedRevision ? { expectedRevision } : {}) }),
    cache: 'no-store',
  })
  return readRun<{ route: 'team'; run: RunRecord }>(response)
}
