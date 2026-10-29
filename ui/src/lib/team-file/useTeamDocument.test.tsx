import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { CHECKER_ROLE } from '../library/checker'
import { absoluteTeamPath, slugifyTeamName, useTeamDocument } from './useTeamDocument'
import { sendBackFields, sendBackOf } from './sendBack'
import type { TeamDocument } from './types'

const TEAM_YAML = `schemaVersion: 1
id: research-team
name: Research and review
entrypoint: researcher
agents:
  - id: researcher
    name: Protocol Researcher
    role: Research ACP behavior
    spawn:
      cmd: opencode
      args:
        - acp
      env: {}
      cwd: .
    model: kimi-for-coding/k3-256k
    allowRecruiting: true
  - id: reviewer
    name: Code Reviewer
    role: Review research findings
    spawn:
      cmd: claude-agent-acp
      args: []
      env: {}
      cwd: .
    model: claude-opus-5
    allowRecruiting: false
edges: []
`

const THREE_AGENT_YAML = `schemaVersion: 1
id: research-team
name: Research and review
entrypoint: researcher
agents:
  - id: researcher
    name: Protocol Researcher
    role: Research ACP behavior
    spawn:
      cmd: opencode
      args:
        - acp
      env: {}
      cwd: .
    model: kimi-for-coding/k3-256k
    allowRecruiting: true
  - id: reviewer
    name: Code Reviewer
    role: Review research findings
    spawn:
      cmd: claude-agent-acp
      args: []
      env: {}
      cwd: .
    model: claude-opus-5
    allowRecruiting: false
  - id: editor
    name: Copy Editor
    role: Tighten the writeup
    spawn:
      cmd: opencode
      args:
        - acp
      env: {}
      cwd: .
    model: kimi-for-coding/k3-256k
    allowRecruiting: false
edges: []
`

const ONE_AGENT_YAML = `schemaVersion: 1
id: research-team
name: Research and review
entrypoint: researcher
agents:
  - id: researcher
    name: Protocol Researcher
    role: Research ACP behavior
    spawn:
      cmd: opencode
      args:
        - acp
      env: {}
      cwd: .
    model: kimi-for-coding/k3-256k
    allowRecruiting: true
edges: []
`

const SCHEMA_GATE = {
  type: 'object',
  required: ['entrypoint', 'agents'],
  properties: {
    entrypoint: { type: 'string', minLength: 1 },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'role', 'model'],
        properties: {
          name: { type: 'string', minLength: 1 },
          role: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          thinkingEffort: { type: 'string', minLength: 1 },
          spawn: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string', minLength: 1 } } },
        },
      },
    },
  },
} as const

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * My agents as the daemon keeps them (ADR 0094): saving a team saves its agents there first.
 * Answers `/api/jobs` from `store` and hands every other request to `next`.
 */
function withMyAgents(next: Fetch, store = new Map<string, Record<string, unknown>>()) {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return jsonResponse(200, { folder: '.jobs', jobs: [...store.values()], problems: [] })
    const saving = /^\/api\/jobs\/([^/]+)$/.exec(url)
    if (saving && init?.method === 'PUT') {
      const id = decodeURIComponent(saving[1])
      const before = store.get(id)
      const saved = { ...JSON.parse(String(init.body)) as Record<string, unknown>, id, file: `.jobs/${id}.yaml`, version: ((before?.version as number | undefined) ?? 0) + 1 }
      store.set(id, saved)
      return jsonResponse(200, saved)
    }
    return next(input, init)
  })
  return Object.assign(handler, { store })
}

/** The team file a save wrote, from a fetch mock's calls. */
function teamPuts(fetchMock: { mock: { calls: unknown[][] } }): { path: string; yaml: string }[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === '/api/team' && (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { path: string; yaml: string })
}

function setPath(path: string) {
  window.history.pushState({}, '', `/?path=${encodeURIComponent(path)}`)
}

