import { display } from './formula'
import type { WidgetEvent, WidgetSpec } from './types'

type Timeline = Extract<WidgetSpec, { kind: 'timeline' }>

/** A date read: its year (below zero before year 1), and its month and day when it has them. */
export interface When { year: number; month?: number; day?: number }

/** A date as the daemon keeps it (`1997`, `1997-06`, `1997-06-26`, `-500`), read; null for
    anything else. */
export function readDate(date: string): When | null {
  const read = /^(-?)(\d{1,5})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(date.trim())
  if (!read) return null
  const year = Number(read[2]) * (read[1] ? -1 : 1)
  if (year === 0) return null
  const month = read[3] === undefined ? undefined : Number(read[3])
  const day = read[4] === undefined ? undefined : Number(read[4])
  if (month !== undefined && (month < 1 || month > 12)) return null
  if (day !== undefined && (day < 1 || day > 31)) return null
  return { year, ...(month !== undefined ? { month } : {}), ...(day !== undefined ? { day } : {}) }
}

/**
 * A date as you read it on a timeline: a year as it is ("1997", "500 BC"), and a month or a day the
 * way your computer writes dates elsewhere in the app ("Jun 1997", "26 Jun 1997" or "Jun 26,
 * 1997"). `locale` is for tests; the app passes none.
 */
export function dateWritten(when: When, locale?: string): string {
  if (when.year < 0) return `${-when.year} BC`
  if (when.month === undefined) return String(when.year)
  // Set the year apart: a year under 100 given to Date.UTC would be read as 19xx.
  const at = new Date(Date.UTC(2000, when.month - 1, when.day ?? 1))
  at.setUTCFullYear(when.year)
  return at.toLocaleDateString(locale, { timeZone: 'UTC', day: when.day === undefined ? undefined : 'numeric', month: 'short', year: 'numeric' })
}

/** The year on a count with a year 0: 1 BC is 0, 2 BC is -1. */
function astronomical(year: number): number {
  return year < 0 ? year + 1 : year
}

/** Days from 1 January 1970 to the start of `when` (its first month, its first day), in the
    calendar of today carried back. */
export function dayNumber(when: When): number {
  const year = astronomical(when.year)
  const month = when.month ?? 1
  const day = when.day ?? 1
  // Days from civil, after Howard Hinnant's algorithm.
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** "1 year", "2,524 years": a count grouped as LoomWatch writes every figure. */
function plural(count: number, one: string): string {
  return `${display(count, 0) ?? count} ${one}${count === 1 ? '' : 's'}`
}

/** The two largest of years, months and days that aren't zero; "over" when a smaller one is cut. */
function twoUnits(parts: [number, string][]): string {
  const shown = parts.filter(([count]) => count > 0)
  if (shown.length === 0) return ''
  const words = shown.slice(0, 2).map(([count, one]) => plural(count, one)).join(' ')
  return shown.length > 2 ? `over ${words}` : words
}

/**
 * How long from `a` to `b`, at the coarser of their two dates: "3 years" between two years, "1 year
 * 2 months" between two months, "12 days" or "over 2 months 5 days" between two days. Empty when
 * there is no time between them, or `b` isn't after `a`.
 */
export function gapWritten(a: When, b: When): string {
  const ya = astronomical(a.year)
  const yb = astronomical(b.year)
  if (a.month === undefined || b.month === undefined) {
    return yb > ya ? plural(yb - ya, 'year') : ''
  }
  const months = (yb * 12 + b.month) - (ya * 12 + a.month)
  if (a.day === undefined || b.day === undefined) {
    return months > 0 ? twoUnits([[Math.floor(months / 12), 'year'], [months % 12, 'month']]) : ''
  }
  const days = dayNumber(b) - dayNumber(a)
  if (days <= 0) return ''
  if (days < 60) return plural(days, 'day')
  // Whole months from `a` to `b`, then the days left after the date as many months on from `a`.
  const whole = months - (b.day < a.day ? 1 : 0)
  const total = ya * 12 + (a.month - 1) + whole
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  const on = { year: year <= 0 ? year - 1 : year, month, day: Math.min(a.day, daysIn(year, month)) }
  return twoUnits([[Math.floor(whole / 12), 'year'], [whole % 12, 'month'], [dayNumber(b) - dayNumber(on), 'day']])
}

/** Days in `month` of an astronomical `year` (with a year 0). */
function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** One row of a timeline as laid out: an event (`today` when it falls on today), or today among
    them. */
export type TimelineRow =
  | { kind: 'event'; event: WidgetEvent; when: When; written: string; today?: boolean }
  | { kind: 'today'; when: When; written: string }

/** The room between two rows: its height beyond the least, and how long it is in words when
    that is worth saying. */
export interface TimelineGap { space: number; words: string | null }

/** The most room between two rows beyond the least, in pixels: the longest gap gets it all. */
export const MOST_SPACE = 40

/**
 * A timeline laid out (ADR 0114, amended 8 November): its events in order with today among them
 * when one of them is still to come (an event on today's date says "Today" instead, so it doesn't
 * read as done), and between each two the room their time apart earns, the
 * longest gap the most. Each gap says how long it is when there are three rows or fewer, when it
 * is half as long again as the middle gap, or when it runs from today to what comes next: the gaps
 * worth noticing, not one under every row.
 */
export function layOut(spec: Timeline, today: Date, locale?: string): { rows: TimelineRow[]; gaps: TimelineGap[] } {
  const now: When = { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() }
  const rows: TimelineRow[] = []
  let onToday = false
  for (const event of spec.events) {
    const when = readDate(event.date)
    if (!when) continue
    const isToday = when.day !== undefined && dayNumber(when) === dayNumber(now)
    onToday ||= isToday
    rows.push(isToday ? { kind: 'event', event, when, written: 'Today', today: true } : { kind: 'event', event, when, written: dateWritten(when, locale) })
  }
  const ahead = rows.findIndex((row) => dayNumber(row.when) > dayNumber(now))
  if (ahead >= 0 && !onToday) rows.splice(ahead, 0, { kind: 'today', when: now, written: 'Today' })
  const lengths = rows.slice(1).map((row, at) => Math.max(0, dayNumber(row.when) - dayNumber(rows[at].when)))
  const longest = Math.max(0, ...lengths)
  const nonzero = lengths.filter((length) => length > 0).sort((a, b) => a - b)
  const middle = nonzero.length ? nonzero[Math.floor((nonzero.length - 1) / 2)] : 0
  const gaps = lengths.map((length, at) => {
    const space = longest > 0 ? Math.round((length / longest) * MOST_SPACE) : 0
    // The time from today to what comes next is always worth saying: it is how long you have.
    const worth = length > 0 && (rows.length <= 3 || length > middle * 1.5 || rows[at].kind === 'today' || (rows[at].kind === 'event' && rows[at].today === true))
    const words = worth ? gapWritten(rows[at].when, rows[at + 1].when) : ''
    return { space, words: words || null }
  })
  return { rows, gaps }
}
