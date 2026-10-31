import type { RunRecord } from '../runs/client'

/**
 * A team's chat, as the team list shows it (ADR 0051): the newest thing that happened in it, in a
 * line, and when — the way a messaging app lists its conversations.
 */
export interface ChatPreview {
  /** When the newest piece of work last changed: its answer, or its start while it works. */
  at: string
  /** The app's own words ("Working on: "), then the request's or the answer's first line, whole and
   * with its Markdown: the card's line cuts it, so a mark is never split. */
  lead: string
  words: string
  /** The newest piece is still going, or waits on you. */
  live: boolean
}

const firstLine = (text: string) => text.trim().split('\n').find((part) => part.trim())?.replace(/^#+\s*/, '').trim() ?? ''

/** The newest piece of work of the team at `teamPath`, as one line; `null` for a team never asked. */
export function chatPreview(records: readonly RunRecord[], teamPath: string): ChatPreview | null {
  const newest = records
    .filter((record) => record.teamPath === teamPath)
    .sort((left, right) => (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt))[0]
  if (!newest) return null
  const at = newest.finishedAt ?? newest.createdAt
  if (newest.status === 'running' && (newest.waitingOn || newest.spendStops?.length)) return { at, lead: 'Waiting for you', words: '', live: true }
  if (newest.status === 'queued' || newest.status === 'starting' || newest.status === 'running') {
    return { at, lead: 'Working on: ', words: firstLine(newest.prompt), live: true }
  }
  if (newest.status === 'failed' && newest.nextTryAt) return { at, lead: 'Trying again soon: ', words: firstLine(newest.prompt), live: false }
  if (newest.status === 'failed') return { at, lead: 'Stopped: ', words: firstLine(newest.prompt), live: false }
  if (newest.status === 'cancelled') return { at, lead: 'You stopped: ', words: firstLine(newest.prompt), live: false }
  return { at, lead: '', words: firstLine(newest.reply ?? '') || firstLine(newest.prompt), live: false }
}

/** "09:40" today, "Yesterday", "Mon" this week, then "5 Oct". */
export function listTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  const today = new Date(now)
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOf(today) - startOf(date)) / 86_400_000)
  if (days === 0) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
