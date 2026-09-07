import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTeamDocument } from './useTeamDocument'

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
    budget:
      limitUsd: 5
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
    budget:
      limitUsd: 5
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
    budget:
      limitUsd: 5
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
    budget:
      limitUsd: 5
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
    budget:
      limitUsd: 5
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
    budget:
      limitUsd: 5
    allowRecruiting: true
edges: []
`

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

  it('save() PUTs the mutated YAML and settles on saved', async () => {
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
        .mockResolvedValue(jsonResponse(200, { path: '/teams/research-team.yaml', yaml: THREE_AGENT_YAML }))
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
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
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
})
