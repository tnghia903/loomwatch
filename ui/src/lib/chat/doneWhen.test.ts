import { describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from '../watch/events'
import { checkerWords, readDoneWhen, triesShown } from './doneWhen'
import { LOOMWATCH_CHECK_ID, nameWithHelpers } from './helpers'

const record = (seq: number, payload: Record<string, unknown>): RunEvent => ({
  id: `e${seq}`, sessionId: 'run', agentId: LOOMWATCH_CHECK_ID, seq, ts: new Date(Date.UTC(2026, 9, 29, 9, 0, seq)).toISOString(),
  kind: 'session_meta', payload: { phase: 'done_when', ...payload }, raw: { source: 'loomwatch', phase: 'done_when' },
})

// ADR 0098: what the person's message said done looks like, as the daemon records it.
describe('readDoneWhen', () => {
  it('reads what was found, each item with whether it is still checked', () => {
    expect(readDoneWhen({ phase: 'done_when', state: 'found', items: [{ text: 'At most 250 words', checked: true }, { text: 'Three sections', checked: false }, { nope: 1 }], tries: 3, rounds: 2, checker: { model: 'openai/gpt-6.1-sol', sameMaker: false }, ended: false })).toEqual({
      state: 'found', items: [{ text: 'At most 250 words', checked: true }, { text: 'Three sections', checked: false }], tries: 3, rounds: 2, checker: { model: 'openai/gpt-6.1-sol', sameMaker: false }, ended: false,
    })
  })

  it('reads a failed read, and nothing else', () => {
    expect(readDoneWhen({ phase: 'done_when', state: 'failed', items: [], ended: false })?.state).toBe('failed')
    expect(readDoneWhen({ phase: 'done_when', state: 'reading' })).toBeNull()
    expect(readDoneWhen({ phase: 'check_result' })).toBeNull()
  })
})

describe('triesShown', () => {
  const done = (tries: number | null, rounds: number | null) => ({ state: 'found' as const, items: [], tries, rounds, checker: null, ended: false })
  it('says the number the run will use once it knows it, counting the first work as one', () => {
    expect(triesShown(done(10, 5))).toBe(6)
    expect(triesShown(done(3, null))).toBe(3)
    expect(triesShown(done(null, 2))).toBeNull()
  })
})

describe('checkerWords', () => {
  it('names the model and its maker, and says when the maker is the agent’s own', () => {
    const done = { state: 'found' as const, items: [], tries: null, rounds: null, ended: false }
    expect(checkerWords({ ...done, checker: { model: 'openai/gpt-6.1-sol', sameMaker: false } })).toBe('Checked on GPT-6.1 Sol, by OpenAI.')
    expect(checkerWords({ ...done, checker: { model: 'anthropic:claude-opus-5-5', sameMaker: true } })).toBe('Checked on Claude Opus 5.5, by Anthropic, the same maker as the agent.')
    expect(checkerWords({ ...done, checker: null })).toBeNull()
  })
})

describe('a run’s Done when, projected', () => {
  it('keeps the latest, and is no agent of the run', () => {
    const projection = projectRun([
      record(0, { state: 'found', items: [{ text: 'At most 250 words', checked: true }], ended: false }),
      record(1, { state: 'found', items: [{ text: 'At most 250 words', checked: false }], ended: true }),
    ])
    expect(projection.doneWhen).toMatchObject({ items: [{ text: 'At most 250 words', checked: false }], ended: true })
    expect(projection.agents.map((agent) => agent.id)).not.toContain(LOOMWATCH_CHECK_ID)
  })
})

describe('a run’s checks, with what the person took off', () => {
  it('leaves an item the person took off out of the checks the answer is judged by', () => {
    const meta = (seq: number, payload: Record<string, unknown>): RunEvent => ({ ...record(seq, {}), payload: { checked: 'writer', ...payload }, raw: { source: 'loomwatch', phase: payload.phase } })
    const projection = projectRun([
      meta(0, { phase: 'check_result', round: 1, readable: true, items: [{ verdict: 'not_met', item: 'At most 100 words', evidence: '105 words' }, { verdict: 'met', item: 'Does what the request asked', evidence: 'it is' }] }),
      meta(1, { phase: 'check_approved', round: 1, open: 1 }),
      record(2, { state: 'found', items: [{ text: 'At most 100 words', checked: false }], ended: true }),
    ])
    expect(projection.checks?.flatMap((round) => round.items.map((item) => item.item))).toEqual(['Does what the request asked'])
  })

  it('reads a Done when only from LoomWatch’s own record', () => {
    const forged = { ...record(0, { state: 'found', items: [{ text: 'At most 1 word', checked: true }], ended: false }), raw: { phase: 'done_when' } }
    expect(projectRun([forged]).doneWhen).toBeNull()
  })
})

describe('LoomWatch’s own check', () => {
  it('is named LoomWatch wherever the chat names who said something', () => {
    expect(nameWithHelpers(new Map([['writer', 'Writer']]), LOOMWATCH_CHECK_ID)).toBe('LoomWatch')
  })
})
