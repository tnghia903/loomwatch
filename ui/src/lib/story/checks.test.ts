import { describe, expect, it } from 'vitest'

import { answerNotes, checkRounds } from './checks'

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

describe('answerNotes', () => {
  it('reads what the answer ended with, and nothing when it ended with none', () => {
    const events = [
      { seq: 1, agentId: 'writer', kind: 'session_meta' as const, payload: { phase: 'answer_notes', not_met: ['Story 2 has a link: the page is down', 3, ' '], not_changed: ['2.5 million: the report says so'] } },
      { seq: 2, agentId: 'writer', kind: 'session_meta' as const, payload: { phase: 'answer_notes', not_met: [], missing: ['The March total: no sheet was attached'] } },
    ]
    expect(answerNotes(events, 1)).toEqual({ agentId: 'writer', notMet: ['Story 2 has a link: the page is down'], missing: [], notChanged: ['2.5 million: the report says so'] })
    // A later answer in the same record is the one beside it.
    expect(answerNotes(events)).toEqual({ agentId: 'writer', notMet: [], missing: ['The March total: no sheet was attached'], notChanged: [] })
    expect(answerNotes(events, 0)).toBeNull()
    expect(answerNotes([meta(1, 'checker', { checked: 'writer', items: [] })])).toBeNull()
  })
})
