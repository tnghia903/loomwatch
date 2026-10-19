import { describe, expect, it } from 'vitest'

import type { CheckWait } from '../runs/client'
import { checkStopLines, checkStopTitle } from './checkStop'

const names = new Map([['writer', 'Writer']])
const name = (id: string) => names.get(id) ?? id
const stop = (extra: Partial<CheckWait>): CheckWait => ({
  checked: 'writer', rounds: 2, reason: 'rounds', met: 2,
  items: [{ verdict: 'not_met', item: 'Cites the 2025 report', evidence: 'cites the 2023 one' }, { verdict: 'not_sure', item: 'Under 200 words', evidence: '' }],
  ...extra,
})

// ADR 0062: what a check step that stopped to ask says, the same in the chat, the composer and
// Needs you.
describe('checkStopTitle', () => {
  it('says how much is still not met, and why it stopped sending the work back', () => {
    expect(checkStopTitle(stop({}), name, 'Checker')).toBe('Writer’s work still misses 2 checks after going back 2 times.')
    expect(checkStopTitle(stop({ rounds: 1, items: stop({}).items.slice(0, 1) }), name, 'Checker')).toBe('Writer’s work still misses 1 check after going back once.')
    expect(checkStopTitle(stop({ reason: 'no_progress' }), name, 'Checker')).toBe('Writer’s work still misses 2 checks: the last round fixed none of them.')
    expect(checkStopTitle(stop({ reason: 'unchecked', rounds: 0 }), name, 'Checker')).toBe('Checker could not confirm 2 checks on Writer’s work.')
    expect(checkStopTitle(stop({ reason: 'not_open' }), name, 'Checker')).toBe('Writer’s work still misses 2 checks, and Writer has finished, so it can’t be sent back.')
  })
})

describe('checkStopLines', () => {
  it('lists each open check with its verdict and what the checker saw', () => {
    expect(checkStopLines(stop({}))).toEqual(['Not met: Cites the 2025 report — cites the 2023 one', 'Not sure: Under 200 words'])
  })
})
