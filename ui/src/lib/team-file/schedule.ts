// The friendly schedule editor owns four fields — frequency, time, timezone
// and prompt — but a `schedule:` block read from disk can carry anything: a key the schema does
// not know, a non-boolean `enabled`, an empty `deliver.notion.title`. Writing the editor's state
// back with a plain `{ ...schedule }` spread carried those straight back into the document, so
// "Save schedule" left the very problem it promised to fix in place and the team stayed unrunnable.
// Everything the editor writes goes through `normalizeSchedule` instead: it emits exactly the
// keys `schemas/team.schema.yaml` allows, so a save either clears the schedule problems or leaves
// one the editor genuinely cannot express (a cron only the daemon can judge).

import type { ScheduleConfig } from './types'

export type ScheduleFrequency = 'daily' | 'weekdays' | 'manual'

/** Every property `$defs/Schedule` accepts; anything else is an `additionalProperties` failure. */
const SCHEDULE_KEYS = ['cron', 'timezone', 'prompt', 'enabled', 'deliver', 'retryAfterMinutes', 'waitForYouMinutes'] as const
/** `$defs/Schedule.retryAfterMinutes`: at most this many waits, each from 1 minute to a day. */
const MAX_RETRIES = 20
const MAX_RETRY_MINUTES = 24 * 60
/** `$defs/Schedule.waitForYouMinutes`: from 1 minute to a week. */
const MAX_WAIT_FOR_YOU_MINUTES = 7 * 24 * 60

export interface ScheduleDraft {
  cron: string
  timezone?: string
  prompt: string
}

/** `enabled`, `deliver`, `retryAfterMinutes` and `waitForYouMinutes` are not editable on the
 * canvas, so they are carried forward — but only in the shapes the schema accepts. A `deliver`
 * block or a wait that is anything else is dropped rather than preserved, since keeping it would
 * mean the operator can never save from this editor. */
export function normalizeSchedule(draft: ScheduleDraft, previous?: Partial<ScheduleConfig> | null): ScheduleConfig {
  // Key order follows `$defs/Schedule` so a rewritten block still reads like a hand-written one.
  const cron = draft.cron.trim()
  const prompt = draft.prompt.trim()
  const timezone = draft.timezone?.trim()
  const next: ScheduleConfig = timezone ? { cron, timezone, prompt } : { cron, prompt }
  if (previous?.enabled !== undefined) next.enabled = previous.enabled !== false
  const title = previous?.deliver?.notion?.title
  if (previous?.deliver && typeof previous.deliver === 'object' && 'notion' in previous.deliver) {
    next.deliver = typeof title === 'string' && title.trim() ? { notion: { title: title.trim() } } : { notion: {} }
  }
  const waits: unknown = previous?.retryAfterMinutes
  if (Array.isArray(waits) && waits.length <= MAX_RETRIES && waits.every((wait) => Number.isInteger(wait) && wait >= 1 && wait <= MAX_RETRY_MINUTES)) {
    next.retryAfterMinutes = [...(waits as number[])]
  }
  const waitForYou: unknown = previous?.waitForYouMinutes
  if (Number.isInteger(waitForYou) && (waitForYou as number) >= 1 && (waitForYou as number) <= MAX_WAIT_FOR_YOU_MINUTES) {
    next.waitForYouMinutes = waitForYou as number
  }
  return next
}

/** What the Schedule button opens: weekdays at 08:00 in this computer's zone. The task is left
 * blank on purpose, since "Save schedule" stays off until the operator says what to do. */
export function newSchedule(): ScheduleConfig {
  return { cron: '0 8 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', prompt: '' }
}

/** Keys the editor will silently drop on the next save, so it can say so before it happens. */
export function unsupportedScheduleKeys(schedule: Partial<ScheduleConfig> | null | undefined): string[] {
  if (!schedule || typeof schedule !== 'object') return []
  return Object.keys(schedule).filter((key) => !(SCHEDULE_KEYS as readonly string[]).includes(key))
}

/** Reads a 5-field cron back into the editor's three frequencies; anything richer stays `manual`. */
export function scheduleParts(cron: string | undefined): { frequency: ScheduleFrequency; time: string } {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = (cron ?? '').trim().split(/\s+/)
  const simple = rest.length === 0 && /^\d{1,2}$/.test(minute ?? '') && /^\d{1,2}$/.test(hour ?? '') && dayOfMonth === '*' && month === '*'
  const time = simple ? `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}` : '08:00'
  if (!simple) return { frequency: 'manual', time }
  if (dayOfWeek === '*') return { frequency: 'daily', time }
  if (['1-5', 'mon-fri', 'MON-FRI'].includes(dayOfWeek ?? '')) return { frequency: 'weekdays', time }
  return { frequency: 'manual', time }
}

