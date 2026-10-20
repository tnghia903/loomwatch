import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { passageId, type AskedPassage } from '../../lib/files/passage'
import { EXPLAIN_WORDS, FileReader } from './FileReader'

const REPORT = '/teams/.loomwatch/market/writer/market-report.md'
const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const read = (overrides: Record<string, unknown> = {}) => ({
  path: REPORT, name: 'market-report.md', kind: 'markdown', text: '# Market report\n\nSales grew 12% in Q3.\n\nCosts fell.\n',
  extracted: false, truncated: false, sizeBytes: 2_048, modifiedAt: '2026-10-19T01:00:00Z', ...overrides,
})
let answer: (url: string) => Promise<Response>

beforeAll(() => {
  // jsdom lays nothing out: every marked range sits in the same place.
  Range.prototype.getBoundingClientRect = () => new DOMRect(120, 300, 160, 18)
  Range.prototype.getClientRects = () => [new DOMRect(120, 300, 160, 18)] as unknown as DOMRectList
})
beforeEach(() => {
  window.localStorage.clear()
  answer = (url) => (url.startsWith('/api/files/read')
    ? respond(200, read())
    : respond(200, { path: REPORT, name: 'market-report.md', exists: true, isDir: false, sizeBytes: 2048, modifiedAt: '2026-10-19T01:00:00Z', kind: 'markdown', folder: null, openable: true }))
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => answer(String(input))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const names = new Map([['writer', 'Writer']])
const renderReader = (props: Partial<Parameters<typeof FileReader>[0]> = {}) => {
  const onAsk = vi.fn()
  const onShowAsked = vi.fn()
  render(<FileReader file={{ path: REPORT, runId: 'run-1', from: 'writer' }} name={(id) => names.get(id) ?? id} hue={() => 2} onAsk={onAsk} onShowAsked={onShowAsked} {...props} />)
  return { onAsk, onShowAsked }
}

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
    expect(onAsk).toHaveBeenCalledWith({ runId: 'run-1', messageId: passageId(REPORT, 'Sales grew 12% in Q3.'), from: 'writer', to: null, kind: 'passage', text: 'Sales grew 12% in Q3.', file: REPORT }, undefined)
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
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ kind: 'passage', text: 'Costs fell.' }), EXPLAIN_WORDS)
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

  it('puts the face of the agent asked beside each part asked about, and shows the answer when pressed', async () => {
    const asked: AskedPassage[] = [{ file: REPORT, text: 'Sales grew 12% in Q3.', from: 'writer', asked: '@Writer why?', runId: 'run-2', messageId: 'm-2' }, { file: '/other.md', text: 'Costs fell.', from: 'writer', asked: 'x', runId: 'run-3', messageId: 'm-3' }]
    const { onShowAsked } = renderReader({ asked })
    const face = await screen.findByRole('button', { name: /^You asked Writer about “Sales grew 12% in Q3\.”: @Writer why\?/ })
    expect(screen.getAllByRole('button', { name: /^You asked/ })).toHaveLength(1)
    fireEvent.click(face)
    expect(onShowAsked).toHaveBeenCalledWith(asked[0])
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
})
