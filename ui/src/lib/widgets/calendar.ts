import type { WidgetBooking, WidgetSpec } from './types'

type Calendar = Extract<WidgetSpec, { kind: 'calendar' }>

/** The hours of a day shown when the agent gives none: waking hours, as the daemon has them. */
const DAY_FROM = 8 * 60
const DAY_TO = 22 * 60
/** Free time shorter than this is not free time worth saying, as the daemon tells the agent. */
const SHORTEST_FREE = 30
/** How far a time to hold moves or stretches at a time. */
export const STEP = 15

/** `09:30` in minutes from midnight; null for one it can't read. */
export function minutes(written: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(written?.trim() ?? '')
  if (!match) return null
  const at = Number(match[1]) * 60 + Number(match[2])
  return Number(match[2]) < 60 && at <= 24 * 60 ? at : null
}

/** Minutes from midnight as `09:30`. */
export function clock(at: number): string {
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`
}

/** A stretch of time in words: 30m, 3h, 4h 30m. */
export function lasting(length: number): string {
  const hours = Math.floor(length / 60)
  const mins = length % 60
  if (hours === 0) return `${mins}m`
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
}

/** One booking in its run of overlapping bookings: its times, and its lane among them. */
export interface Laned { booking: WidgetBooking; from: number; to: number; lane: number }

/** A piece of a day, in time order: free time, or a run of bookings that overlap (one alone is a
 *  run of one), side by side in lanes. */
export type Piece =
  | { kind: 'free'; from: number; to: number; length: number }
  | { kind: 'booked'; from: number; to: number; items: Laned[]; lanes: number }

export interface Day {
  day: string
  /** Its shown hours: the agent's, or waking hours, widened to take in its bookings. Its free time
   *  is found in them, as the daemon found it for the agent. */
  from: number
  to: number
  allDay: WidgetBooking[]
  pieces: Piece[]
  /** Its free time all told, in minutes; none on a day booked all day. */
  freeLength: number
}

interface Timed { booking: WidgetBooking; start: number; end: number }

/** Each day of the calendar in pieces: its free time, and its bookings in runs where they overlap,
 *  in time order, its free time found in its hours as the daemon found it for the agent. */
export function layOut(spec: Calendar): Day[] {
  return spec.days.map((day) => {
    const mine = spec.bookings.filter((booking) => booking.day === day)
    const allDay = mine.filter((booking) => minutes(booking.start) === null)
    const timed: Timed[] = mine
      .map((booking) => ({ booking, start: minutes(booking.start), end: minutes(booking.end) }))
      .filter((at): at is Timed => at.start !== null && at.end !== null)
      .sort((a, b) => a.start - b.start || a.end - b.end)
    let from = minutes(spec.hours?.from) ?? DAY_FROM
    let to = minutes(spec.hours?.to) ?? DAY_TO
    for (const at of timed) {
      from = Math.min(from, at.start)
      to = Math.max(to, at.end)
    }
    const pieces: Piece[] = []
    if (allDay.length === 0) {
      let at = from
      let run: Extract<Piece, { kind: 'booked' }> | null = null
      const laneEnds: number[] = []
      for (const one of timed) {
        if (!run || one.start >= run.to) {
          if (one.start - at >= SHORTEST_FREE) pieces.push({ kind: 'free', from: at, to: one.start, length: one.start - at })
          run = { kind: 'booked', from: one.start, to: one.end, items: [], lanes: 1 }
          laneEnds.length = 0
          pieces.push(run)
        }
        let lane = laneEnds.findIndex((end) => end <= one.start)
        if (lane < 0) lane = laneEnds.length
        laneEnds[lane] = one.end
        run.items.push({ booking: one.booking, from: one.start, to: one.end, lane })
        run.to = Math.max(run.to, one.end)
        run.lanes = Math.max(run.lanes, lane + 1)
        at = Math.max(at, one.end)
      }
      if (to - at >= SHORTEST_FREE) pieces.push({ kind: 'free', from: at, to, length: to - at })
    }
    const freeLength = pieces.reduce((sum, piece) => sum + (piece.kind === 'free' ? piece.length : 0), 0)
    return { day, from, to, allDay, pieces, freeLength }
  })
}

/** How long a booking overlaps those in lanes before it in its run, in minutes; 0 for none. */
export function overlap(run: Extract<Piece, { kind: 'booked' }>, item: Laned): number {
  return Math.max(0, ...run.items.filter((other) => other.lane < item.lane && other.from < item.to && other.to > item.from)
    .map((other) => Math.min(other.to, item.to) - Math.max(other.from, item.from)))
}

/** What a day comes to, under its date in the week: its free time, or busy for a day booked all
 *  day. */
export function summed(day: Day): string {
  if (day.allDay.length > 0) return 'busy'
  return day.freeLength > 0 ? lasting(day.freeLength) : 'no gaps'
}

/** One day of the week strip: its weekday and date, the day the calendar shows there if any, and
 *  how much of its hours are free, from 0 to 1, for the ring round its date. */
export interface WeekDay {
  day: string
  weekday: string
  date: number
  shown: Day | null
  free: number
}

/** The seven days the week strip shows, as a calendar app's does: the calendar's days and those
 *  round them, its days as near the middle as they allow. Days it doesn't show stay quiet: nothing
 *  is known of them. */
export function week(spec: Calendar, days: Day[], locale?: string): WeekDay[] {
  const dates = spec.days.map(parse).filter((date): date is Date => date !== null)
  if (dates.length === 0) return []
  const first = dates.reduce((a, b) => (a < b ? a : b))
  const last = dates.reduce((a, b) => (a > b ? a : b))
  const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
  const start = new Date(first)
  start.setDate(first.getDate() - Math.max(0, Math.floor((7 - span) / 2)))
  return Array.from({ length: 7 }, (_, at) => {
    const date = new Date(start)
    date.setDate(start.getDate() + at)
    const day = iso(date)
    const shown = days.find((one) => one.day === day) ?? null
    return {
      day,
      weekday: date.toLocaleDateString(locale, { weekday: 'short' }),
      date: date.getDate(),
      shown,
      free: shown && shown.allDay.length === 0 ? shown.freeLength / Math.max(1, shown.to - shown.from) : 0,
    }
  })
}

/** A day as the person reads it at the top of the day: Saturday, 14 Nov. */
export function written(day: string, locale?: string): string {
  const date = parse(day)
  return date ? date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' }) : day
}

/** A time to hold inside a free stretch: `from` to `to` moved to whole steps, at least one step
 *  long, never past the stretch's ends. */
export function held(free: { from: number; to: number }, from: number, to: number): { from: number; to: number } {
  const length = Math.max(STEP, Math.min(free.to - free.from, Math.round((to - from) / STEP) * STEP))
  const start = Math.min(free.to - length, Math.max(free.from, Math.round(from / STEP) * STEP))
  return { from: start, to: start + length }
}

/** The time first offered to hold in a free stretch: its first hour, or all of it when shorter. */
export function offered(free: { from: number; to: number }): { from: number; to: number } {
  return { from: free.from, to: Math.min(free.to, free.from + 60) }
}

/** What a tap sends the agent, as your message: hold the time on your calendar, or help book
 *  something in it. The day is written out in full, with its year, so the agent can't misread it. */
export function asked(what: 'hold' | 'book', day: string, from: number, to: number): string {
  const date = parse(day)
  const when = `${date ? date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : day}, ${clock(from)}–${clock(to)}`
  return what === 'hold' ? `Hold ${when} on my calendar.` : `Help me book something for ${when}.`
}

function parse(day: string): Date | null {
  const [year, month, date] = day.split('-').map(Number)
  return year && month && date ? new Date(year, month - 1, date) : null
}

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
