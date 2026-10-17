import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MODEL } from '../ai/modelIds'
import { forgetKeyStatus } from '../ai/useKeyStatus'
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
let deletes: string[]
let gone: Set<string>
let keyed: boolean

beforeEach(() => {
  conversations = []
  posts = []
  deletes = []
  gone = new Set()
  keyed = true
  forgetKeyStatus()
  archive.events.clear()
  window.sessionStorage.clear()
  window.localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (init?.method === 'POST') posts.push({ url, body })
    if (init?.method === 'DELETE') { deletes.push(url); return json(204, null) }
    if (url === '/api/ai') return json(200, { openrouter: { connected: keyed } })
    if (url === '/api/ask/conversations' && init?.method === 'POST') {
      const id = `ask-${conversations.length + 1}`
      conversations.push(id)
      const chosen = (body as { model?: string } | undefined) ?? {}
      return json(201, { id, app: 'loomwatch', appName: 'LoomWatch', model: chosen.model ?? DEFAULT_MODEL, state: 'starting' })
    }
    const message = url.match(/^\/api\/ask\/conversations\/([^/]+)\/messages$/)
    if (message) return gone.has(message[1]) ? json(410, { error: 'This conversation has ended. Start a new one.' }) : json(202, { state: 'working' })
    const status = url.match(/^\/api\/ask\/conversations\/([^/]+)$/)
    if (status) return gone.has(status[1]) || !conversations.includes(status[1]) ? json(404, { error: 'gone' }) : json(200, { id: status[1], state: 'ready' })
    if (url.endsWith('/settings')) return json(200, {})
    return json(404, { error: `unexpected ${url}` })
  }))
})
// Without `globals`, Testing Library never unmounts on its own, and a hook left mounted can set
// state after the test file's window is gone.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('useAsk', () => {
  it('starts a conversation on the default model with the first message, and says where the person is', async () => {
    const { result } = renderHook(() => useAsk(CONTEXT))
    expect(result.current.selectedModel).toBe(DEFAULT_MODEL)
    await waitFor(() => expect(posts).toEqual([]))
    expect(result.current.unavailable).toBeNull()
    await act(async () => { expect(await result.current.send('  Add a fact-checker  ')).toBe(true) })
    expect(posts).toEqual([
      { url: '/api/ask/conversations', body: { askBeforeRun: true, model: DEFAULT_MODEL } },
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

  it('needs an OpenRouter key, and says so', async () => {
    keyed = false
    const { result } = renderHook(() => useAsk(CONTEXT))
    await waitFor(() => expect(result.current.needsKey).toBe(true))
    expect(result.current.unavailable).toMatch(/OpenRouter key/)
  })

  it('starts the next conversation on the model the person chose, and remembers it', async () => {
    const { result } = renderHook(() => useAsk(CONTEXT))
    act(() => result.current.chooseModel('openai/gpt-6.1-sol'))
    expect(result.current.selectedModel).toBe('openai/gpt-6.1-sol')
    await act(async () => { await result.current.send('Hello') })
    expect(posts[0]).toEqual({ url: '/api/ask/conversations', body: { askBeforeRun: true, model: 'openai/gpt-6.1-sol' } })
    const again = renderHook(() => useAsk(CONTEXT))
    expect(again.result.current.selectedModel).toBe('openai/gpt-6.1-sol')
  })

  it('ends a conversation when the person switches to another model, and keeps it for the same one', async () => {
    const { result } = renderHook(() => useAsk(CONTEXT))
    await act(async () => { await result.current.send('Hello') })
    expect(result.current.conversationId).toBe('ask-1')
    act(() => result.current.chooseModel(DEFAULT_MODEL))
    expect(result.current.conversationId).toBe('ask-1')
    expect(deletes).toEqual([])
    act(() => result.current.chooseModel('anthropic/claude-haiku-5.5'))
    expect(result.current.conversationId).toBeNull()
    await waitFor(() => expect(deletes).toEqual(['/api/ask/conversations/ask-1']))
    expect(window.sessionStorage.getItem('loomwatch:ask:conversation')).toBeNull()
  })

  it('keeps the panel open across pages in the same tab', () => {
    const first = renderHook(() => useAsk(CONTEXT))
    act(() => first.result.current.setOpen(true))
    const next = renderHook(() => useAsk(CONTEXT))
    expect(next.result.current.open).toBe(true)
  })
})
