import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentFacts } from '../../lib/chat/faces'
import { forgetAnswersRead } from '../../lib/files/answersRead'
import { openPdf } from '../../lib/files/pdf'
import { askKey, partId, passageId, type AskedPassage, type PassageAnswer } from '../../lib/files/passage'
import { isGoldFill } from '../../test/cascade'
import { EXPLAIN_WORDS, FileReader } from './FileReader'

// PDF.js stands in as a PDF of a few pages, each 600 by 800 at scale 1, saying which page it is.
// A drawing waits for `hold`, and laying words out for `wordsHold`, when there is one; each is
// handed a signal that stops it, kept in `stops` and `wordStops`. Pages let go of are in `released`.
const pdfState = vi.hoisted(() => ({
  pages: 2, fail: false, hang: false, sharp: true, pictured: true, drawnAgain: [] as unknown[],
  hold: null as Promise<void> | null, stops: [] as (AbortSignal | undefined)[],
  wordsHold: null as Promise<void> | null, wordStops: [] as (AbortSignal | undefined)[], released: [] as number[],
  textHold: null as Promise<void> | null,
}))
vi.mock('../../lib/files/pdf', async (real) => ({
  ...await real<typeof import('../../lib/files/pdf')>(),
  openPdf: vi.fn(async () => {
    if (pdfState.fail) throw new Error('not a PDF')
    if (pdfState.hang) await new Promise(() => undefined)
    return {
      pages: pdfState.pages,
      close: () => undefined,
      picture: async (at: unknown) => { pdfState.drawnAgain.push(at); return pdfState.sharp ? new Blob(['sharp png'], { type: 'image/png' }) : null },
      text: async (number: number) => {
        if (pdfState.textHold) await pdfState.textHold
        return `Page ${number} says sales grew.`
      },
      page: async (number: number) => ({
        width: 600,
        height: 800,
        draw: async (canvas: HTMLCanvasElement, _scale: number, stop?: AbortSignal) => {
          pdfState.stops.push(stop)
          if (pdfState.hold) await pdfState.hold
          canvas.width = 1200
          canvas.height = 1600
        },
        words: async (container: HTMLElement, _scale: number, stop?: AbortSignal) => {
          pdfState.wordStops.push(stop)
          if (pdfState.wordsHold) await pdfState.wordsHold
          if (stop?.aborted) return
          container.innerHTML = `<span>Page ${number} says sales grew.</span><div class="endOfContent"></div>`
        },
        pictures: async () => pdfState.pictured,
        release: () => { pdfState.released.push(number) },
      }),
    }
  }),
}))

const REPORT = '/teams/.loomwatch/market/writer/market-report.md'
const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const read = (overrides: Record<string, unknown> = {}) => ({
  path: REPORT, name: 'market-report.md', kind: 'markdown', text: '# Market report\n\nSales grew 12% in Q3.\n\nCosts fell.\n',
  extracted: false, truncated: false, sizeBytes: 2_048, modifiedAt: '2026-10-19T01:00:00Z', ...overrides,
})
let answer: (url: string) => Promise<Response>

