import { describe, expect, it } from 'vitest'

import { dateWritten, dayNumber, gapWritten, layOut, readDate } from './timeline'

describe('a timeline’s dates', () => {
  it('reads the dates the daemon keeps, and writes each one way', () => {
    expect(readDate('1997')).toEqual({ year: 1997 })
    expect(readDate('1997-06')).toEqual({ year: 1997, month: 6 })
    expect(readDate('1997-06-26')).toEqual({ year: 1997, month: 6, day: 26 })
    expect(readDate('-500')).toEqual({ year: -500 })
    expect(readDate('June 1997')).toBeNull()
    expect(readDate('0')).toBeNull()
    expect(readDate('1997-13')).toBeNull()
    expect(dateWritten({ year: 1997 })).toBe('1997')
    expect(dateWritten({ year: 1997, month: 6 }, 'en-GB')).toBe('Jun 1997')
    expect(dateWritten({ year: 1997, month: 6, day: 26 }, 'en-GB')).toBe('26 Jun 1997')
    // As the computer writes dates elsewhere in the app.
    expect(dateWritten({ year: 1997, month: 6, day: 26 }, 'en-US')).toBe('Jun 26, 1997')
    expect(dateWritten({ year: 44, month: 3, day: 15 }, 'en-GB')).toBe('15 Mar 44')
    expect(dateWritten({ year: -500 })).toBe('500 BC')
  })

  it('counts days as the calendar does, years before year 1 too', () => {
    expect(dayNumber({ year: 1970, month: 1, day: 1 })).toBe(0)
    expect(dayNumber({ year: 2000, month: 3, day: 1 }) - dayNumber({ year: 2000, month: 2, day: 28 })).toBe(2)
    expect(dayNumber({ year: 1900, month: 3, day: 1 }) - dayNumber({ year: 1900, month: 2, day: 28 })).toBe(1)
    // 1 BC to AD 1 is one year: there is no year 0.
    expect(dayNumber({ year: 1 }) - dayNumber({ year: -1 })).toBe(366)
  })

  it('says how long a gap is at the coarser of its two dates, and exactly', () => {
    expect(gapWritten({ year: 1997 }, { year: 2000 })).toBe('3 years')
    expect(gapWritten({ year: -500 }, { year: 1997 })).toBe('2,496 years')
    expect(gapWritten({ year: 1997, month: 6, day: 26 }, { year: 1998 })).toBe('1 year')
    expect(gapWritten({ year: 2025, month: 11 }, { year: 2027, month: 1 })).toBe('1 year 2 months')
    expect(gapWritten({ year: 2026, month: 1 }, { year: 2026, month: 4 })).toBe('3 months')
    expect(gapWritten({ year: 2026, month: 10, day: 1 }, { year: 2026, month: 11, day: 8 })).toBe('38 days')
    expect(gapWritten({ year: 2026, month: 1, day: 10 }, { year: 2026, month: 3, day: 25 })).toBe('2 months 15 days')
    expect(gapWritten({ year: 2024, month: 1, day: 31 }, { year: 2025, month: 3, day: 5 })).toBe('over 1 year 1 month')
    expect(gapWritten({ year: 1997 }, { year: 1997 })).toBe('')
  })
})

describe('a timeline laid out', () => {
  const spec = (dates: string[]) => ({ kind: 'timeline' as const, title: 'x', events: dates.map((date, at) => ({ date, label: `Event ${at + 1}` })) })

  it('gives the longest gap the most room, and words only to the gaps worth noticing', () => {
    const { rows, gaps } = layOut(spec(['1990', '1991', '1992', '1993', '2003']), new Date('2026-11-08T12:00:00'))
    expect(rows).toHaveLength(5)
    expect(gaps.map((gap) => gap.space)).toEqual([4, 4, 4, 40])
    expect(gaps.map((gap) => gap.words)).toEqual([null, null, null, '10 years'])
  })

  it('puts today before the first event still to come, and not among a history', () => {
    const plan = layOut(spec(['2026-10-01', '2026-12-01', '2027-01-15']), new Date('2026-11-08T12:00:00'), 'en-GB')
    expect(plan.rows.map((row) => row.written)).toEqual(['1 Oct 2026', 'Today', '1 Dec 2026', '15 Jan 2027'])
    // From today to what comes next is said even where the other gaps aren't.
    const busy = layOut(spec(['2026-10-20', '2026-11-20', '2026-11-27', '2026-12-05']), new Date('2026-11-08T12:00:00'), 'en-GB')
    expect(busy.gaps.map((gap) => gap.words)).toEqual(['19 days', '12 days', null, null])
    const history = layOut(spec(['1997', '2007']), new Date('2026-11-08T12:00:00'))
    expect(history.rows.map((row) => row.kind)).toEqual(['event', 'event'])
    // An event on today's date says "Today" itself, with the time to the next said.
    const due = layOut(spec(['2026-10-01', '2026-11-08', '2026-12-01']), new Date('2026-11-08T12:00:00'), 'en-GB')
    expect(due.rows.map((row) => row.written)).toEqual(['1 Oct 2026', 'Today', '1 Dec 2026'])
    expect(due.gaps.map((gap) => gap.words)).toEqual(['38 days', '23 days'])
  })
})