export function cronFor(frequency: ScheduleFrequency, time: string, manual: string): string {
  if (frequency === 'manual') return manual.trim()
  const [hour = '8', minute = '0'] = time.split(':')
  return `${Number(minute)} ${Number(hour)} * * ${frequency === 'weekdays' ? '1-5' : '*'}`
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** The days a cron's day-of-week field names, Monday first; null for anything but days, lists and ranges. */
function cronDays(field: string): number[] | null {
  if (field === '*') return [1, 2, 3, 4, 5, 6, 0]
  const day = (token: string) => (/^[0-7]$/.test(token) ? Number(token) : DAY_NAMES.indexOf(token))
  const days = new Set<number>()
  for (const part of field.toLowerCase().split(',')) {
    const [from, to = from, ...extra] = part.split('-').map(day)
    if (extra.length > 0 || from < 0 || to < from) return null
    for (let next = from; next <= to; next += 1) days.add(next % 7)
  }
  return [1, 2, 3, 4, 5, 6, 0].filter((next) => days.has(next))
}

function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
  return `${n}${suffix}`
}

function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? ''
}

/**
 * A cron in plain words: at a time or a few on days of the week, on a date each month, or every so
 * many minutes or hours; null for anything richer. `every` says "Every Monday at 9:00 AM" for a sentence, where
 * the canvas card says "Mondays at 9:00 AM".
 */
export function cronInWords(cron: string | undefined, every = false): string | null {
  const [minute = '', hour = '', dayOfMonth, month, dayOfWeek = '', ...rest] = (cron ?? '').trim().split(/\s+/)
  if (rest.length > 0 || month !== '*') return null
  const step = (field: string) => (field === '*' ? 1 : Number(/^\*\/(\d+)$/.exec(field)?.[1] ?? 0))
  if (dayOfMonth === '*' && dayOfWeek === '*') {
    if (hour === '*' && minute === '0') return 'Every hour'
    if (hour === '*' && step(minute) > 0) return step(minute) === 1 ? 'Every minute' : `Every ${step(minute)} minutes`
    if (minute === '0' && hour !== '*' && step(hour) > 0) return step(hour) === 1 ? 'Every hour' : `Every ${step(hour)} hours`
  }
  // One time a day, or a few: "at 9:00 AM and 5:00 PM".
  const hours = hour.split(',')
  if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59 || hours.some((one) => !/^\d{1,2}$/.test(one) || Number(one) > 23)) return null
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const at = listed(hours.map(Number).sort((left, right) => left - right).map((one) => clock.format(new Date(2026, 0, 1, one, Number(minute)))))
  if (dayOfMonth !== '*') {
    if (dayOfWeek !== '*' || !/^\d{1,2}$/.test(dayOfMonth ?? '') || Number(dayOfMonth) < 1 || Number(dayOfMonth) > 31) return null
    return `${every ? 'Every month' : 'Monthly'} on the ${ordinal(Number(dayOfMonth))} at ${at}`
  }
  const days = cronDays(dayOfWeek)
  if (!days || days.length === 0) return null
  if (days.length === 7) return `${every ? 'Every day' : 'Daily'} at ${at}`
  if (days.join() === '1,2,3,4,5') return `${every ? 'Every weekday' : 'Weekdays'} at ${at}`
  return `${every ? 'Every ' : ''}${listed(days.map((day) => (every ? DAYS[day] : `${DAYS[day]}s`)))} at ${at}`
}

export function summarizeSchedule(schedule: Partial<ScheduleConfig>): string {
  return cronInWords(schedule.cron) ?? (schedule.cron?.trim() || 'Choose a time')
}

/** `.schedule-node` in app.css. React Flow renders a node `visibility: hidden` until it has a size —
 * measured, declared, or initial (`nodeHasDimensions`) — and a synthetic node's measurement is lost
 * whenever the controlled `nodes` prop is rebuilt, which the canvas does on every render. Declaring
 * the card's own CSS size means the schedule can never vanish while React Flow waits to measure it;
 * the real measurement still refines it. Lives here rather than beside the component so the module
 * exporting it stays Fast Refresh friendly. */
export const SCHEDULE_CARD = { width: 276, height: 96 }