beforeAll(() => {
  // jsdom lays nothing out: every marked range sits in the same place, on a stage that holds it.
  Range.prototype.getBoundingClientRect = () => new DOMRect(120, 300, 160, 18)
  Range.prototype.getClientRects = () => [new DOMRect(120, 300, 160, 18)] as unknown as DOMRectList
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 800, 600))
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [new DOMRect(120, 300, 160, 18)] as unknown as DOMRectList)
})
beforeEach(() => {
  window.localStorage.clear()
  forgetAnswersRead()
  answer = (url) => (url.startsWith('/api/files/read')
    ? respond(200, read())
    : respond(200, { path: REPORT, name: 'market-report.md', exists: true, isDir: false, sizeBytes: 2048, modifiedAt: '2026-10-19T01:00:00Z', kind: 'markdown', folder: null, openable: true }))
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => answer(String(input))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const names = new Map([['writer', 'Writer'], ['research', 'Researcher'], ['editor', 'Editor'], ['analyst', 'Analyst'], ['checker', 'Fact-checker'], ['designer', 'Designer'], ['legal', 'Legal']])
const roles = new Map([['research', 'Find the sources.'], ['analyst', '## Numbers\nWork out what the sales figures mean.'], ['legal', 'Check what may be promised.']])
const renderReader = (props: Partial<Parameters<typeof FileReader>[0]> = {}) => {
  const onAsk = vi.fn()
  const onShowAsked = vi.fn()
  const reader = (more: Partial<Parameters<typeof FileReader>[0]>) => <FileReader file={{ path: REPORT, runId: 'run-1', from: 'writer' }} name={(id) => names.get(id) ?? id} hue={() => 2} onAsk={onAsk} onShowAsked={onShowAsked} {...props} {...more} />
  const { rerender } = render(reader({}))
  return { onAsk, onShowAsked, rerender: (more: Partial<Parameters<typeof FileReader>[0]>) => rerender(reader(more)) }
}
const SALES = 'Sales grew 12% in Q3.'
const part = (answer: PassageAnswer, overrides: Partial<AskedPassage> = {}): AskedPassage => ({
  file: REPORT, text: SALES, from: 'writer', asked: '@Writer Explain this part in plain words.', runId: 'run-1', messageId: 'n-1', onItsOwn: true, answer, ...overrides,
})
const answerCard = () => screen.queryByRole('region', { name: "Writer's answer to your question" })

/** Marks `words` on the page as a person would: press, select, let go. */
async function mark(words: string) {
  const paragraph = await screen.findByText(words)
  fireEvent.pointerDown(paragraph)
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.pointerUp(paragraph)
  return screen.findByRole('toolbar', { name: 'Ask Writer about the words you marked' })
}

describe('reading a file an agent made', () => {
  it('reads a report as a document, says who made it, and keeps its own app a click away', async () => {
    renderReader()
    expect(await screen.findByRole('heading', { name: 'Market report', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Market report', level: 3 })).toHaveAttribute('title', REPORT)
    expect(screen.getByText('Markdown · 2.0 KB · changed', { exact: false })).toBeInTheDocument()
    expect(document.querySelector('.rd-from')).toHaveTextContent('Writer')
    expect(screen.getByRole('button', { name: 'Open market-report.md in its own app' })).toBeEnabled()
    expect(screen.getByText('Mark any words')).toBeInTheDocument()
    // Its kind is a label on the sheet's paper, not a second gold fill beside the chat's.
    const kind = document.querySelector('.rd-sheet b')!
    expect(kind).toHaveTextContent('MD')
    expect(isGoldFill(kind)).toBe(false)
  })

  it('shows the pictures a report links to beside it, as they were when it was read, and never one from the web', async () => {
    const stat = answer
    answer = (url) => (url.startsWith('/api/files/read')
      ? respond(200, read({ text: '# Market report\n\n![Sales by month](figures/sales%20chart.svg)\n\n![Logo](file:///teams/.loomwatch/market/logo.png)\n\n![tracker](https://example.com/pixel.png)\n\n![Old chart](figures/gone.png)\n' }))
      : stat(url))
    renderReader()
    const version = `&v=${encodeURIComponent('2026-10-19T01:00:00Z')}`
    const chart = await screen.findByRole('img', { name: 'Sales by month' })
    expect(chart).toHaveAttribute('src', `/api/files/raw?path=${encodeURIComponent('/teams/.loomwatch/market/writer/figures/sales chart.svg')}${version}`)
    expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute('src', `/api/files/raw?path=${encodeURIComponent('/teams/.loomwatch/market/logo.png')}${version}`)
    expect(screen.queryByRole('img', { name: 'tracker' })).toBeNull()
    expect(screen.getByText('[Image: tracker]')).toBeInTheDocument()
    // A picture that isn't there reads as its words.
    fireEvent.error(screen.getByRole('img', { name: 'Old chart' }))
    expect(screen.queryByRole('img', { name: 'Old chart' })).toBeNull()
    expect(screen.getByText('[Image: Old chart]')).toBeInTheDocument()
  })

  it('Ask hands the marked words to the chat as a part of this file, from the agent asked, and lets go of them', async () => {
    const { onAsk } = renderReader()
    const bubble = await mark('Sales grew 12% in Q3.')
    expect(bubble).toHaveTextContent('Ask')
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenCalledWith({ runId: 'run-1', messageId: passageId(REPORT, 'Sales grew 12% in Q3.'), from: 'writer', to: null, kind: 'passage', text: 'Sales grew 12% in Q3.', file: REPORT }, undefined, 'writer')
    expect(document.getSelection()!.isCollapsed).toBe(true)
    expect(screen.queryByRole('toolbar')).toBeNull()
    // The tip has done its work, here and next time.
    expect(screen.queryByText('Mark any words')).toBeNull()
    expect(window.localStorage.getItem('loomwatch.readerHint')).toBe('seen')
  })

  it('Explain asks for the marked words in plain words at once', async () => {
    const { onAsk } = renderReader()
    await mark('Costs fell.')
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ kind: 'passage', text: 'Costs fell.' }), EXPLAIN_WORDS, 'writer')
    // With nobody else on hand, there is nobody else to choose.
    expect(screen.queryByRole('group', { name: 'Or ask someone else' })).toBeNull()
  })

  it('asks the agent who made the file unless another face on the team is pressed', async () => {
    const { onAsk } = renderReader({ team: ['research', 'writer', 'editor'] })
    const bubble = await mark('Sales grew 12% in Q3.')
    const others = within(bubble).getByRole('group', { name: 'Or ask someone else' })
    expect(within(others).getAllByRole('button').map((face) => face.getAttribute('aria-label'))).toEqual(['Ask Researcher instead', 'Ask Editor instead'])
    fireEvent.click(within(others).getByRole('button', { name: 'Ask Researcher instead' }))
    // The face pressed is the one asked; the maker is a press away again.
    const chosen = await screen.findByRole('toolbar', { name: 'Ask Researcher about the words you marked' })
    expect(within(chosen).getAllByRole('button', { name: /instead$/ }).map((face) => face.getAttribute('aria-label'))).toEqual(['Ask Writer, who made this, instead', 'Ask Editor instead'])
    fireEvent.click(within(chosen).getByRole('button', { name: 'Explain' }))
    // Still a part of the Writer's file, asked of the Researcher.
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ kind: 'passage', from: 'writer', text: 'Sales grew 12% in Q3.' }), EXPLAIN_WORDS, 'research')
    // Other words are asked of the maker again.
    await mark('Costs fell.')
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Costs fell.' }), undefined, 'writer')
  })

  it('in a big team, shows a few faces and lists everyone, with what each is for, a press away', async () => {
    const { onAsk } = renderReader({ team: ['research', 'analyst', 'checker', 'writer', 'editor', 'designer', 'legal'], role: (id) => roles.get(id) ?? '' })
    const bubble = await mark('Sales grew 12% in Q3.')
    const others = within(bubble).getByRole('group', { name: 'Or ask someone else' })
    // Three faces in the team's order, then the rest counted.
    expect(within(others).getAllByRole('button', { name: /instead$/ }).map((face) => face.getAttribute('aria-label'))).toEqual(['Ask Researcher instead', 'Ask Analyst instead', 'Ask Fact-checker instead'])
    const more = within(others).getByRole('button', { name: 'Everyone on the team: 3 more' })
    expect(more).toHaveTextContent('+3')
    expect(screen.queryByRole('list', { name: 'Everyone on the team' })).toBeNull()
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list', { name: 'Everyone on the team' })
    expect(within(list).getAllByRole('button').map((row) => row.getAttribute('aria-label'))).toEqual([
      'Ask Researcher instead: Find the sources.',
      'Ask Analyst instead: Work out what the sales figures mean.',
      'Ask Fact-checker instead',
      'Ask Editor instead',
      'Ask Designer instead',
      'Ask Legal instead: Check what may be promised.',
    ])
    fireEvent.click(within(list).getByRole('button', { name: /^Ask Legal instead/ }))
    // The one chosen is asked; the list closes and the maker is the first face, a press back.
    const chosen = await screen.findByRole('toolbar', { name: 'Ask Legal about the words you marked' })
    expect(screen.queryByRole('list', { name: 'Everyone on the team' })).toBeNull()
    expect(within(chosen).getAllByRole('button', { name: /instead$/ }).map((face) => face.getAttribute('aria-label'))).toEqual(['Ask Writer, who made this, instead', 'Ask Researcher instead', 'Ask Analyst instead'])
    fireEvent.click(within(chosen).getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ from: 'writer', text: 'Sales grew 12% in Q3.' }), undefined, 'legal')
  })

  it('Esc lets go of the marked words', async () => {
    renderReader()
    await mark('Costs fell.')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('offers no asking where there is nobody to ask', async () => {
    renderReader({ file: { path: REPORT, runId: null, from: null } })
    const paragraph = await screen.findByText('Costs fell.')
    fireEvent.pointerDown(paragraph)
    document.getSelection()!.selectAllChildren(paragraph)
    fireEvent.pointerUp(paragraph)
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.queryByText('Mark any words')).toBeNull()
  })

  it('marks each part asked about with a bubble from the agent asked, which opens its answer beside the part', async () => {
    const said: PassageAnswer = { state: 'said', by: 'writer', text: 'It means **sales** went up.', at: '2026-10-19T01:05:00Z' }
    const asked: AskedPassage[] = [part(said, { asked: '@Writer why?', runId: 'run-2', messageId: 'm-2', onItsOwn: false }), part(said, { file: '/other.md', text: 'Costs fell.', asked: 'x', runId: 'run-3', messageId: 'm-3' })]
    const { onShowAsked } = renderReader({ asked })
    // An answer given before this browser kept count is one you have read.
    const bubble = await screen.findByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" })
    // On hover, what you asked, without the @ it was sent with.
    expect(bubble).toHaveAttribute('title', 'why?')
    expect(document.querySelectorAll('.rd-bubble')).toHaveLength(1)
    // The part's words are marked in the text, and the bubble sits in the line right after them.
    const marks = [...document.querySelectorAll('.rd-mark')]
    expect(marks.map((mark) => mark.textContent)).toEqual([SALES])
    expect(marks[0]).toHaveClass('read')
    expect(marks[0].nextElementSibling).toHaveClass('rd-slot')
    expect(marks[0].nextElementSibling).toContainElement(bubble)
    expect(document.querySelector('.rd-pin')).toBeNull()
    // A part asked about before the file was opened waits for its bubble to be pressed.
    expect(answerCard()).toBeNull()
    fireEvent.click(bubble)
    const card = answerCard()!
    expect(bubble).toHaveAttribute('aria-expanded', 'true')
    // The answer reads as it does in the chat: its Markdown drawn, not its marks.
    expect(await within(card).findByText('sales', { selector: 'strong' })).toBeInTheDocument()
    expect(card).not.toHaveTextContent('**')
    expect(onShowAsked).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: 'Show it in the chat' }))
    expect(onShowAsked).toHaveBeenCalledWith(asked[0])
    // The bubble closes it again.
    fireEvent.click(bubble)
    expect(answerCard()).toBeNull()
  })

  it('gives each agent asked about the same words its own bubble after them, and its own answer', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString()
    renderReader({ asked: [
      part({ state: 'said', by: 'writer', text: 'Made it bold.', at: '2026-10-19T01:05:00Z' }, { asked: '@Writer bold this text', messageId: 'n-1' }),
      part({ state: 'said', by: 'research', text: 'It means sales rose.', at: soon }, { from: 'research', asked: '@Researcher Explain this part in plain words.', messageId: 'n-2' }),
    ] })
    const writer = await screen.findByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" })
    const researcher = screen.getByRole('button', { name: 'New answer from Researcher about “Sales grew 12% in Q3.”' })
    // The words are marked once, and both bubbles follow them, in the order asked.
    const marks = [...document.querySelectorAll('.rd-mark')]
    expect(marks.map((mark) => mark.textContent)).toEqual([SALES])
    expect([...marks[0].nextElementSibling!.children]).toEqual([writer, researcher])
    // The words wear the answer that waits for you; each bubble its own.
    expect(marks[0]).toHaveClass('waiting')
    expect(writer).toHaveClass('read')
    expect(researcher).toHaveClass('waiting')
    // The words open the answer waiting for you; each bubble opens its own.
    fireEvent.click(marks[0])
    expect(screen.getByRole('region', { name: "Researcher's answer to your question" })).toHaveTextContent('It means sales rose.')
    expect(researcher).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(writer)
    expect(answerCard()).toHaveTextContent('Made it bold.')
    expect(answerCard()!.querySelector('.rd-answer-asked')).toHaveTextContent(/^You asked: bold this text$/)
    expect(writer).toHaveAttribute('aria-expanded', 'true')
    expect(writer).toHaveClass('lit')
    expect(researcher).toHaveAttribute('aria-expanded', 'false')
    expect(researcher).not.toHaveClass('lit')
  })

  it('opens the answer waiting for you from the marked words, though a newer ask is about them too', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString()
    renderReader({ asked: [
      part({ state: 'said', by: 'research', text: 'It means sales rose.', at: soon }, { from: 'research', asked: '@Researcher why?', messageId: 'n-2' }),
      part({ state: 'said', by: 'writer', text: 'Made it bold.', at: '2026-10-19T01:05:00Z' }, { asked: '@Writer bold this text', messageId: 'n-1' }),
    ] })
    await screen.findByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" })
    fireEvent.click(document.querySelector('.rd-mark')!)
    expect(screen.getByRole('region', { name: "Researcher's answer to your question" })).toHaveTextContent('It means sales rose.')
  })

  it('pops up only the new bubble when another agent is asked about words already asked about', async () => {
    const said = part({ state: 'said', by: 'writer', text: 'Made it bold.', at: '2026-10-19T01:05:00Z' }, { asked: '@Writer bold this text', messageId: 'n-1' })
    const { rerender } = renderReader({ asked: [said] })
    const writer = await screen.findByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" })
    rerender({ asked: [said, part({ state: 'sending' }, { from: 'research', asked: '@Researcher Explain this part in plain words.', messageId: null })] })
    // Its answer opens as it is sent, and the first agent's bubble stays as it was.
    expect(screen.getByRole('region', { name: "Researcher's answer to your question" })).toHaveTextContent('Sending your question…')
    const researcher = screen.getByRole('button', { name: 'Researcher is answering your question about “Sales grew 12% in Q3.”' })
    expect(researcher).toHaveClass('fresh')
    expect(writer).not.toHaveClass('fresh')
    expect(screen.getByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" })).toBe(writer)
    expect(document.querySelector('.rd-mark')).toHaveClass('busy')
  })

  it('shows a part asked about with the newer part that overlaps it, its answer beside them', async () => {
    renderReader({ asked: [
      part({ state: 'said', by: 'writer', text: 'Up by twelve.', at: '2026-10-19T01:05:00Z' }, { text: 'Sales grew', asked: '@Writer why?', messageId: 'n-1' }),
      part({ state: 'said', by: 'research', text: 'A good quarter.', at: '2026-10-19T01:06:00Z' }, { text: 'grew 12% in Q3.', from: 'research', asked: '@Researcher why?', messageId: 'n-2' }),
    ] })
    const writer = await screen.findByRole('button', { name: "Writer's answer about “Sales grew”" })
    const researcher = screen.getByRole('button', { name: "Researcher's answer about “grew 12% in Q3.”" })
    expect([...document.querySelectorAll('.rd-mark')].map((mark) => mark.textContent)).toEqual(['grew 12% in Q3.'])
    expect([...document.querySelector('.rd-slot')!.children]).toEqual([writer, researcher])
    fireEvent.click(writer)
    expect(answerCard()).toHaveTextContent('Up by twelve.')
    expect(answerCard()).not.toHaveClass('gone')
    // It points at the newer part's words, so it says which words it is about.
    expect(answerCard()!.querySelector('.rd-answer-about')).toHaveTextContent('About “Sales grew”')
    fireEvent.click(researcher)
    expect(screen.getByRole('region', { name: "Researcher's answer to your question" }).querySelector('.rd-answer-about')).toBeNull()
  })

  it('opens the card of the agent whose bubble is pointed at, as the chat does, with what you asked it', async () => {
    const facts = (id: string, name: string, role: string): AgentFacts => ({ id, name, hue: 2, state: 'idle', stateWords: 'ready', model: 'Claude Sonnet 5.5', role, step: null, skills: 0, tools: 0, knowledge: 0 })
    renderReader({
      faces: [facts('writer', 'Writer', 'Writes the report.'), facts('research', 'Researcher', 'Finds the sources.')],
      asked: [
        part({ state: 'said', by: 'writer', text: 'Made it bold.', at: '2026-10-19T01:05:00Z' }, { asked: '@Writer bold this text', messageId: 'n-1' }),
        part({ state: 'said', by: 'research', text: 'It means sales rose.', at: '2026-10-19T01:06:00Z' }, { from: 'research', asked: '@Researcher why?', messageId: 'n-2' }),
      ],
    })
    const researcher = await screen.findByRole('button', { name: "Researcher's answer about “Sales grew 12% in Q3.”" })
    // The card says who the agent is; the page's own tooltip would cover it.
    expect(researcher).not.toHaveAttribute('title')
    fireEvent.pointerEnter(researcher, { pointerType: 'mouse' })
    // Not at once: only once the pointer has rested on the bubble.
    expect(screen.queryByRole('tooltip')).toBeNull()
    const card = await screen.findByRole('tooltip')
    expect(card).toHaveTextContent('Researcher')
    expect(card).toHaveTextContent('Finds the sources.')
    expect(card.querySelector('.tc-agent-card-asked')).toHaveTextContent(/^You asked: why\?$/)
    expect(card).not.toHaveTextContent('Click to mention')
    expect(researcher).toHaveAttribute('aria-describedby', card.id)
    fireEvent.pointerLeave(researcher)
    fireEvent.mouseLeave(researcher)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    // Passing over a bubble on the way somewhere else opens nothing.
    const writer = screen.getByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" })
    fireEvent.pointerEnter(writer, { pointerType: 'mouse' })
    fireEvent.mouseLeave(writer)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByRole('tooltip')).toBeNull()
    // Reached with the keyboard, the card opens at once; pressing the bubble opens the answer instead.
    fireEvent.focus(writer)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Writer')
    expect(screen.getByRole('tooltip')).toHaveTextContent('You asked: bold this text')
    fireEvent.click(writer)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(answerCard()).toHaveTextContent('Made it bold.')
  })


  it('shows the agent at work in the bubble, then a dot until the answer is read, here and next time', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString()
    const { rerender } = renderReader({ asked: [part({ state: 'writing', by: 'writer' })] })
    const look = () => document.querySelector('.rd-mark')!.className
    expect(await screen.findByRole('button', { name: 'Writer is answering your question about “Sales grew 12% in Q3.”' })).toHaveAttribute('title', 'Writer is writing · Explain this part in plain words.')
    expect(look()).toContain('busy')
    expect(document.querySelector('.rd-bubble .chat-dots')).not.toBeNull()
    rerender({ asked: [part({ state: 'said', by: 'writer', text: 'Up by twelve.', at: soon })] })
    const waiting = screen.getByRole('button', { name: 'New answer from Writer about “Sales grew 12% in Q3.”' })
    expect(waiting).toHaveAttribute('title', 'New answer · Explain this part in plain words.')
    expect(look()).toContain('waiting')
    expect(waiting.querySelector('.rd-bubble-new')).not.toBeNull()
    fireEvent.click(waiting)
    expect(answerCard()).toHaveTextContent('Up by twelve.')
    expect(look()).toContain('read')
    expect(document.querySelector('.rd-bubble-new')).toBeNull()
    // Read is kept in this browser: opened again, the answer has no dot.
    cleanup()
    forgetAnswersRead()
    renderReader({ asked: [part({ state: 'said', by: 'writer', text: 'Up by twelve.', at: soon })] })
    expect(await screen.findByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" })).toBeInTheDocument()
  })

  it('opens the answer beside the part as the question is sent, and fills it in when the agent answers', async () => {
    const { rerender } = renderReader()
    await mark(SALES)
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))
    expect(answerCard()).toBeNull()
    // The chat says the question is on its way, then that the agent is writing, then what it said.
    rerender({ asked: [part({ state: 'sending' }, { messageId: null })] })
    expect(answerCard()).toHaveTextContent('Sending your question…')
    expect(within(answerCard()!).getByLabelText('Sending your question')).toBeInTheDocument()
    rerender({ asked: [part({ state: 'writing', by: 'writer' })] })
    expect(answerCard()).toHaveTextContent('is writing')
    expect(within(answerCard()!).getByLabelText('Writer is writing')).toBeInTheDocument()
    rerender({ asked: [part({ state: 'said', by: 'writer', text: 'It means **sales** went up.', at: '2026-10-19T01:05:00Z' })] })
    expect(await within(answerCard()!).findByText('sales', { selector: 'strong' })).toBeInTheDocument()
    // Over the answer, what you asked, as a comment's words: without the @ it was sent with.
    expect(answerCard()!.querySelector('.rd-answer-asked')).toHaveTextContent(/^You asked: Explain this part in plain words\.$/)
  })

  it('keeps the answer when the agent changed the words it was asked about, at the top of the file', async () => {
    const { rerender } = renderReader()
    await screen.findByText(SALES)
    // You asked for the part to change; the work changed it, so the file no longer has those words.
    rerender({ asked: [part({ state: 'sending' }, { text: 'Sales rose 12 percent.', asked: '@Writer say it shorter', messageId: null })] })
    rerender({ asked: [part({ state: 'said', by: 'writer', text: 'Done: it is shorter now.', at: null }, { text: 'Sales rose 12 percent.', asked: '@Writer say it shorter', onItsOwn: false })] })
    const card = answerCard()!
    expect(card).toHaveTextContent('Done: it is shorter now.')
    expect(card).toHaveClass('gone')
    // Said on a line of its own, not folded into what you asked.
    expect(card.querySelector('.rd-answer-asked')).toHaveTextContent(/^You asked: say it shorter$/)
    expect(card.querySelector('.rd-answer-gone')).toHaveTextContent('The words you marked have changed.')
    expect(card.style).toMatchObject({ top: '12px', visibility: '' })
  })

  it('opens a part’s answer from its lit words, and closes it on Esc or the close button', async () => {
    renderReader({ asked: [part({ state: 'said', by: 'writer', text: 'Up by twelve.', at: '2026-10-19T01:05:00Z' })] })
    await screen.findByRole('heading', { name: 'Market report', level: 1 })
    document.getSelection()!.removeAllRanges()
    // Away from the marked words: nothing.
    fireEvent.click(screen.getByText('Costs fell.'))
    expect(answerCard()).toBeNull()
    const words = await waitFor(() => document.querySelector('.rd-mark')!)
    fireEvent.click(words)
    expect(answerCard()).toHaveTextContent('Up by twelve.')
    // Esc closes the answer, and goes no further: the pane the file is in closes on Esc too.
    const pane = vi.fn()
    window.addEventListener('keydown', pane)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', pane)
    expect(answerCard()).toBeNull()
    expect(pane).not.toHaveBeenCalled()
    fireEvent.click(words)
    fireEvent.click(within(answerCard()!).getByRole('button', { name: 'Close the answer' }))
    expect(answerCard()).toBeNull()
  })

  it('Reply under an answer writes back about the same part to the agent that answered, and the talk reads down from the first question', async () => {
    const first = part({ state: 'said', by: 'research', text: 'A claim is a sentence that could be wrong.', at: '2026-10-19T01:05:00Z' }, { from: 'research', asked: '@Researcher what is a claim?', messageId: 'n-1' })
    const { onAsk, rerender } = renderReader({ asked: [first] })
    fireEvent.click(await screen.findByRole('button', { name: "Researcher's answer about “Sales grew 12% in Q3.”" }))
    const card = () => screen.getByRole('region', { name: "Researcher's answer to your question" })
    fireEvent.click(within(card()).getByRole('button', { name: 'Reply to Researcher' }))
    // The part again, from the agent who made the file, asked of the agent who answered: written in the message box, as Ask is.
    expect(onAsk).toHaveBeenCalledWith({ runId: 'run-1', messageId: passageId(REPORT, SALES), from: 'writer', to: null, kind: 'passage', text: SALES, file: REPORT }, undefined, 'research')
    expect(card()).toBeInTheDocument()

    // Sent, it is one more ask about the part: the answer to it comes under the talk before it.
    const next = (answer: PassageAnswer, messageId: string | null) => part(answer, { from: 'research', asked: '@Researcher an example?', messageId })
    rerender({ asked: [first, next({ state: 'sending' }, null)] })
    const asked = () => [...card().querySelectorAll('.rd-answer-asked')].map((line) => line.textContent)
    expect(asked()).toEqual(['You asked: what is a claim?', 'You asked: an example?'])
    expect(card()).toHaveTextContent('A claim is a sentence that could be wrong.')
    expect(within(card()).getByLabelText('Sending your question')).toBeInTheDocument()
    expect(document.querySelectorAll('.rd-bubble')).toHaveLength(1)
    // Nothing to reply to until it has answered.
    expect(within(card()).queryByRole('button', { name: 'Reply to Researcher' })).toBeNull()
    rerender({ asked: [first, next({ state: 'said', by: 'research', text: 'Sales grew **12%**.', at: '2026-10-19T01:07:00Z' }, 'n-2')] })
    expect(await within(card()).findByText('12%', { selector: 'strong' })).toBeInTheDocument()
    expect(asked()).toEqual(['You asked: what is a claim?', 'You asked: an example?'])
    expect(within(card()).getByRole('button', { name: 'Reply to Researcher' })).toBeInTheDocument()
  })

  it('shows an earlier question still being answered at work, under the newer one’s sending', async () => {
    const { rerender } = renderReader({ asked: [part({ state: 'writing', by: 'writer' }, { asked: '@Writer why?', messageId: 'n-1' })] })
    await screen.findByRole('button', { name: 'Writer is answering your question about “Sales grew 12% in Q3.”' })
    rerender({ asked: [part({ state: 'writing', by: 'writer' }, { asked: '@Writer why?', messageId: 'n-1' }), part({ state: 'sending' }, { asked: '@Writer and how?', messageId: null })] })
    const turn = answerCard()!.querySelector('.rd-answer-turn') as HTMLElement
    expect(turn).toHaveTextContent('why?')
    expect(within(turn).getByLabelText('Writer is writing')).toBeInTheDocument()
    expect(within(answerCard()!).getByLabelText('Sending your question')).toBeInTheDocument()
  })

  it('keeps the talk with each agent apart, and offers no Reply where nothing can be sent', async () => {
    renderReader({ onAsk: undefined, asked: [
      part({ state: 'said', by: 'writer', text: 'Made it bold.', at: '2026-10-19T01:05:00Z' }, { asked: '@Writer bold this text', messageId: 'n-1' }),
      part({ state: 'said', by: 'research', text: 'It means sales rose.', at: '2026-10-19T01:06:00Z' }, { from: 'research', asked: '@Researcher why?', messageId: 'n-2' }),
      part({ state: 'said', by: 'writer', text: 'Done.', at: '2026-10-19T01:07:00Z' }, { file: '/other.md', asked: '@Writer bold this text', messageId: 'n-3' }),
    ] })
    fireEvent.click(await screen.findByRole('button', { name: "Writer's answer about “Sales grew 12% in Q3.”" }))
    expect([...answerCard()!.querySelectorAll('.rd-answer-asked')].map((line) => line.textContent)).toEqual(['You asked: bold this text'])
    expect(within(answerCard()!).queryByRole('button', { name: /^Reply/ })).toBeNull()
  })

  it('says when the work stopped, or nothing came back', async () => {
    const { rerender } = renderReader({ asked: [part({ state: 'failed', by: 'writer', text: 'The AI could not be reached.' })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Writer didn’t finish answering about “Sales grew 12% in Q3.”' }))
    expect(screen.getByRole('button', { name: 'Writer didn’t finish answering about “Sales grew 12% in Q3.”' })).toHaveAttribute('title', 'Didn’t finish · Explain this part in plain words.')
    expect(document.querySelector('.rd-mark')).toHaveClass('failed')
    expect(answerCard()).toHaveTextContent('stopped')
    expect(answerCard()).toHaveTextContent('The AI could not be reached.')
    rerender({ asked: [part({ state: 'none', why: 'lost' })] })
    expect(answerCard()).toHaveTextContent('No answer came back.')
    rerender({ asked: [part({ state: 'none', why: 'passed' })] })
    expect(answerCard()).toHaveTextContent('Writer had nothing to add.')
    // With nothing to read, the way on is said in words.
    expect(within(answerCard()!).getByRole('button', { name: 'Show it in the chat' })).toHaveTextContent('Show it in the chat')
  })

  it('says a document’s words are its text without its layout, when its pages can’t be made', async () => {
    // As without LibreOffice (ADR 0091): a Word document is otherwise shown as its pages.
    pdfState.fail = true
    try {
      answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: '/w/brief.docx', name: 'brief.docx', kind: 'document', text: 'Brief\n\nWe sell tea.', extracted: true })) : respond(404, {}))
      renderReader({ file: { path: '/w/brief.docx', runId: 'run-1', from: 'writer' } })
      expect(await screen.findByText(/These are the words of the Word document, as your agents read them/)).toBeInTheDocument()
      expect(screen.getByText(/Words from a Word document/)).toBeInTheDocument()
      expect(document.querySelector('.rd-doc-heading')).toHaveTextContent('Brief')
      expect(screen.getByText('We sell tea.')).toBeInTheDocument()
    } finally {
      pdfState.fail = false
    }
  })

  it('reads a table as a sheet', async () => {
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: '/w/sales.csv', name: 'sales.csv', kind: 'spreadsheet', text: 'month,sales\nMay,12\nJune,15\n' })) : respond(404, {}))
    renderReader({ file: { path: '/w/sales.csv', runId: 'run-1', from: 'writer' } })
    expect(await screen.findByRole('columnheader', { name: 'sales' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '15' })).toHaveClass('num')
  })

  it('says why a file can’t be read, in the daemon’s words', async () => {
    answer = () => respond(403, { error: '/etc/x.md is outside the folders your teams use, so LoomWatch will not open it' })
    renderReader({ file: { path: '/etc/x.md', runId: null, from: 'writer' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('outside the folders your teams use')
  })

  it('reads the file again when it changes on disk, and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let modifiedAt = '2026-10-19T01:00:00Z'
      let text = '# Market report\n\nSales grew 12% in Q3.\n'
      answer = (url) => (url.startsWith('/api/files/read')
        ? respond(200, read({ text, modifiedAt }))
        : respond(200, { path: REPORT, name: 'market-report.md', exists: true, isDir: false, sizeBytes: 2048, modifiedAt, kind: 'markdown', folder: null, openable: true }))
      renderReader()
      expect(await screen.findByText('Sales grew 12% in Q3.')).toBeInTheDocument()
      modifiedAt = '2026-10-19T01:05:00Z'
      text = '# Market report\n\nSales grew 14% in Q3.\n'
      await act(() => vi.advanceTimersByTimeAsync(3_100))
      expect(await screen.findByText('Sales grew 14% in Q3.')).toBeInTheDocument()
      expect(screen.getByText('Updated just now')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ADR 0091: a part of a picture is a box on it, asked about as words are.
describe('a picture in the reader', () => {
  const CHART = '/teams/.loomwatch/market/writer/chart.png'
  const TOP_RIGHT = { kind: 'box' as const, x: 5000, y: 0, w: 5000, h: 5000 }
  let drawn: number[][] = []
  beforeEach(() => {
    drawn = []
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1600)
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(900)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (...args: unknown[]) => { drawn.push(args.slice(1, 5) as number[]) } }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['png'], { type: 'image/png' })))
  })
  const picture = () => document.querySelector<HTMLElement>('.rd-picture-frame')!
  /** Presses on the picture at (x, y) and lets go at (toX, toY): the frame is 800 by 600 in jsdom. */
  const drag = (target: Element, x: number, y: number, toX = x, toY = y) => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: x, clientY: y })
    fireEvent.pointerMove(picture(), { pointerId: 1, clientX: toX, clientY: toY })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: toX, clientY: toY })
  }
  /** What is marked stays marked once the browser has had its turn (a click's own work runs after it). */
  const settle = () => act(() => new Promise((done) => { setTimeout(done, 20) }))

  it('marks a box dragged over it, or all of it for a click, and sends the part’s place with the picture inside it', async () => {
    const { onAsk } = renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' } })
    await screen.findByText('Drag over any part')
    drag(picture(), 200, 0, 600, 300)
    expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the part you marked' })).toBeInTheDocument()
    await settle()
    expect(screen.getByRole('toolbar', { name: 'Ask Writer about the part you marked' })).toBeInTheDocument()
    expect(document.querySelector('.rd-box.marking')).toHaveStyle({ left: '25%', top: '0%', width: '50%', height: '50%' })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const top = { kind: 'box', x: 2500, y: 0, w: 5000, h: 5000 }
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(
      { runId: 'run-1', messageId: passageId(CHART, 'The top of the picture', top as typeof TOP_RIGHT), from: 'writer', to: null, kind: 'passage', text: 'The top of the picture', file: CHART, at: top },
      undefined, 'writer', [expect.any(File)],
    ))
    // What is sent is the box cut out of the picture at its own size: 1600 by 900 here.
    expect(drawn).toEqual([[400, 0, 800, 450]])
    const [sent] = onAsk.mock.lastCall![3] as File[]
    expect(sent.name).toBe('chart part.png')
    expect(sent.type).toBe('image/png')
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(document.querySelector('.rd-box.marking')).toBeNull()

    // A click marks all of it; Explain asks at once.
    drag(picture(), 400, 300)
    await screen.findByRole('toolbar', { name: 'Ask Writer about the part you marked' })
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))
    await waitFor(() => expect(onAsk).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'All of the picture', at: { kind: 'box', x: 0, y: 0, w: 10000, h: 10000 } }), EXPLAIN_WORDS, 'writer', [expect.any(File)],
    ))
    expect(drawn.at(-1)).toEqual([0, 0, 1600, 900])
  })

  it('takes a press that slips a little as a click, not a sliver of the picture', async () => {
    renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' } })
    await screen.findByText('Drag over any part')
    drag(picture(), 100, 100, 300, 108)
    await screen.findByRole('toolbar')
    expect(document.querySelector('.rd-box.marking')).toHaveClass('whole')
  })

  it('lets go of the marked box on Esc or a press anywhere else, and a picture with nobody to ask marks nothing', async () => {
    renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' } })
    await screen.findByText('Drag over any part')
    drag(picture(), 100, 100, 300, 200)
    await screen.findByRole('toolbar')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(document.querySelector('.rd-box')).toBeNull()
    drag(picture(), 100, 100, 300, 200)
    await screen.findByRole('toolbar')
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('toolbar')).toBeNull()
    cleanup()
    renderReader({ file: { path: CHART, runId: null, from: null } })
    await waitFor(() => expect(picture()).toBeInTheDocument())
    drag(picture(), 100, 100, 300, 200)
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.queryByText('Drag over any part')).toBeNull()
  })

  it('is marked from the keyboard, which goes on to Ask, and its bubbles are not inside the picture’s button', async () => {
    const asked = [part({ state: 'said', by: 'writer', text: 'Yes.', at: null }, { file: CHART, text: 'The top right of the picture', at: TOP_RIGHT })]
    renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' }, asked })
    const target = await screen.findByRole('button', { name: 'Ask about Chart' })
    expect(target.querySelector('.rd-bubble')).toBeNull()
    target.focus()
    fireEvent.keyDown(target, { key: 'Enter' })
    await screen.findByRole('toolbar', { name: 'Ask Writer about the part you marked' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ask' })).toHaveFocus())
  })

  it('shows its own tip to a person who has only marked words', async () => {
    window.localStorage.setItem('loomwatch.readerHint', 'seen')
    renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' } })
    expect(await screen.findByText('Drag over any part')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide this tip' }))
    expect(screen.queryByText('Drag over any part')).toBeNull()
    expect(window.localStorage.getItem('loomwatch.readerHint.picture')).toBe('seen')
  })

  it('draws each box asked about, the smaller over the larger, with the bubble of the agent asked at its corner, and opens its answer from either', async () => {
    const asked = [
      part({ state: 'said', by: 'writer', text: 'The legend sits there.', at: null }, { file: CHART, text: 'The top right of the picture', at: TOP_RIGHT }),
      part({ state: 'said', by: 'writer', text: 'A chart of sales.', at: null }, { file: CHART, text: 'The whole picture', at: { kind: 'box', x: 0, y: 0, w: 10000, h: 10000 }, messageId: 'n-2' }),
    ]
    renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' }, asked })
    // An answer given before this browser kept count is one you have read.
    const bubble = await screen.findByRole('button', { name: "Writer's answer about “The top right of the picture”" })
    const boxes = [...document.querySelectorAll<HTMLElement>('.rd-box[data-part]')]
    expect(boxes.map((box) => box.style.width)).toEqual(['100%', '50%'])
    const small = boxes[1]
    expect(small).toHaveStyle({ left: '50%', top: '0%', width: '50%', height: '50%' })
    expect(small).toHaveClass('read')
    expect(small.contains(bubble)).toBe(true)
    fireEvent.click(bubble)
    expect(answerCard()).toHaveTextContent('The legend sits there.')
    fireEvent.click(screen.getByRole('button', { name: 'Close the answer' }))
    expect(answerCard()).toBeNull()
    // A click on the box itself opens it too, and marks nothing.
    drag(small, 500, 100)
    expect(answerCard()).toHaveTextContent('The legend sits there.')
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('Reply under a box’s answer asks about the same box again, with its picture', async () => {
    const asked = [part({ state: 'said', by: 'writer', text: 'The legend sits there.', at: null }, { file: CHART, text: 'The top right of the picture', at: TOP_RIGHT })]
    const { onAsk } = renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' }, asked })
    fireEvent.click(await screen.findByRole('button', { name: "Writer's answer about “The top right of the picture”" }))
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Writer' }))
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'The top right of the picture', at: TOP_RIGHT, file: CHART }), undefined, 'writer', [expect.any(File)],
    ))
    expect(drawn).toEqual([[800, 0, 800, 450]])
  })

  it('tells the box being written about in the message box from the others', async () => {
    const asked = [part({ state: 'said', by: 'writer', text: 'Yes.', at: null }, { file: CHART, text: 'The top right of the picture', at: TOP_RIGHT })]
    renderReader({ file: { path: CHART, runId: 'run-1', from: 'writer' }, asked, asking: 'The top right of the picture\u0001box:5000,0,5000,5000' })
    await waitFor(() => expect(document.querySelector('.rd-box[data-part]')?.className).toContain('asking'))
  })
})

