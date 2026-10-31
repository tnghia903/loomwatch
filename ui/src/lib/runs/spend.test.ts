import { describe, expect, it } from 'vitest'

import type { SpendStop } from './client'
import { dollarField, dollars, openStops, spendNote, spoolLabel, spoolMatters, spoolOf, spoolWords, stopActions, stopSentence, typedDollars } from './spend'

const stop = (extra: Partial<SpendStop> = {}): SpendStop => ({ id: 's1', limitUsd: 1, spentUsd: 1.03, addUsd: 0.5, since: '2026-10-17T09:00:00Z', ...extra })
const names: Record<string, string> = { r: 'Researcher', w: 'Writer' }
const name = (id: string) => names[id] ?? id

describe('spend as the operator reads it (ADR 0068)', () => {
  it('writes dollars as they are: cents from a dollar up, three figures below', () => {
    expect(dollars(1)).toBe('$1.00')
    expect(dollars(12.345)).toBe('$12.35')
    expect(dollars(0.5)).toBe('$0.50')
    expect(dollars(0.12)).toBe('$0.12')
    expect(dollars(0.012)).toBe('$0.012')
    expect(dollars(0.123456)).toBe('$0.123')
    expect(dollars(0.003)).toBe('$0.003')
    expect(dollars(0.000479)).toBe('$0.000479')
    expect(dollars(0)).toBe('$0.00')
  })

  it('shows a limit in a field as it is, and never rounds a typed one down to nothing', () => {
    expect(dollarField(1)).toBe('1.00')
    expect(dollarField(0.3)).toBe('0.30')
    expect(dollarField(0.003)).toBe('0.003')
    expect(dollarField(0.255)).toBe('0.255')
    expect(typedDollars('2.499')).toBe(2.5)
    expect(typedDollars('0.004')).toBe(0.004)
    expect(typedDollars('0.3')).toBe(0.3)
    for (const nothing of ['', ' ', '0', '-1', 'abc']) expect(typedDollars(nothing)).toBeNull()
  })

  it('says whose limit a stop is, and its two answers', () => {
    expect(stopSentence(stop())).toBe('The team used its $1.00 for this run.')
    expect(stopActions(stop())).toEqual({ add: 'Add $0.50 and carry on', finish: 'Finish with what it has' })
    const guard = stop({ agent: 'r', name: 'Researcher', limitUsd: 0.3, addUsd: 0.15 })
    expect(stopSentence(guard)).toBe('Researcher used its $0.30 for this run.')
    expect(stopActions(guard)).toEqual({ add: 'Add $0.15 and carry on', finish: 'Stop Researcher here' })
  })

  it('draws each agent’s thread as its share, biggest first, and says the figure', () => {
    const view = spoolOf({ limitUsd: 1, spentUsd: 0.12, agents: { w: { spentUsd: 0.04 }, r: { spentUsd: 0.08 }, idle: { spentUsd: 0 } } })
    expect(view).toEqual({ limit: 1, spent: 0.12, used: 0.12, threads: [{ agent: 'r', usd: 0.08 }, { agent: 'w', usd: 0.04 }] })
    expect(spoolWords(view!)).toBe('$0.12 of $1.00')
    expect(spoolLabel(view!, name)).toBe('Spent $0.12 of $1.00: Researcher $0.08, Writer $0.04')
  })

  it('shows what a run with no limit spent, and nothing for a run with no record of spend', () => {
    expect(spoolWords(spoolOf({ spentUsd: 0.2, agents: { r: { spentUsd: 0.2 } } })!)).toBe('$0.20')
    expect(spoolOf({ spentUsd: 0 })).toBeNull()
    expect(spoolOf(null)).toBeNull()
    expect(spoolOf({ limitUsd: 1, spentUsd: 0 })?.used).toBe(0)
  })

  it('shows money on a run’s line only near or at a limit', () => {
    expect(spoolMatters({ limitUsd: 1, spentUsd: 0.5 })).toBe(false)
    expect(spoolMatters({ limitUsd: 1, spentUsd: 0.75 })).toBe(true)
    expect(spoolMatters({ spentUsd: 3 })).toBe(false)
    expect(spoolMatters({ limitUsd: 1, spentUsd: 0.1 }, [stop()])).toBe(true)
    expect(spoolMatters({ limitUsd: 1.5, spentUsd: 0.1, added: [{ atUsd: 1, addUsd: 0.5 }] })).toBe(true)
    expect(spoolMatters({ limitUsd: 1, spentUsd: 0.1, stopped: 'nobody_to_ask' })).toBe(true)
    expect(spoolMatters({ limitUsd: 1, spentUsd: 0.1, agents: { r: { spentUsd: 0.1, limitUsd: 0.05, stopped: true } } })).toBe(true)
    expect(spoolMatters(null)).toBe(false)
  })

  it('only counts the stops of a run that is still going', () => {
    expect(openStops({ status: 'running', spendStops: [stop()] })).toHaveLength(1)
    expect(openStops({ status: 'succeeded', spendStops: [stop()] })).toHaveLength(0)
  })

  it('tells the receipt what was added and why a run stopped at its limit', () => {
    expect(spendNote({ spend: { limitUsd: 1.5, spentUsd: 1.2, added: [{ atUsd: 1, addUsd: 0.5 }] } }, name)).toBe('You added $0.50 at $1.00')
    expect(spendNote({ spend: { limitUsd: 1, spentUsd: 1.02, stopped: 'finished' } }, name)).toBe('Stopped at its $1.00: you finished with what it had')
    expect(spendNote({ spend: { limitUsd: 1, spentUsd: 1.02, stopped: 'nobody_to_ask' } }, name)).toBe('Stopped at its $1.00: nobody was there to add more')
    expect(spendNote({ spend: { limitUsd: 1, spentUsd: 0.4, agents: { r: { spentUsd: 0.31, limitUsd: 0.3, stopped: true } } } }, name)).toBe('You stopped Researcher at its $0.30')
    // ADR 0090: a scheduled run nobody answered at its limit never reads as something you did.
    expect(spendNote({ spend: { limitUsd: 1, spentUsd: 1.02, stopped: 'no_answer' } }, name)).toBe('Stopped at its $1.00: nobody answered, so it finished with what it had')
    expect(spendNote({ spend: { limitUsd: 1, spentUsd: 0.4, agents: { r: { spentUsd: 0.31, limitUsd: 0.3, stopped: true, unanswered: true } } } }, name)).toBe('Researcher stopped at its $0.30: nobody answered in time')
    expect(spendNote({ spend: { limitUsd: 1, spentUsd: 0.4 } }, name)).toBeNull()
    expect(spendNote({}, name)).toBeNull()
  })
})
