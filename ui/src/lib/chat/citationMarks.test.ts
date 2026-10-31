import { describe, expect, it } from 'vitest'

import { withoutCitationMarks } from './citationMarks'

// The same cases as `citation_marks_leave_plain_words` in crates/loomwatch-backend/src/agent/chatgpt.rs.
describe('citation marks in an answer', () => {
  it('keeps a link’s words; any other mark goes, and a mark left open loses only its opening sign', () => {
    expect(withoutCitationMarks('citeturn0news12 Published today.')).toBe(' Published today.')
    expect(withoutCitationMarks('* cite7†Docs(opens in a new window)†developers.openai.com L8')).toBe('* Docs(opens in a new window) L8')
    expect(withoutCitationMarks('a cite and more')).toBe('a cite and more')
    expect(withoutCitationMarks('no marks')).toBe('no marks')
  })

  it('takes every mark out of an answer saved with them', () => {
    expect(withoutCitationMarks('in cash. citeturn2search1\n\nOperating loss narrowed. citeturn2search4'))
      .toBe('in cash. \n\nOperating loss narrowed. ')
  })
})
