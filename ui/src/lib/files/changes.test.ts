import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem, ChatMessage, ReplyTo } from '../chat/client'
import type { RunRecord } from '../runs/client'
import { addChange, removeChange, sendChanges, withChanges, type FileChange } from './changes'
import { askedPassages, askKey, bubbleCardParts, bubbleLabel, fileAsks, partLook, passageId } from './passage'

const FILE = '/w/.loomwatch/t/writer/market.md'
const part = (text: string, at?: ReplyTo['at']): ReplyTo => ({ runId: 'run-0', messageId: passageId(FILE, text), from: 'writer', to: null, kind: 'passage', text, file: FILE, ...(at ? { at } : {}) })
const left = (id: string, state: FileChange['state'], overrides: Partial<FileChange> = {}): FileChange => ({
  id, teamPath: 't.yaml', file: FILE, agent: 'writer', words: `change ${id}`, part: part(`words ${id}`), files: [], createdAt: '2026-10-31T01:00:00.000Z',
  state, messageId: state === 'waiting' ? null : `m-${id}`, runId: state === 'sent' ? 'run-1' : null, kept: state === 'sent' ? `kept-${id}` : null, number: state === 'waiting' ? null : 1, ...overrides,
})
const message = (id: string, changes: ChatMessage['changes'], agentId = 'writer'): ChatMessage => ({
  id, teamKey: 't', teamPath: 't.yaml', text: `${changes?.length ?? 0} changes to market.md`, createdAt: '2026-10-31T02:00:00.000Z', route: 'agent', runId: 'run-1', agentId, deliveredAt: null, now: false, replyTo: null, changes,
})
const working = (request: ChatMessage, status = 'running', reply: string | null = null): ChatItem => ({ kind: 'work', run: { runId: 'run-1', status, reply, finishedAt: null } as unknown as RunRecord, request, notes: [] })

afterEach(() => vi.unstubAllGlobals())

