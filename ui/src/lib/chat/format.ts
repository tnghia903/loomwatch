/** How the team's chat says times, days and durations: the words a chat app uses. */

const DAY_MS = 24 * 60 * 60 * 1000

const startOfDay = (time: number) => {
  const day = new Date(time)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** "Today", "Yesterday", "Monday" within the week, then "Mon 5 Oct" (with the year when it is not this one). */
export function dayLabel(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const date = new Date(time)
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The day an instant falls on, for grouping a chat by day. */
export const dayKey = (iso: string): string => {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '' : String(startOfDay(time))
}

/** "09:40". */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '' : new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** "12 s", "4 min", "1 h 5 min". */
export function took(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return ''
  const ms = Date.parse(to) - Date.parse(from)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
}

/** "Researcher", "Researcher and Writer", "Researcher, Editor and Writer". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** "# Today's AI digest" asked on 6 October → `todays-ai-digest-2026-10-06.md`. */
export function answerFileName(answer: string, createdAt: string): string {
  const title = answer.match(/^#\s+(.+)$/m)?.[1] ?? 'team answer'
  const slug = title.normalize('NFKD').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'team-answer'
  return `${slug}-${createdAt.slice(0, 10)}.md`
}
