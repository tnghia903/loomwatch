import { describe, expect, it } from 'vitest'

import { asked, clock, held, lasting, layOut, minutes, offered, overlap, summed, week } from './calendar'
import type { WidgetSpec } from './types'

type Calendar = Extract<WidgetSpec, { kind: 'calendar' }>

const weekend: Calendar = {
  kind: 'calendar',
  title: 'Your long weekend',
  days: ['2026-11-14', '2026-11-15', '2026-11-16'],
  hours: { from: '07:00', to: '24:00' },
  bookings: [
    { day: '2026-11-14', start: '10:00', end: '15:00', label: 'Study', place: 'Home' },
    { day: '2026-11-14', start: '19:00', end: '21:30', label: 'Dinner with Linh' },
    { day: '2026-11-15', label: 'Family day' },
    { day: '2026-11-16', start: '09:00', end: '11:00', label: 'Standup' },
    { day: '2026-11-16', start: '10:00', end: '12:00', label: 'Design review' },
    { day: '2026-11-16', start: '14:00', end: '15:00', label: 'Dentist' },
  ],
}

const pieces = (day: ReturnType<typeof layOut>[number]) => day.pieces.map((piece) => `${piece.kind} ${clock(piece.from)}–${clock(piece.to)}`)

describe('a calendar', () => {
  it('reads and writes times as the daemon keeps them, and says how long a stretch lasts', () => {
    expect([minutes('9:30'), minutes('24:00'), minutes('24:30'), minutes(undefined)]).toEqual([570, 1440, null, null])
    expect(clock(570)).toBe('09:30')
    expect([lasting(30), lasting(180), lasting(270)]).toEqual(['30m', '3h', '4h 30m'])
  })

  it('cuts each day into its free time and its bookings, in time order, the free time as the agent was told', () => {
    const [saturday, sunday, monday] = layOut(weekend)
    expect(pieces(saturday)).toEqual(['free 07:00–10:00', 'booked 10:00–15:00', 'free 15:00–19:00', 'booked 19:00–21:30', 'free 21:30–24:00'])
    expect(saturday.freeLength).toBe(9 * 60 + 30)
    expect(summed(saturday)).toBe('9h 30m')
    // Booked all day: no pieces, no free time.
    expect(sunday.pieces).toEqual([])
    expect(summed(sunday)).toBe('busy')
    // Overlapping bookings are one run, side by side, the later flagged by how long they overlap.
    expect(pieces(monday)).toEqual(['free 07:00–09:00', 'booked 09:00–12:00', 'free 12:00–14:00', 'booked 14:00–15:00', 'free 15:00–24:00'])
    const run = monday.pieces[1]
    if (run.kind !== 'booked') throw new Error('a run')
    expect(run.lanes).toBe(2)
    expect(run.items.map((item) => [item.booking.label, item.lane, overlap(run, item)])).toEqual([['Standup', 0, 0], ['Design review', 1, 60]])
  })

  it('shows the week round the calendar’s days, each ringed by how much of it is free', () => {
    const days = layOut(weekend)
    const strip = week(weekend, days, 'en-GB')
    expect(strip.map((one) => one.date)).toEqual([12, 13, 14, 15, 16, 17, 18])
    expect(strip.map((one) => one.shown !== null)).toEqual([false, false, true, true, true, false, false])
    expect(strip[2].weekday).toBe('Sat')
    expect(strip[2].free).toBeCloseTo((9.5 * 60) / (17 * 60))
    expect(strip[3].free).toBe(0)
  })

  it('offers the first hour of free time to hold, and keeps what you move or stretch inside it, in quarter hours', () => {
    const free = { from: 15 * 60, to: 19 * 60 }
    expect(offered(free)).toEqual({ from: 900, to: 960 })
    expect(offered({ from: 21 * 60 + 30, to: 22 * 60 })).toEqual({ from: 1290, to: 1320 })
    expect(held(free, 16 * 60 + 7, 17 * 60 + 37), 'to the quarter hour').toEqual({ from: 960, to: 1050 })
    expect(held(free, 18 * 60 + 30, 19 * 60 + 30), 'pushed past its end, it stops there').toEqual({ from: 1080, to: 1140 })
    expect(held(free, 14 * 60, 14 * 60 + 5), 'never shorter than a quarter hour, nor before its start').toEqual({ from: 900, to: 915 })
    expect(held(free, 15 * 60, 23 * 60), 'never longer than the free time').toEqual({ from: 900, to: 1140 })
  })

  it('asks the agent in words it can’t misread', () => {
    expect(asked('hold', '2026-11-14', 960, 1050)).toBe('Hold Saturday, 14 November 2026, 16:00–17:30 on my calendar.')
    expect(asked('book', '2026-11-14', 960, 1050)).toBe('Help me book something for Saturday, 14 November 2026, 16:00–17:30.')
  })
})
