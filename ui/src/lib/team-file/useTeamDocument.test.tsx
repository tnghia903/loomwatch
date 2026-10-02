import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { absoluteTeamPath, slugifyTeamName, useTeamDocument } from './useTeamDocument'

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
        required: ['name', 'role', 'model', 'spawn'],
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
  it('switches harnesses without losing attached skills and clears incompatible model choices', async () => {
    const yaml = TEAM_YAML.replace('    model: kimi-for-coding/k3-256k', '    capabilities: [{ kind: skill, name: claude-design }]\n    model: kimi-for-coding/k3-256k')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema' ? jsonResponse(200, SCHEMA_GATE) : jsonResponse(200, { path: '/teams/research-team.yaml', yaml }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.nodes).toHaveLength(2))
    const before = result.current.nodes[0].data.agent
    act(() => result.current.updateAgentSpawn('researcher', { cmd: 'codex-acp', args: [], env: {}, cwd: '.' }))
    const after = result.current.nodes[0].data.agent
    expect(after.spawn?.cmd).toBe('codex-acp')
    expect(before.capabilities).toEqual([{ kind: 'skill', name: 'claude-design' }])
    expect(after.capabilities).toEqual(before.capabilities)
    expect(after.model).toBe('')
    expect(after.role).toBe(before.role)
    expect(result.current.documentChipState).toBe('invalid')
    act(() => result.current.updateAgentModel('researcher', 'gpt-5.6'))
    expect(result.current.documentChipState).toBe('dirty')
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
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      group: 'presets', id: 'reviewer', label: 'Reviewer', role: 'Review work', model: 'model-1',
      spawn: { cmd: 'codex-acp', args: [] },
    }), { x: 0, y: 0 }))
    await act(async () => { await result.current.save() })

    expect(result.current.saveState).toBe('saved')
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
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

  it('renames the team without touching its id or file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/config/schema'
        ? jsonResponse(200, SCHEMA_GATE)
        : jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML }),
    ))
    const { result } = renderHook(() => useTeamDocument())
    await waitFor(() => expect(result.current.saveState).toBe('clean'))
    act(() => result.current.renameTeam('  Trip planner (Japan) '))
    expect(result.current.teamName).toBe('Trip planner (Japan)')
    expect(result.current.saveState).toBe('dirty')
    expect(result.current.yamlPreview).toContain('name: Trip planner (Japan)')
    expect(result.current.yamlPreview).toContain('id: research-team')
    act(() => result.current.undo())
    expect(result.current.teamName).toBe('Research and review')
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
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
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

  it('shows a working-folder edit in the YAML preview and validation at once, keeping the rest of spawn', async () => {
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
    expect(result.current.nodes.find((node) => node.id === 'researcher')?.data.agent.spawn)
      .toEqual({ cmd: 'opencode', args: ['acp'], env: {}, cwd: 'work' })
  })

  it('save() rechecks an unchanged disk revision, PUTs the mutated YAML, and settles on saved', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init) {
        return jsonResponse(200, { path: '/teams/research-team.yaml', yaml: TEAM_YAML })
      }
      const body = JSON.parse(init.body as string) as { path: string; yaml: string }
      expect(body.yaml).toContain('role: Investigate protocols')
      return jsonResponse(200, body)
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
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
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
      const fetchMock = vi
        .fn()
        .mockImplementation(async () =>
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
      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(putCall).toBeDefined()
      const [, init] = putCall as [string, RequestInit]
      const body = JSON.parse(init.body as string) as { yaml: string }
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
      const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      const [, init] = putCall as [string, RequestInit]
      const body = JSON.parse(init.body as string) as { yaml: string }
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
