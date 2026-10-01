import { afterEach, describe, expect, it, vi } from 'vitest'

import { DAEMON_UNREACHABLE, daemonFetch } from './daemonFetch'

afterEach(() => vi.unstubAllGlobals())

describe('daemonFetch', () => {
  it('turns a refused connection into one sentence the operator can act on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(daemonFetch('/api/teams')).rejects.toThrow(DAEMON_UNREACHABLE)
  })

  it('treats a proxy’s empty 502 as the daemon being down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))
    await expect(daemonFetch('/api/teams')).rejects.toThrow(DAEMON_UNREACHABLE)
  })

  it('passes the daemon’s own answers through, errors included', async () => {
    const answer = new Response(JSON.stringify({ error: 'busy' }), { status: 503, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn().mockResolvedValue(answer)
    vi.stubGlobal('fetch', fetchMock)
    await expect(daemonFetch('/api/runs', { method: 'POST' })).resolves.toBe(answer)
    expect(fetchMock).toHaveBeenCalledWith('/api/runs', { method: 'POST' })
  })

  it('lets an abort stay an abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')))
    await expect(daemonFetch('/api/runs')).rejects.toMatchObject({ name: 'AbortError' })
  })
})
