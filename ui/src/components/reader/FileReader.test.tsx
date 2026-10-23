import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentFacts } from '../../lib/chat/faces'
import { forgetAnswersRead } from '../../lib/files/answersRead'
import { askKey, passageId, type AskedPassage, type PassageAnswer } from '../../lib/files/passage'
import { EXPLAIN_WORDS, FileReader } from './FileReader'

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

  it('says when the work stopped, or nothing came back', async () => {
    const { rerender } = renderReader({ asked: [part({ state: 'failed', by: 'writer', text: 'The AI could not be reached.' })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Writer stopped before answering about “Sales grew 12% in Q3.”' }))
    expect(screen.getByRole('button', { name: 'Writer stopped before answering about “Sales grew 12% in Q3.”' })).toHaveAttribute('title', 'Stopped · Explain this part in plain words.')
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

  it('says a document’s words are its text without its layout', async () => {
    answer = (url) => (url.startsWith('/api/files/read') ? respond(200, read({ path: '/w/brief.docx', name: 'brief.docx', kind: 'document', text: 'Brief\n\nWe sell tea.', extracted: true })) : respond(404, {}))
    renderReader({ file: { path: '/w/brief.docx', runId: 'run-1', from: 'writer' } })
    expect(await screen.findByText(/These are the words of the word document, as your agents read them/)).toBeInTheDocument()
    expect(document.querySelector('.rd-doc-heading')).toHaveTextContent('Brief')
    expect(screen.getByText('We sell tea.')).toBeInTheDocument()
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
