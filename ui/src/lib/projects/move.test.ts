import { afterEach, describe, expect, it, vi } from 'vitest'

import { projectIdFor } from './client'
import { projectFromTeam } from './move'

const client = vi.hoisted(() => ({
  fetchTeamFile: vi.fn(),
  fetchTeamsDiscovery: vi.fn(async () => ({ root: '/Users/colin/LoomWatch/teams', files: [] })),
  saveTeamFile: vi.fn(async () => ({})),
}))
vi.mock('../team-file/client', () => client)
const memory = vi.hoisted(() => ({ fetchMemory: vi.fn() }))
vi.mock('../memory/client', () => memory)
const projects = vi.hoisted(() => ({ fetchProjects: vi.fn(async () => ({ projects: [{ id: 'gate' }], loose: [], missing: [] })), saveProject: vi.fn(async () => ({})) }))
vi.mock('./client', async (importOriginal) => ({ ...(await importOriginal<typeof import('./client')>()), ...projects }))

afterEach(() => vi.clearAllMocks())

describe('every team becomes a project of its own (ADR 0097)', () => {
  it('names the project after the team, takes its Brief as the About and its folders by full path', () => {
    const made = projectFromTeam(
      {
        name: 'Gate',
        agents: [
          { capabilities: [{ kind: 'knowledge', name: 'SUTD', path: '/Users/colin/SUTD' }, { kind: 'skill', name: 'cite' }] },
          { capabilities: [{ kind: 'knowledge', name: 'SUTD again', path: '/Users/colin/SUTD' }, { kind: 'knowledge', name: 'Spec', path: 'gate.files/spec.pdf' }] },
          { kind: 'operator', capabilities: [{ kind: 'knowledge', name: 'Never', path: '/never' }] },
        ],
      },
      '/Users/colin/LoomWatch/teams/sutd/gate.yaml',
      [' Colin’s final project. ', 'Plain words.'],
    )
    expect(made).toEqual({
      name: 'Gate',
      about: 'Colin’s final project.\n\nPlain words.',
      folders: [
        { name: 'SUTD', path: '/Users/colin/SUTD' },
        { name: 'Spec', path: '/Users/colin/LoomWatch/teams/sutd/gate.files/spec.pdf' },
      ],
      briefMoves: true,
    })
    // A team with no name is named after its file; a Brief too long for an About stays the team's.
    const long = projectFromTeam({}, '/teams/blog.yaml', ['x'.repeat(4001)])
    expect(long).toMatchObject({ name: 'blog', about: '', briefMoves: false })
  })

  it('takes a free id, as the daemon does', () => {
    expect(projectIdFor('SUTD final project')).toBe('sutd-final-project')
    expect(projectIdFor('Gate', ['gate'])).toBe('gate-2')
    expect(projectIdFor('!!')).toBe('project')
  })

  it('saves the project, then the team as working in it with its Brief moved, as the editor saves it', async () => {
    const { moveIntoProjects } = await import('./move')
    client.fetchTeamFile.mockResolvedValue({
      yaml: 'schemaVersion: 1\nid: gate\nname: Gate\nentrypoint: a\nmemory:\n  brief:\n    - path: gate.brief/about.md\n    - path: gate.brief/writer.md\n      appliesTo: [a]\nagents:\n  - id: a\n    name: A\n    role: Research.\n    model: fake/offline\nedges: []\n',
      revision: 'rev-1',
    })
    memory.fetchMemory.mockResolvedValue({ enabled: true, entries: [{ path: 'gate.brief/about.md', body: 'Colin’s gate.' }, { path: 'gate.brief/writer.md', body: 'Only for A.', appliesTo: ['a'] }] })
    expect(await moveIntoProjects(['gate.yaml'])).toEqual(['gate.yaml'])
    expect(projects.saveProject).toHaveBeenCalledWith('gate-2', { name: 'Gate', about: 'Colin’s gate.' })
    const [path, yaml, revision] = client.saveTeamFile.mock.calls[0] as unknown as [string, string, string]
    expect([path, revision]).toEqual(['gate.yaml', 'rev-1'])
    expect(yaml).toContain('project: gate-2')
    expect(yaml).not.toContain('gate.brief/about.md')
    expect(yaml).toContain('gate.brief/writer.md')
  })

  it('leaves a team that already works in a project as it is', async () => {
    const { moveIntoProjects } = await import('./move')
    client.fetchTeamFile.mockResolvedValue({ yaml: 'schemaVersion: 1\nid: gate\nname: Gate\nproject: sutd\nentrypoint: a\nagents: []\nedges: []\n', revision: 'r' })
    expect(await moveIntoProjects(['gate.yaml'])).toEqual([])
    expect(projects.saveProject).not.toHaveBeenCalled()
    expect(client.saveTeamFile).not.toHaveBeenCalled()
  })
})
