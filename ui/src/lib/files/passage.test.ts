import { describe, expect, it } from 'vitest'

import type { ChatItem, ChatMessage, ReplyTo } from '../chat/client'
import type { RunRecord } from '../runs/client'
import { answerPlace, askedInChat, askedPassages, askKey, bubbleCardLine, bubblePlace, fileAsks, findPassage, pageText, partBox, partLines, partLook, partTexts, PASSAGE_MAX_CHARS, passageId, passageOf, passageReply, wordsLook, wordsOpen, type AskedPassage } from './passage'

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
  const message = (id: string, text: string, replyTo: ReplyTo | null, runId: string | null = 'run-1', at = '01:00'): ChatMessage => ({
    id, teamKey: 't', teamPath: 't.yaml', text, createdAt: `2026-10-19T${at}:00.000Z`, route: 'agent', runId, agentId: 'writer', deliveredAt: null, now: false, replyTo,
  })
  const work = (runId: string, request: ChatMessage | null, notes: ChatMessage[] = []): ChatItem => ({ kind: 'work', run: { runId } as RunRecord, request, notes })

  it('finds them in messages that started work, notes into it, notes on their own and messages on their way, oldest first by when they were asked', () => {
    // As the chat keeps them: oldest first, a note sent into work kept with that work.
    const items: ChatItem[] = [
      work('run-1', message('m-1', 'start', { ...passage('x'), kind: 'answer', file: undefined }, 'run-1', '01:00')),
      work('run-2', message('m-2', 'why?', passage('Sales grew'), 'run-2', '01:01'), [message('n-1', 'shorter', passage('Q3 note'), 'run-2', '01:05')]),
      { kind: 'note', message: message('n-2', 'and this', passage('Costs fell'), null, '01:03') },
    ]
    const found = askedPassages(items, [{ text: '@Writer explain', replyTo: passage('On its way') }])
    expect(found.map((item) => [item.text, item.asked, item.runId, item.messageId])).toEqual([
      ['Sales grew', 'why?', 'run-2', 'm-2'],
      ['Costs fell', 'and this', 'run-1', 'n-2'],
      ['Q3 note', 'shorter', 'run-2', 'n-1'],
      ['On its way', '@Writer explain', 'run-1', null],
    ])
  })

  it('names the agent asked, which need not be the one who made the file', () => {
    const items: ChatItem[] = [
      { kind: 'note', message: { ...message('n-1', 'for everyone', passage('Costs fell'), null, '01:00'), route: 'team_note', agentId: null } },
      work('run-2', { ...message('m-2', '@Researcher why?', passage('Sales grew'), 'run-2', '01:02'), agentId: 'researcher' }),
    ]
    const found = askedPassages(items, [{ text: '@Researcher explain', replyTo: passage('On its way'), to: { kind: 'agent', agent: 'researcher' } }])
    expect(found.map((item) => [item.text, item.from])).toEqual([
      ['Costs fell', 'writer'],
      ['Sales grew', 'researcher'],
      ['On its way', 'researcher'],
    ])
  })
})

describe('the asks a file shows', () => {
  const ask = (text: string, from: string, asked: string, more: Partial<AskedPassage> = {}): AskedPassage => ({
    file: '/w/lesson.html', text, from, asked, runId: null, messageId: asked, onItsOwn: true, answer: { state: 'none', why: 'note' }, ...more,
  })

  it('keeps each agent asked about the same words, oldest first, and an agent asked again only for its newest', () => {
    const asked = [
      ask('not derived', 'tutor', 'bold this text'),
      ask('Markov-chain', 'tutor', 'why?'),
      ask('not derived', 'checker', 'Explain this part in plain words.'),
      ask('Sales', 'tutor', 'elsewhere', { file: '/w/other.md' }),
      ask('Markov-chain', 'tutor', 'shorter, please'),
    ]
    expect(fileAsks(asked, '/w/lesson.html').map((item) => [item.text, item.from, item.asked])).toEqual([
      ['not derived', 'tutor', 'bold this text'],
      ['not derived', 'checker', 'Explain this part in plain words.'],
      ['Markov-chain', 'tutor', 'shorter, please'],
    ])
    expect(askKey(asked[0])).not.toBe(askKey(asked[2]))
    expect(askKey(asked[1])).toBe(askKey(asked[4]))
  })

  it('marks each part’s words once, in the order of its newest ask', () => {
    expect(partTexts([{ text: 'a' }, { text: 'b' }, { text: 'a' }, { text: 'c' }])).toEqual(['b', 'a', 'c'])
  })

  it('shows words asked about by several agents at work while any is, waiting while any answer waits, and opens the newest waiting answer', () => {
    expect(wordsLook(['read', 'busy', 'waiting'])).toBe('busy')
    expect(wordsLook(['read', 'waiting', 'failed'])).toBe('waiting')
    expect(wordsLook(['read', 'failed'])).toBe('failed')
    expect(wordsLook([])).toBe('read')
    const look = (ask: { look: 'busy' | 'waiting' | 'read' | 'failed' }) => ask.look
    expect(wordsOpen([{ id: 1, look: 'waiting' }, { id: 2, look: 'waiting' }, { id: 3, look: 'read' }] as const, look)?.id).toBe(2)
    expect(wordsOpen([{ id: 1, look: 'read' }, { id: 2, look: 'busy' }] as const, look)?.id).toBe(2)
    expect(wordsOpen([], look)).toBeUndefined()
  })
})

