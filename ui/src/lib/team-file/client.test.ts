import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchConfigSchema, fetchTeamFile, fetchTeamsDiscovery, saveTeamFile, TeamFileApiError } from './client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchTeamFile', () => {
  it('GETs /api/team with the path as a query parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/a b.yaml', yaml: 'x: 1\n' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchTeamFile('/teams/a b.yaml')

    expect(fetchMock).toHaveBeenCalledWith('/api/team?path=%2Fteams%2Fa+b.yaml')
    expect(result).toEqual({ path: '/teams/a b.yaml', yaml: 'x: 1\n' })
  })

  it('throws TeamFileApiError with the daemon message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(404, { error: 'team file not found' })),
    )

    const failure = fetchTeamFile('/teams/missing.yaml')
    await expect(failure).rejects.toThrow(TeamFileApiError)
    await expect(failure).rejects.toThrow('team file not found')
  })
})

describe('fetchTeamsDiscovery', () => {
  it('loads the canonical teams root used for absolute display paths', async () => {
    const payload = { root: '/Users/operator/.loomwatch/teams', files: ['nested/research.yaml'] }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTeamsDiscovery()).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith('/api/teams')
  })
})

describe('saveTeamFile', () => {
  it('PUTs the path and yaml as a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/a.yaml', yaml: 'x: 1\n' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveTeamFile('/teams/a.yaml', 'x: 1\n', 'sha256:abc')

    expect(fetchMock).toHaveBeenCalledWith('/api/team', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"sha256:abc"' },
      body: JSON.stringify({ path: '/teams/a.yaml', yaml: 'x: 1\n' }),
    })
    expect(result).toEqual({ path: '/teams/a.yaml', yaml: 'x: 1\n' })
  })

  it('surfaces a 422 validation failure as TeamFileApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(422, { error: 'invalid team YAML: unsupported schema version' })),
    )

    const failure = saveTeamFile('/teams/a.yaml', 'schemaVersion: 2\n', null)
    await expect(failure).rejects.toThrow(TeamFileApiError)
    await expect(failure).rejects.toMatchObject({ status: 422 })
  })
})

describe('fetchConfigSchema', () => {
  it('loads the daemon-served schema', async () => {
    const schema = { type: 'object', properties: { schemaVersion: { const: 1 } } }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, schema))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchConfigSchema()).resolves.toEqual(schema)
    expect(fetchMock).toHaveBeenCalledWith('/api/config/schema')
  })
})
