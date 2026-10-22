import { beforeEach, describe, expect, it, vi } from 'vitest'

import { answerRead, forgetAnswersRead, markAnswerRead } from './answersRead'
import type { AskedPassage, PassageAnswer } from './passage'

const part = (answer: PassageAnswer, messageId = 'n-1'): AskedPassage => ({
  file: '/w/notes.md', text: 'an embedding', from: 'tutor', asked: 'explain', runId: null, messageId, onItsOwn: true, answer,
})

describe('which answers to parts of files you have read', () => {
  beforeEach(() => {
    window.localStorage.clear()
    forgetAnswersRead()
    vi.useRealTimers()
  })

  it('counts from the first part looked at, so the first answer in a new browser is news', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-22T09:00:00Z') })
    // The part is asked about; nothing has answered yet.
    expect(answerRead(part({ state: 'writing', by: 'tutor' }))).toBe(true)
    const said = part({ state: 'said', by: 'tutor', text: 'A list of numbers.', at: '2026-10-22T09:00:05Z' })
    vi.setSystemTime(Date.parse('2026-10-22T09:00:06Z'))
    expect(answerRead(said)).toBe(false)
    markAnswerRead(said)
    expect(answerRead(said)).toBe(true)
    // Kept in the browser: read again from storage.
    forgetAnswersRead()
    expect(answerRead(said)).toBe(true)
  })

  it('counts answers given before it began as read, and a new answer to the same message as news', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-22T09:00:00Z') })
    expect(answerRead(part({ state: 'said', by: 'tutor', text: 'Old.', at: '2026-10-21T12:00:00Z' }))).toBe(true)
    const first = part({ state: 'said', by: 'tutor', text: 'First.', at: '2026-10-22T09:01:00Z' })
    markAnswerRead(first)
    expect(answerRead(part({ state: 'said', by: 'tutor', text: 'Again.', at: '2026-10-22T09:05:00Z' }))).toBe(false)
  })
})
