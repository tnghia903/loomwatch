// How a permission request reads to a person (ADR 0040): who wants to do what, in the words of the
// switch that would have allowed it, and when it gives up waiting.
import type { PermissionRequest } from './client'

const WANTS: Record<string, string> = {
  web: 'use the web',
  commands: 'run a command',
  edits: 'change a file',
}

/** "Researcher wants to use the web" — the sentence a card or ticket leads with. */
export function permissionSentence(request: Pick<PermissionRequest, 'name' | 'switch' | 'title'>): string {
  const wants = request.switch ? WANTS[request.switch] : null
  return `${request.name} wants to ${wants ?? `do this: ${request.title}`}`
}

/** "Asks to use the web" — the request as the asking agent's own message in the team's chat. */
export function permissionAsks(switchKey: string | null | undefined): string {
  const wants = switchKey ? WANTS[switchKey] : null
  return wants ? `Asks to ${wants}` : 'Asks your permission for'
}

/** What exactly: the app's own title, plus the query, command or path when it named one. */
export function permissionWhat(request: Pick<PermissionRequest, 'title' | 'detail'>): string {
  return request.detail ? `${request.title} · ${request.detail}` : request.title
}

/** "Declines by itself in 9 min" — or "in under a minute" once it is close. */
export function permissionDeadline(expiresAt: string, now = Date.now()): string {
  const left = Date.parse(expiresAt) - now
  if (!Number.isFinite(left)) return 'Declines by itself if nobody answers.'
  const minutes = Math.floor(left / 60000)
  return minutes >= 1 ? `Declines by itself in ${minutes} min if nobody answers.` : 'Declines by itself in under a minute if nobody answers.'
}