beforeEach(() => {
  setPath('/teams/research-team.yaml')
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

describe('useTeamDocument', () => {
  it('changes an agent’s model without losing its attached skills', async () => {
    const yaml = TEAM_YAML.replace('    model: kimi-for-coding/k3-256k', '    capabilities: [{ kind: skill, name: claude-design }]\n    model: kimi-for-coding/k3-256k')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema' ? jsonResponse(200, SCHEMA_GATE) : jsonResponse(200, { path: '/teams/research-team.yaml', yaml }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.nodes).toHaveLength(2))
    const before = result.current.nodes[0].data.agent
    act(() => result.current.updateAgentModel('researcher', 'openai/gpt-6.1-sol'))
    const after = result.current.nodes[0].data.agent
    expect(after.model).toBe('openai/gpt-6.1-sol')
    expect(before.capabilities).toEqual([{ kind: 'skill', name: 'claude-design' }])
    expect(after.capabilities).toEqual(before.capabilities)
    expect(after.role).toBe(before.role)
    expect(result.current.yamlPreview).toContain('model: openai/gpt-6.1-sol')
    // Validation waits for the schema, which loads on its own; under a busy test run it can land
    // after this edit, so wait for it rather than assume it is already there.
    await waitFor(() => expect(result.current.documentChipState).toBe('dirty'))
  })

  it('turns skills off for several agents in one edit, and wiring one again turns it back on (ADR 0060)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema' ? jsonResponse(200, SCHEMA_GATE) : jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.nodes).toHaveLength(2))
    const agent = (id: string) => result.current.nodes.find((node) => node.id === id)?.data.agent
    act(() => result.current.turnOff(new Map([
      ['researcher', [{ kind: 'skill' as const, name: 'canvas-design' }, { kind: 'tool' as const, name: 'agentmemory' }]],
      ['reviewer', [{ kind: 'skill' as const, name: 'canvas-design' }]],
    ])))
    expect(agent('researcher')?.turnedOff).toEqual([{ kind: 'skill', name: 'canvas-design' }, { kind: 'tool', name: 'agentmemory' }])
    expect(agent('reviewer')?.turnedOff).toEqual([{ kind: 'skill', name: 'canvas-design' }])
    expect(result.current.yamlPreview).toContain('turnedOff:')

    act(() => result.current.setAgentCapabilities('researcher', [{ kind: 'skill', name: 'canvas-design' }]))
    expect(agent('researcher')?.turnedOff).toEqual([{ kind: 'tool', name: 'agentmemory' }])
    act(() => result.current.turnBackOn('researcher', { kind: 'tool', name: 'agentmemory' }))
    expect(agent('researcher')?.turnedOff).toBeUndefined()
    expect(agent('reviewer')?.turnedOff).toEqual([{ kind: 'skill', name: 'canvas-design' }])

    act(() => result.current.undo())
    act(() => result.current.undo())
    act(() => result.current.undo())
    expect(agent('researcher')?.turnedOff).toBeUndefined()
    expect(agent('reviewer')?.turnedOff).toBeUndefined()
  })

  it('resolves a relative requested path against the canonical teams root for display', async () => {
    setPath('nested/research-team.yaml')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/teams') {
        return jsonResponse(200, { root: '/Users/operator/.loomwatch/teams', files: ['nested/research-team.yaml'] })
      }
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      return jsonResponse(200, { path: 'nested/research-team.yaml', yaml: TEAM_YAML })
    }))

    expect(absoluteTeamPath('/Users/operator/.loomwatch/teams/', 'nested/./research-team.yaml'))
      .toBe('/Users/operator/.loomwatch/teams/nested/research-team.yaml')
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    expect(result.current.path).toBe('/Users/operator/.loomwatch/teams/nested/research-team.yaml')
  })

  it('slugifies names and creates a new document without writing until its first save', async () => {
    window.history.pushState({}, '', '/')
    const fetchMock = withMyAgents(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (init?.method === 'PUT') return jsonResponse(200, JSON.parse(init.body as string))
      return jsonResponse(404, { error: 'not found' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())

    expect(slugifyTeamName('  Research & Réview  ')).toBe('research-review')
    await waitFor(() => expect(result.current.isValid).toBe(true))
    act(() => result.current.createNewDocument('Research & Review'))
    expect(result.current.path).toBe('research-review.yaml')
    expect(result.current.saveState).toBe('new')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    act(() => result.current.addAgentFromDrop(JSON.stringify({
      group: 'presets', id: 'reviewer', label: 'Reviewer', role: 'Review work', model: 'anthropic/claude-haiku-5.5',
    }), { x: 0, y: 0 }))
    await act(async () => { await result.current.save() })

    expect(result.current.saveState).toBe('saved')
    expect(teamPuts(fetchMock)).toHaveLength(1)
    // The agent dropped from the palette joined My agents first, and the team points at it, keeping
    // the model suggested for it here: the agent names none of its own.
    expect(fetchMock.store.get('reviewer')).toMatchObject({ name: 'Reviewer', instructions: 'Review work' })
    expect(fetchMock.store.get('reviewer')).not.toHaveProperty('model')
    expect((parse(teamPuts(fetchMock)[0].yaml) as TeamDocument).agents).toEqual([
      { id: 'reviewer', model: 'anthropic/claude-haiku-5.5', followsSuggestion: true, from: { agent: 'reviewer' } },
    ])
  })

  it('opens an unknown schema version read-only', async () => {
    const versionTwo = TEAM_YAML.replace('schemaVersion: 1', 'schemaVersion: 2')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/team')
        ? jsonResponse(200, { path: '/teams/research-team.yaml', yaml: versionTwo })
        : jsonResponse(500, { error: 'not available in test' }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('read-only'))
    expect(result.current.readOnlyReason).toContain('schema version 2')
    expect(result.current.nodes).toHaveLength(2)
  })

  it('surfaces malformed YAML as a parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      path: '/teams/research-team.yaml', yaml: 'schemaVersion: [\n',
    })))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.loadFailure).not.toBeNull())
    expect(result.current.saveState).toBe('error')
    expect(result.current.loadFailure?.line).toBe('schemaVersion: [')
  })

  it('refuses a YAML file that is not a team, and leaves without a "Leave site?" prompt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      path: '/teams/notes.yaml', yaml: 'shopping:\n  - milk\n',
    })))
    const listens = vi.spyOn(window, 'addEventListener')
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.loadFailure).not.toBeNull())
    expect(result.current.loadFailure?.kind).toBe('shape')
    expect(result.current.saveState).toBe('error')
    // Nothing was loaded, so there is nothing to lose: the way out must not ask to stay.
    expect(listens.mock.calls.some(([type]) => type === 'beforeunload')).toBe(false)
    listens.mockRestore()
  })

  /**
   * The daemon's side of Rename (ADR 0099) for these tests: the team at `/teams/research-team.yaml`
   * as `yaml`, the teams folder at `/teams`, and a rename that moves it to `<stem>.yaml`.
   */
  function renameDaemon(yaml: string, answer?: (body: { path: string; stem: string; yaml: string }) => Response, myAgents?: Map<string, Record<string, unknown>>) {
    return withMyAgents(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (url === '/api/teams') return jsonResponse(200, { root: '/teams', files: ['research-team.yaml', 'trip-planner.yaml'], trashed: ['trip-planner-2.yaml'] })
      if (url === '/api/team/rename') {
        const body = JSON.parse(String(init?.body)) as { path: string; stem: string; yaml: string }
        return answer?.(body) ?? jsonResponse(200, { path: `${body.stem}.yaml`, yaml: body.yaml, revision: 'r2' })
      }
      return jsonResponse(200, { path: '/teams/research-team.yaml', yaml, revision: 'r1' })
    }, myAgents)
  }

  function renameCalls(fetchMock: { mock: { calls: unknown[][] } }) {
    return fetchMock.mock.calls
      .filter(([input]) => String(input) === '/api/team/rename')
      .map(([, init]) => ({ body: JSON.parse(String((init as RequestInit).body)) as { path: string; stem: string; yaml: string }, headers: (init as RequestInit).headers as Record<string, string> }))
  }

  // ADR 0099: the file's name said one thing and the team's another.
  it('renames a saved team and its file, and opens it again where it now is', async () => {
    const fetchMock = renameDaemon(TEAM_YAML)
    vi.stubGlobal('fetch', fetchMock)
    const moves: unknown[] = []
    const heard = (event: Event) => moves.push((event as CustomEvent).detail)
    window.addEventListener('loomwatch:team-moved', heard)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    let refused: string | null = 'not answered'
    await act(async () => { refused = await result.current.renameTeam('  Trip planner (Japan) ') })
    window.removeEventListener('loomwatch:team-moved', heard)

    expect(refused).toBeNull()
    const [call] = renameCalls(fetchMock)
    expect(call.headers['If-Match']).toBe('"r1"')
    expect(call.body.path).toBe('/teams/research-team.yaml')
    expect(call.body.stem).toBe('trip-planner-japan')
    // The file as it is on disk, with only its name changed: the id its notes are filed by stays.
    expect(call.body.yaml).toBe(TEAM_YAML.replace('name: Research and review', 'name: Trip planner (Japan)'))
    expect(result.current.path).toBe('/teams/trip-planner-japan.yaml')
    expect(result.current.teamName).toBe('Trip planner (Japan)')
    expect(result.current.saveState).toBe('clean')
    expect(new URLSearchParams(window.location.search).get('path')).toBe('/teams/trip-planner-japan.yaml')
    expect(moves).toEqual([{ from: '/teams/research-team.yaml', to: '/teams/trip-planner-japan.yaml' }])
  })

  // A team renamed before its file followed, as "Research team" in old-project.yaml: the same
  // name again brings the file in line, and a name its file already matches changes nothing.
  it('brings the file in line when the name stays and the file was named before', async () => {
    const fetchMock = renameDaemon(TEAM_YAML)
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    await act(async () => { await result.current.renameTeam('Research and review') })
    expect(renameCalls(fetchMock).map((call) => call.body)).toMatchObject([{ stem: 'research-and-review', yaml: TEAM_YAML }])
    expect(result.current.path).toBe('/teams/research-and-review.yaml')
    unmount()

    setPath('/teams/research-team.yaml')
    const matching = renameDaemon(TEAM_YAML.replace('name: Research and review', 'name: Research team'))
    vi.stubGlobal('fetch', matching)
    const again = renderHook(() => useTeamDocument())
    await waitFor(() => expect(again.result.current.saveState).toBe('clean'))
    await act(async () => { await again.result.current.renameTeam('Research team') })
    expect(renameCalls(matching)).toEqual([])
  })

  it('writes in the id a team without one was filed under, so its notes stay with it', async () => {
    const fetchMock = renameDaemon(TEAM_YAML.replace('id: research-team\n', ''))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    await act(async () => { await result.current.renameTeam('Trip planner') })
    const [call] = renameCalls(fetchMock)
    expect((parse(call.body.yaml) as TeamDocument).id).toBe('research-team')
    expect(result.current.path).toBe('/teams/trip-planner.yaml')
  })

  it('says why a saved team was not renamed, and stays where it is', async () => {
    const fetchMock = renameDaemon(TEAM_YAML, () => jsonResponse(409, { error: 'This team is working right now.' }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    let refused: string | null = null
    await act(async () => { refused = await result.current.renameTeam('Trip planner') })
    expect(refused).toBe('This team is working right now.')
    expect(result.current.path).toBe('/teams/research-team.yaml')
    expect(result.current.teamName).toBe('Research and review')
    expect(result.current.saveState).toBe('clean')
  })

  // The page shows an agent of My agents filled in; the file holds only where it comes from. The
  // rename is of the file, so what is sent is the file with only its name changed.
  it('renames the file as it is on disk, not as the page fills it in', async () => {
    const pointerYaml = 'schemaVersion: 1\nid: research-team\nname: Research and review\nentrypoint: researcher\nagents:\n  - id: researcher\n    from:\n      agent: researcher\nedges: []\n'
    const myAgents = new Map<string, Record<string, unknown>>([['researcher', {
      id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts.', model: 'fake/offline', version: 1,
    }]])
    const fetchMock = renameDaemon(pointerYaml, undefined, myAgents)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    expect(result.current.nodes[0].data.agent).toMatchObject({ name: 'Researcher', role: 'Find facts.' })
    await act(async () => { await result.current.renameTeam('Trip planner') })
    expect(renameCalls(fetchMock)[0].body.yaml).toBe(pointerYaml.replace('name: Research and review', 'name: Trip planner'))
    expect(result.current.nodes[0].data.agent).toMatchObject({ name: 'Researcher', role: 'Find facts.' })
  })

  // Changed on disk since it was read: the clean page reads it again and the name can be tried again.
  it('reads the file again when it changed outside LoomWatch before the rename', async () => {
    const fetchMock = renameDaemon(TEAM_YAML, () => jsonResponse(412, { error: 'The team file changed or the destination already exists. Reload before saving.' }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    let refused: string | null = null
    await act(async () => { refused = await result.current.renameTeam('Trip planner') })
    expect(refused).toBe('This team’s file changed outside LoomWatch, so it was read again. Rename it again.')
    expect(result.current.path).toBe('/teams/research-team.yaml')
  })

  // What went wrong inside LoomWatch is no help to the person: the daemon put everything back.
  it('says plainly that nothing changed when renaming failed inside LoomWatch', async () => {
    const fetchMock = renameDaemon(TEAM_YAML, () => jsonResponse(500, { error: "couldn't move /teams/research-team.brief: Permission denied (os error 13); nothing was moved" }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    let refused: string | null = null
    await act(async () => { refused = await result.current.renameTeam('Trip planner') })
    expect(refused).toBe('LoomWatch couldn’t rename this team, so nothing changed. Try again.')
    expect(result.current.path).toBe('/teams/research-team.yaml')
  })

  it('moves a saved team’s file only once its changes are saved', async () => {
    const fetchMock = renameDaemon(TEAM_YAML)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    act(() => result.current.renameAgent('reviewer', 'name', 'Editor'))
    let refused: string | null = null
    await act(async () => { refused = await result.current.renameTeam('Trip planner') })
    expect(refused).toBe('Save or discard your changes first.')
    expect(renameCalls(fetchMock)).toEqual([])
    expect(result.current.teamName).toBe('Research and review')
  })

  it('renames a team not saved yet, and the file it will be saved as, writing nothing', async () => {
    window.history.pushState({}, '', '/')
    const fetchMock = renameDaemon(TEAM_YAML)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.isValid).toBe(true))
    act(() => result.current.createNewDocument('Research & Review'))
    await act(async () => { await result.current.renameTeam('Trip planner') })
    // trip-planner.yaml is a team and trip-planner-2.yaml a deleted one's: the next name is free.
    expect(result.current.path).toBe('trip-planner-3.yaml')
    expect(result.current.teamName).toBe('Trip planner')
    expect(result.current.yamlPreview).toContain('id: trip-planner-3')
    expect(result.current.saveState).toBe('new')
    expect(renameCalls(fetchMock)).toEqual([])
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false)
  })

  it('routes malformed YAML from manual reload through the parse-failure modal state', async () => {
    let yaml = TEAM_YAML
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema'
        ? jsonResponse(200, SCHEMA_GATE)
        : jsonResponse(200, { path: '/teams/research-team.yaml', yaml }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    yaml = 'schemaVersion: [\n'
    await act(async () => { await result.current.reloadFromDisk() })

    expect(result.current.loadFailure?.line).toBe('schemaVersion: [')
    expect(result.current.saveState).toBe('error')
  })

  it('routes malformed YAML from a clean focus refresh through the parse-failure modal state', async () => {
    let yaml = TEAM_YAML
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema'
        ? jsonResponse(200, SCHEMA_GATE)
        : jsonResponse(200, { path: '/teams/research-team.yaml', yaml }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    yaml = 'schemaVersion: [\n'
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(result.current.loadFailure?.line).toBe('schemaVersion: ['))
    expect(result.current.saveState).toBe('error')
  })

  it('routes malformed YAML chosen with Use disk through the parse-failure modal without rejecting', async () => {
    let yaml = TEAM_YAML
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema'
        ? jsonResponse(200, SCHEMA_GATE)
        : jsonResponse(200, { path: '/teams/research-team.yaml', yaml }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    act(() => result.current.renameAgent('researcher', 'role', 'Changed locally'))
    yaml = 'schemaVersion: [\n'
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(result.current.saveState).toBe('conflict'))

    await expect(act(async () => { await result.current.useDisk() })).resolves.toBeUndefined()

    expect(result.current.loadFailure?.line).toBe('schemaVersion: [')
    expect(result.current.saveState).toBe('error')
  })

  it('uses daemon revisions when SubtleCrypto is unavailable on a LAN origin', async () => {
    vi.stubGlobal('crypto', {})
    const revision = 'sha256:' + 'a'.repeat(64)
    const savedRevision = 'sha256:' + 'b'.repeat(64)
    const fetchMock = withMyAgents(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (init?.method === 'PUT') {
        expect(new Headers(init.headers).get('If-Match')).toBe(`"${revision}"`)
        const { yaml } = JSON.parse(String(init.body))
        return jsonResponse(200, { path: '/teams/research-team.yaml', yaml, revision: savedRevision })
      }
      return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML, revision })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    act(() => result.current.renameAgent('researcher', 'name', 'LAN writer'))
    await act(async () => { await result.current.save() })
    expect(result.current.saveState).toBe('saved')
  })

  it('preserves edits when another writer wins after the preflight read', async () => {
    let raced = false
    const diskYaml = TEAM_YAML.replace('Protocol Researcher', 'Disk writer')
    const fetchMock = withMyAgents(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (init?.method === 'PUT') {
        expect(new Headers(init.headers).get('If-Match')).toMatch(/^"sha256:[a-f0-9]{64}"$/)
        raced = true
        return jsonResponse(412, { error: 'The team changed.' })
      }
      return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: raced ? diskYaml : TEAM_YAML })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    act(() => result.current.renameAgent('researcher', 'name', 'Local writer'))
    await act(async () => { await result.current.save() })
    expect(result.current.saveState).toBe('conflict')
    expect(result.current.externalChange?.diskYaml).toBe(diskYaml)
    expect(result.current.nodes[0].data.agent.name).toBe('Local writer')
  })

  it('recovers a deleted backing file by saving the in-memory document to a new path', async () => {
    let deleted = false
    const fetchMock = withMyAgents(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (String(input) === '/api/teams') return jsonResponse(200, { root: '/Users/operator/.loomwatch/teams', files: [] })
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as { path: string; yaml: string }
        return jsonResponse(200, body)
      }
      return deleted
        ? jsonResponse(404, { error: 'team file not found' })
        : jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    deleted = true
    await act(async () => { await result.current.reloadFromDisk() })
    expect(result.current.fileGone).toBe(true)
    expect(result.current.readOnlyReason).toContain('File is gone')

    let saved = false
    await act(async () => { saved = await result.current.saveCopy('copies/research-team.yaml') })

    expect(saved).toBe(true)
    expect(result.current.fileGone).toBe(false)
    expect(result.current.path).toBe('/Users/operator/.loomwatch/teams/copies/research-team.yaml')
    expect(fetchMock).toHaveBeenCalledWith('/api/team', expect.objectContaining({ method: 'PUT' }))
    // A copy is a new team with its own id, so it starts its own chat rather than the original's.
    const [written] = teamPuts(fetchMock)
    expect(written).toBeDefined()
    expect(written.yaml).toMatch(/^id: copies-research-team$/m)
  })

  it('enters the File is gone recovery state when the pre-save fetch 404s instead of a generic save error', async () => {
    let deleted = false
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (String(input) === '/api/teams') return jsonResponse(200, { root: '/Users/operator/.loomwatch/teams', files: [] })
      if (init?.method === 'PUT') return jsonResponse(200, JSON.parse(init.body as string))
      return deleted
        ? jsonResponse(404, { error: 'team file not found' })
        : jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.renameAgent('researcher', 'role', 'Edited after deletion'))

    deleted = true
    await act(async () => { await result.current.save() })

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    expect(result.current.saveState).toBe('read-only')
    expect(result.current.fileGone).toBe(true)
    expect(result.current.readOnlyReason).toContain('File is gone')
    expect(result.current.saveError).toContain('File is gone')
    expect(result.current.yamlPreview).toContain('Edited after deletion')
  })

  it('loads the team file named by ?path= into nodes, edges and entrypoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )

    const { result } = renderHook(() => useTeamDocument())

    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    expect(result.current.nodes.map((node) => node.id).sort()).toEqual(['researcher', 'reviewer'])
    expect(result.current.entrypoint).toBe('researcher')
    expect(result.current.edges).toHaveLength(0)
  })

  it('stores an explicitly selected responder in the team YAML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.promoteResponder('reviewer'))

    expect(result.current.responder).toBe('reviewer')
    expect(result.current.yamlPreview).toContain('responder: reviewer')
    expect(result.current.saveState).toBe('dirty')
  })

  it('makes auto-layout undoable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.onNodesChange([
      { id: 'researcher', type: 'position', position: { x: 999, y: 999 } },
    ]))
    act(() => result.current.layoutNodes())
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.position).not.toEqual({ x: 999, y: 999 })

    act(() => result.current.undo())
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.position).toEqual({ x: 999, y: 999 })
  })

  it('keeps history through a save but resets it after reloading from disk', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (init?.method === 'PUT') return jsonResponse(200, JSON.parse(init.body as string))
      return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.renameAgent('researcher', 'role', 'Changed role'))
    expect(result.current.canUndo).toBe(true)
    await act(async () => { await result.current.save() })
    expect(result.current.canUndo).toBe(true)

    await act(async () => { await result.current.reloadFromDisk() })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.role).toBe('Research ACP behavior')
  })

  it('settles collision from the final drop position rather than stale drag state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    const occupied = result.current.nodes.find((node) => node.id === 'researcher')!.position

    act(() => result.current.settleNodeCollision('reviewer', occupied))

    expect(result.current.nodes.find((node) => node.id === 'reviewer')?.position).toEqual({
      x: occupied.x + 24,
      y: occupied.y + 24,
    })
  })

  it('fetches the daemon schema, exposes incomplete fields live, and blocks their save', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (init?.method === 'PUT') return jsonResponse(200, JSON.parse(init.body as string))
      return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.isValid).toBe(true))

    act(() => result.current.renameAgent('researcher', 'role', ''))

    await waitFor(() => expect(result.current.isValid).toBe(false))
    expect(result.current.fieldProblemsByAgent.get('researcher')?.role).toMatchObject({ weight: 'incomplete' })

    await act(async () => { await result.current.save() })

    expect(result.current.fieldProblemsByAgent.get('researcher')?.role).toMatchObject({ weight: 'error' })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it('drawing a valid edge marks the document dirty and adds a configured edge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => {
      result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
    })

    expect(result.current.edges).toHaveLength(1)
    expect(result.current.edges[0]).toMatchObject({ source: 'researcher', target: 'reviewer' })
    expect(result.current.saveState).toBe('dirty')
    expect(result.current.refusal).toBeNull()
  })

  it('refuses an edge into the entrypoint and offers to promote the source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => {
      result.current.onConnect({ source: 'reviewer', target: 'researcher', sourceHandle: null, targetHandle: null })
    })

    expect(result.current.edges).toHaveLength(0)
    expect(result.current.refusal).toMatchObject({ promote: 'reviewer' })
  })

  it('renaming a field marks the document dirty and updates node data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.renameAgent('researcher', 'role', 'Investigate protocols'))

    expect(result.current.saveState).toBe('dirty')
    const node = result.current.nodes.find((n) => n.id === 'researcher')
    expect(node?.data.agent.role).toBe('Investigate protocols')
  })

  it('stores thinking effort separately from the model in the team YAML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.updateAgentThinkingEffort('researcher', 'high'))

    expect(result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.thinkingEffort).toBe('high')
    expect(result.current.yamlPreview).toContain('thinkingEffort: high')
    expect(result.current.yamlPreview).toContain('model: kimi-for-coding/k3-256k')
  })

  // ADR 0037: only switches that are on are written, and the block goes when the last one does,
  // so a team that never used them saves exactly as before.
  it('writes only the allow switches that are on, and drops the block when none is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
    )
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    const allow = () => result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.allow

    act(() => result.current.updateAgentAllow('researcher', 'web', true))
    expect(allow()).toEqual({ web: true })
    expect(result.current.yamlPreview).toMatch(/allow:\n\s+web: true/)
    expect(result.current.saveState).toBe('dirty')

    act(() => result.current.updateAgentAllow('researcher', 'commands', true))
    expect(allow()).toEqual({ web: true, commands: true })

    act(() => result.current.updateAgentAllow('researcher', 'web', false))
    act(() => result.current.updateAgentAllow('researcher', 'commands', false))
    expect(allow()).toBeUndefined()
    expect(result.current.yamlPreview).not.toContain('allow:')
  })

  it('shows a working-folder edit in the YAML preview and validation at once, dropping an AI app’s command', async () => {
    const yaml = TEAM_YAML.replace('      cwd: .\n    model: kimi-for-coding/k3-256k', '      cwd: ""\n    model: kimi-for-coding/k3-256k')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema'
        ? jsonResponse(200, SCHEMA_GATE)
        : jsonResponse(200, { path: '/teams/research-team.yaml', yaml }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.fieldProblemsByAgent.get('researcher')?.cwd).toBeDefined())

    act(() => result.current.updateAgentCwd('researcher', 'work'))

    expect(result.current.yamlPreview).toContain('cwd: work')
    expect(result.current.fieldProblemsByAgent.get('researcher')?.cwd).toBeUndefined()
    expect(result.current.isValid).toBe(true)
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.spawn).toEqual({ cwd: 'work' })
  })

  it('save() rechecks an unchanged disk revision, PUTs the mutated YAML, and settles on saved', async () => {
    const fetchMock = withMyAgents(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init) {
        return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })
      }
      return jsonResponse(200, JSON.parse(init.body as string))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.renameAgent('researcher', 'role', 'Investigate protocols'))
    expect(result.current.saveState).toBe('dirty')

    await act(async () => {
      await result.current.save()
    })

    expect(result.current.saveState).toBe('saved')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/team',
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(fetchMock.mock.calls.filter(([input, init]) => init === undefined && String(input).startsWith('/api/team'))).toHaveLength(2)
    expect(teamPuts(fetchMock)).toHaveLength(1)
    // ADR 0094: the instructions are the agent's, so they went to it in My agents, and the team
    // file points at it with only what is the team's.
    expect(fetchMock.store.get('protocol-researcher')).toMatchObject({ name: 'Protocol Researcher', instructions: 'Investigate protocols' })
    expect(teamPuts(fetchMock)[0].yaml).not.toContain('Investigate protocols')
    expect((parse(teamPuts(fetchMock)[0].yaml) as TeamDocument).agents[0].from).toEqual({ agent: 'protocol-researcher' })
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.role).toBe('Investigate protocols')
  })

  it('opens a team’s agents from My agents, and takes a change made here to the agent, for every team', async () => {
    const pointerYaml = `schemaVersion: 1
id: research-team
name: Research and review
entrypoint: researcher
agents:
  - id: researcher
    # Where it works in this team.
    spawn:
      cwd: work
    from:
      agent: researcher
edges: []
`
    const myAgents = new Map<string, Record<string, unknown>>([['researcher', {
      id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts with sources.', model: 'anthropic/claude-sonnet-5.5', skills: ['cite'], version: 4,
    }]])
    const fetchMock = withMyAgents(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (!init) return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: pointerYaml })
      return jsonResponse(200, JSON.parse(init.body as string))
    }, myAgents)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    const shown = result.current.nodes[0].data.agent
    expect(shown).toMatchObject({ name: 'Researcher', role: 'Find facts with sources.', model: 'anthropic/claude-sonnet-5.5', spawn: { cwd: 'work' } })
    expect(shown.capabilities).toEqual([{ kind: 'skill', name: 'cite' }])

    act(() => result.current.renameAgent('researcher', 'role', 'Find facts with two sources.'))
    await act(async () => { await result.current.save() })
    expect(result.current.saveState).toBe('saved')
    const agentPuts = fetchMock.mock.calls.filter(([input, init]) => String(input).startsWith('/api/jobs/') && init?.method === 'PUT')
    expect(agentPuts).toHaveLength(1)
    // Saved over the copy it was shown, so a change made elsewhere since is refused, not lost.
    expect(new Headers(agentPuts[0][1]?.headers).get('If-Match')).toBe('"4"')
    expect(myAgents.get('researcher')).toMatchObject({ instructions: 'Find facts with two sources.', skills: ['cite'], version: 5 })
    const [written] = teamPuts(fetchMock)
    expect(written.yaml).toContain('# Where it works in this team.')
    expect(written.yaml).not.toContain('Find facts')
    expect(written.yaml).not.toContain('name: Researcher')

    // A save that changes nothing of the agent's touches no agent.
    fetchMock.mockClear()
    act(() => result.current.renameAgent('researcher', 'name', 'Researcher'))
    await act(async () => { await result.current.save() })
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/jobs/'))).toHaveLength(0)

    // Saved on its workbench in the Agents tab: the team shows it as it is now, and stays clean.
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    act(() => result.current.refillAgent({ id: 'researcher', file: '.jobs/researcher.yaml', name: 'Fact finder', instructions: 'Find facts.', model: 'anthropic/claude-sonnet-5.5', skills: ['cite'], version: 6 }))
    expect(result.current.nodes[0].data.agent).toMatchObject({ name: 'Fact finder', role: 'Find facts.', spawn: { cwd: 'work' } })
    expect(result.current.saveState).toBe('clean')
    // What the team's unsaved changes are measured against moved with it: nothing waits to be saved.
    expect(result.current.loadedYaml).toBe(result.current.yamlPreview)

    // With a change of the team's own waiting, that change still waits.
    act(() => result.current.updateAgentCwd('researcher', 'drafts'))
    const waiting = result.current.loadedYaml
    act(() => result.current.refillAgent({ id: 'researcher', file: '.jobs/researcher.yaml', name: 'Fact finder', instructions: 'Find facts fast.', model: 'anthropic/claude-sonnet-5.5', skills: ['cite'], version: 7 }))
    expect(result.current.nodes[0].data.agent).toMatchObject({ role: 'Find facts fast.', spawn: { cwd: 'drafts' } })
    expect(result.current.loadedYaml).toBe(waiting)
    expect(result.current.saveState).toBe('dirty')
  })

  it('keeps a skill taken off or wired on the canvas in this team, and brings the agent’s own back when turned on', async () => {
    const pointerYaml = 'schemaVersion: 1\nid: research-team\nname: Research and review\nentrypoint: researcher\nagents:\n  - id: researcher\n    from:\n      agent: researcher\nedges: []\n'
    const myAgents = new Map<string, Record<string, unknown>>([['researcher', {
      id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts.', model: 'fake/offline', skills: ['cite'], version: 2,
    }]])
    const fetchMock = withMyAgents(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/config/schema') return jsonResponse(200, SCHEMA_GATE)
      if (!init) return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: pointerYaml })
      return jsonResponse(200, JSON.parse(init.body as string))
    }, myAgents)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    // Taken off the canvas: off in this team, as the canvas does it (ADR 0060), and a skill wired besides.
    act(() => result.current.setAgentCapabilities('researcher', [{ kind: 'skill', name: 'slides' }]))
    act(() => result.current.turnOff(new Map([['researcher', [{ kind: 'skill' as const, name: 'cite' }]]])))
    await act(async () => { await result.current.save() })
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).startsWith('/api/jobs/') && init?.method === 'PUT')).toHaveLength(0)
    expect(myAgents.get('researcher')).toMatchObject({ skills: ['cite'] })
    const written = parse(teamPuts(fetchMock).at(-1)!.yaml) as TeamDocument
    expect(written.agents[0]).toEqual({ id: 'researcher', from: { agent: 'researcher' }, capabilities: [{ kind: 'skill', name: 'slides' }], turnedOff: [{ kind: 'skill', name: 'cite' }] })
    expect(result.current.nodes[0].data.agent.capabilities).toEqual([{ kind: 'skill', name: 'slides' }])

    // Turned back on: the agent's own skill is on its card again.
    act(() => result.current.turnBackOn('researcher', { kind: 'skill', name: 'cite' }))
    expect(result.current.nodes[0].data.agent.capabilities).toEqual([{ kind: 'skill', name: 'slides' }, { kind: 'skill', name: 'cite' }])
    expect(result.current.nodes[0].data.agent.turnedOff).toBeUndefined()
  })

  it('refuses and flags a save when the file changed on disk after load', async () => {
    const diskYaml = TEAM_YAML.replace('name: Research and review', 'name: Edited outside LoomWatch')
    let getCount = 0
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init) {
        getCount += 1
        const yaml = getCount === 1 ? TEAM_YAML : diskYaml
        return jsonResponse(200, { path: '/teams/research-team.yaml', yaml })
      }
      return jsonResponse(200, JSON.parse(init.body as string))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    act(() => result.current.renameAgent('researcher', 'role', 'Investigate protocols'))

    await act(async () => {
      await result.current.save()
    })

    expect(result.current.saveState).toBe('conflict')
    expect(result.current.saveError).toContain('changed on disk')
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
  })

  it('detects a changed file on window focus and lets a dirty canvas keep its edits', async () => {
    let diskYaml = TEAM_YAML
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/team')
        ? jsonResponse(200, { path: '/teams/research-team.yaml', yaml: diskYaml })
        : jsonResponse(200, SCHEMA_GATE),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    act(() => result.current.renameAgent('researcher', 'role', 'Investigate protocols'))
    diskYaml = TEAM_YAML.replace('name: Research and review', 'name: Edited outside LoomWatch')
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(result.current.saveState).toBe('conflict'))
    expect(result.current.externalChange?.diskYaml).toBe(diskYaml)

    act(() => result.current.keepMine())
    expect(result.current.saveState).toBe('dirty')

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(result.current.externalChange).toBeNull())
    expect(result.current.saveState).toBe('dirty')
  })

  it('silently reloads a clean canvas when its file changed on focus', async () => {
    let diskYaml = TEAM_YAML
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/team')
        ? jsonResponse(200, { path: '/teams/research-team.yaml', yaml: diskYaml })
        : jsonResponse(200, SCHEMA_GATE),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))

    diskYaml = TEAM_YAML.replace('name: Research and review', 'name: Edited outside LoomWatch')
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(result.current.diskNotice).toBe('Reloaded from disk'))
    expect(result.current.saveState).toBe('clean')
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.name).toBe('Protocol Researcher')
  })

  it('reloads a changed read-only canvas on focus instead of raising a false conflict (§9.3/§9.5)', async () => {
    const versionTwo = TEAM_YAML.replace('schemaVersion: 1', 'schemaVersion: 2')
    let diskYaml = versionTwo
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/team')
        ? jsonResponse(200, { path: '/teams/research-team.yaml', yaml: diskYaml })
        : jsonResponse(200, SCHEMA_GATE),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('read-only'))

    diskYaml = versionTwo.replace('name: Protocol Researcher', 'name: Edited outside LoomWatch')
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(result.current.diskNotice).toBe('Reloaded from disk'))
    expect(result.current.saveState).toBe('read-only')
    expect(result.current.externalChange).toBeNull()
    expect(result.current.saveError).toBeNull()
    expect(result.current.readOnlyReason).toContain('schema version 2')
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.name).toBe('Edited outside LoomWatch')
  })

  it('re-evaluates a read-only canvas to clean when focus brings a supported schema version (§9.5)', async () => {
    const versionTwo = TEAM_YAML.replace('schemaVersion: 1', 'schemaVersion: 2')
    let diskYaml = versionTwo
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/team')
        ? jsonResponse(200, { path: '/teams/research-team.yaml', yaml: diskYaml })
        : jsonResponse(200, SCHEMA_GATE),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('read-only'))

    diskYaml = TEAM_YAML
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    expect(result.current.readOnlyReason).toBeNull()
    expect(result.current.externalChange).toBeNull()
    expect(result.current.diskNotice).toBe('Reloaded from disk')

    act(() => result.current.renameAgent('researcher', 'role', 'Investigate protocols'))
    expect(result.current.saveState).toBe('dirty')
  })

  describe('deleting the entrypoint node (docs/CANVAS_SPEC.md §5.4)', () => {
    it('promotes the sole survivor automatically when exactly one agent remains', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => result.current.removeAgent('researcher'))

      expect(result.current.nodes.map((node) => node.id)).toEqual(['reviewer'])
      expect(result.current.entrypoint).toBe('reviewer')
      expect(result.current.entrypointProblem).toBeNull()
    })

    it('leaves entrypoint unset — not dangling — and blocks save when two or more agents remain', async () => {
      const fetchMock = withMyAgents(async () =>
        jsonResponse(200, { path: '/teams/research-team.yaml', yaml: THREE_AGENT_YAML }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => result.current.removeAgent('researcher'))

      // React state clears...
      expect(result.current.entrypoint).toBeNull()
      expect(result.current.nodes.map((node) => node.id).sort()).toEqual(['editor', 'reviewer'])
      expect(result.current.saveState).toBe('dirty')

      // ...and the problem is surfaced with every remaining agent as a promotion candidate.
      expect(result.current.entrypointProblem).toMatchObject({
        message: 'This team has no entry point.',
        candidates: expect.arrayContaining([
          { id: 'reviewer', name: 'Code Reviewer' },
          { id: 'editor', name: 'Copy Editor' },
        ]),
      })

      // save() is a no-op while the document has no entry point — it must never write a YAML
      // model that still names the deleted agent as `entrypoint`.
      fetchMock.mockClear()
      await act(async () => {
        await result.current.save()
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.current.saveState).toBe('dirty')

      // Promoting a candidate clears the problem and re-enables save with the new entrypoint.
      act(() => result.current.promoteEntrypoint('reviewer'))
      expect(result.current.entrypointProblem).toBeNull()

      await act(async () => {
        await result.current.save()
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/team', expect.objectContaining({ method: 'PUT' }))
      const [body] = teamPuts(fetchMock)
      expect(body).toBeDefined()
      expect(body.yaml).toContain('entrypoint: reviewer')
      expect(body.yaml).not.toContain('entrypoint: researcher')
    })

    it('requires at least one agent when the last agent is deleted (§10.2)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: ONE_AGENT_YAML }))
      vi.stubGlobal('fetch', fetchMock)
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => result.current.removeAgent('researcher'))

      expect(result.current.nodes).toHaveLength(0)
      expect(result.current.entrypoint).toBeNull()
      expect(result.current.entrypointProblem).toMatchObject({
        message: 'A team needs at least one agent.',
        candidates: [],
      })

      fetchMock.mockClear()
      await act(async () => {
        await result.current.save()
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('execution modes (docs/CANVAS_SPEC.md §8)', () => {
    it('is team mode with no pipeline steps until the first edge is drawn', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      expect(result.current.mode).toBe('team')
      expect(result.current.pipelineSteps).toEqual([])
      expect(result.current.modeSwitchBanner).toBe(false)
    })

    it('switches to pipeline mode and raises the switch banner on the first edge', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })

      expect(result.current.mode).toBe('pipeline')
      expect(result.current.modeSwitchBanner).toBe(true)
      expect(result.current.pipelineSteps).toEqual([
        { id: 'researcher', step: 1, joinFrom: [] },
        { id: 'reviewer', step: 2, joinFrom: [] },
      ])
    })

    it('clears the switch banner after 4s', async () => {
      vi.useFakeTimers()
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await vi.waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      expect(result.current.modeSwitchBanner).toBe(true)

      act(() => vi.advanceTimersByTime(4000))
      expect(result.current.modeSwitchBanner).toBe(false)
      vi.useRealTimers()
    })

    it('deleting the last edge offers a 5s undo before reverting to team mode', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      expect(result.current.mode).toBe('pipeline')

      act(() => result.current.removeEdgeBetween('researcher', 'reviewer'))

      // The deletion already took effect — mode has reverted — but it is undoable for 5s.
      expect(result.current.mode).toBe('team')
      expect(result.current.edges).toHaveLength(0)
      expect(result.current.pendingEdgeRemoval).toMatchObject({
        edges: [{ from: 'researcher', to: 'reviewer' }],
      })

      act(() => result.current.undoLastEdgeRemoval())

      expect(result.current.mode).toBe('pipeline')
      expect(result.current.edges).toHaveLength(1)
      expect(result.current.pendingEdgeRemoval).toBeNull()
    })

    it('changing how a check step sends work back writes sendBack and takes an older file’s sendBackOnce out (ADR 0062)', async () => {
      const yaml = `schemaVersion: 1
id: checked-team
name: Checked
entrypoint: writer
agents:
  - id: writer
    name: Writer
    role: Write it.
    model: anthropic/claude-sonnet-5.5
  - id: checker
    name: Checker
    role: Check it.
    model: openai/gpt-6.1-sol
    checks: writer
    sendBackOnce: true
edges:
  - { from: writer, to: checker, layer: configured, kind: sequence, ts: "2026-10-19T00:00:00Z" }
`
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/checked.yaml', yaml })))
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))
      const checker = () => result.current.nodes.find((node) => node.id === 'checker')?.data.agent
      expect(sendBackOf(checker() ?? {})).toEqual({ rounds: 1, whenStillNotMet: 'answer' })
      act(() => result.current.applyAgentFields('checker', sendBackFields({ rounds: 3, whenStillNotMet: 'ask' })))
      expect(result.current.yamlPreview).toContain('checks: writer\n    sendBack:\n      rounds: 3\n      whenStillNotMet: ask')
      expect(result.current.yamlPreview).not.toContain('sendBackOnce')
      expect(sendBackOf(checker() ?? {})).toEqual({ rounds: 3, whenStillNotMet: 'ask' })
      // Off is off: neither field is left in the file.
      act(() => result.current.applyAgentFields('checker', sendBackFields(null)))
      expect(result.current.yamlPreview).not.toContain('sendBack')
      act(() => result.current.applyAgentFields('checker', sendBackFields({ rounds: 2, whenStillNotMet: 'answer' })))
      // A check step whose work is no longer handed to it stops being one, sending back and all.
      act(() => result.current.removeEdgeBetween('writer', 'checker'))
      expect(result.current.yamlPreview).not.toContain('checks:')
      expect(result.current.yamlPreview).not.toContain('sendBack')
    })

    it('connecting work into a Checker makes it check that work, send a miss back up to twice then ask, and think as the effort table says (ADR 0062)', async () => {
      const checkerYaml = (from: { id: string; name: string; role: string }, role: string) => `schemaVersion: 1
id: checked-team
name: Checked
entrypoint: ${from.id}
agents:
  - id: ${from.id}
    name: ${from.name}
    role: ${from.role}
    model: anthropic/claude-sonnet-5.5
  - id: checker
    name: Checker
    role: ${JSON.stringify(role)}
    model: openai/gpt-6.1-sol
    thinkingEffort: low
edges: []
`
      const connect = async (yaml: string, from: string) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/checked.yaml', yaml })))
        const { result, unmount } = renderHook(() => useTeamDocument())
        await waitFor(() => expect(result.current.saveState).toBe('clean'))
        act(() => result.current.onConnect({ source: from, target: 'checker', sourceHandle: null, targetHandle: null }))
        const agent = result.current.nodes.find((node) => node.id === 'checker')?.data.agent
        const yamlPreview = result.current.yamlPreview
        unmount()
        return { agent, yamlPreview }
      }
      const writer = { id: 'writer', name: 'Writer', role: 'Write the piece from what you were given.' }
      const written = await connect(checkerYaml(writer, CHECKER_ROLE), 'writer')
      expect(written.agent).toMatchObject({ checks: 'writer', sendBack: { rounds: 2, whenStillNotMet: 'ask' }, thinkingEffort: 'high' })
      expect(written.yamlPreview).toContain('sendBack:\n      rounds: 2\n      whenStillNotMet: ask')
      expect(written.yamlPreview).toContain('thinkingEffort: high')
      const coder = { id: 'coder', name: 'Coder', role: 'Change the code in this folder.' }
      expect((await connect(checkerYaml(coder, CHECKER_ROLE), 'coder')).agent).toMatchObject({ checks: 'coder', sendBack: { rounds: 2, whenStillNotMet: 'ask' }, thinkingEffort: 'high' })
      // Any other agent connected into a non-Checker is only connected.
      expect((await connect(checkerYaml(writer, 'Read the piece and say what you think.'), 'writer')).agent).not.toHaveProperty('checks')
    })

    it('undo after deleting the last edge brings back the check step it ended (ADR 0062)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      act(() => result.current.applyAgentFields('reviewer', { checks: 'researcher', sendBackOnce: true }))
      const reviewer = () => result.current.nodes.find((node) => node.id === 'reviewer')?.data.agent

      act(() => result.current.removeEdgeBetween('researcher', 'reviewer'))
      expect(reviewer()?.checks).toBeUndefined()
      expect(result.current.yamlPreview).not.toContain('checks:')

      act(() => result.current.undoLastEdgeRemoval())
      expect(result.current.edges).toHaveLength(1)
      expect(reviewer()).toMatchObject({ checks: 'researcher', sendBackOnce: true })
      expect(result.current.yamlPreview).toContain('checks: researcher')
    })

    it('a newer edit closes the last-edge undo, so Undo cannot take back that edit instead', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      act(() => result.current.removeEdgeBetween('researcher', 'reviewer'))
      expect(result.current.pendingEdgeRemoval).not.toBeNull()
      act(() => result.current.applyAgentFields('reviewer', { doneWhen: ['Names its source'] }))
      expect(result.current.pendingEdgeRemoval).toBeNull()
      expect(result.current.yamlPreview).toContain('Names its source')
    })

    it('offers the same undo when deleting a node removes the final edge', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      act(() => result.current.removeAgent('reviewer'))

      expect(result.current.mode).toBe('team')
      expect(result.current.pendingEdgeRemoval).toMatchObject({
        edges: [{ from: 'researcher', to: 'reviewer' }],
      })

      act(() => result.current.undoLastEdgeRemoval())
      expect(result.current.mode).toBe('pipeline')
      expect(result.current.edges).toHaveLength(1)
      expect(result.current.nodes.map((node) => node.id).sort()).toEqual(['researcher', 'reviewer'])
    })

    it('"Keep it" clears the pending removal without restoring the edge', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      act(() => result.current.removeEdgeBetween('researcher', 'reviewer'))
      expect(result.current.pendingEdgeRemoval).not.toBeNull()

      act(() => result.current.keepLastEdgeRemoval())

      expect(result.current.pendingEdgeRemoval).toBeNull()
      expect(result.current.edges).toHaveLength(0)
      expect(result.current.mode).toBe('team')
    })

    it('auto-accepts the removal after 5s of inaction', async () => {
      vi.useFakeTimers()
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })),
      )
      const { result } = renderHook(() => useTeamDocument())
      await vi.waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      act(() => result.current.removeEdgeBetween('researcher', 'reviewer'))
      expect(result.current.pendingEdgeRemoval).not.toBeNull()

      act(() => vi.advanceTimersByTime(5000))
      expect(result.current.pendingEdgeRemoval).toBeNull()
      vi.useRealTimers()
    })

    // The canvas no longer edits `guards` (CANVAS_SPEC §8.1), so the file is their only home: a
    // limit someone wrote by hand must survive every save the canvas makes.
    it('keeps hand-written team guards through an edit and save', async () => {
      const fetchMock = withMyAgents(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init) {
          return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: `${TEAM_YAML.trimEnd()}\nguards:\n  maxDispatchDepth: 3\n` })
        }
        return jsonResponse(200, JSON.parse(init.body as string))
      })
      vi.stubGlobal('fetch', fetchMock)
      const { result } = renderHook(() => useTeamDocument())
      await waitFor(() => expect(result.current.saveState).toBe('clean'))

      act(() => {
        result.current.onConnect({ source: 'researcher', target: 'reviewer', sourceHandle: null, targetHandle: null })
      })
      expect(result.current.saveState).toBe('dirty')

      await act(async () => {
        await result.current.save()
      })
      const [body] = teamPuts(fetchMock)
      expect(body.yaml).toContain('maxDispatchDepth: 3')
      expect(body.yaml).not.toContain('budget')
    })
  })
})

