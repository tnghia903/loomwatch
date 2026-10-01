import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CAPABILITY_NOT_FOUND, STALE_DAEMON, STALE_DETAILS_DAEMON, fetchCapabilities, fetchCapabilityDetails } from './client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

function response(init: { status?: number; contentType?: string; body?: unknown }) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: '',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? init.contentType ?? 'application/json' : null) },
    json: async () => init.body ?? {},
  } as unknown as Response
}

describe('fetchCapabilities', () => {
  it('returns the inventory the daemon scanned', async () => {
    fetchMock.mockResolvedValue(response({ body: { skills: [{ name: 'notebooklm' }], tools: [], sources: [] } }))
    await expect(fetchCapabilities()).resolves.toMatchObject({ skills: [{ name: 'notebooklm' }] })
  })

  // `loomwatchd` embeds the UI at build time, so a daemon left running from before this endpoint
  // existed serves the new bundle and then answers its scan with the SPA's HTML. That used to
  // reach the operator as `Unexpected token '<'`, which reads like a broken scanner rather than a
  // daemon that needs restarting.
  it('names a daemon older than the app it serves, instead of a JSON parse error', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'text/html' }))
    await expect(fetchCapabilities()).rejects.toThrow(STALE_DAEMON)

    fetchMock.mockResolvedValue(response({ status: 404, body: { error: 'API route not found' } }))
    await expect(fetchCapabilities()).rejects.toThrow(STALE_DAEMON)
  })

  it('still reports a genuine server failure as itself', async () => {
    fetchMock.mockResolvedValue({ ...response({ status: 500 }), statusText: 'Internal Server Error' } as Response)
    await expect(fetchCapabilities()).rejects.toThrow('Internal Server Error')
  })
})

describe('fetchCapabilityDetails', () => {
  it('loads a selected skill definition on demand', async () => {
    fetchMock.mockResolvedValue(response({ body: {
      id: 'skill-notebooklm', kind: 'skill', definitions: [{ source: 'Codex', path: '/skills/notebooklm/SKILL.md', content: '# Instructions' }],
    } }))

    await expect(fetchCapabilityDetails('skill-notebooklm')).resolves.toMatchObject({
      definitions: [{ content: '# Instructions' }],
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/skill-notebooklm')
  })

  it('explains that an older daemon must be restarted', async () => {
    fetchMock.mockResolvedValue(response({ status: 404, body: { error: 'API route not found' } }))
    await expect(fetchCapabilityDetails('skill-old')).rejects.toThrow(STALE_DETAILS_DAEMON)
  })

  /** A current daemon that does not know the id is not a stale daemon, and must not say so. */
  it('says a capability is missing, not that the daemon is old, when the id is unknown', async () => {
    fetchMock.mockResolvedValue(response({ status: 404, body: { error: 'unknown capability "skill:claude-design"' } }))
    await expect(fetchCapabilityDetails('skill:claude-design')).rejects.toThrow(CAPABILITY_NOT_FOUND)
  })
})
