import { describe, expect, it } from 'vitest'

import { checkRounds } from './checks'

const meta = (seq: number, agentId: string, payload: Record<string, unknown>) => ({ seq, agentId, kind: 'session_meta' as const, payload: { phase: 'check_result', ...payload } })

describe('checkRounds', () => {
  it('keeps the last round of each check step and drops what it cannot read', () => {
    const events = [
      meta(1, 'checker', { checked: 'writer', round: 1, items: [{ verdict: 'not_met', item: 'Every claim has a link', evidence: 'claim 2' }] }),
      meta(2, 'checker', { checked: 'writer', round: 2, items: [{ verdict: 'met', item: 'Every claim has a link', evidence: 'all linked' }, { verdict: 'maybe', item: 'x' }, 'junk'] }),
      { seq: 3, agentId: 'writer', kind: 'session_meta' as const, payload: { phase: 'stage_handover' } },
    ]
    expect(checkRounds(events)).toEqual([{ checker: 'checker', checked: 'writer', round: 2, items: [{ verdict: 'met', item: 'Every claim has a link', evidence: 'all linked' }] }])
    expect(checkRounds(events, 1)[0].round).toBe(1)
  })
})
