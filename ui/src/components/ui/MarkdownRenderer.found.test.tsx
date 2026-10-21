import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { FindScopeContext, showFoundWords } from '../../lib/chat/findWords'
import MarkdownRenderer from './MarkdownRenderer'

afterEach(() => { cleanup(); showFoundWords(null) })

const lit = (container: HTMLElement) => [...container.querySelectorAll('mark.tc-find-hit')].map((mark) => mark.textContent)

describe('the words a chat search found, in Markdown (ADR 0081)', () => {
  it('are lit in the chat and the answer beside it, in any form, and not in code blocks', () => {
    showFoundWords([{ text: 'recycl', prefix: true }])
    const { container } = render(
      <FindScopeContext.Provider value>
        <MarkdownRenderer>{'## Recycling\n\nBattery **recycling** is informal.\n\n```\nrecycling()\n```'}</MarkdownRenderer>
      </FindScopeContext.Provider>,
    )
    expect(lit(container)).toEqual(['Recycling', 'recycling'])
    act(() => showFoundWords(null))
    expect(lit(container)).toEqual([])
  })

  it('leave inline code whole, so a file path still opens as a file', () => {
    showFoundWords([{ text: 'report', prefix: true }])
    const { container } = render(
      <FindScopeContext.Provider value>
        <MarkdownRenderer>{'Saved as `/Users/x/report.md` and the report is short.'}</MarkdownRenderer>
      </FindScopeContext.Provider>,
    )
    expect(lit(container)).toEqual(['report'])
    expect(container.querySelector('code mark')).toBeNull()
  })

  it('are not lit anywhere else on the screen', () => {
    showFoundWords([{ text: 'recycl', prefix: true }])
    const { container } = render(<MarkdownRenderer>Battery recycling</MarkdownRenderer>)
    expect(lit(container)).toEqual([])
  })
})
