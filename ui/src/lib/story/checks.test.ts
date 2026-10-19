import { describe, expect, it } from 'vitest'

import { answerNotes, checkProgress, checkRounds } from './checks'

const meta = (seq: number, agentId: string, payload: Record<string, unknown>) => ({ seq, agentId, kind: 'session_meta' as const, payload: { phase: 'check_result', ...payload } })

describe('checkRounds', () => {
  it('keeps the last round of each check step and drops what it cannot read', () => {
    const events = [
      meta(1, 'checker', { checked: 'writer', round: 1, items: [{ verdict: 'not_met', item: 'Every claim has a link', evidence: 'claim 2' }] }),
      meta(2, 'checker', { checked: 'writer', round: 2, items: [{ verdict: 'met', item: 'Every claim has a link', evidence: 'all linked' }, { verdict: 'maybe', item: 'x' }, 'junk'] }),
      { seq: 3, agentId: 'writer', kind: 'session_meta' as const, payload: { phase: 'stage_handover' } },
    ]
    expect(checkRounds(events)).toEqual([{
      checker: 'checker', checked: 'writer', round: 2,
      items: [{ verdict: 'met', item: 'Every claim has a link', evidence: 'all linked' }],
      // What the first round found stays with the last, so a send-back's fix can be shown.
      first: [{ verdict: 'not_met', item: 'Every claim has a link', evidence: 'claim 2' }],
    }])
    expect(checkRounds(events, 1)).toEqual([{ checker: 'checker', checked: 'writer', round: 1, items: [{ verdict: 'not_met', item: 'Every claim has a link', evidence: 'claim 2' }] }])
  })

  // ADR 0062: approved at the check step's stop with checks still not met, which the badge says.
  it('marks the last round you approved as it was, and only that check step’s', () => {
    const events = [
      meta(1, 'checker', { checked: 'writer', round: 2, items: [{ verdict: 'not_met', item: 'Linked', evidence: 'claim 2' }] }),
      meta(2, 'other', { checked: 'coder', round: 1, items: [{ verdict: 'not_met', item: 'Tests pass', evidence: '1 fails' }] }),
      meta(3, 'checker', { phase: 'check_approved', checked: 'writer', round: 2, open: 1 }),
    ]
    expect(checkRounds(events).map((round) => [round.checker, round.approved ?? false])).toEqual([['checker', true], ['other', false]])
  })

  it('says when a check step’s reply could not be read', () => {
    const events = [meta(1, 'checker', { checked: 'writer', round: 1, readable: false, items: [{ verdict: 'not_sure', item: 'Linked', evidence: 'no block' }] })]
    expect(checkRounds(events)[0].readable).toBe(false)
    expect(checkRounds([meta(1, 'checker', { checked: 'writer', round: 1, readable: true, items: [] })])[0]).not.toHaveProperty('readable')
  })
})

describe('checkProgress', () => {
  const item = (verdict: 'met' | 'not_met' | 'not_sure', name: string) => ({ verdict, item: name, evidence: '' })
  it('counts what the first round missed and the last round met', () => {
    const round = { checker: 'checker', checked: 'writer', round: 2, first: [item('not_met', 'Linked'), item('not_met', 'Short'), item('not_sure', 'Dated'), item('met', 'Named')], items: [item('met', 'Linked'), item('not_met', 'Short'), item('met', 'Dated'), item('met', 'Named')] }
    expect(checkProgress(round)).toEqual({ found: 2, fixed: 1 })
    // Nothing was sent back: one round, or a first round that missed nothing.
    expect(checkProgress({ ...round, round: 1, first: undefined })).toBeNull()
    expect(checkProgress({ ...round, first: [item('met', 'Linked')] })).toBeNull()
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
