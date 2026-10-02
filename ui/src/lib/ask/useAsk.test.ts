import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../watch/events'
import { useAsk } from './useAsk'

const archive = vi.hoisted(() => ({ events: new Map<string, RunEvent[]>() }))
vi.mock('../watch/useSessionEvents', () => ({
  useSessionEvents: (sessionId: string) => ({ sessionId, events: archive.events.get(sessionId) ?? [], error: null, connected: true }),
}))

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const CONTEXT = { view: 'build' as const, teamPath: 'brief.yaml', runId: null }

let conversations: string[]
let posts: Array<{ url: string; body: unknown }>
let gone: Set<string>

beforeEach(() => {
  conversations = []
  posts = []
  gone = new Set()
  archive.events.clear()
  window.sessionStorage.clear()
  window.localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (init?.method === 'POST') posts.push({ url, body })
    if (url === '/api/ask/apps') return json(200, { apps: [{ id: 'claude', name: 'Claude', available: true, reason: null }], defaultApp: 'claude' })
    if (url === '/api/ask/inbox') return json(200, { items: [] })
    if (url === '/api/ask/conversations' && init?.method === 'POST') {
      const id = `ask-${conversations.length + 1}`
      conversations.push(id)
      return json(201, { id, app: 'claude', appName: 'Claude', state: 'starting' })
    }
    const message = url.match(/^\/api\/ask\/conversations\/([^/]+)\/messages$/)
    if (message) return gone.has(message[1]) ? json(410, { error: 'This conversation has ended. Start a new one.' }) : json(202, { state: 'working' })
    const status = url.match(/^\/api\/ask\/conversations\/([^/]+)$/)
    if (status) return gone.has(status[1]) || !conversations.includes(status[1]) ? json(404, { error: 'gone' }) : json(200, { id: status[1], state: 'ready' })
    if (url.endsWith('/settings')) return json(200, {})
    return json(404, { error: `unexpected ${url}` })
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('useAsk', () => {
  it('starts a conversation on the first message and says where the person is', async () => {
    const { result } = renderHook(() => useAsk(CONTEXT))
    await waitFor(() => expect(result.current.apps?.defaultApp).toBe('claude'))
    expect(result.current.unavailable).toBeNull()
    await act(async () => { expect(await result.current.send('  Add a fact-checker  ')).toBe(true) })
    expect(posts).toEqual([
      { url: '/api/ask/conversations', body: { askBeforeRun: true } },
      { url: '/api/ask/conversations/ask-1/messages', body: { text: 'Add a fact-checker', context: CONTEXT } },
    ])
    expect(result.current.conversationId).toBe('ask-1')
    expect(window.sessionStorage.getItem('loomwatch:ask:conversation')).toBe('ask-1')
    // Until the archive has the message, it shows as on its way.
    expect(result.current.pending).toBe('Add a fact-checker')
    expect(result.current.activity).toBe('Sending')
  })

  it('carries on in a new conversation when the old one ended', async () => {
    window.sessionStorage.setItem('loomwatch:ask:conversation', 'ask-old')
    const { result } = renderHook(() => useAsk(CONTEXT))
    await waitFor(() => expect(result.current.ended).toBe(true))
    await act(async () => { await result.current.send('Run it') })
    expect(posts.map((post) => post.url)).toEqual(['/api/ask/conversations', '/api/ask/conversations/ask-1/messages'])
  })

  it('starts again when a conversation ends between checking and sending', async () => {
    const { result } = renderHook(() => useAsk(CONTEXT))
    await act(async () => { await result.current.send('First') })
    gone.add('ask-1')
    await act(async () => { await result.current.send('Second') })
    expect(posts.map((post) => post.url)).toEqual([
      '/api/ask/conversations', '/api/ask/conversations/ask-1/messages',
      '/api/ask/conversations/ask-1/messages', '/api/ask/conversations', '/api/ask/conversations/ask-2/messages',
    ])
    expect(result.current.error).toBeNull()
  })

  it('remembers “ask me before starting a run” and tells a live conversation', async () => {
    const { result } = renderHook(() => useAsk(CONTEXT))
    await act(async () => { await result.current.send('Hello') })
    act(() => result.current.setAskBeforeRun(false))
    expect(window.localStorage.getItem('loomwatch:ask:ask-before-run')).toBe('0')
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/ask/conversations/ask-1/settings', body: { askBeforeRun: false } }))
    const again = renderHook(() => useAsk(CONTEXT))
    expect(again.result.current.askBeforeRun).toBe(false)
  })

  it('says plainly when no AI app can host Ask', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/ask/apps' ? json(200, { apps: [], defaultApp: null }) : json(200, { items: [] }))
    const { result } = renderHook(() => useAsk(CONTEXT))
    await waitFor(() => expect(result.current.unavailable).toMatch(/needs Claude Code, Codex, Gemini CLI or OpenCode/))
  })

  it('keeps the panel open across pages in the same tab', () => {
    const first = renderHook(() => useAsk(CONTEXT))
    act(() => first.result.current.setOpen(true))
    const next = renderHook(() => useAsk(CONTEXT))
    expect(next.result.current.open).toBe(true)
  })
})
