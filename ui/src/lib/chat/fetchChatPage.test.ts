import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const note = (id: string) => ({ kind: 'note', message: { id, text: 'hi', createdAt: '2026-11-11T00:00:00Z' }, reactions: [] })
const page = (...ids: string[]) => JSON.stringify({ teamKey: 'news', teamPath: 'news.yaml', items: ids.map(note), more: false })

// The pages it read last are kept by the module: each test starts with none.
let fetchChatPage: typeof import('./client').fetchChatPage
beforeEach(async () => {
  vi.resetModules()
  ;({ fetchChatPage } = await import('./client'))
})
afterEach(() => vi.unstubAllGlobals())

const sentTag = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers).get('If-None-Match')

it('reads a page whole once, then only hears that nothing changed, and keeps the very same page', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Headers(init?.headers).get('If-None-Match') === 'W/"chat-a"'
    ? new Response(null, { status: 304, headers: { ETag: 'W/"chat-a"' } })
    : new Response(page('n1'), { status: 200, headers: { ETag: 'W/"chat-a"' } }))
  vi.stubGlobal('fetch', fetch)

  const first = await fetchChatPage('news.yaml', null, 20)
  const second = await fetchChatPage('news.yaml', null, 20)
  expect(fetch.mock.calls.map(sentTag)).toEqual([null, 'W/"chat-a"'])
  // Not a copy: the same page and items, so nothing on it is compared or drawn again.
  expect(second).toBe(first)
  expect(second.items[0]).toBe(first.items[0])
})

it('takes a changed page whole, and keeps each page’s version apart', async () => {
  const replies = [
    new Response(page('n1'), { status: 200, headers: { ETag: 'W/"chat-a"' } }),
    new Response(page('n0'), { status: 200, headers: { ETag: 'W/"chat-old"' } }),
    new Response(page('n1', 'n2'), { status: 200, headers: { ETag: 'W/"chat-b"' } }),
  ]
  const fetch = vi.fn(async () => replies.shift()!)
  vi.stubGlobal('fetch', fetch)

  await fetchChatPage('news.yaml', null, 20)
  // An older page has an address and a version of its own.
  await fetchChatPage('news.yaml', '2026-11-10T00:00:00Z', 20)
  const changed = await fetchChatPage('news.yaml', null, 20)
  expect(changed.items).toHaveLength(2)
  expect(fetch.mock.calls.map(sentTag)).toEqual([null, null, 'W/"chat-a"'])
})

it('asks for the whole page every time from a daemon that gives no version', async () => {
  const fetch = vi.fn(async () => new Response(page('n1'), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  await fetchChatPage('news.yaml', null, 20)
  await fetchChatPage('news.yaml', null, 20)
  expect(fetch.mock.calls.map(sentTag)).toEqual([null, null])
})
