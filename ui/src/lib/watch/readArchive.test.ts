import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Reads under way are kept by the module: each test starts with none.
let readArchive: typeof import('./useSessionEvents').readArchive
beforeEach(async () => {
  vi.resetModules()
  ;({ readArchive } = await import('./useSessionEvents'))
})
afterEach(() => vi.unstubAllGlobals())

const URL = '/api/session/events?session=s&afterSeq=-1&limit=500&lean=true'

/** A fetch that answers only when told, and remembers whether its download was stopped. */
function heldFetch() {
  const calls: { signal: AbortSignal; answer: (body: unknown) => void }[] = []
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal!
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    calls.push({ signal, answer: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) })
  }))
  vi.stubGlobal('fetch', fetch)
  return { fetch, calls }
}

it('downloads a page once for two readers asking at the same moment, and keeps nothing after', async () => {
  const { fetch, calls } = heldFetch()
  const chat = readArchive<number[]>(URL, new AbortController().signal)
  const lessons = readArchive<number[]>(URL)
  calls[0].answer([1, 2])
  expect(await chat).toEqual([1, 2])
  expect(await lessons).toEqual([1, 2])
  expect(fetch).toHaveBeenCalledTimes(1)

  // Once it has arrived, the next read asks again: a run still going may have more by now.
  const later = readArchive<number[]>(URL)
  expect(fetch).toHaveBeenCalledTimes(2)
  calls[1].answer([1, 2, 3])
  expect(await later).toEqual([1, 2, 3])
})

// Opening a team, its chat's pieces and then its checkup's lessons read the same pages one after the other.
it('answers a later reader from a full page it read moments ago, never from one short of full', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const full = '/api/session/events?session=s&afterSeq=-1&limit=2&lean=true'
    const newest = '/api/session/events?session=s&afterSeq=1&limit=2&lean=true'
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === full ? [1, 2] : [3]), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    const chat = await readArchive<number[]>(full)
    await readArchive<number[]>(newest)
    vi.advanceTimersByTime(20_000)
    // The full page can't change: the same answer, not downloaded again.
    expect(await readArchive<number[]>(full)).toBe(chat)
    // The newest page of a run may have grown: asked again.
    await readArchive<number[]>(newest)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([full, newest, newest])

    // After half a minute it is read again.
    vi.advanceTimersByTime(11_000)
    await readArchive<number[]>(full)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([full, newest, newest, full])
  } finally {
    vi.useRealTimers()
  }
})

it('lets one reader stop without stopping another, and stops the download when all have stopped', async () => {
  const { fetch, calls } = heldFetch()
  const leaving = new AbortController()
  const stays = readArchive<number[]>(URL)
  const goes = readArchive<number[]>(URL, leaving.signal)
  leaving.abort()
  await expect(goes).rejects.toMatchObject({ name: 'AbortError' })
  expect(calls[0].signal.aborted).toBe(false)
  calls[0].answer([7])
  expect(await stays).toEqual([7])

  const first = new AbortController()
  const second = new AbortController()
  const one = readArchive(URL, first.signal)
  const two = readArchive(URL, second.signal)
  expect(fetch).toHaveBeenCalledTimes(2)
  first.abort()
  second.abort()
  await expect(one).rejects.toMatchObject({ name: 'AbortError' })
  await expect(two).rejects.toMatchObject({ name: 'AbortError' })
  expect(calls[1].signal.aborted).toBe(true)
})

it('gives every reader waiting the archive’s refusal', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No such session.' }), { status: 404 })))
  const one = readArchive(URL)
  const two = readArchive(URL)
  await expect(one).rejects.toThrow('No such session.')
  await expect(two).rejects.toThrow('No such session.')
})
