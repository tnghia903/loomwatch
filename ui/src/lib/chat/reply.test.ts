import { describe, expect, it } from 'vitest'

import { QUOTE_SENT_CHARS, questionBackOf, quoteLine, replyOf, replyWhat } from './reply'

const names = new Map([['researcher', 'Researcher'], ['writer', 'Writer']])
const name = (id: string) => names.get(id) ?? id

describe('replies', () => {
  it('names what a reply answers the way the daemon tells the agent', () => {
    expect(replyWhat({ from: 'researcher', to: 'writer', kind: 'handover' }, name)).toBe("Researcher's handover to Writer")
    expect(replyWhat({ from: 'researcher', to: null, kind: 'question_back' }, name)).toBe("Researcher's question back")
    expect(replyWhat({ from: 'researcher', to: 'helper', kind: 'task' }, name)).toBe('the task Researcher sent to helper')
    expect(replyWhat({ from: 'researcher', to: 'writer', kind: 'check' }, name)).toBe("Researcher's check of Writer's work")
  })

  it('finds the question in an answer that asks back, as a heading or a label', () => {
    expect(questionBackOf('It depends.\n\n## Question back\nWhich year?')).toBe('Which year?')
    expect(questionBackOf('**Question back:**\nWhich quarter?')).toBe('Which quarter?')
    expect(questionBackOf('Which year?')).toBe('Which year?')
  })

  it('quotes in one line, and cuts a long quote in the middle', () => {
    expect(quoteLine('## Draft\n**Lead** with\n\n> the rule')).toBe('Draft Lead with the rule')
    const long = replyOf({ runId: 'r', messageId: 'm', from: 'writer', to: null, kind: 'answer', text: `head${'x'.repeat(QUOTE_SENT_CHARS * 2)}tail` })
    expect(long.text.startsWith('head') && long.text.endsWith('tail') && long.text.includes('[… cut …]')).toBe(true)
    expect([...long.text].length).toBeLessThan(QUOTE_SENT_CHARS + 40)
  })
})