describe('what a bubble’s agent card says', () => {
  const asked = (answer: AskedPassage['answer']): AskedPassage => ({ file: '/w/a.md', text: 'x', from: 'writer', asked: '@Writer why?', runId: null, messageId: 'm', onItsOwn: true, answer })
  const name = (id: string) => (id === 'writer' ? 'Writer' : id)

  it('is what you asked, after what came of it while that is news', () => {
    expect(bubbleCardLine(asked({ state: 'said', by: 'writer', text: 'y', at: null }), 'read', name)).toBe('You asked: why?')
    expect(bubbleCardLine(asked({ state: 'said', by: 'writer', text: 'y', at: null }), 'waiting', name)).toBe('New answer · You asked: why?')
    expect(bubbleCardLine(asked({ state: 'writing', by: 'writer' }), 'busy', name)).toBe('Writing its answer · You asked: why?')
    expect(bubbleCardLine(asked({ state: 'failed', by: 'writer', text: 'z' }), 'failed', name)).toBe('Stopped · You asked: why?')
    expect(bubbleCardLine(asked({ state: 'unsent' }), 'failed', name)).toBe('Not sent · You asked: why?')
  })
})

describe('what came of asking about a part', () => {
  const at = '2026-10-19T01:00:00Z'
  const now = Date.parse(at) + 30_000
  const part: ReplyTo = { runId: 'run-1', messageId: passageId('/w/market.md', 'Sales grew'), from: 'writer', to: null, kind: 'passage', text: 'Sales grew', file: '/w/market.md' }
  const asked = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    id: 'n-1', teamKey: 't', teamPath: 't.yaml', text: '@Writer Explain this part in plain words.', createdAt: at, route: 'team_note', runId: null, agentId: 'writer', deliveredAt: null, now: false, replyTo: part, ...overrides,
  })
  const note = (answers: ChatMessage['answers'], agentId: string | null = 'writer'): ChatItem => ({ kind: 'note', message: asked({ answers, agentId }) })
  const work = (run: Partial<RunRecord>): ChatItem => ({
    kind: 'work',
    run: { runId: 'run-2', status: 'running', responder: 'writer', reply: null, error: null, finishedAt: null, ...run } as RunRecord,
    request: asked({ id: 'm-2', route: 'agent', runId: 'run-2', text: '@Writer make it shorter' }),
    notes: [],
  })
  const answerOf = (item: ChatItem, time = now) => askedPassages([item], [], time)[0].answer

  it('is the asked agent writing its answer in the chat, then what it said, not what another said', () => {
    expect(answerOf(note({ waiting: ['writer'], said: [] }))).toEqual({ state: 'writing', by: 'writer' })
    expect(answerOf(note({ waiting: [], said: [{ from: 'research', text: 'Not mine to answer.', at }, { from: 'writer', text: '**Sales** rose.', at }] })))
      .toEqual({ state: 'said', by: 'writer', text: '**Sales** rose.', at })
    // The one asked had nothing to add: the other's answer is not its.
    expect(answerOf(note({ waiting: [], said: [{ from: 'research', text: 'Here is why.', at }] }))).toEqual({ state: 'none', why: 'passed' })
  })

  it('asked of everyone, is the first to answer, or the one who made the file still writing, else the first', () => {
    expect(answerOf(note({ waiting: ['writer'], said: [{ from: 'research', text: 'Here is why.', at }] }, null))).toEqual({ state: 'said', by: 'research', text: 'Here is why.', at })
    expect(answerOf(note({ waiting: ['research', 'writer'], said: [] }, null))).toEqual({ state: 'writing', by: 'writer' })
    expect(answerOf(note({ waiting: ['research', 'editor'], said: [] }, null))).toEqual({ state: 'writing', by: 'research' })
  })

  it('is nothing, and says why: a note for the team, an answer that never came', () => {
    expect(answerOf(note(null))).toEqual({ state: 'none', why: 'note' })
    expect(answerOf(note({ waiting: ['writer'], said: [] }), now + 10 * 60_000)).toEqual({ state: 'none', why: 'lost' })
  })

  it('is the work the message started: at work, then its answer, or what stopped it', () => {
    expect(answerOf(work({ status: 'running', working: ['editor'] }))).toEqual({ state: 'working', by: 'editor' })
    expect(answerOf(work({ status: 'queued' }))).toEqual({ state: 'working', by: 'writer' })
    expect(answerOf(work({ status: 'succeeded', reply: 'Shorter now: **two** lines.', finishedAt: at }))).toEqual({ state: 'said', by: 'writer', text: 'Shorter now: **two** lines.', at })
    expect(answerOf(work({ status: 'failed', error: 'The AI could not be reached.\nretry later' }))).toEqual({ state: 'failed', by: 'writer', text: 'The AI could not be reached.' })
    expect(answerOf(work({ status: 'cancelled' }))).toEqual({ state: 'none', why: 'stopped' })
    expect(answerOf(work({ status: 'succeeded', reply: ' ' }))).toEqual({ state: 'none', why: 'lost' })
  })

  it('is on its way while your message is, and not sent when the chat could not send it', () => {
    expect(askedPassages([], [{ text: '@Writer explain', replyTo: part }], now)[0].answer).toEqual({ state: 'sending' })
    const unsent = askedPassages([], [{ text: '@Writer explain', replyTo: part, state: 'failed' }], now)[0]
    expect(unsent.answer).toEqual({ state: 'unsent' })
    expect(partLook(unsent.answer, false)).toBe('failed')
    // It waits at the bottom of the chat, with Try again.
    expect(askedInChat(unsent)).toEqual({ runId: '', id: 'pending' })
  })

  it('is shown in the chat where it is kept: under your message, or as the answer of the work', () => {
    expect(askedInChat(askedPassages([note({ waiting: [], said: [] })], [], now)[0])).toEqual({ runId: '', id: 'note:n-1' })
    expect(askedInChat(askedPassages([work({ status: 'succeeded', reply: 'Done.' })], [], now)[0])).toEqual({ runId: 'run-2', id: 'answer:run-2' })
    // Not yet in the chat: nowhere to show, and never the work that made the file.
    expect(askedInChat(askedPassages([], [{ text: '@Writer explain', replyTo: part }], now)[0])).toBeNull()
  })
})

