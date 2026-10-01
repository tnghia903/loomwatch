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
const SCHEDULE_KEYS = ['cron', 'timezone', 'prompt', 'enabled', 'deliver'] as const

export interface ScheduleDraft {
  cron: string
  timezone?: string
  prompt: string
}

/** `enabled` and `deliver` are not editable on the canvas, so they are carried forward — but only
 * in the shapes the schema accepts. A `deliver` block that is anything else is dropped rather
 * than preserved, since keeping it would mean the operator can never save from this editor. */
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
  return next
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

export function summarizeSchedule(schedule: Partial<ScheduleConfig>): string {
  const parts = scheduleParts(schedule.cron)
  if (parts.frequency === 'manual') return schedule.cron?.trim() || 'Choose a time'
  const [hour, minute] = parts.time.split(':').map(Number)
  const display = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2026, 0, 1, hour, minute))
  return `${parts.frequency === 'weekdays' ? 'Weekdays' : 'Daily'} at ${display}`
}

/** `.schedule-node` in app.css. React Flow renders a node `visibility: hidden` until it has a size —
 * measured, declared, or initial (`nodeHasDimensions`) — and a synthetic node's measurement is lost
 * whenever the controlled `nodes` prop is rebuilt, which the canvas does on every render. Declaring
 * the card's own CSS size means the schedule can never vanish while React Flow waits to measure it;
 * the real measurement still refines it. Lives here rather than beside the component so the module
 * exporting it stays Fast Refresh friendly. */
export const SCHEDULE_CARD = { width: 276, height: 96 }
