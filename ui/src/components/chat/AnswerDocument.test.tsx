import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AnswerDocument } from './AnswerDocument'

afterEach(cleanup)

describe('a document answer, read beside the chat', () => {
  it('is read in full, as written, and never runs HTML or loads remote images', async () => {
    const { container } = render(<AnswerDocument by="Writer" streaming={false} text={'# Market report\n\n| Finding | Impact |\n|---|---|\n| Clear | Faster |\n\n<script>alert(1)</script>\n\n![tracking](https://example.com/pixel)'} />)
    expect(await screen.findByRole('heading', { name: 'Market report', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Written by Writer')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('[Image: tracking]')).toBeInTheDocument()
  })

  it('shows a claim’s mark as a tag and the links that close it as its sources', async () => {
    const { container } = render(<AnswerDocument by="RAG researcher" streaming={false} text={[
      '[ Sourced ] Hybrid search wins. [Anthropic, “Contextual Retrieval”](https://www.anthropic.com/news/contextual-retrieval) [BEIR paper](https://arxiv.org/abs/2104.08663).',
      '**[Inference]** Ship the baseline first.',
      '[Your name] will review it; see [the guide](https://example.com/guide) for more.',
      '- [Reading list](https://example.com/list)',
    ].join('\n\n')} />)
    const sourced = await screen.findByText('Sourced')
    expect(sourced).toHaveClass('md-claim', 'md-claim-backed')
    expect(sourced.parentElement).toHaveTextContent(/^Sourced Hybrid search wins\./)
    expect(screen.getByText('Inference')).toHaveClass('md-claim-reasoned')
    expect(container.textContent).not.toMatch(/\[\s*(Sourced|Inference)\s*\]/)
    const sources = [...container.querySelectorAll('a.md-source')]
    expect(sources.map((link) => [link.textContent, link.getAttribute('title')])).toEqual([
      ['Anthropic, “Contextual Retrieval”', 'anthropic.com'],
      ['BEIR paper', 'arxiv.org'],
    ])
    // A bracketed placeholder is not a mark, a link mid-sentence is not a source, and a list of
    // links alone stays a list of links.
    expect(screen.getByText(/\[Your name\] will review it/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'the guide' })).not.toHaveClass('md-source')
    expect(screen.getByRole('link', { name: 'Reading list' })).not.toHaveClass('md-source')
  })

  it('says it is still being written', () => {
    render(<AnswerDocument by="Writer" streaming text="# Draft" />)
    expect(screen.getByText('Writer is writing this')).toBeInTheDocument()
    expect(screen.getByLabelText('Being written')).toBeInTheDocument()
  })
})