// ADR 0091: cells of a sheet are asked about by dragging across them.
// ADR 0091: cells of a sheet are asked about by dragging across them.
describe('a sheet in the reader', () => {
  const SALES = '/teams/.loomwatch/market/writer/sales.csv'
  const BOOK = '/teams/.loomwatch/market/writer/sales.xlsx'
  const csv = 'Region,Q1,Q2\nWest,120,140\nEast,80,95\nNorth,60,75\n'
  const workbook = 'Sheet 1 of 3: Summary (2 rows, 2 columns)\nTotal\t570\nRegions\t3\n\nSheet 2 of 3: By region (3 rows, 2 columns, from cell B2)\nRegion\tSales\nWest\t260\nEast\t175\n\nSheet 3 of 3: Chart (not a table of cells)\n'
  const reading = (path: string, text: string, extra: Record<string, unknown> = {}) => {
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path, name: path.split('/').pop(), kind: 'spreadsheet', text, ...extra })) : respond(200, { path, exists: true, isDir: false, sizeBytes: 100, modifiedAt: '2026-10-19T01:00:00Z', kind: 'spreadsheet', folder: null, openable: true }))
  }
  const cell = (row: number, column: number) => document.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)!
  const grid = () => document.querySelector<HTMLElement>('.rd-grid')!
  /** Presses on one place and lets go on another, as a person drags across a sheet. */
  const dragCells = (from: HTMLElement, to: HTMLElement) => {
    let over: Element = from
    const was = document.elementFromPoint
    document.elementFromPoint = () => over
    fireEvent.pointerDown(from, { button: 0, pointerId: 1 })
    over = to
    fireEvent.pointerMove(grid(), { pointerId: 1 })
    fireEvent.pointerUp(grid(), { pointerId: 1 })
    document.elementFromPoint = was
  }

  it('marks the cells dragged across, and asks about them as their words with their column and row names', async () => {
    reading(SALES, csv)
    const { onAsk } = renderReader({ file: { path: SALES, runId: 'run-1', from: 'writer' } })
    expect(await screen.findByText('Drag across any cells')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Q1' })).toBeInTheDocument()
    dragCells(cell(2, 2), cell(3, 3))
    expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the cells you marked' })).toBeInTheDocument()
    // Still marked once the browser has had its turn: nothing reads a selection of words here.
    await act(() => new Promise((done) => { setTimeout(done, 20) }))
    expect(screen.getByRole('toolbar', { name: 'Ask Writer about the cells you marked' })).toBeInTheDocument()
    expect(document.querySelector('.rd-range.marking')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const at = { kind: 'cells', top: 2, left: 2, bottom: 3, right: 3 }
    const text = 'Region\tQ1\tQ2\nWest\t120\t140\nEast\t80\t95'
    expect(onAsk).toHaveBeenCalledWith(
      { runId: 'run-1', messageId: passageId(SALES, text, at as never), from: 'writer', to: null, kind: 'passage', text, file: SALES, at },
      undefined, 'writer',
    )
    expect(document.querySelector('.rd-range.marking')).toBeNull()
  })

  it('marks whole columns from their names and whole rows from their numbers, by press or by drag, never the names’ row', async () => {
    reading(SALES, csv)
    const { onAsk } = renderReader({ file: { path: SALES, runId: 'run-1', from: 'writer' } })
    await screen.findByText('Drag across any cells')
    const q2 = screen.getByRole('columnheader', { name: 'Q2' })
    dragCells(q2, q2)
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Region\tQ2\nWest\t140\nEast\t95\nNorth\t75', at: { kind: 'cells', top: 2, left: 3, bottom: 4, right: 3 } }), EXPLAIN_WORDS, 'writer')
    dragCells(screen.getByRole('columnheader', { name: 'Q1' }), q2)
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ at: { kind: 'cells', top: 2, left: 2, bottom: 4, right: 3 } }), EXPLAIN_WORDS, 'writer')
    dragCells(screen.getByRole('rowheader', { name: '3' }), screen.getByRole('rowheader', { name: '3' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Region\tQ1\tQ2\nEast\t80\t95', at: { kind: 'cells', top: 3, left: 1, bottom: 3, right: 3 } }), EXPLAIN_WORDS, 'writer')
    dragCells(screen.getByRole('rowheader', { name: '2' }), screen.getByRole('rowheader', { name: '4' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ at: { kind: 'cells', top: 2, left: 1, bottom: 4, right: 3 } }), EXPLAIN_WORDS, 'writer')
    // A drag into the column names stops at the first row under them.
    dragCells(cell(3, 2), screen.getByRole('columnheader', { name: 'Q1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ at: { kind: 'cells', top: 2, left: 2, bottom: 3, right: 2 } }), EXPLAIN_WORDS, 'writer')
  })

  it('marks a whole column or row from the keyboard, and copies the marked cells', async () => {
    reading(SALES, csv)
    renderReader({ file: { path: SALES, runId: 'run-1', from: 'writer' } })
    await screen.findByText('Drag across any cells')
    const column = within(screen.getByRole('columnheader', { name: 'Q1' })).getByRole('button', { name: 'Q1' })
    expect(column).toHaveAttribute('title', 'Mark the whole column')
    // A press from the keyboard is a click with no count.
    fireEvent.click(column, { detail: 0 })
    await screen.findByRole('toolbar', { name: 'Ask Writer about the cells you marked' })
    let copied = ''
    const event = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: { setData: (type: string, value: string) => void } }
    event.clipboardData = { setData: (_type, value) => { copied = value } }
    document.dispatchEvent(event)
    expect(copied).toBe('120\n80\n60')
    expect(event.defaultPrevented).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(screen.getByRole('rowheader', { name: '4' })).getByRole('button', { name: '4' }), { detail: 0 })
    await screen.findByRole('toolbar', { name: 'Ask Writer about the cells you marked' })
    // A mouse's click is the press already handled: it marks nothing more.
    fireEvent.click(column, { detail: 1 })
    expect(document.querySelectorAll('.rd-range.marking')).toHaveLength(1)
  })

  it('draws each range asked about with the bubble of the agent asked beside it, in the page’s lightness, and a press on its cells opens the answer', async () => {
    reading(SALES, csv)
    const at = { kind: 'cells' as const, top: 2, left: 2, bottom: 3, right: 3 }
    const asked = [part({ state: 'said', by: 'writer', text: 'West sold most.', at: null }, { file: SALES, text: 'Region\tQ1\tQ2\nWest\t120\t140\nEast\t80\t95', at })]
    renderReader({ file: { path: SALES, runId: 'run-1', from: 'writer' }, asked })
    // Quoted with its rows kept.
    const bubble = await screen.findByRole('button', { name: "Writer's answer about “Region, Q1, Q2 · West, 120, 140 · East, 80, 95”" })
    expect(document.querySelector('.rd-range[data-part]')?.contains(bubble)).toBe(true)
    expect(document.querySelector('.rd-range[data-part] > .rd-slot')).not.toHaveClass('on-dark')
    dragCells(cell(3, 2), cell(3, 2))
    expect(answerCard()).toHaveTextContent('West sold most.')
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('gives a range’s bubble the dark look on a dark page, as words’ bubbles have', async () => {
    reading(SALES, csv)
    const at = { kind: 'cells' as const, top: 2, left: 2, bottom: 2, right: 2 }
    const asked = [part({ state: 'said', by: 'writer', text: 'Yes.', at: null }, { file: SALES, text: 'Region\tQ1\nWest\t120', at })]
    document.body.style.backgroundColor = 'rgb(12, 12, 14)'
    try {
      renderReader({ file: { path: SALES, runId: 'run-1', from: 'writer' }, asked })
      await waitFor(() => expect(document.querySelector('.rd-range[data-part] > .rd-slot')).toHaveClass('on-dark'))
    } finally {
      document.body.style.backgroundColor = ''
    }
  })

  it('keeps marking the words asked about in a table before its cells could be marked', async () => {
    reading(SALES, csv)
    const asked = [part({ state: 'said', by: 'writer', text: 'Up.', at: null }, { file: SALES, text: 'North' })]
    renderReader({ file: { path: SALES, runId: 'run-1', from: 'writer' }, asked })
    await waitFor(() => expect([...document.querySelectorAll('.rd-mark')].map((mark) => mark.textContent)).toEqual(['North']))
  })

  it('draws a workbook as its sheets, each from its first cell, with its tabs above the sheet, and shows the sheet of an answer that opens', async () => {
    reading(BOOK, workbook, { extracted: true })
    const { onAsk, rerender } = renderReader({ file: { path: BOOK, runId: 'run-1', from: 'writer' } })
    const summary = await screen.findByRole('tab', { name: 'Summary', selected: true })
    // The tabs sit above the scrolling sheet, so they never scroll away.
    expect(summary.closest('.rd-scroll')).toBeNull()
    expect(summary.closest('.rd-sheet-bar')).not.toBeNull()
    expect(screen.queryByText(/without the layout/)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Chart' }))
    expect(screen.getByText('There are no cells on this sheet to show here. Open it in its own app to see it.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'By region' }))
    expect(screen.getByRole('columnheader', { name: 'Sales' })).toBeInTheDocument()
    // The sheet starts at B2: its cells are named by the sheet's own rows and columns.
    dragCells(cell(3, 2), cell(4, 3))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Region\tSales\nWest\t260\nEast\t175', at: { kind: 'cells', sheet: 'By region', top: 3, left: 2, bottom: 4, right: 3 } }), EXPLAIN_WORDS, 'writer',
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }))
    // Asked about cells on the other sheet: their answer opens on their sheet.
    const at = { kind: 'cells' as const, sheet: 'By region', top: 3, left: 2, bottom: 4, right: 3 }
    rerender({ asked: [part({ state: 'sending' }, { file: BOOK, text: 'Region\tSales\nWest\t260\nEast\t175', at })] })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'By region, with cells asked about', selected: true })).toBeInTheDocument())
    expect(answerCard()).not.toBeNull()
    // From another sheet, its tab says it holds cells asked about.
    fireEvent.click(screen.getByRole('button', { name: 'Close the answer' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }))
    expect(screen.getByRole('tab', { name: 'By region, with cells asked about', selected: false })).toHaveAttribute('title', 'Has cells you asked about')
    expect(screen.getByRole('tab', { name: 'Summary' }).querySelector('.rd-sheet-asked')).toBeNull()
  })

  it('shows the bubbles of cells asked about on another sheet once its tab is chosen', async () => {
    reading(BOOK, workbook, { extracted: true })
    const at = { kind: 'cells' as const, sheet: 'By region', top: 3, left: 2, bottom: 4, right: 3 }
    const asked = [part({ state: 'said', by: 'writer', text: 'East sold less.', at: null }, { file: BOOK, text: 'Region\tSales\nWest\t260\nEast\t175', at })]
    renderReader({ file: { path: BOOK, runId: 'run-1', from: 'writer' }, asked })
    await screen.findByRole('tab', { name: 'Summary', selected: true })
    expect(screen.queryByRole('button', { name: /^Writer's answer about/ })).toBeNull()
    // In a tab in the background no frame is drawn: the bubbles can't wait for one.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    fireEvent.click(screen.getByRole('tab', { name: 'By region, with cells asked about' }))
    const bubble = await screen.findByRole('button', { name: /^Writer's answer about “By region/ })
    expect(document.querySelector('.rd-range[data-part]')?.contains(bubble)).toBe(true)
    vi.mocked(window.requestAnimationFrame).mockRestore()
  })

  it('says once that a workbook too big to read whole is cut', async () => {
    reading(BOOK, workbook, { extracted: true, truncated: true })
    renderReader({ file: { path: BOOK, runId: 'run-1', from: 'writer' } })
    expect(await screen.findByText('This workbook is too big to show whole here. Open it in its own app for the rest.')).toBeInTheDocument()
    expect(screen.queryByText(/rows are shown/)).toBeNull()
  })
})

// ADR 0091: a moment, a span or a box on a frame of a recording is asked about from its line.
describe('a recording in the reader', () => {
  const TALK = '/teams/.loomwatch/market/writer/talk.mp4'
  const SONG = '/teams/.loomwatch/market/writer/song.mp3'
  let drawn: number[][] = []
  let times = new WeakMap<HTMLMediaElement, number>()
  let seeks: [HTMLMediaElement, number][] = []
  /** Where the recording on screen was sent, in seconds, in order. */
  const seeksOf = (media: HTMLMediaElement) => seeks.filter(([each]) => each === media).map(([, value]) => value)
  beforeEach(() => {
    drawn = []
    times = new WeakMap()
    seeks = []
    answer = (url) => respond(200, { path: TALK, exists: true, isDir: false, sizeBytes: 9_000_000, modifiedAt: '2026-10-19T01:00:00Z', kind: 'media', folder: null, openable: true, url })
    // jsdom plays nothing: a minute-long recording that goes where it is told.
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(60)
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(true)
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(function (this: HTMLMediaElement) { return times.get(this) ?? 0 })
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(function (this: HTMLMediaElement, value: number) {
      times.set(this, value)
      seeks.push([this, value])
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')))
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (...args: unknown[]) => { drawn.push(args.slice(1, 5) as number[]) } }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['png'], { type: 'image/png' })))
  })
  const line = () => document.querySelector<HTMLElement>('.rd-media-line')!
  /** Presses on the line at x and lets go at toX: the line is 800 wide in jsdom, a minute long. */
  const slide = (target: Element, x: number, toX = x) => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: x, clientY: 10 })
    fireEvent.pointerMove(line(), { pointerId: 1, clientX: toX, clientY: 10 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: toX, clientY: 10 })
  }

  it('marks the moment pressed on its line, goes there, and sends its frame with the question', async () => {
    const { onAsk } = renderReader({ file: { path: TALK, runId: 'run-1', from: 'writer' } })
    expect(await screen.findByText('Click or drag the bar')).toBeInTheDocument()
    await waitFor(() => expect(line()).toHaveAttribute('tabindex', '0'))
    expect(line()).toHaveAccessibleName('Ask Writer about a moment')
    slide(line(), 200)
    expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the moment you marked' })).toBeInTheDocument()
    const video = document.querySelector('video')!
    expect(video.currentTime).toBe(15)
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const at = { kind: 'time', start: 15_000 }
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(
      { runId: 'run-1', messageId: passageId(TALK, 'The moment at 0:15', at as never), from: 'writer', to: null, kind: 'passage', text: 'The moment at 0:15', file: TALK, at },
      undefined, 'writer', [expect.any(File)],
    ))
    expect((onAsk.mock.lastCall![3] as File[])[0].name).toBe('talk at 0.15.png')
    expect(drawn).toEqual([[0, 0, 1280, 720]])
  })

  it('marks the span dragged along its line, and sends its first, middle and last frames, taken without moving the recording on screen', async () => {
    const { onAsk } = renderReader({ file: { path: TALK, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(line()).toHaveAttribute('tabindex', '0'))
    slide(line(), 400, 200)
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'From 0:15 to 0:30', at: { kind: 'time', start: 15_000, end: 30_000 } }), EXPLAIN_WORDS, 'writer', [expect.any(File), expect.any(File), expect.any(File)],
    ))
    expect((onAsk.mock.lastCall![3] as File[]).map((frame) => frame.name)).toEqual(['talk at 0.15.png', 'talk at 0.23.png', 'talk at 0.30.png'])
    // The frames came from a copy: the recording on screen only went to the span's start.
    expect(seeksOf(document.querySelector('video')!)).toEqual([15])
  })

  it('marks a box on the paused frame, placed on the whole frame though its bottom is left to the controls, and sent cut out of that frame', async () => {
    const { onAsk } = renderReader({ file: { path: TALK, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(line()).toHaveAttribute('tabindex', '0'))
    slide(line(), 400)
    // The recording has gone to 0:30 once it says so.
    await act(() => Promise.resolve())
    fireEvent.keyDown(document, { key: 'Escape' })
    // The frame is 800 by 600; what takes the pointer stops short of the player's controls.
    const frame = document.querySelector<HTMLElement>('.rd-media-catch')!
    frame.getBoundingClientRect = () => new DOMRect(0, 0, 800, 528)
    fireEvent.pointerDown(frame, { button: 0, pointerId: 2, clientX: 400, clientY: 0 })
    fireEvent.pointerMove(frame, { pointerId: 2, clientX: 800, clientY: 300 })
    fireEvent.pointerUp(frame, { pointerId: 2, clientX: 800, clientY: 300 })
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    const at = { kind: 'box', x: 5000, y: 0, w: 5000, h: 5000, ms: 30_000 }
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ text: 'The top right of the frame at 0:30', at }), EXPLAIN_WORDS, 'writer', [expect.any(File)]))
    expect(drawn.at(-1)).toEqual([640, 0, 640, 360])
  })

  it('draws each part asked about on its line with the bubble of the agent asked, which opens the answer and goes to its moment', async () => {
    const asked = [part({ state: 'said', by: 'writer', text: 'The chart appears.', at: null }, { file: TALK, text: 'From 0:15 to 0:30', at: { kind: 'time', start: 15_000, end: 30_000 } })]
    renderReader({ file: { path: TALK, runId: 'run-1', from: 'writer' }, asked })
    const bubble = await screen.findByRole('button', { name: "Writer's answer about “From 0:15 to 0:30”" })
    const mark = document.querySelector<HTMLElement>('.rd-moment[data-part]')!
    expect(mark.contains(bubble)).toBe(true)
    expect(mark).toHaveStyle({ left: '25%', width: '25%' })
    slide(mark, 300)
    expect(answerCard()).toHaveTextContent('The chart appears.')
    expect(document.querySelector('video')!.currentTime).toBe(15)
  })

  it('asks about a moment of a recording of sound only by its time alone', async () => {
    const { onAsk } = renderReader({ file: { path: SONG, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(line()).toHaveAttribute('tabindex', '0'))
    expect(document.querySelector('.rd-media-drawing')).toBeNull()
    line().focus()
    fireEvent.keyDown(line(), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ text: 'The moment at 0:00', at: { kind: 'time', start: 0 } }), undefined, 'writer'))
  })

  it('moves the recording with the arrow keys on its bar, further with Shift, and Enter marks where it is', async () => {
    renderReader({ file: { path: TALK, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(line()).toHaveAttribute('tabindex', '0'))
    line().focus()
    fireEvent.keyDown(line(), { key: 'ArrowRight', shiftKey: true })
    await act(() => Promise.resolve())
    fireEvent.keyDown(line(), { key: 'ArrowRight' })
    await act(() => Promise.resolve())
    expect(document.querySelector('video')!.currentTime).toBe(6)
    fireEvent.keyDown(line(), { key: 'Enter' })
    expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the moment you marked' })).toBeInTheDocument()
    expect(document.querySelector('.rd-moment.marking')).toHaveStyle({ left: '10%' })
  })

  it('shows the time a mouse over the bar would mark, and the agent asked at its start until a part is asked about', async () => {
    renderReader({ file: { path: TALK, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(line()).toHaveAttribute('tabindex', '0'))
    expect(line().querySelector('.rd-media-face')).not.toBeNull()
    fireEvent.pointerMove(line(), { pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: 10 })
    expect(line().querySelector('.rd-media-hover')).toHaveTextContent('0:15')
    fireEvent.pointerLeave(line(), { pointerId: 1, pointerType: 'mouse' })
    expect(line().querySelector('.rd-media-hover')).toBeNull()
  })

  it('puts bubbles too near to sit side by side in a row of their own under the bar', async () => {
    const asked = [
      part({ state: 'said', by: 'writer', text: 'A title.', at: null }, { messageId: 'n-1', file: TALK, text: 'The moment at 0:15', at: { kind: 'time', start: 15_000 } }),
      part({ state: 'said', by: 'writer', text: 'Still the title.', at: null }, { messageId: 'n-2', file: TALK, text: 'The moment at 0:16', at: { kind: 'time', start: 16_000 } }),
      part({ state: 'said', by: 'writer', text: 'The end.', at: null }, { messageId: 'n-3', file: TALK, text: 'The moment at 0:45', at: { kind: 'time', start: 45_000 } }),
    ]
    renderReader({ file: { path: TALK, runId: 'run-1', from: 'writer' }, asked })
    await waitFor(() => expect(document.querySelectorAll('.rd-moment[data-part] .rd-bubble')).toHaveLength(3))
    const rows = [...document.querySelectorAll<HTMLElement>('.rd-moment[data-part] > .rd-slot')].map((slot) => slot.dataset.row)
    expect(rows).toEqual(['0', '1', '0'])
    expect(document.querySelectorAll<HTMLElement>('.rd-moment[data-part] > .rd-slot')[1].style.top).toBe('calc(100% + 6px)')
    // A part asked about takes the agent's place at the bar's start.
    expect(line().querySelector('.rd-media-face')).toBeNull()
  })

  it('draws no bar where nothing can be asked and nothing has been', async () => {
    renderReader({ file: { path: TALK, runId: 'run-1', from: null } })
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull())
    expect(document.querySelector('.rd-media-line')).toBeNull()
  })
})

// ADR 0091: a PDF is drawn as its pages; its words are marked as any file's, and a drag on a page
// where there are no words marks a box there.
describe('a PDF in the reader', () => {
  const PDF = '/teams/.loomwatch/market/writer/report.pdf'
  let drawn: number[][] = []
  beforeEach(() => {
    pdfState.pages = 2
    pdfState.fail = false
    pdfState.hang = false
    pdfState.sharp = true
    pdfState.pictured = true
    pdfState.drawnAgain = []
    pdfState.hold = null
    pdfState.stops = []
    pdfState.wordsHold = null
    pdfState.wordStops = []
    pdfState.released = []
    pdfState.textHold = null
    vi.mocked(openPdf).mockClear()
    drawn = []
    // Each page's line of words is at the top left, 300 by 16 at 50,40; the page is 800 by 600. A
    // spy here would be the one every element already has, and would move every element.
    HTMLSpanElement.prototype.getBoundingClientRect = () => new DOMRect(50, 40, 300, 16)
    answer = (url) => (url.startsWith('/api/files/read')
      ? respond(200, read({ path: PDF, name: 'report.pdf', kind: 'document', text: 'Page 1 says sales grew.\n\nPage 2 says sales grew.', extracted: true }))
      : respond(200, { path: PDF, exists: true, isDir: false, sizeBytes: 9_000, modifiedAt: '2026-10-19T01:00:00Z', kind: 'document', folder: null, openable: true }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (...args: unknown[]) => { drawn.push(args.slice(1, 5) as number[]) } }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['png'], { type: 'image/png' })))
  })
  afterEach(() => {
    delete (HTMLSpanElement.prototype as Partial<HTMLSpanElement>).getBoundingClientRect
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockRestore()
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockRestore()
    vi.useRealTimers()
  })
  const page = (number: number) => document.querySelector<HTMLElement>(`.rd-pdf-page[data-page="${number}"]`)!

  it('draws a PDF as its pages with its words over them, and marks its words as in any file', async () => {
    const { onAsk } = renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(document.querySelectorAll('.rd-pdf-page')).toHaveLength(2))
    await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
    expect(page(1).querySelector('canvas')!.width).toBe(1200)
    // Opened once, at the version read, not again when the version is known.
    expect(vi.mocked(openPdf).mock.calls).toEqual([[expect.stringMatching(/report\.pdf&v=2026-10-19T01%3A00%3A00Z$/)]])
    expect(screen.queryByText(/Only the first 500 pages/)).toBeNull()
    expect(screen.getByText('drag over a chart or picture')).toBeInTheDocument()
    await mark('Page 1 says sales grew.')
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ kind: 'passage', text: 'Page 1 says sales grew.', file: PDF }), undefined, 'writer')
  })

  it('marks a box on a page where there are no words, sent drawn again sharp, or cut out of the page as drawn', async () => {
    const { onAsk } = renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
    // A drag that starts on words, or just beside them, is a drag over words: no box.
    const words = page(2).querySelector('.rd-pdf-text span')!
    fireEvent.pointerDown(words, { button: 0, pointerId: 1, clientX: 100, clientY: 45 })
    expect(page(2).querySelector('.rd-box.drawing')).toBeNull()
    fireEvent.pointerUp(words, { pointerId: 1, clientX: 100, clientY: 45 })
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 6, clientX: 362, clientY: 52 })
    fireEvent.pointerMove(page(2), { pointerId: 6, clientX: 700, clientY: 300 })
    expect(page(2).querySelector('.rd-box.drawing')).toBeNull()
    fireEvent.pointerUp(page(2), { pointerId: 6, clientX: 700, clientY: 300 })
    // Beside a label in a chart ("200"), not a line of words, a press starts a box, as a drag over
    // a chart starts at its edge.
    const label = document.createElement('span')
    label.textContent = '200'
    label.getBoundingClientRect = () => new DOMRect(600, 400, 20, 10)
    page(2).querySelector('.rd-pdf-text')!.append(label)
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 11, clientX: 630, clientY: 405 })
    expect(page(2).querySelector('.rd-box.drawing')).not.toBeNull()
    fireEvent.pointerCancel(page(2), { pointerId: 11 })
    const legend = document.createElement('span')
    legend.textContent = 'Q3 2024'
    legend.getBoundingClientRect = () => new DOMRect(600, 450, 40, 10)
    page(2).querySelector('.rd-pdf-text')!.append(legend)
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 15, clientX: 650, clientY: 455 })
    expect(page(2).querySelector('.rd-box.drawing')).not.toBeNull()
    fireEvent.pointerCancel(page(2), { pointerId: 15 })
    // On the page where there are none, it draws a box; the page is 800 by 600 in jsdom. Words
    // marked before it are let go of, not taken for what is marked.
    const before = document.createRange()
    before.selectNodeContents(page(1).querySelector('.rd-pdf-text span')!)
    document.getSelection()!.addRange(before)
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 2, clientX: 400, clientY: 0 })
    expect(String(document.getSelection())).toBe('')
    fireEvent.pointerMove(page(2), { pointerId: 2, clientX: 800, clientY: 300 })
    expect(page(2).querySelector('.rd-box.drawing')).not.toBeNull()
    fireEvent.pointerUp(page(2), { pointerId: 2, clientX: 800, clientY: 300 })
    // No words selected after it lets go of words, not of the box.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    const at = { kind: 'box', x: 5000, y: 0, w: 5000, h: 5000, page: 2 }
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ text: 'The top right of page 2', at }), EXPLAIN_WORDS, 'writer', [expect.any(File)]))
    const [sharp] = onAsk.mock.lastCall![3] as File[]
    expect([sharp.name, await sharp.text()]).toEqual(['report part.png', 'sharp png'])
    expect(pdfState.drawnAgain).toEqual([at])
    expect(drawn).toEqual([])
    // Where it can't be drawn again, it is cut out of the page as the screen shows it.
    pdfState.sharp = false
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 3, clientX: 400, clientY: 0 })
    fireEvent.pointerMove(page(2), { pointerId: 3, clientX: 800, clientY: 300 })
    fireEvent.pointerUp(page(2), { pointerId: 3, clientX: 800, clientY: 300 })
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    await waitFor(() => expect(onAsk).toHaveBeenCalledTimes(2))
    expect(drawn.at(-1)).toEqual([600, 0, 600, 800])
  })

  it('draws each box asked about on its page with the bubble of the agent asked, which opens the answer', async () => {
    const at = { kind: 'box' as const, x: 5000, y: 0, w: 5000, h: 5000, page: 2 }
    const asked = [part({ state: 'said', by: 'writer', text: 'That is the total.', at: null }, { file: PDF, text: 'The top right of page 2', at })]
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' }, asked })
    const bubble = await screen.findByRole('button', { name: "Writer's answer about “The top right of page 2”" })
    const box = page(2).querySelector<HTMLElement>('.rd-box[data-part]')!
    expect(box.contains(bubble)).toBe(true)
    expect(page(1).querySelector('.rd-box[data-part]')).toBeNull()
    fireEvent.click(bubble)
    expect(answerCard()).toHaveTextContent('That is the total.')
    // Escape in the message box is the box's, however the box is editable.
    const field = document.createElement('div')
    field.setAttribute('contenteditable', 'plaintext-only')
    document.body.append(field)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(answerCard()).toHaveTextContent('That is the total.')
    field.remove()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(answerCard()).toBeNull()
    // A right click, for the menu, opens nothing.
    fireEvent.pointerDown(box, { button: 2, pointerId: 12, clientX: 500, clientY: 100 })
    fireEvent.pointerUp(box, { button: 2, pointerId: 12, clientX: 500, clientY: 100 })
    expect(answerCard()).toBeNull()
    // A click on the box opens its answer; a drag that starts on it draws a new box.
    fireEvent.pointerDown(box, { button: 0, pointerId: 4, clientX: 500, clientY: 100 })
    fireEvent.pointerUp(box, { pointerId: 4, clientX: 500, clientY: 100 })
    expect(answerCard()).toHaveTextContent('That is the total.')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(box, { button: 0, pointerId: 5, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(page(2), { pointerId: 5, clientX: 700, clientY: 400 })
    fireEvent.pointerUp(page(2), { pointerId: 5, clientX: 700, clientY: 400 })
    expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the part you marked' })).toBeInTheDocument()
  })

  it('shows its words when it can’t be drawn', async () => {
    pdfState.fail = true
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    expect(await screen.findByText(/Page 2 says sales grew\./)).toBeInTheDocument()
    expect(document.querySelector('.rd-pdf-page')).toBeNull()
  })

  it('shows its words when it doesn’t open in time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    pdfState.hang = true
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    // One line for the whole wait, the reader's own, said on by the PDF while it opens.
    await waitFor(() => expect(document.querySelector('.rd-as-pdf .rd-loading')).toHaveTextContent('Reading report.pdf…'))
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(await screen.findByText(/Page 2 says sales grew\./)).toBeInTheDocument()
    expect(screen.queryByText('Reading report.pdf…')).toBeNull()
    expect(document.querySelector('.rd-pdf-page')).toBeNull()
  })

  it('draws its pages in a tab in the background, which draws no frames', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    try {
      renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
      await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
    } finally {
      frames.mockRestore()
    }
  })

  it('shows its pages though it has no words the daemon can read, as scanned pages have none', async () => {
    answer = (url) => (url.startsWith('/api/files/read')
      ? respond(422, { error: 'report.pdf can’t be read in LoomWatch: it has no text in it.' })
      : respond(200, { path: PDF, exists: true, isDir: false, sizeBytes: 9_000, modifiedAt: '2026-10-19T01:00:00Z', kind: 'document', folder: null, openable: true }))
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(document.querySelectorAll('.rd-pdf-page')).toHaveLength(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('speaks of boxes in its tip only when a page shows a picture or a chart', async () => {
    pdfState.pictured = false
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
    expect(screen.getByText('Mark any words')).toBeInTheDocument()
    expect(screen.queryByText('drag over a chart or picture')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Ask about page/ })).toBeNull()
    fireEvent.pointerDown(page(1), { button: 0, pointerId: 13, pointerType: 'touch', clientX: 400, clientY: 300 })
    fireEvent.pointerUp(page(1), { pointerId: 13, pointerType: 'touch', clientX: 400, clientY: 300 })
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull()
  })

  it('puts the bubbles after words asked about over the page, light as the paper, and keeps them while words are selected', async () => {
    // jsdom lays nothing out, but reads colours from a style sheet: a dark theme round white paper.
    const theme = document.createElement('style')
    theme.textContent = 'body { background-color: rgb(16, 16, 18); } .rd-pdf-page { background-color: rgb(255, 255, 255); }'
    document.head.append(theme)
    try {
      const asked = [part({ state: 'said', by: 'writer', text: 'It grew 12%.', at: null }, { file: PDF, text: 'Page 1 says sales grew.' })]
      renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' }, asked })
      // Marked again once the page the part is on is known; its bubble then stays where it is.
      await screen.findByRole('button', { name: "Writer's answer about “Page 1 says sales grew.”" })
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      const slot = screen.getByRole('button', { name: "Writer's answer about “Page 1 says sales grew.”" }).closest<HTMLElement>('.rd-slot')!
      // Not in the line, where it would be stretched with the words and push them off the drawing.
      expect(page(1).querySelector('.rd-pdf-slots')!.contains(slot)).toBe(true)
      expect(page(1).querySelector('.rd-pdf-text')!.contains(slot)).toBe(false)
      // At the end of the last word marked, 120 + 160 across and 300 + 9 down a page of 800 by 600.
      const row = slot.parentElement!
      expect(row).toHaveClass('rd-pdf-row')
      expect([row.style.left, row.style.top]).toEqual(['35%', '51.5%'])
      // Right after the words it follows, its point points at them.
      expect(row).not.toHaveClass('apart')
      expect(slot).not.toHaveClass('on-dark')
      // A drag over words in Safari moves the block after them along: the marks stay as they are.
      const marked = page(1).querySelector('.rd-mark')!
      const words = page(1).querySelector('.rd-pdf-text')!
      words.prepend(words.querySelector('.endOfContent')!)
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(marked.isConnected).toBe(true)
    } finally {
      theme.remove()
    }
  })

  it.each(['smaller', 'larger'])('draws a smaller box asked about over a larger one, and a click where both are opens the smaller one’s answer, the %s asked first', async (first) => {
    const whole = { kind: 'box' as const, x: 0, y: 0, w: 10_000, h: 10_000, page: 2 }
    const corner = { kind: 'box' as const, x: 5000, y: 0, w: 5000, h: 5000, page: 2 }
    const both = [
      part({ state: 'said', by: 'writer', text: 'That is the total.', at: null }, { file: PDF, text: 'The top right of page 2', at: corner }),
      part({ state: 'said', by: 'writer', text: 'That is all of it.', at: null }, { file: PDF, text: 'All of page 2', at: whole, messageId: 'n-2' }),
    ]
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' }, asked: first === 'smaller' ? both : [...both].reverse() })
    await screen.findByRole('button', { name: "Writer's answer about “All of page 2”" })
    expect([...page(2).querySelectorAll<HTMLElement>('.rd-box[data-part]')].map((box) => box.dataset.part!.split('\u0001')[0])).toEqual(['All of page 2', 'The top right of page 2'])
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 7, clientX: 600, clientY: 100 })
    fireEvent.pointerUp(page(2), { pointerId: 7, clientX: 600, clientY: 100 })
    expect(answerCard()).toHaveTextContent('That is the total.')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 8, clientX: 100, clientY: 500 })
    fireEvent.pointerUp(page(2), { pointerId: 8, clientX: 100, clientY: 500 })
    expect(answerCard()).toHaveTextContent('That is all of it.')
    // Just beside words a press marks words; a click there that marks none opens the box's answer too.
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 9, clientX: 362, clientY: 52 })
    fireEvent.pointerUp(page(2), { pointerId: 9, clientX: 362, clientY: 52 })
    expect(answerCard()).toHaveTextContent('That is all of it.')
  })

  it('asks about all of a page with a picture from the keyboard, or with a tap that doesn’t move', async () => {
    const { onAsk } = renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Ask about page 2' }), { key: 'Enter' })
    // All of a page is taller than the view of 600: the pill stays inside it, drawn as on paper.
    const pill = await screen.findByRole('toolbar', { name: 'Ask Writer about the page you marked' })
    expect(pill).toHaveClass('on-paper')
    expect(Number.parseFloat(pill.style.top)).toBeLessThan(600)
    fireEvent.click(await screen.findByRole('button', { name: 'Ask' }))
    const all = (number: number) => ({ kind: 'box', x: 0, y: 0, w: 10_000, h: 10_000, page: number })
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ text: 'All of page 2', at: all(2) }), undefined, 'writer', [expect.any(File)]))
    // A tap on words is a tap on words: the page isn't marked.
    const line = page(1).querySelector('.rd-pdf-text span')!
    fireEvent.pointerDown(line, { button: 0, pointerId: 14, pointerType: 'touch', clientX: 100, clientY: 45 })
    fireEvent.pointerUp(line, { pointerId: 14, pointerType: 'touch', clientX: 100, clientY: 45 })
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull()
    // A finger that moves is scrolling: nothing is marked.
    fireEvent.pointerDown(page(1), { button: 0, pointerId: 9, pointerType: 'touch', clientX: 400, clientY: 300 })
    fireEvent.pointerUp(page(1), { pointerId: 9, pointerType: 'touch', clientX: 400, clientY: 340 })
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull()
    fireEvent.pointerDown(page(1), { button: 0, pointerId: 10, pointerType: 'touch', clientX: 400, clientY: 300 })
    fireEvent.pointerUp(page(1), { pointerId: 10, pointerType: 'touch', clientX: 400, clientY: 300 })
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    await waitFor(() => expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'All of page 1', at: all(1) }), EXPLAIN_WORDS, 'writer', [expect.any(File)]))
  })

  it('draws pages ahead of the reader’s own view, and stops drawing a page at a width it no longer has', async () => {
    const near: IntersectionObserverInit[] = []
    vi.stubGlobal('IntersectionObserver', class {
      seen: IntersectionObserverCallback
      constructor(seen: IntersectionObserverCallback, options: IntersectionObserverInit) { this.seen = seen; near.push(options) }
      observe(target: Element) { this.seen([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
    })
    const resized: (() => void)[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(seen: () => void) { resized.push(seen) }
      observe() {}
      disconnect() {}
    })
    let release = () => {}
    pdfState.hold = new Promise<void>((resolve) => { release = resolve })
    let releaseWords = () => {}
    pdfState.wordsHold = new Promise<void>((resolve) => { releaseWords = resolve })
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(pdfState.stops).toHaveLength(2))
    expect(near.find((options) => options.rootMargin === '600px')).toEqual(expect.objectContaining({ root: document.querySelector('.rd-scroll') }))
    // The reader is made narrower while both pages are being drawn.
    document.querySelector('.rd-pdf')!.getBoundingClientRect = () => new DOMRect(0, 0, 600, 450)
    act(() => resized.forEach((seen) => seen()))
    await waitFor(() => expect(pdfState.stops).toHaveLength(4))
    expect(pdfState.stops.map((stop) => stop?.aborted)).toEqual([true, true, false, false])
    // And again while their words are being laid out.
    release()
    await waitFor(() => expect(pdfState.wordStops).toHaveLength(2))
    document.querySelector('.rd-pdf')!.getBoundingClientRect = () => new DOMRect(0, 0, 500, 450)
    act(() => resized.forEach((seen) => seen()))
    await waitFor(() => expect(pdfState.wordStops).toHaveLength(4))
    expect(pdfState.wordStops.map((stop) => stop?.aborted)).toEqual([true, true, false, false])
    releaseWords()
    await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
    expect(page(2).style.getPropertyValue('--total-scale-factor')).toBe(String(500 / 600))
  })

  it('lets go of the drawing of a page far from the view, keeps its words, and draws it again once near', async () => {
    const watchers = new Map<string, IntersectionObserverCallback>()
    vi.stubGlobal('IntersectionObserver', class {
      seen: IntersectionObserverCallback
      constructor(seen: IntersectionObserverCallback, options: IntersectionObserverInit) { this.seen = seen; watchers.set(options.rootMargin ?? '', seen) }
      observe(target: Element) { this.seen([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
    })
    const tell = (margin: string, near: boolean) => act(() => watchers.get(margin)!([{ isIntersecting: near, target: page(2) } as unknown as IntersectionObserverEntry], {} as IntersectionObserver))
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(page(2).querySelector('canvas')!.width).toBe(1200))
    const laid = pdfState.wordStops.length
    tell('3000px', false)
    await waitFor(() => expect(pdfState.released).toEqual([2]))
    expect(page(2).querySelector('canvas')!.width).toBe(0)
    expect(page(2)).toHaveTextContent('Page 2 says sales grew.')
    tell('600px', true)
    await waitFor(() => expect(page(2).querySelector('canvas')!.width).toBe(1200))
    expect(pdfState.wordStops).toHaveLength(laid)
  })

  it('finds words asked about on a page not drawn yet, and says only of words on no page that they have changed', async () => {
    // Only page 1 is ever near the view.
    vi.stubGlobal('IntersectionObserver', class {
      seen: IntersectionObserverCallback
      constructor(seen: IntersectionObserverCallback) { this.seen = seen }
      observe(target: Element) { if (target.getAttribute('data-page') === '1') this.seen([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
    })
    const onPageTwo = part({ state: 'said', by: 'writer', text: 'It grew.', at: null }, { file: PDF, text: 'Page 2 says sales grew.' })
    const { rerender } = renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' }, asked: [onPageTwo] })
    // Its page's words are laid out, so the part is marked with its bubble; its drawing is not made.
    const bubble = await screen.findByRole('button', { name: "Writer's answer about “Page 2 says sales grew.”" })
    expect(page(2).querySelector('.rd-pdf-slots')!.contains(bubble)).toBe(true)
    expect(page(2).querySelector('canvas')!.width).not.toBe(1200)
    // Asked about words on none of its pages, the answer says they have changed.
    rerender({ asked: [onPageTwo, part({ state: 'sending' }, { file: PDF, text: 'Words no page has.', messageId: null })] })
    expect(await screen.findByText('The words you marked have changed.')).toBeInTheDocument()
  })

  it('doesn’t take words on a page not laid out yet for words the file no longer has', async () => {
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
    // The file changes: its pages open again, and their words are slow to be laid out, and to be
    // looked through for the page a part is on.
    pdfState.wordsHold = new Promise(() => undefined)
    let releaseText = () => {}
    pdfState.textHold = new Promise<void>((resolve) => { releaseText = resolve })
    cleanup()
    const { rerender } = renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(document.querySelectorAll('.rd-pdf-page')).toHaveLength(2))
    rerender({ asked: [part({ state: 'sending' }, { file: PDF, text: 'Page 2 says sales grew.', messageId: null })] })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.queryByText('The words you marked have changed.')).toBeNull()
    releaseText()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.queryByText('The words you marked have changed.')).toBeNull()
  })

  it('doesn’t take a box on a PDF still opening for one the file no longer has', async () => {
    pdfState.hang = true
    const { rerender } = renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(document.querySelector('.rd-as-pdf .rd-loading')).not.toBeNull())
    rerender({ asked: [part({ state: 'sending' }, { file: PDF, text: 'The top right of page 2', at: { kind: 'box', x: 5000, y: 0, w: 5000, h: 5000, page: 2 }, messageId: null })] })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.queryByText('The words you marked have changed.')).toBeNull()
  })

  describe('a slide deck, shown as the PDF LibreOffice makes of it', () => {
    const DECK = '/teams/.loomwatch/market/writer/deck.pptx'
    beforeEach(() => {
      answer = (url) => (url.startsWith('/api/files/read')
        ? respond(200, read({ path: DECK, name: 'deck.pptx', kind: 'document', text: 'Slide 1\n\nSales grew.\n\nSlide 2\n\nNorth leads.', extracted: true }))
        : respond(200, { path: DECK, exists: true, isDir: false, sizeBytes: 9_000, modifiedAt: '2026-10-19T01:00:00Z', kind: 'document', folder: null, openable: true }))
    })

    it('is drawn as its slides, from the PDF of them, each part named by its slide', async () => {
      const { onAsk } = renderReader({ file: { path: DECK, runId: 'run-1', from: 'writer' } })
      await waitFor(() => expect(screen.getAllByRole('group', { name: /^Slide \d$/ })).toHaveLength(2))
      expect(vi.mocked(openPdf).mock.calls).toEqual([[expect.stringMatching(/^\/api\/files\/pages\?path=.*deck\.pptx&v=/)]])
      // Not the words alone, as a deck was shown before.
      expect(screen.queryByText(/These are the words of the slides/)).toBeNull()
      await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
      fireEvent.pointerDown(page(2), { button: 0, pointerId: 2, clientX: 400, clientY: 0 })
      fireEvent.pointerMove(page(2), { pointerId: 2, clientX: 800, clientY: 300 })
      fireEvent.pointerUp(page(2), { pointerId: 2, clientX: 800, clientY: 300 })
      fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
      await waitFor(() => expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ text: 'The top right of slide 2', at: { kind: 'box', x: 5000, y: 0, w: 5000, h: 5000, page: 2 } }), EXPLAIN_WORDS, 'writer', [expect.any(File)]))
      // All of a slide, from the keyboard.
      fireEvent.keyDown(await screen.findByRole('button', { name: 'Ask about slide 1' }), { key: 'Enter' })
      expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the slide you marked' })).toBeInTheDocument()
    })

    it('waits longer for its slides than a PDF is waited for, as LibreOffice makes them first', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      pdfState.hang = true
      renderReader({ file: { path: DECK, runId: 'run-1', from: 'writer' } })
      await waitFor(() => expect(document.querySelector('.rd-as-pdf .rd-loading')).toHaveTextContent(/^Reading deck\.pptx…$/))
      // Nothing to mark yet: the tip waits for the slides.
      expect(screen.queryByText('Mark any words')).toBeNull()
      // A long wait says why it may go on.
      await act(async () => { vi.advanceTimersByTime(10_000) })
      expect(document.querySelector('.rd-as-pdf .rd-loading')).toHaveTextContent('Reading deck.pptx…The first time can take a minute or two.')
      await act(async () => { vi.advanceTimersByTime(50_000) })
      expect(document.querySelector('.rd-as-pdf .rd-loading')).toHaveTextContent(/^Reading deck\.pptx…/)
      await act(async () => { vi.advanceTimersByTime(100_000) })
      expect(await screen.findByText('North leads.')).toBeInTheDocument()
    })

    it('shows its words when its slides can’t be made, as without LibreOffice', async () => {
      pdfState.fail = true
      renderReader({ file: { path: DECK, runId: 'run-1', from: 'writer' } })
      expect(await screen.findByText(/These are the words of the slides, as your agents read them/)).toBeInTheDocument()
      expect(screen.getByText('North leads.')).toBeInTheDocument()
      expect(document.querySelector('.rd-pdf-page')).toBeNull()
    })
  })

  it('shows a Word document as the PDF LibreOffice makes of its pages, waited for as a deck is', async () => {
    const LETTER = '/teams/.loomwatch/market/writer/letter.docx'
    answer = (url) => (url.startsWith('/api/files/read')
      ? respond(200, read({ path: LETTER, name: 'letter.docx', kind: 'document', text: 'Dear team,\n\nSales grew.', extracted: true }))
      : respond(200, { path: LETTER, exists: true, isDir: false, sizeBytes: 9_000, modifiedAt: '2026-10-19T01:00:00Z', kind: 'document', folder: null, openable: true }))
    const { onAsk } = renderReader({ file: { path: LETTER, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(screen.getAllByRole('group', { name: /^Page \d$/ })).toHaveLength(2))
    expect(vi.mocked(openPdf).mock.calls).toEqual([[expect.stringMatching(/^\/api\/files\/pages\?path=.*letter\.docx&v=/)]])
    expect(screen.queryByText(/These are the words of the Word document/)).toBeNull()
    await waitFor(() => expect(page(2)).toHaveTextContent('Page 2 says sales grew.'))
    fireEvent.pointerDown(page(2), { button: 0, pointerId: 2, clientX: 400, clientY: 0 })
    fireEvent.pointerMove(page(2), { pointerId: 2, clientX: 800, clientY: 300 })
    fireEvent.pointerUp(page(2), { pointerId: 2, clientX: 800, clientY: 300 })
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }))
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ text: 'The top right of page 2', file: LETTER }), EXPLAIN_WORDS, 'writer', [expect.any(File)]))
    // Its words are marked as any file's are.
    await mark('Page 1 says sales grew.')
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'passage', text: 'Page 1 says sales grew.', file: LETTER }), undefined, 'writer')
  })

  it('waits for a Word document’s pages as for a deck’s, saying why after a while', async () => {
    const LETTER = '/teams/.loomwatch/market/writer/letter.docx'
    answer = (url) => (url.startsWith('/api/files/read')
      ? respond(200, read({ path: LETTER, name: 'letter.docx', kind: 'document', text: 'Dear team,\n\nSales grew.', extracted: true }))
      : respond(200, { path: LETTER, exists: true, isDir: false, sizeBytes: 9_000, modifiedAt: '2026-10-19T01:00:00Z', kind: 'document', folder: null, openable: true }))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    pdfState.hang = true
    renderReader({ file: { path: LETTER, runId: 'run-1', from: 'writer' } })
    await waitFor(() => expect(document.querySelector('.rd-as-pdf .rd-loading')).toHaveTextContent(/^Reading letter\.docx…$/))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(document.querySelector('.rd-as-pdf .rd-loading')).toHaveTextContent('Reading letter.docx…The first time can take a minute or two.')
    await act(async () => { vi.advanceTimersByTime(100_000) })
    expect(await screen.findByText('Sales grew.')).toBeInTheDocument()
  })

  it('says under the file’s name that only its first 500 pages are shown', async () => {
    pdfState.pages = 501
    renderReader({ file: { path: PDF, runId: 'run-1', from: 'writer' } })
    const note = await screen.findByText('Only the first 500 pages are shown here. Open it in its own app for the rest.')
    expect(note.closest('.rd-pdf')).toBeNull()
    expect(document.querySelectorAll('.rd-pdf-page')).toHaveLength(500)
  })
})