// Ask LoomWatch puts a proposed team file on the canvas whole (ADR 0033).
describe('useTeamDocument.applyYaml', () => {
  const loaded = async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema' ? jsonResponse(200, SCHEMA_GATE) : jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })))
    const hook = renderHook(() => useTeamDocument())
    await waitFor(() => expect(hook.result.current.saveState).toBe('clean'))
    return hook
  }

  it('applies a proposed file as one undoable edit, keeping where the person put each agent', async () => {
    const { result } = await loaded()
    act(() => result.current.onNodesChange([{ id: 'researcher', type: 'position', position: { x: 999, y: 999 } }]))
    let applied = false
    act(() => { applied = result.current.applyYaml(TEAM_YAML.replace('role: Review research findings', 'role: Review it twice')) })
    expect(applied).toBe(true)
    expect(result.current.saveState).toBe('dirty')
    expect(result.current.nodes.find((node) => node.id === 'reviewer')?.data.agent.role).toBe('Review it twice')
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.position).toEqual({ x: 999, y: 999 })
    expect(result.current.yamlPreview).toContain('Review it twice')

    act(() => result.current.undo())
    expect(result.current.nodes.find((node) => node.id === 'reviewer')?.data.agent.role).toBe('Review research findings')
    expect(result.current.yamlPreview).not.toContain('Review it twice')
  })

  it('lays the team out again when the file adds an agent, and refuses text that is not a team', async () => {
    const { result } = await loaded()
    act(() => { result.current.applyYaml(THREE_AGENT_YAML) })
    expect(result.current.nodes.map((node) => node.id)).toEqual(['researcher', 'reviewer', 'editor'])
    const editor = result.current.nodes.find((node) => node.id === 'editor')
    expect(editor?.position).toBeDefined()

    let refused = true
    act(() => { refused = result.current.applyYaml('just: some notes\n') })
    expect(refused).toBe(false)
    expect(result.current.nodes).toHaveLength(3)
  })

  it('fills in a proposed team’s agent from My agents once it has read them, on a page with no team open', async () => {
    window.history.pushState({}, '', '/')
    const mine = new Map([['researcher', { id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find the facts, with a source for each.', model: 'anthropic/claude-sonnet-5.5' }]])
    vi.stubGlobal('fetch', withMyAgents(async (input) =>
      String(input) === '/api/config/schema' ? jsonResponse(200, SCHEMA_GATE) : jsonResponse(404, { error: 'not found' }), mine))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.checking).toBe(false))
    const proposed = 'schemaVersion: 1\nid: review\nname: Review\nentrypoint: researcher\nagents:\n  - id: researcher\n    from: { agent: researcher }\nedges: []\n'

    await act(async () => { await result.current.loadMyAgents() })
    act(() => { result.current.applyYaml(proposed, 'review.yaml') })
    const agent = result.current.nodes.find((node) => node.id === 'researcher')?.data.agent
    expect(agent?.name).toBe('Researcher')
    expect(agent?.role).toBe('Find the facts, with a source for each.')
    expect(agent?.model).toBe('anthropic/claude-sonnet-5.5')
  })

  it('opens a proposed new team unsaved, with nothing to undo back to, and closes it to no team', async () => {
    window.history.pushState({}, '', '/')
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema' ? jsonResponse(200, SCHEMA_GATE) : jsonResponse(404, { error: 'not found' }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.checking).toBe(false))

    act(() => { result.current.applyYaml(TEAM_YAML, 'research-team.yaml') })
    expect(result.current.path).toBe('research-team.yaml')
    expect(result.current.saveState).toBe('new')
    expect(result.current.nodes).toHaveLength(2)
    expect(result.current.canUndo).toBe(false)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    act(() => result.current.closeDocument())
    expect(result.current.path).toBeNull()
    expect(result.current.saveState).toBe('no-file')
    expect(result.current.nodes).toHaveLength(0)
    expect(window.location.search).toBe('')
  })
})