describe('changes left on a file for its agents (ADR 0107)', () => {
  it('reads each change a message sent as its own part, going as the message’s work goes', () => {
    const sent = message('m-1', [
      { id: 'c-1', number: 1, words: 'Make it a question', part: part('Why customers stay') },
      { id: 'c-2', number: 2, words: 'Use our green', part: part('The chart', { kind: 'box', x: 0, y: 0, w: 5000, h: 5000 }) },
    ])
    const found = askedPassages([working(sent)])
    expect(found.map((passage) => [passage.text, passage.asked, passage.change?.id, passage.change?.number, passage.answer.state])).toEqual([
      ['Why customers stay', 'Make it a question', 'c-1', 1, 'working'],
      ['The chart', 'Use our green', 'c-2', 2, 'working'],
    ])
    expect(found[1].at).toEqual({ kind: 'box', x: 0, y: 0, w: 5000, h: 5000 })
    // Done: each says what the work said, a dot until read.
    const done = askedPassages([working(sent, 'succeeded', '1. Done. 2. Done.')])
    expect(done.map((passage) => partLook(passage.answer, false))).toEqual(['waiting', 'waiting'])
  })

  it('keeps a change apart from a question about the same words, and from another change there', () => {
    const asked = { file: FILE, text: 'Why customers stay', from: 'writer', asked: 'why?', runId: null, messageId: 'q', onItsOwn: false, answer: { state: 'sending' as const } }
    const one = { ...asked, asked: 'Make it a question', change: { id: 'c-1', state: 'waiting' as const, number: null, kept: null } }
    const two = { ...one, change: { ...one.change, id: 'c-2' } }
    expect(new Set([askKey(asked), askKey(one), askKey(two)]).size).toBe(3)
    expect(fileAsks([asked, one, two], FILE)).toHaveLength(3)
  })

  it('holds a change waiting for Send, or for its turn, at its part, and gives a sent one its kept copy', () => {
    const sentInChat = askedPassages([working(message('m-3', [{ id: 'c-3', number: 1, words: 'change c-3', part: part('words c-3') }]), 'succeeded', 'Done.')])
    const shown = withChanges(fileAsks(sentInChat, FILE), [left('c-1', 'waiting'), left('c-2', 'queued'), left('c-3', 'sent'), left('c-4', 'sent', { messageId: 'msg-4' })], FILE)
    const by = new Map(shown.map((passage) => [passage.change?.id, passage]))
    expect(by.get('c-1')?.answer).toEqual({ state: 'held', why: 'send' })
    expect(by.get('c-2')?.answer).toEqual({ state: 'held', why: 'turn' })
    expect(partLook(by.get('c-1')!.answer, false)).toBe('held')
    // Sent and in the chat: its answer, and the copy that puts it back.
    expect(by.get('c-3')?.answer.state).toBe('said')
    expect(by.get('c-3')?.change?.kept).toBe('kept-c-3')
    // Sent a moment ago, not in the chat yet: at work.
    expect(by.get('c-4')?.answer).toEqual({ state: 'working', by: 'writer' })
    // The daemon spells the file by its canonical path; the change is drawn at the file read here.
    expect(withChanges([], [left('c-9', 'waiting', { file: '/private/w/market.md' })], FILE).map((passage) => passage.file)).toEqual([FILE])
  })

  it('holds a change the chat has a message for while the daemon says it waits, for Send or for its turn', () => {
    const sent = message('m-5', [
      { id: 'c-1', number: 1, words: 'Make it a question', part: part('Why customers stay') },
      { id: 'c-2', number: 2, words: 'Use our green', part: part('The chart') },
    ])
    const shown = withChanges(fileAsks(askedPassages([working(sent)]), FILE), [left('c-1', 'waiting'), left('c-2', 'queued')], FILE)
    const by = new Map(shown.map((passage) => [passage.change?.id, passage]))
    expect(by.get('c-1')?.answer).toEqual({ state: 'held', why: 'send' })
    expect(by.get('c-2')?.answer).toEqual({ state: 'held', why: 'turn' })
    expect(shown).toHaveLength(2)
  })

  it('says a change waits for you while its agent asks something first, not that it is being made', () => {
    const name = (id: string) => (id === 'writer' ? 'Writer' : id)
    const sent = message('m-6', [{ id: 'c-1', number: 1, words: 'Make it a question', part: part('Why customers stay') }])
    const asking = { kind: 'work' as const, run: { runId: 'run-1', status: 'running', reply: null, finishedAt: null, permissionRequests: [{ id: 'p-1', agent: 'writer', name: 'Writer', title: 'Write market.md', kind: 'edit', since: '', expiresAt: '' }] } as unknown as RunRecord, request: sent, notes: [] }
    const [change] = askedPassages([asking])
    expect(change.answer).toEqual({ state: 'asking', by: 'writer' })
    // Gold, as an agent waiting for you is.
    expect(partLook(change.answer, false)).toBe('waiting')
    expect(bubbleLabel(change, 'waiting', name)).toBe('Writer asks you something before making your change to “Why customers stay”')
    expect(bubbleCardParts(change, 'waiting', name)).toEqual({ said: 'Asks you first, in the chat', words: 'Make it a question' })
    // Answered: at work again.
    const [working_] = askedPassages([working(sent)])
    expect(working_.answer).toEqual({ state: 'working', by: 'writer' })
    expect(bubbleCardParts(working_, 'busy', name).said).toBe('Making it')
  })

  it('leaves, takes back and sends changes from LoomWatch’s own page', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(new Response(String(input).endsWith('/send') ? '{"messages":[]}' : JSON.stringify(left('c-1', 'waiting')), { status: 200 }))
    }))
    await addChange({ teamPath: 't.yaml', file: FILE, agent: 'writer', words: 'Make it a question', part: part('Why customers stay'), files: [] })
    await removeChange('c-1')
    await sendChanges('t.yaml', FILE)
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([['/api/changes', 'POST'], ['/api/changes/c-1', 'DELETE'], ['/api/changes/send', 'POST']])
    for (const call of calls) expect(new Headers(call.init?.headers).get('X-LoomWatch-Request')).toBe('1')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ teamPath: 't.yaml', file: FILE, agent: 'writer', words: 'Make it a question' })
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ teamPath: 't.yaml', file: FILE })
  })
})
