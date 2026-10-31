import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { crewOf, useTeamCrews } from './teamCrews'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useTeamCrews', () => {
  // The rail stays while teams change beside it, so it reads the folder again as they do: only
  // the files changed since, with the list it has kept on screen meanwhile.
  it('reads the folder again when asked, only the files changed since, keeping the list meanwhile', async () => {
    const changed = { trip: '2026-10-22T08:00:00Z', demo: '2026-10-22T08:00:00Z' }
    let tripAgent = 'Planner'
    let answerFolder: (() => void) | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/teams') {
        const body = { root: '/teams', files: ['demo.yaml', 'trip.yaml'], teams: [{ path: 'demo.yaml', name: 'Demo', agentCount: 1, modifiedAt: changed.demo }, { path: 'trip.yaml', name: 'Trip', agentCount: 1, modifiedAt: changed.trip }] }
        if (answerFolder === null) return jsonResponse(body)
        return new Promise<Response>((resolve) => { answerFolder = () => resolve(jsonResponse(body)) })
      }
      const path = new URLSearchParams(url.split('?')[1]).get('path')
      return jsonResponse({ path, revision: 'r', yaml: path === 'trip.yaml' ? `name: Trip\nagents:\n  - {id: planner, name: ${tripAgent}}\n` : 'name: Demo\nagents:\n  - {id: writer, name: Writer}\n' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const reads = () => fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith('/api/team?'))

    const crews = renderHook(({ again }) => useTeamCrews(again), { initialProps: { again: 'demo.yaml' } })
    await waitFor(() => expect(crews.result.current.teams?.map((team) => team.name)).toEqual(['Demo', 'Trip']))
    expect(reads()).toHaveLength(2)

    // Trip is saved with a new agent; the folder says it changed.
    tripAgent = 'Booker'
    changed.trip = '2026-10-22T09:00:00Z'
    answerFolder = () => {}
    crews.rerender({ again: 'trip.yaml' })
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/teams')).toHaveLength(2))
    expect(crews.result.current.teams?.map((team) => team.name)).toEqual(['Demo', 'Trip'])
    answerFolder()

    await waitFor(() => expect(crews.result.current.teams?.find((team) => team.path === 'trip.yaml')?.agents.map((agent) => agent.name)).toEqual(['Booker']))
    expect(reads()).toEqual(['/api/team?path=demo.yaml', '/api/team?path=trip.yaml', '/api/team?path=trip.yaml'])
  })
})

describe('crewOf', () => {
  // ADR 0094: a team file holds no name for an agent that is one of My agents.
  it('names an agent that is one of My agents as it is there, and one gone from there by its id', () => {
    const crew = crewOf('name: Blog\nagents:\n  - {id: writer, from: {agent: writer}}\n  - {id: own, name: Own}\n  - {id: gone, from: {agent: gone}}\n', [{ id: 'writer', name: 'Writer' }])
    expect(crew?.agents.map((agent) => agent.name)).toEqual(['Writer', 'Own', 'gone'])
  })
})
