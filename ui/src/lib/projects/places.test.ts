import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { projectsChanged } from './client'
import { loadPlaces, setupDiffers, usePlaces } from './places'

const team = (id: string, project: string | null, shares = 'prices') => `schemaVersion: 1\nid: ${id}\nshares: ${shares}\n${project ? `project: ${project}\n` : ''}name: Prices\nentrypoint: a\nagents:\n  - {id: a, name: Writer, model: fake/offline, role: Write.}\nedges: []\n`

const FILES: Record<string, string> = {
  'coffee.yaml': team('prices', 'coffee'),
  'bikes.yaml': team('prices-bikes', 'bikes'),
  'other.yaml': team('other', 'bikes', 'other'),
}

let projects = [{ id: 'coffee', name: 'Coffee shop', teams: ['coffee.yaml'] }, { id: 'bikes', name: 'Bike rental', teams: ['bikes.yaml', 'other.yaml'] }]
function daemon() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: Object.keys(FILES), teams: Object.keys(FILES).map((path) => ({ path, agentCount: 1 })) }), { status: 200 })
    if (url === '/api/projects') return new Response(JSON.stringify({ projects, loose: [], missing: [], removed: [] }), { status: 200 })
    const path = new URLSearchParams(url.split('?')[1]).get('path') ?? ''
    return new Response(JSON.stringify({ path, yaml: FILES[path], revision: 'r' }), { status: 200 })
  }))
}

afterEach(() => vi.unstubAllGlobals())

// The team page's view of them: none for a team in one project, read again when a project changes.
describe('the open team’s places', () => {
  it('are none without a shared team, found with one, and read again after a project changes', async () => {
    daemon()
    const none = renderHook(() => usePlaces(null, '/teams/coffee.yaml'))
    expect(none.result.current).toBeNull()
    const { result } = renderHook(() => usePlaces('prices', '/teams/coffee.yaml'))
    await waitFor(() => expect(result.current).toEqual({ here: 'Coffee shop', others: [{ path: 'bikes.yaml', project: 'Bike rental' }] }))
    projects = [{ ...projects[0] }, { ...projects[1], name: 'Bikes for rent' }]
    act(() => projectsChanged())
    await waitFor(() => expect(result.current?.others[0].project).toBe('Bikes for rent'))
  })
})

// ADR 0103: where a team works, seen from the place open, for its page's save line and Delete team.
describe('a team’s places', () => {
  it('finds the project of the place open and the team’s other places, by name, from either spelling of its path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: Object.keys(FILES), teams: Object.keys(FILES).map((path) => ({ path, agentCount: 1 })) }), { status: 200 })
      if (url === '/api/projects') return new Response(JSON.stringify({ projects: [{ id: 'coffee', name: 'Coffee shop', teams: ['coffee.yaml'] }, { id: 'bikes', name: 'Bike rental', teams: ['bikes.yaml', 'other.yaml'] }], loose: [], missing: [], removed: [] }), { status: 200 })
      const path = new URLSearchParams(url.split('?')[1]).get('path') ?? ''
      return new Response(JSON.stringify({ path, yaml: FILES[path], revision: 'r' }), { status: 200 })
    }))
    const expected = { here: 'Coffee shop', others: [{ path: 'bikes.yaml', project: 'Bike rental' }] }
    expect(await loadPlaces('prices', 'coffee.yaml')).toEqual(expected)
    // The open team names its file in full.
    expect(await loadPlaces('prices', '/teams/coffee.yaml')).toEqual(expected)
  })
})

// Only a change to the setup reaches the other places: a schedule, delivery or Brief is this one's.
describe('what an unsaved change reaches', () => {
  const saved = team('prices', 'coffee')
  it('is the setup, not a place’s own keys', () => {
    expect(setupDiffers(saved, saved)).toBe(false)
    expect(setupDiffers(saved, `${saved}schedule: {cron: "0 8 * * 1", prompt: Weekly}\n`)).toBe(false)
    expect(setupDiffers(saved, saved.replace('project: coffee', 'project: bikes'))).toBe(false)
    expect(setupDiffers(saved, saved.replace('role: Write.', 'role: Write it all.'))).toBe(true)
    expect(setupDiffers(saved, saved.replace('name: Prices', 'name: Costs'))).toBe(true)
  })
})
