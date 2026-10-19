import { describe, expect, it } from 'vitest'

import type { ChatItem, ChatMessage, ReplyTo } from '../chat/client'
import type { RunRecord } from '../runs/client'
import { askedPassages, bubblePlace, findPassage, pageText, PASSAGE_MAX_CHARS, passageId, passageOf, passageReply } from './passage'

describe('a marked part, as it is asked about', () => {
  it('keeps its lines, trims its edges and blank runs, and refuses a stray letter', () => {
    expect(passageOf('  Sales grew 12%  \r\n\r\n\r\n\tin Q3.  ')).toBe('Sales grew 12%\n\n\tin Q3.')
    expect(passageOf(' a ')).toBeNull()
    expect(passageOf('\n \n')).toBeNull()
    expect(passageOf('ok')).toBe('ok')
  })

  it('cuts a very long part, saying so', () => {
    const cut = passageOf('word '.repeat(2_000))!
    expect([...cut].length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS + 1)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('is a reply that names its file, with a short id that is the same for the same words', () => {
    const reply = passageReply({ path: '/w/market.md', runId: 'run-1', from: 'writer' }, 'Sales grew')
    expect(reply).toMatchObject({ kind: 'passage', file: '/w/market.md', from: 'writer', runId: 'run-1', to: null, text: 'Sales grew' })
    expect(reply.messageId).toBe(passageId('/w/market.md', 'Sales grew'))
    expect(reply.messageId).not.toBe(passageId('/w/other.md', 'Sales grew'))
    expect(reply.messageId.length).toBeLessThan(40)
  })
})

describe('the parts a chat asked about', () => {
  const passage = (text: string, file = '/w/market.md'): ReplyTo => ({ runId: 'run-1', messageId: passageId(file, text), from: 'writer', to: null, kind: 'passage', text, file })
  const message = (id: string, text: string, replyTo: ReplyTo | null, runId: string | null = 'run-1'): ChatMessage => ({
    id, teamKey: 't', teamPath: 't.yaml', text, createdAt: '2026-10-19T01:00:00Z', route: 'agent', runId, agentId: 'writer', deliveredAt: null, now: false, replyTo,
  })
  const work = (runId: string, request: ChatMessage | null, notes: ChatMessage[] = []): ChatItem => ({ kind: 'work', run: { runId } as RunRecord, request, notes })

  it('finds them in messages that started work, notes into it, notes on their own and messages on their way, oldest first', () => {
    const items: ChatItem[] = [
      { kind: 'note', message: message('n-2', 'and this', passage('Costs fell'), null) },
      work('run-2', message('m-2', 'why?', passage('Sales grew'), 'run-2'), [message('n-1', 'shorter', passage('Q3 note'), 'run-2')]),
      work('run-1', message('m-1', 'start', { ...passage('x'), kind: 'answer', file: undefined })),
    ]
    const found = askedPassages(items, [{ text: '@Writer explain', replyTo: passage('On its way') }])
    expect(found.map((item) => [item.text, item.asked, item.runId, item.messageId])).toEqual([
      ['Sales grew', 'why?', 'run-2', 'm-2'],
      ['Q3 note', 'shorter', 'run-2', 'n-1'],
      ['Costs fell', 'and this', 'run-1', 'n-2'],
      ['On its way', '@Writer explain', 'run-1', null],
    ])
  })

  it('names the agent asked, which need not be the one who made the file', () => {
    const items: ChatItem[] = [
      work('run-2', { ...message('m-2', '@Researcher why?', passage('Sales grew'), 'run-2'), agentId: 'researcher' }),
      { kind: 'note', message: { ...message('n-1', 'for everyone', passage('Costs fell'), null), route: 'team_note', agentId: null } },
    ]
    const found = askedPassages(items, [{ text: '@Researcher explain', replyTo: passage('On its way'), to: { kind: 'agent', agent: 'researcher' } }])
    expect(found.map((item) => [item.text, item.from])).toEqual([
      ['Costs fell', 'writer'],
      ['Sales grew', 'researcher'],
      ['On its way', 'researcher'],
    ])
  })
})

describe('finding a part on the page again', () => {
  const page = (html: string) => {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    return root
  }

  it('finds it across elements and however the page spaced its words', () => {
    const root = page('<h2>Market</h2><p>Sales <strong>grew   12%</strong>\n in Q3.</p><ul><li>Costs fell.</li></ul>')
    const text = pageText(root)
    const range = findPassage(text, 'Sales grew 12% in Q3.')!
    expect(range.toString().replace(/\s+/g, ' ')).toBe('Sales grew 12% in Q3.')
    // A part that spans two blocks, as a selection copies it with a line between.
    expect(findPassage(text, 'in Q3.\n\nCosts fell.')!.toString()).toContain('Costs fell.')
    expect(findPassage(text, 'Not in it')).toBeNull()
    root.remove()
  })

  it('skips the reader’s own controls, and finds a cut part by its start', () => {
    const long = 'word '.repeat(200)
    const root = page(`<p>${long}</p><span data-reader-chrome>Sales</span>`)
    const text = pageText(root)
    expect(text.chars.includes('Sales')).toBe(false)
    expect(findPassage(text, `${long.slice(0, 900)}and more…`)).not.toBeNull()
    root.remove()
  })
})

describe('where the ask bubble sits', () => {
  const view = { top: 100, left: 50, width: 600 }
  const size = { width: 160, height: 40 }
  it('above the marked words, centred on them', () => {
    expect(bubblePlace({ top: 300, bottom: 318, left: 250, right: 350 }, view, { top: 0, left: 0 }, size)).toEqual({ top: 150, left: 250, below: false })
  })
  it('below them at the top of the view, and never past its sides', () => {
    expect(bubblePlace({ top: 110, bottom: 128, left: 52, right: 60 }, view, { top: 0, left: 0 }, size)).toEqual({ top: 38, left: 88, below: true })
    expect(bubblePlace({ top: 300, bottom: 318, left: 640, right: 650 }, view, { top: 0, left: 0 }, size).left).toBe(512)
  })
})
