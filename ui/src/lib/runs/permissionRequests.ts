// How a permission request reads to a person (ADR 0040): who wants to do what, in the words of the
// switch that would have allowed it, and when it gives up waiting.
import type { PermissionDecision, PermissionRequest } from './client'

const WANTS: Record<string, string> = {
  web: 'use the web',
  commands: 'run a command',
  edits: 'change a file',
}

/** What an answer did, in the words the tray and the island at the notch say once it is sent. */
export const PERMISSION_SAID: Record<PermissionDecision, string> = { edit: 'Allowed as you changed it.', answer: 'Your answer was sent.', allow_once: 'Allowed once.', allow_run: 'Allowed for the rest of the run.', allow_team: 'Allowed for the whole team, for the rest of the run.', deny: 'Denied. The agent carries on without it.' }

/**
 * Whether a request can be answered with one tap, away from its full card: the island at the notch
 * offers Allow and Deny only for these (ADR 0083). A command can't be judged from one line, and
 * the ones Auto mode still asks about are the risky ones, so they, and a request that offers an
 * edit, open their run instead.
 */
export function answerableAtAGlance(request: Pick<PermissionRequest, 'switch' | 'kind' | 'auto' | 'edit'>): boolean {
  return request.switch !== 'commands' && request.kind !== 'execute' && !request.auto && !request.edit
}

/** "Researcher wants to use the web" — the sentence a card or ticket leads with. */
export function permissionSentence(request: Pick<PermissionRequest, 'name' | 'switch' | 'title' | 'tool'>): string {
  // A connected tool's call (ADR 0069): which tool, then the call and what it sends, below.
  if (request.tool) return `${request.name} wants to use ${request.tool.server}`
  const wants = request.switch ? WANTS[request.switch] : null
  return `${request.name} wants to ${wants ?? `do this: ${request.title}`}`
}

/** "Asks to use the web" — the request as the asking agent's own message in the team's chat. */
export function permissionAsks(switchKey: string | null | undefined, tool?: string | null): string {
  if (tool) return `Asks to use ${tool}`
  const wants = switchKey ? WANTS[switchKey] : null
  return wants ? `Asks to ${wants}` : 'Asks your permission for'
}

/**
 * Why Auto mode left a command to you (ADR 0061), as the daemon put it — "Auto mode never runs
 * this without you: it deletes files" — ending in a full stop, for the line under the command.
 */
export function autoNote(note: string): string {
  const text = note.trim()
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`
}

/** What exactly: the app's own title, plus the query, command or path when it named one. */
export function permissionWhat(request: Pick<PermissionRequest, 'title' | 'detail'>): string {
  return request.detail ? `${request.title} · ${request.detail}` : request.title
}

/**
 * How long until `expiresAt`, as a sentence says it: "in 11 hours" once it is two hours or more
 * away (a scheduled run waits twelve, ADR 0090), "in 95 min" below that, "in under a minute" once
 * it is close. `null` when it isn't a time.
 */
export function timeLeft(expiresAt: string, now = Date.now()): string | null {
  const left = Date.parse(expiresAt) - now
  if (!Number.isFinite(left)) return null
  const minutes = Math.floor(left / 60000)
  if (minutes >= 120) return `in ${Math.floor(minutes / 60)} hours`
  return minutes >= 1 ? `in ${minutes} min` : 'in under a minute'
}

/** "Declines by itself in 9 min" — or "in under a minute" once it is close. */
export function permissionDeadline(expiresAt: string, now = Date.now()): string {
  const left = timeLeft(expiresAt, now)
  return left ? `Declines by itself ${left} if nobody answers.` : 'Declines by itself if nobody answers.'
}
