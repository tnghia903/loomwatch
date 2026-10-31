import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FindScopeContext, showFoundWords } from '../../lib/chat/findWords'

// The real module, code-split renderer and all: test/setup.ts swaps it for the renderer alone.
const { InlineMarkdown } = await vi.importActual<typeof import('./Markdown')>('./Markdown')

afterEach(() => { cleanup(); showFoundWords(null) })

describe('an agent’s Markdown inside a line of the app’s own', () => {
  // A check's evidence showed `**ln(1 + ratio)**` and `[IR book](https://…)` as typed.
  it('shows its bold, code and links in the sentence, with no paragraph of its own', async () => {
    const { container } = render(<p>Not met <InlineMarkdown>{'Gives **1.897** with `idf()`, as [IR book §11.4.3](https://nlp.stanford.edu/IR-book/) says, inspected by hand.'}</InlineMarkdown></p>)
    expect(await screen.findByRole('link', { name: 'IR book §11.4.3' })).toHaveAttribute('href', 'https://nlp.stanford.edu/IR-book/')
    expect(container.querySelector('strong')).toHaveTextContent('1.897')
    expect(container.querySelector('code')).toHaveTextContent('idf()')
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container).toHaveTextContent('Not met Gives 1.897 with idf(), as IR book §11.4.3 says, inspected by hand.')
  })

  it('keeps a heading or a list as its words, in the line', async () => {
    const { container } = render(<p><InlineMarkdown>{'## Fix the **slot** count\n\n- one\n- two'}</InlineMarkdown></p>)
    expect(await screen.findByText('slot')).toBeInTheDocument()
    expect(container.querySelector('h2, ul, li')).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container).toHaveTextContent('Fix the slot count one two')
  })

  it('keeps a number that would start a list as its words: “2025.” is not an empty list', async () => {
    const { container } = render(<p>Answer: <InlineMarkdown>{'2025.'}</InlineMarkdown> then <InlineMarkdown>{'3) **maybe**'}</InlineMarkdown></p>)
    expect(await screen.findByText('maybe')).toBeInTheDocument()
    expect(container).toHaveTextContent('Answer: 2025. then 3) maybe')
  })

  it('keeps a claim’s tag and the words a chat search found', async () => {
    showFoundWords([{ text: 'slot', prefix: true }])
    const { container } = render(<FindScopeContext.Provider value><p><InlineMarkdown>{'[Sourced] Two filled slots and one empty.'}</InlineMarkdown></p></FindScopeContext.Provider>)
    expect(await screen.findByText('Sourced')).toHaveClass('md-claim')
    expect([...container.querySelectorAll('mark.tc-find-hit')].map((mark) => mark.textContent)).toEqual(['slots'])
  })
})
