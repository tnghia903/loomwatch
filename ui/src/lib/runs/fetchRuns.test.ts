import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const run = (runId: string, status = 'succeeded') => ({ runId, status, prompt: 'go', createdAt: '2026-11-11', teamPath: 'demo.yaml' })

// The list it read last is kept by the module: each test starts with a fresh one.
let fetchRuns: typeof import('./client').fetchRuns
beforeEach(async () => {
  vi.resetModules()
  ;({ fetchRuns } = await import('./client'))
})
afterEach(() => vi.unstubAllGlobals())

const sentTag = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers).get('If-None-Match')

it('reads the whole list once, then only hears that nothing changed, and keeps the very same list', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Headers(init?.headers).get('If-None-Match') === 'W/"runs-a-1-1"'
    ? new Response(null, { status: 304, headers: { ETag: 'W/"runs-a-1-1"' } })
    : new Response(JSON.stringify([run('r1')]), { status: 200, headers: { ETag: 'W/"runs-a-1-1"' } }))
  vi.stubGlobal('fetch', fetch)

  const first = await fetchRuns()
  expect(first.map((record) => record.runId)).toEqual(['r1'])
  expect(sentTag(fetch.mock.calls[0])).toBeNull()

  const second = await fetchRuns()
  expect(sentTag(fetch.mock.calls[1])).toBe('W/"runs-a-1-1"')
  // Not a copy: the same array, so nothing drawn from it is worked out again.
  expect(second).toBe(first)
})

it('takes a changed list whole and asks with its new version next time', async () => {
  const lists = [
    new Response(JSON.stringify([run('r1', 'running')]), { status: 200, headers: { ETag: 'W/"runs-a-1-1"' } }),
    new Response(JSON.stringify([run('r1')]), { status: 200, headers: { ETag: 'W/"runs-a-2-1"' } }),
    new Response(null, { status: 304, headers: { ETag: 'W/"runs-a-2-1"' } }),
  ]
  const fetch = vi.fn(async () => lists.shift()!)
  vi.stubGlobal('fetch', fetch)

  await fetchRuns()
  const changed = await fetchRuns()
  expect(changed[0].status).toBe('succeeded')
  expect(await fetchRuns()).toBe(changed)
  expect(fetch.mock.calls.map(sentTag)).toEqual([null, 'W/"runs-a-1-1"', 'W/"runs-a-2-1"'])
})

it('asks for the whole list every time from a daemon that gives no version', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify([run('r1')]), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  await fetchRuns()
  await fetchRuns()
  expect(fetch.mock.calls.map(sentTag)).toEqual([null, null])
})
