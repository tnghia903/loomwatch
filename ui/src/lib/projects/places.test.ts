import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadPlaces } from './places'

const team = (id: string, project: string | null, shares = 'prices') => `schemaVersion: 1\nid: ${id}\nshares: ${shares}\n${project ? `project: ${project}\n` : ''}name: Prices\nentrypoint: a\nagents:\n  - {id: a, name: Writer, model: fake/offline, role: Write.}\nedges: []\n`

const FILES: Record<string, string> = {
  'coffee.yaml': team('prices', 'coffee'),
  'bikes.yaml': team('prices-bikes', 'bikes'),
  'other.yaml': team('other', 'bikes', 'other'),
}

afterEach(() => vi.unstubAllGlobals())

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
