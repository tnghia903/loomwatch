import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '../runs/client'
import type { ChatItem, ChatMessage } from './client'
import type { Reaction } from './reactions'
import { useTeamChat } from './useTeamChat'

const run: RunRecord = {
  runId: 'run-1', sessionId: 'run-1', teamPath: 'news.yaml', prompt: 'today’s digest', status: 'succeeded', mode: 'pipeline',
  entrypoint: 'researcher', responder: 'writer', agentIds: ['researcher', 'writer'], createdAt: '2026-10-19T02:00:00.000Z',
  startedAt: '2026-10-19T02:00:00.000Z', finishedAt: '2026-10-19T02:04:00.000Z', error: null, exitCode: 0, eventCount: 10,
  reply: 'The chip story.', trigger: 'manual',
} as RunRecord

const hello: ChatMessage = {
  id: 'n-1', teamKey: 'news', teamPath: 'news.yaml', text: '@team hi team, I am Colin', createdAt: '2026-10-19T01:00:00.000Z', route: 'team_note',
  runId: null, agentId: null, deliveredAt: null, now: false, answers: { waiting: [], said: [{ from: 'writer', text: 'Hi Colin!', at: '2026-10-19T01:00:05.000Z' }] },
}

let stored: Reaction[] = []
let refuse = false
let posts = 0
/** The chat holds a team note rather than a piece of work. */
let noted = false

beforeEach(() => {
  vi.useFakeTimers()
  stored = []
  refuse = false
  posts = 0
  noted = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/chat?')) {
      const items: ChatItem[] = [noted ? { kind: 'note', message: hello, reactions: stored } : { kind: 'work', run, request: null, notes: [], reactions: stored }]
      return new Response(JSON.stringify({ teamKey: 'news', teamPath: 'news.yaml', items, more: false }), { status: 200 })
    }
    if (url === '/api/chat/reactions' && init?.method === 'POST') {
      posts += 1
      if (refuse) return new Response(JSON.stringify({ error: 'database is locked' }), { status: 500 })
      const body = JSON.parse(String(init.body)) as { anchor: string; target: string; face: Reaction['face'] | null }
      const reactions = body.face ? [{ target: body.target, face: body.face, at: '2026-10-19T02:05:00.000Z' }] : []
      return new Response(JSON.stringify({ anchor: body.anchor, reactions }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const faces = (items: ChatItem[]) => (items[0]?.reactions ?? []).map((reaction) => `${reaction.target}=${reaction.face}`)
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(8_000) })

describe('your reactions in the chat', () => {
  it('show at once, and a page read before the daemon had them cannot take them off', async () => {
    const { result } = renderHook(() => useTeamChat('news.yaml'))
    await settle()
    expect(faces(result.current.items)).toEqual([])

    let sent: Promise<void> = Promise.resolve()
    act(() => { sent = result.current.react('run-1', 'answer', 'love') })
    expect(faces(result.current.items)).toEqual(['answer=love'])
    await act(async () => { await sent })
    expect(posts).toBe(1)

    // A page that does not have it yet leaves it on.
    await poll()
    expect(faces(result.current.items)).toEqual(['answer=love'])
    // Once a page shows it back, the page is the record again: taken off elsewhere, it goes.
    stored = [{ target: 'answer', face: 'love', at: '2026-10-19T02:05:00.000Z' }]
    await poll()
    stored = []
    await poll()
    expect(faces(result.current.items)).toEqual([])
  })

  it('go back to what they were when the daemon refuses', async () => {
    stored = [{ target: 'answer', face: 'glad', at: '2026-10-19T02:05:00.000Z' }]
    const { result } = renderHook(() => useTeamChat('news.yaml'))
    await settle()
    expect(faces(result.current.items)).toEqual(['answer=glad'])

    refuse = true
    let sent: Promise<void> = Promise.resolve()
    act(() => { sent = result.current.react('run-1', 'answer', 'off') })
    expect(faces(result.current.items)).toEqual(['answer=off'])
    await act(async () => { await expect(sent).rejects.toThrow('database is locked') })
    expect(faces(result.current.items)).toEqual(['answer=glad'])
  })

  it('go on a team note and the agents\u2019 answers to it the same way, kept on the note', async () => {
    noted = true
    const { result } = renderHook(() => useTeamChat('news.yaml'))
    await settle()
    expect(result.current.items[0]?.kind).toBe('note')

    let sent: Promise<void> = Promise.resolve()
    act(() => { sent = result.current.react('n-1', 'reply:writer', 'glad') })
    expect(faces(result.current.items)).toEqual(['reply:writer=glad'])
    await act(async () => { await sent })
    // A page that does not have it yet leaves it on; one that has it keeps it.
    await poll()
    expect(faces(result.current.items)).toEqual(['reply:writer=glad'])
    stored = [{ target: 'reply:writer', face: 'glad', at: '2026-10-19T02:05:00.000Z' }]
    await poll()
    expect(faces(result.current.items)).toEqual(['reply:writer=glad'])

    refuse = true
    act(() => { sent = result.current.react('n-1', 'note:n-1', 'off') })
    expect(faces(result.current.items)).toEqual(['reply:writer=glad', 'note:n-1=off'])
    await act(async () => { await expect(sent).rejects.toThrow('database is locked') })
    expect(faces(result.current.items)).toEqual(['reply:writer=glad'])
  })

  it('stay on a piece when its run changes outside a page read', async () => {
    stored = [{ target: 'talk:h1:said', face: 'seen', at: '2026-10-19T02:05:00.000Z' }]
    const { result } = renderHook(() => useTeamChat('news.yaml'))
    await settle()
    act(() => result.current.applyRun({ ...run, status: 'cancelled' } as RunRecord))
    expect(faces(result.current.items)).toEqual(['talk:h1:said=seen'])
  })
})
