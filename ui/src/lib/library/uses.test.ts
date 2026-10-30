import { afterEach, describe, expect, it, vi } from 'vitest'

import { findTeamAgents } from './uses'

const team = (id: string, extra = '') => `schemaVersion: 1\nid: ${id}\n${extra}name: Prices\nentrypoint: writer\nagents:\n  - id: writer\n    from: {agent: writer}\nedges: []\n`

const FILES: Record<string, string> = {
  'coffee.yaml': team('prices', 'shares: prices\nproject: coffee\n'),
  'bikes.yaml': team('prices-bikes', 'shares: prices\nproject: bikes\n'),
  'blog.yaml': team('blog').replace('name: Prices', 'name: Blog'),
}

afterEach(() => vi.unstubAllGlobals())

// ADR 0103: a team set up once works in several projects, each place a file of its own.
describe('where My agents are used', () => {
  it('lists a team in several projects once, with its other places', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: Object.keys(FILES), teams: Object.keys(FILES).map((path) => ({ path, agentCount: 1 })) }), { status: 200 })
      const path = new URLSearchParams(url.split('?')[1]).get('path') ?? ''
      return new Response(JSON.stringify({ path, yaml: FILES[path], revision: 'r' }), { status: 200 })
    }))
    const { uses } = await findTeamAgents()
    expect(uses.map((use) => [use.teamName, use.teamPath, use.places ?? []])).toEqual([
      ['Blog', 'blog.yaml', []],
      ['Prices', 'coffee.yaml', ['bikes.yaml']],
    ])
  })
})