describe('where an answer sits beside the part it answers', () => {
  const view = { top: 100, left: 40, width: 600, height: 500 }
  const size = { width: 360, height: 120 }
  it('under the part, centred on it, its point at the part', () => {
    expect(answerPlace({ top: 200, bottom: 218, left: 300, right: 400 }, view, size)).toEqual({ top: 128, left: 130, above: false, arrow: 180 })
  })
  it('over the part when there is more room there', () => {
    expect(answerPlace({ top: 520, bottom: 538, left: 300, right: 400 }, view, size)).toMatchObject({ top: 290, above: true })
  })
  it('inside the view at its sides, still pointing at the part', () => {
    expect(answerPlace({ top: 200, bottom: 218, left: 50, right: 70 }, view, size)).toMatchObject({ left: 8, arrow: 18 })
    expect(answerPlace({ top: 200, bottom: 218, left: 600, right: 620 }, view, size)).toMatchObject({ left: 232, arrow: 338 })
  })
  it('nowhere while the part is scrolled out of sight', () => {
    expect(answerPlace({ top: 70, bottom: 90, left: 300, right: 400 }, view, size)).toBeNull()
    expect(answerPlace({ top: 610, bottom: 628, left: 300, right: 400 }, view, size)).toBeNull()
  })
})

describe('a part asked about, as it is marked', () => {
  it('is one box a line, however many pieces of text the line holds, with empty boxes left out', () => {
    const box = (top: number, left: number, right: number, bottom = top + 18) => ({ top, bottom, left, right })
    expect(partLines([box(40, 200, 260), box(10, 100, 150), box(11, 150, 300, 28), box(40, 10, 10), box(40, 10, 60)])).toEqual([
      box(10, 100, 300, 28),
      box(40, 10, 260),
    ])
    expect(partBox(partLines([box(10, 100, 300), box(40, 10, 260)]))).toEqual({ top: 10, bottom: 58, left: 10, right: 300 })
    expect(partBox([])).toBeNull()
  })

  it('looks busy while the agent is at it, waiting until its answer is read, and quiet after', () => {
    expect(partLook({ state: 'sending' }, false)).toBe('busy')
    expect(partLook({ state: 'writing', by: 'writer' }, false)).toBe('busy')
    expect(partLook({ state: 'working', by: 'writer' }, false)).toBe('busy')
    expect(partLook({ state: 'said', by: 'writer', text: 'x', at: null }, false)).toBe('waiting')
    expect(partLook({ state: 'said', by: 'writer', text: 'x', at: null }, true)).toBe('read')
    expect(partLook({ state: 'failed', by: 'writer', text: 'x' }, false)).toBe('failed')
    expect(partLook({ state: 'none', why: 'note' }, false)).toBe('read')
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
