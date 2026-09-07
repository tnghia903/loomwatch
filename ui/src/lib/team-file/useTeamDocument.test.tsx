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
})
