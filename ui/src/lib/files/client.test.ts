import { afterEach, describe, expect, it, vi } from 'vitest'

import { lookupFile, openFile } from './client'

const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

afterEach(() => vi.unstubAllGlobals())

describe('file client', () => {
  it('asks once for a file shown in several places at the same time', async () => {
    const fetchMock = vi.fn(() => respond(200, { path: '/t/a.pdf', name: 'a.pdf', exists: true, isDir: false, sizeBytes: 1, modifiedAt: null, kind: 'pdf', folder: null, openable: true }))
    vi.stubGlobal('fetch', fetchMock)
    const [first, second] = await Promise.all([lookupFile('/t/a.pdf'), lookupFile('/t/a.pdf')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(first.state).toBe('found')
    await lookupFile('/t/a.pdf')
    expect(fetchMock).toHaveBeenCalledTimes(2) // settled answers are not cached: files change
  })

  it('reports the teams-folder boundary apart from not knowing', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.includes('secret') ? respond(403, { error: 'outside the teams folder' }) : respond(404, {}))))
    expect(await lookupFile('/etc/secret.txt')).toEqual({ state: 'outside', message: 'outside the teams folder' })
    expect((await lookupFile('/t/older-daemon.pdf')).state).toBe('unknown')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    expect(await lookupFile('/t/b.pdf')).toEqual({ state: 'unknown', message: 'offline' })
  })

  it('opens with a JSON body and surfaces the daemon’s refusal', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => respond(422, { error: 'LoomWatch does not open code files; show it in its folder instead' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(openFile('/t/run.sh')).rejects.toThrow('show it in its folder')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/files/open')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({ path: '/t/run.sh', reveal: false })
  })
})
