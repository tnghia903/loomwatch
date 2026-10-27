import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnswerDocument } from './AnswerDocument'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a document answer, read beside the chat', () => {
  it('is read in full, as written, and never runs HTML or loads images', async () => {
    const { container } = render(<AnswerDocument by="Writer" streaming={false} text={'# Market report\n\n| Finding | Impact |\n|---|---|\n| Clear | Faster |\n\n<script>alert(1)</script>\n\n![tracking](https://example.com/pixel)\n\n![chart](/Users/ana/out/chart.png)'} />)
    expect(await screen.findByRole('heading', { name: 'Market report', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Written by Writer')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('[Image: tracking]')).toBeInTheDocument()
    // A picture on this computer is shown only where the screen says where it is: the reader.
    expect(screen.getByText('[Image: chart]')).toBeInTheDocument()
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

  it('opens a file the agent names from its own folder', async () => {
    // The shape of a real reply (run aace60a2): a link relative to the agent's folder, spaces as %20.
    const guide = '/Users/me/LoomWatch/teams/.loomwatch/bench-coby/coby/LLM Prefill Guide.html'
    const { container } = render(<AnswerDocument by="Coby" streaming={false} touched={[guide]} text={[
      '### [Open the interactive guide](./LLM%20Prefill%20Guide.html)',
      '**File:** `LLM Prefill Guide.html`',
      'Also [notes](./notes.md), which it never wrote.',
    ].join('\n\n')} />)
    const chips = await screen.findAllByRole('button', { name: /LLM Prefill Guide\.html/ })
    expect(chips.map((chip) => chip.getAttribute('title')?.split('\n')[0])).toEqual([guide, guide])
    // Opened in a new tab, a name from a folder the page cannot know would only load LoomWatch again.
    expect(screen.queryByRole('link', { name: 'notes' })).toBeNull()
    expect(container.querySelector('.md-unlinked')).toHaveTextContent('notes')
  })

  it('opens a file the agent made with a command, linked from the folder it works in', async () => {
    const folder = '/Users/me/LoomWatch/teams/.loomwatch/bench-coby/coby'
    const guide = `${folder}/LLM Prefill Guide.html`
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify({
      path: new URL(url, 'http://x').searchParams.get('path'), name: 'LLM Prefill Guide.html', exists: true, isDir: false, sizeBytes: 9_000,
      modifiedAt: null, kind: 'web', folder: '.loomwatch/bench-coby/coby', openable: true,
    }), { status: 200 }))))
    render(<AnswerDocument by="Coby" streaming={false} folder={folder} text={[
      '### [Open the interactive guide](./LLM%20Prefill%20Guide.html)',
      '**File:** `LLM Prefill Guide.html`',
    ].join('\n\n')} />)
    const chip = await screen.findByRole('button', { name: 'Open LLM Prefill Guide.html (Web page)' })
    expect(chip).toBeEnabled()
    expect(chip.getAttribute('title')?.split('\n')[0]).toBe(guide)
    // The bare name in code is not taken from the folder: it stays the agent's words.
    expect(screen.getAllByRole('button', { name: /LLM Prefill Guide\.html/ })).toHaveLength(1)
    expect(screen.getByText('LLM Prefill Guide.html', { selector: 'code' })).toBeInTheDocument()
  })

  it('opens a file the run wrote where the answer names it in plain words', async () => {
    const page = '/Users/me/sutd-final-project/design/architecture.html'
    render(<AnswerDocument by="Designer" streaming={false} touched={[page]} written={[page]} text={'Files are in /Users/me/sutd-final-project/design:\n\n- architecture.html'} />)
    const chip = await screen.findByRole('button', { name: /architecture\.html/ })
    expect(chip.getAttribute('title')?.split('\n')[0]).toBe(page)
  })

  it('says it is still being written', () => {
    render(<AnswerDocument by="Writer" streaming text="# Draft" />)
    expect(screen.getByText('Writer is writing this')).toBeInTheDocument()
    expect(screen.getByLabelText('Being written')).toBeInTheDocument()
  })
})
