/**
 * The last moment you looked at each team's chat, in this browser (ADR 0051): what an unread mark
 * on the team list is measured against. A convenience for whoever is looking, so it lives in local
 * storage, and a storage that throws (a private window) simply shows no marks.
 */

const KEY = 'lw-chat-seen'

function read(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** When you last saw `teamPath`'s chat, or `null` if never in this browser. */
export function lastSeen(teamPath: string): string | null {
  return read()[teamPath] ?? null
}

/** You have seen `teamPath`'s chat up to `at`. Never moves backwards. */
export function markSeen(teamPath: string, at: string): void {
  try {
    const seen = read()
    if (seen[teamPath] && seen[teamPath] >= at) return
    seen[teamPath] = at
    window.localStorage.setItem(KEY, JSON.stringify(seen))
    window.dispatchEvent(new Event('loomwatch:chat-seen'))
  } catch {
    // Not kept: the mark comes back on the next visit, which is the honest failure.
  }
}

/** Whether something in a chat is newer than when you last looked. */
export function isUnread(teamPath: string, latest: string | null | undefined): boolean {
  if (!latest) return false
  const seen = lastSeen(teamPath)
  return seen === null ? false : latest > seen
}