describe('a web page in the reader', () => {
  it('runs in a sandbox with no origin, and shows its code on request', async () => {
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: '/w/site.html', name: 'site.html', kind: 'web', text: '<h1>Hello</h1>' })) : respond(404, {}))
    renderReader({ file: { path: '/w/site.html', runId: 'run-1', from: 'writer' } })
    const frame = await waitFor(() => {
      const element = document.querySelector('iframe')
      if (!element) throw new Error('no frame yet')
      return element
    })
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Hello</h1>')
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }))
    expect(await screen.findByText('<h1>Hello</h1>')).toBeInTheDocument()
  })

  it('asks about a chart the page says was marked, with the picture the page drew of it, and has the page outline it once asked', async () => {
    const SITE = '/w/site/page.html'
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: SITE, name: 'page.html', kind: 'web', text: '<h2>Sales</h2><canvas id="chart"></canvas>' })) : respond(404, {}))
    const { onAsk, rerender } = renderReader({ file: { path: SITE, runId: 'run-1', from: 'writer' } })
    const frame = await waitFor(() => {
      const element = document.querySelector('iframe')
      if (!element?.contentWindow) throw new Error('no frame yet')
      return element
    })
    const told = vi.spyOn(frame.contentWindow!, 'postMessage')
    const fromPage = (data: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { lw: 'reader', ...data }, source: frame.contentWindow })) })
    fromPage({ type: 'ready' })
    const at = { kind: 'element', what: 'chart', path: 'canvas#chart' }
    fromPage({ type: 'thing', what: 'chart', path: 'canvas#chart', text: 'The chart under “Sales”', rect: { top: 40, bottom: 190, left: 20, right: 320 }, picture: new Uint8Array([1, 2, 3]).buffer })
    expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the chart you marked' })).toBeInTheDocument()
    // The page reports it moved while marked: the picture it sent is kept.
    fromPage({ type: 'thing', what: 'chart', path: 'canvas#chart', text: 'The chart under “Sales”', rect: { top: 30, bottom: 180, left: 20, right: 320 } })
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))
    expect(onAsk).toHaveBeenCalledWith(
      { runId: 'run-1', messageId: passageId(SITE, 'The chart under “Sales”', at as never), from: 'writer', to: null, kind: 'passage', text: 'The chart under “Sales”', file: SITE, at },
      EXPLAIN_WORDS, 'writer', [expect.any(File)],
    )
    const [picture] = onAsk.mock.lastCall![3] as File[]
    expect([picture.name, picture.type, picture.size]).toEqual(['page chart.png', 'image/png', 3])
    expect(told).toHaveBeenCalledWith({ lw: 'reader', type: 'clear' }, '*')
    // Asked: the page is told to outline it, by its path, known by its part's id; its bubble reads on.
    rerender({ asked: [part({ state: 'said', by: 'writer', text: 'North leads.', at: null }, { file: SITE, text: 'The chart under “Sales”', at: at as never })] })
    await waitFor(() => expect(told).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'marks', parts: [expect.objectContaining({ text: partId({ text: 'The chart under “Sales”', at: at as never }), at, look: 'read', label: "Writer's answer about the chart under “Sales”" })],
    }), '*'))
  })

  it('has a Pick switch that has the page mark the part clicked, stops on Esc, on asking or with another file, and is taught in its tip until a part is asked about', async () => {
    const SITE = '/w/site/page.html'
    const OTHER = '/w/site/other.html'
    answer = (url) => (!url.startsWith('/api/files/read') ? respond(404, {})
      : url.includes(encodeURIComponent(OTHER)) ? respond(200, read({ path: OTHER, name: 'other.html', kind: 'web', text: '<p>Other</p>' }))
        : respond(200, read({ path: SITE, name: 'page.html', kind: 'web', text: '<p>Sales grew.</p><svg><rect></rect><text>API</text></svg>' })))
    const { onAsk, rerender } = renderReader({ file: { path: SITE, runId: 'run-1', from: 'writer' } })
    const frameOf = () => waitFor(() => {
      const element = document.querySelector('iframe')
      if (!element?.contentWindow) throw new Error('no frame yet')
      return element
    })
    const frame = await frameOf()
    const told = vi.spyOn(frame.contentWindow!, 'postMessage')
    const fromPage = (data: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { lw: 'reader', ...data }, source: frame.contentWindow })) })
    fromPage({ type: 'ready' })
    // It doesn't say who answers (the pill does, once a part is marked): it shows a page with one part picked, not a face.
    const pick = screen.getByRole('button', { name: 'Pick a part of the page to ask about' })
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    expect(pick.querySelector('svg .rd-pick-part')).not.toBeNull()
    expect(pick.textContent).toBe('')
    await waitFor(() => expect(told).toHaveBeenCalledWith({ lw: 'reader', type: 'pick', on: false }, '*'))
    // The tip draws the switch, says where it is and what it does.
    const tip = () => document.querySelector('.rd-hint')
    expect(tip()).toHaveTextContent(/^WRMark any words, or click at the top, then any part, to ask Writer$/)
    expect(screen.getByRole('img', { name: 'the Pick a part button' }).querySelector('svg .rd-pick-part')).not.toBeNull()
    // On: the page is told, and keeps the keys where it had them for a mouse's click; the tip says what to do now.
    fireEvent.click(pick, { detail: 1 })
    expect(pick).toHaveAttribute('aria-pressed', 'true')
    expect(pick).toHaveAttribute('title', 'Click any part of the page. Click here or press Esc to stop.')
    await waitFor(() => expect(told).toHaveBeenLastCalledWith({ lw: 'reader', type: 'pick', on: true }, '*'))
    expect(document.activeElement).not.toBe(frame)
    expect(tip()).toHaveTextContent(/^WRClick any part to ask Writer about it$/)
    // The arrow keys' part is said to a screen reader.
    fromPage({ type: 'pointing', text: 'The part “API”' })
    expect(screen.getByText('The part “API”')).toHaveAttribute('role', 'status')
    // Esc in the page, with no answer open over it, stops picking.
    fromPage({ type: 'escape' })
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(told).toHaveBeenLastCalledWith({ lw: 'reader', type: 'pick', on: false }, '*'))
    expect(screen.queryByText('The part “API”')).toBeNull()
    // Turned on from the keyboard, the page takes the keys and outlines where they start, and a screen reader is told how.
    fireEvent.click(pick, { detail: 0 })
    expect(document.activeElement).toBe(frame)
    await waitFor(() => expect(told).toHaveBeenLastCalledWith({ lw: 'reader', type: 'pick', on: true, keys: true }, '*'))
    expect(screen.getByText('Picking. Use the arrow keys, then Enter.')).toHaveAttribute('role', 'status')
    // Words asked about teach words, and asking stops picking: the page's own buttons work again.
    fromPage({ type: 'selection', text: 'Sales grew.', rect: { top: 10, bottom: 28, left: 20, right: 120 } })
    fireEvent.click(await screen.findByRole('button', { name: 'Ask' }))
    expect(window.localStorage.getItem('loomwatch.readerHint')).toBe('seen')
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    expect(tip()).toHaveTextContent(/^WRClick at the top, then any part, to ask Writer about it$/)
    // A part the page says was picked: asked about by its path, with no picture when the page drew none.
    fireEvent.click(pick, { detail: 1 })
    const at = { kind: 'element', what: 'part', path: 'body > svg > rect' }
    fromPage({ type: 'thing', what: 'part', path: 'body > svg > rect', text: 'The part “API”', rect: { top: 40, bottom: 90, left: 20, right: 220 } })
    expect(await screen.findByRole('toolbar', { name: 'Ask Writer about the part you marked' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenLastCalledWith(
      { runId: 'run-1', messageId: passageId(SITE, 'The part “API”', at as never), from: 'writer', to: null, kind: 'passage', text: 'The part “API”', file: SITE, at },
      undefined, 'writer',
    )
    expect(pick).toHaveAttribute('aria-pressed', 'false')
    // Asking about a part is what the tip teaches.
    expect(window.localStorage.getItem('loomwatch.readerHint.pick')).toBe('seen')
    expect(tip()).toBeNull()
    // The switch is for the file open now: another page opens with it off.
    fireEvent.click(pick, { detail: 1 })
    expect(pick).toHaveAttribute('aria-pressed', 'true')
    rerender({ file: { path: OTHER, runId: 'run-1', from: 'writer' } })
    await screen.findByRole('article', { name: 'other.html, read here' })
    expect(screen.getByRole('button', { name: 'Pick a part of the page to ask about' })).toHaveAttribute('aria-pressed', 'false')
    // The page's code has no parts to pick.
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }))
    expect(screen.queryByRole('button', { name: 'Pick a part of the page to ask about' })).toBeNull()
  })

  it('hands the page the files beside it that it asks for as it runs, inside its own folder only', async () => {
    const SITE = '/w/site/page.html'
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: SITE, name: 'page.html', kind: 'web', text: '<p>Sales</p>' }))
      : url.startsWith('/api/files/raw') && url.includes(encodeURIComponent('/w/site/data/sales.csv'))
        ? Promise.resolve(new Response('region,q3\nNorth,190\n', { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } }))
        : respond(404, {}))
    renderReader({ file: { path: SITE, runId: 'run-1', from: 'writer' } })
    const frame = await waitFor(() => {
      const element = document.querySelector('iframe')
      if (!element?.contentWindow) throw new Error('no frame yet')
      return element
    })
    const told = vi.spyOn(frame.contentWindow!, 'postMessage')
    const fromPage = (data: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { lw: 'reader', ...data }, source: frame.contentWindow })) })
    fromPage({ type: 'load', id: 7, url: 'data/sales.csv' })
    await waitFor(() => expect(told).toHaveBeenCalledWith(expect.objectContaining({ lw: 'reader', type: 'loaded', id: 7, status: 200, mediaType: 'text/csv; charset=utf-8' }), '*', [expect.any(ArrayBuffer)]))
    const [sent] = told.mock.calls.find(([message]) => (message as { id?: number }).id === 7)!
    expect(new TextDecoder().decode((sent as { body: ArrayBuffer }).body)).toBe('region,q3\nNorth,190\n')
    // Above the page's folder: not found, and the daemon is never asked.
    fromPage({ type: 'load', id: 8, url: '../other-team/secret.csv' })
    await waitFor(() => expect(told).toHaveBeenCalledWith({ lw: 'reader', type: 'loaded', id: 8, status: 404, mediaType: '', body: null }, '*', []))
    expect(vi.mocked(fetch).mock.calls.map(([input]) => decodeURIComponent(String(input))).join(' ')).not.toContain('secret')
  })

  it('opens a part’s answer when the page says its lit words were clicked, and places it where the page says the part is', async () => {
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: '/w/site.html', name: 'site.html', kind: 'web', text: `<p>${SALES}</p>` })) : respond(404, {}))
    const asked = [part({ state: 'said', by: 'writer', text: 'Up by twelve.', at: null }, { file: '/w/site.html' }), part({ state: 'working', by: 'research' }, { file: '/w/site.html', from: 'research', asked: '@Researcher why?', messageId: 'n-2' })]
    renderReader({ file: { path: '/w/site.html', runId: 'run-1', from: 'writer' }, asked })
    const frame = await waitFor(() => {
      const element = document.querySelector('iframe')
      if (!element?.contentWindow) throw new Error('no frame yet')
      return element
    })
    const told = vi.spyOn(frame.contentWindow!, 'postMessage')
    const fromPage = (data: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { lw: 'reader', ...data }, source: frame.contentWindow })) })
    fromPage({ type: 'ready' })
    // The page is told which parts to mark, and each ask's bubble, how it looks: it marks them itself.
    await waitFor(() => expect(told).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'marks', asking: null,
      parts: [
        { key: askKey(asked[0]), text: SALES, look: 'read', fresh: false, lit: false, open: false, label: "Writer's answer about “Sales grew 12% in Q3.”", title: 'Explain this part in plain words.', figure: null, initials: 'WR' },
        { key: askKey(asked[1]), text: SALES, look: 'busy', fresh: false, lit: false, open: false, label: 'Researcher is answering your question about “Sales grew 12% in Q3.”', title: 'Researcher is working · why?', figure: null, initials: 'RE' },
      ],
    }), '*'))
    expect(document.querySelector('.rd-mark, .rd-bubble')).toBeNull()
    // It says where its parts are, so the answer opens beside the one clicked.
    const at = (top: number) => ({ type: 'parts', parts: [{ text: SALES, rects: [{ top, bottom: top + 18, left: 100, right: 300 }], missing: false, dark: false }] })
    fromPage(at(40))
    fromPage({ type: 'open', key: askKey(asked[0]) })
    await waitFor(() => expect(told).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [expect.objectContaining({ lit: true, open: true }), expect.objectContaining({ lit: false, open: false })] }), '*'))
    const card = answerCard()!
    expect(card).toHaveTextContent('Up by twelve.')
    // Under the part (the frame sits at 0,0 in jsdom), clear of it.
    expect(Number.parseFloat(card.style.top)).toBeGreaterThan(58)
    expect(card.style.visibility).toBe('')
    // Escape pressed in the page closes it; the part's bubble opens it again.
    fromPage({ type: 'escape' })
    expect(answerCard()).toBeNull()
    fromPage({ type: 'open', key: askKey(asked[0]) })
    expect(answerCard()).not.toBeNull()
    // The page scrolled: the marks follow, and a part out of the frame's view has nothing to point at.
    fromPage(at(-200))
    expect(answerCard()).toBeNull()
    fromPage(at(120))
    expect(answerCard()).not.toBeNull()
    // The other agent's bubble opens its own answer, beside the same words.
    fromPage({ type: 'open', key: askKey(asked[1]) })
    expect(screen.getByRole('region', { name: "Researcher's answer to your question" })).toHaveTextContent('is working')
  })

  it('opens the card of the agent whose bubble in the page is pointed at, where the page says it is', async () => {
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: '/w/site.html', name: 'site.html', kind: 'web', text: `<p>${SALES}</p>` })) : respond(404, {}))
    const asked = [part({ state: 'said', by: 'writer', text: 'Up by twelve.', at: null }, { file: '/w/site.html', asked: '@Writer why?' })]
    renderReader({ file: { path: '/w/site.html', runId: 'run-1', from: 'writer' }, asked, faces: [{ id: 'writer', name: 'Writer', hue: 2, state: 'idle', stateWords: 'ready', model: null, role: 'Writes the report.', step: null, skills: 0, tools: 0, knowledge: 0 }] })
    const frame = await waitFor(() => {
      const element = document.querySelector('iframe')
      if (!element?.contentWindow) throw new Error('no frame yet')
      return element
    })
    const told = vi.spyOn(frame.contentWindow!, 'postMessage')
    const fromPage = (data: Record<string, unknown>) => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { lw: 'reader', ...data }, source: frame.contentWindow })) })
    fromPage({ type: 'ready' })
    // With the card to show, the page's bubble has no tooltip of its own.
    await waitFor(() => expect(told).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [expect.objectContaining({ key: askKey(asked[0]), title: '' })] }), '*'))
    fromPage({ type: 'hover', key: askKey(asked[0]), now: true, rect: { top: 40, bottom: 62, left: 300, right: 322 } })
    const card = screen.getByRole('tooltip')
    expect(card).toHaveTextContent('Writer')
    expect(card).toHaveTextContent('You asked: why?')
    // Under the bubble: the frame sits at 0,0 in jsdom.
    expect(card.style.top).toBe('70px')
    fromPage({ type: 'hover', key: null, now: true })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
