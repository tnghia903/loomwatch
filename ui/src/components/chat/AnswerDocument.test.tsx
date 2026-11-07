import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { showInDocument } from '../../lib/widgets/documentWidgets'
import type { KeptWidget } from '../../lib/widgets/types'
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

  // A ChatGPT model's answer saved before the daemon took its citation marks out read
  // "…in cash. [box]cite[box]turn2search1[box]".
  it('drops the private citation marks a ChatGPT model wrote, keeping a link’s words', async () => {
    const { container } = render(<AnswerDocument by="Cole" streaming={false} text={'The **$72.4B is largely non-cash accounting**. citeturn2search1\n\nSee cite3†the filing†sec.gov.'} />)
    expect(await screen.findByText('$72.4B is largely non-cash accounting')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/[-]|turn2search1/)
    expect(container.textContent).toContain('See the filing.')
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

  // The shape of a real answer (Coby, 6 November): each point closes on its source in brackets.
  it('shows sources in brackets as chips without their brackets, and leaves brackets that hold more', async () => {
    const { container } = render(<AnswerDocument by="Coby" streaming={false} text={[
      'Cả hai nước đều có cơ quan làm luật, điều hành và xét xử. ([usa.gov](https://www.usa.gov/branches-of-government))',
      '- **Làm luật:** Ở Mỹ, Hạ viện đại diện theo dân số. ([usa.gov](https://www.usa.gov/legislative-branch)).',
      '- **Điều hành:** Ở Việt Nam, **Thủ tướng đứng đầu Chính phủ**. ([usa.gov](https://www.usa.gov/executive-branch))',
      '- **Chính trị:** Mỹ có hệ thống đa đảng. ([xaydungchinhsach.chinhphu.vn](https://xaydungchinhsach.chinhphu.vn/a), [usa.gov](https://www.usa.gov/b))',
      '',
      'The US has three branches ([usa.gov](https://www.usa.gov/branches)).',
      '',
      'Read the rules first (see [the guide](https://example.com/guide)).',
    ].join('\n')} />)
    await screen.findByText(/Cả hai nước/)
    const sources = [...container.querySelectorAll('a.md-source')]
    expect(sources.map((link) => [link.textContent, link.getAttribute('title')])).toEqual([
      ['usa.gov', 'usa.gov'],
      ['usa.gov', 'usa.gov'],
      ['usa.gov', 'usa.gov'],
      ['xaydungchinhsach.chinhphu.vn', 'xaydungchinhsach.chinhphu.vn'],
      ['usa.gov', 'usa.gov'],
      ['usa.gov', 'usa.gov'],
    ])
    for (const source of sources) expect(source.parentElement?.textContent).not.toMatch(/[()[\]]/)
    expect(screen.getByText(/Cả hai nước/).textContent).toBe('Cả hai nước đều có cơ quan làm luật, điều hành và xét xử. usa.gov')
    // After bold words the full stop stays the claim's.
    expect(screen.getByText(/Ở Việt Nam/).textContent).toBe('Điều hành: Ở Việt Nam, Thủ tướng đứng đầu Chính phủ. usa.gov')
    // A full stop after the bracket ends the claim before its chip, and is never lost.
    expect(screen.getByText(/three branches/).textContent).toBe('The US has three branches. usa.gov')
    expect(screen.getByText('Làm luật:').closest('li')?.textContent).toBe('Làm luật: Ở Mỹ, Hạ viện đại diện theo dân số. usa.gov')
    // Brackets with more than the links in them stay as written, the link a link.
    expect(screen.getByRole('link', { name: 'the guide' })).not.toHaveClass('md-source')
    expect(screen.getByText(/Read the rules first/).textContent).toBe('Read the rules first (see the guide).')
  })

  // ADR 0116: a source is named by its page, as the run's search found it, with its site's icon,
  // which only LoomWatch fetches; without either it is its words, as before.
  it('names a source by its page and shows its site’s icon from LoomWatch, else its own words', async () => {
    const sources = new Map([['usa.gov/branches-of-government', 'Branches of the U.S. government | USAGov']])
    const { container } = render(<AnswerDocument by="Coby" streaming={false} sources={sources} text={[
      'Mỹ có ba nhánh quyền lực. ([usa.gov](https://www.usa.gov/branches-of-government/))',
      '',
      'Việt Nam có một Quốc hội. ([xaydungchinhsach.chinhphu.vn](https://xaydungchinhsach.chinhphu.vn/a))',
    ].join('\n')} />)
    await screen.findByText(/ba nhánh/)
    const [named, plain] = [...container.querySelectorAll<HTMLAnchorElement>('a.md-source')]
    expect(named).toHaveTextContent('Branches of the U.S. government | USAGov')
    expect(named).toHaveAttribute('title', 'Branches of the U.S. government | USAGov · usa.gov')
    expect(named).toHaveAttribute('href', 'https://www.usa.gov/branches-of-government/')
    expect(named.querySelector('img')).toHaveAttribute('src', '/api/site-icon?host=www.usa.gov')
    expect(plain).toHaveTextContent('xaydungchinhsach.chinhphu.vn')
    // A site without an icon keeps its words and arrow.
    fireEvent.error(plain.querySelector('img')!)
    expect(plain.querySelector('img')).toBeNull()
    expect(plain.querySelector('svg')).not.toBeNull()
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

// ADR 0114: a long answer's widgets stand in it where its words placed them, not under its card.
describe('a document answer’s widgets', () => {
  const jobs: KeptWidget = { n: 1, line: 12, spec: { kind: 'chart', title: 'US jobs added in October', unit: 'jobs', bars: [{ label: 'Expected', value: 65_000 }, { label: 'Actual', value: 165_000 }] } }
  const stake: KeptWidget = { n: 2, line: 7, spec: { kind: 'chart', title: 'Kokuyo’s stake in Thien Long', unit: '%', bars: [{ label: 'Bought on 6 Nov', value: 46.82 }, { label: 'After the offer', value: 65.01 }] } }
  const todo: KeptWidget = { n: 3, spec: { kind: 'checklist', title: 'Read before Monday', items: [{ text: 'The jobs report' }, { text: 'The tender offer' }] } }
  // The shape of the owner's brief (7 November): bullets, a loose list, each closing on its source.
  const brief = [
    '# Morning Brief',
    '',
    '## Vietnam',
    '',
    '### Business',
    '- **Kokuyo bought 46.82% of Thien Long.** A tender offer would take it to 65.01%. [VnExpress](https://vnexpress.net/a)',
    '',
    '- **Most small firms can’t meet foreign investors’ standards.** [Bao Tin tuc](https://baotintuc.vn/b)',
    '',
    '## World',
    '',
    '- **US employers added 165,000 jobs in October.** [Yahoo Finance](https://finance.yahoo.com/c)',
    '- **A Fed rate rise in December looks likelier.** [Reuters](https://reuters.com/d)',
  ].join('\n')
  const keep = vi.fn(async (n: number) => ({ ...todo, n, changedAt: '2026-11-07T01:00:00.000Z' }))
  afterEach(() => { showInDocument('run-1', null); keep.mockClear() })

  it('stands each under the bullet it goes with, keeping the list whole and its sources', async () => {
    showInDocument('run-1', { widgets: [jobs, stake, todo], live: false, onChange: keep })
    const { container } = render(<AnswerDocument runId="run-1" by="Writer" streaming={false} text={brief} />)
    const stakeChart = await screen.findByRole('region', { name: 'Kokuyo’s stake in Thien Long' })
    // Between two bullets of a loose list: at the end of the one above, and the list stays one.
    const kokuyo = stakeChart.closest('li')!
    expect(kokuyo).toHaveTextContent(/^Kokuyo bought 46\.82% of Thien Long\./)
    expect(kokuyo.parentElement!.children).toHaveLength(2)
    // Between two bullets of a tight list too; its source is still a source.
    const jobsItem = screen.getByRole('region', { name: 'US jobs added in October' }).closest('li')!
    expect(jobsItem).toHaveTextContent(/^US employers added 165,000 jobs in October\./)
    expect(within(jobsItem).getByRole('link', { name: /Yahoo Finance/ })).toHaveClass('md-source')
    expect(jobsItem.parentElement!.children).toHaveLength(2)
    // One its words didn't place: at the end, on its own.
    const list = screen.getByRole('region', { name: 'Read before Monday' })
    expect(list.closest('li')).toBeNull()
    expect(screen.getByText(/A Fed rate rise/).compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('.md-widget')).toHaveLength(3)
  })

  it('keeps a numbered list counting and the footnotes at the very end', async () => {
    const steps: KeptWidget = { ...stake, line: 2 }
    showInDocument('run-1', { widgets: [steps, todo], live: false, onChange: keep })
    const { container } = render(<AnswerDocument runId="run-1" by="Writer" streaming={false} text={'1. Read the offer.\n2. Check the price.\n3. Decide by Friday.\n\nThe offer closes in December.[^1]\n\n[^1]: From the filing.'} />)
    const chart = await screen.findByRole('region', { name: 'Kokuyo’s stake in Thien Long' })
    expect(chart.closest('li')).toHaveTextContent(/^Check the price\./)
    expect(container.querySelectorAll('ol')[0].children).toHaveLength(3)
    const notes = container.querySelector<HTMLElement>('section.footnotes')!
    const list = screen.getByRole('region', { name: 'Read before Monday' })
    expect(list.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(notes).getByText(/From the filing\./)).toBeInTheDocument()
  })

  // `\[x\]` is read as a `$$` block of three lines: a widget after it still stands where it was placed.
  it('stands where it was placed after math that takes more lines once read', async () => {
    showInDocument('run-1', { widgets: [{ ...stake, line: 6 }], live: false, onChange: keep })
    render(<AnswerDocument runId="run-1" by="Writer" streaming={false} text={'Intro.\n\n\\[x^2 + y^2 = z^2\\]\n\nAfter the formula.\n\nLast words.'} />)
    const chart = await screen.findByRole('region', { name: 'Kokuyo’s stake in Thien Long' })
    const after = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(after(screen.getByText('After the formula.'), chart)).toBe(true)
    expect(after(chart, screen.getByText('Last words.'))).toBe(true)
  })

  it('stands inside a quote, and under the item of a list inside a list', async () => {
    showInDocument('run-1', { widgets: [{ ...stake, line: 2 }], live: false, onChange: keep })
    const { container } = render(<AnswerDocument runId="run-1" by="Writer" streaming={false} text={'> First thought.\n>\n> Second thought.\n\nAfter the quote.'} />)
    const inQuote = await screen.findByRole('region', { name: 'Kokuyo’s stake in Thien Long' })
    expect(inQuote.closest('blockquote')).not.toBeNull()
    expect(inQuote.compareDocumentPosition(screen.getByText('Second thought.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('blockquote')).toHaveLength(1)
    cleanup()
    render(<AnswerDocument runId="run-1" by="Writer" streaming={false} text={'- Fruit\n  - Apples\n  - Pears\n- Bread'} />)
    const nested = await screen.findByRole('region', { name: 'Kokuyo’s stake in Thien Long' })
    expect(nested.closest('li')).toHaveTextContent(/^Apples/)
  })

  it('draws widgets that arrive after the words, and keeps each in place as the words grow', async () => {
    const { rerender } = render(<AnswerDocument runId="run-1" by="Writer" streaming text={brief.split('\n').slice(0, 9).join('\n')} />)
    expect(await screen.findByText(/Kokuyo bought/)).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
    act(() => showInDocument('run-1', { widgets: [stake], live: true, onChange: keep }))
    const chart = await screen.findByRole('region', { name: 'Kokuyo’s stake in Thien Long' })
    expect(chart.closest('li')).toHaveTextContent(/^Kokuyo bought/)
    rerender(<AnswerDocument runId="run-1" by="Writer" streaming={false} text={brief} />)
    expect(await screen.findByText(/A Fed rate rise/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Kokuyo’s stake in Thien Long' }).closest('li')).toHaveTextContent(/^Kokuyo bought/)
  })

  it('keeps a tick made in it, and waits while the answer is still written', async () => {
    showInDocument('run-1', { widgets: [todo], live: false, onChange: keep })
    render(<AnswerDocument runId="run-1" by="Writer" streaming={false} text={brief} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: /The jobs report/ }))
    expect(keep).toHaveBeenCalledWith(3, { checked: [true, false] })
    cleanup()
    showInDocument('run-1', { widgets: [todo], live: true, onChange: keep })
    render(<AnswerDocument runId="run-1" by="Writer" streaming text={brief} />)
    expect(await screen.findByRole('checkbox', { name: /The jobs report/ })).toBeDisabled()
  })

  it('draws none for another answer, and its words read as before', async () => {
    showInDocument('run-1', { widgets: [jobs], live: false, onChange: keep })
    const { container } = render(<AnswerDocument runId="run-2" by="Writer" streaming={false} text={brief} />)
    expect(await screen.findByText(/Kokuyo bought/)).toBeInTheDocument()
    expect(container.querySelector('.md-widget')).toBeNull()
    expect(screen.queryByRole('region')).toBeNull()
  })
})
