import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useComposerLayout } from './useComposerLayout'

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

// This project does not enable RTL's automatic cleanup, so a hook left mounted keeps its pending
// autosave timer and fires it into the next test's `fetchMock`.
const mountedViews: { unmount: () => void }[] = []

afterEach(() => {
  while (mountedViews.length > 0) mountedViews.pop()?.unmount()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mounted(path = 'daily-news.yaml', agents: string[] = ['collector']) {
  const view = renderHook(({ p, a }: { p: string; a: string[] }) => useComposerLayout(p, a), {
    initialProps: { p: path, a: agents },
  })
  mountedViews.push(view)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  return view
}

describe('useComposerLayout', () => {
  it('preserves saved output settings and writes an edited format with the layout', async () => {
    fetchMock.mockResolvedValueOnce(ok({ version: 2, nodes: [], edges: [], agents: {}, output: { name: 'Market report', format: 'Markdown report' } }))
    const view = await mounted()
    await waitFor(() => expect(view.result.current.output?.name).toBe('Market report'))
    fetchMock.mockResolvedValue(ok({}))
    act(() => view.result.current.setOutput({ name: 'Market report', format: 'HTML dashboard' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/team/layout', expect.objectContaining({ method: 'PUT' })))
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).layout.output).toEqual({ name: 'Market report', format: 'HTML dashboard' })
  })
  it('places a capability, wires it to an agent and writes the sidecar', async () => {
    fetchMock.mockResolvedValueOnce(ok({ version: 1, nodes: [], edges: [] }))
    const view = await mounted()

    fetchMock.mockResolvedValue(ok({}))
    act(() => { view.result.current.place({ kind: 'skill', name: 'notebooklm', source: 'Claude Code' }, { x: 10, y: 20 }) })
    act(() => { view.result.current.connect('collector', 'skill:notebooklm') })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/team/layout', expect.objectContaining({ method: 'PUT' })))
    const lastCall = fetchMock.mock.calls.at(-1) as [string, { body: string }] | undefined
    const body = JSON.parse(lastCall?.[1].body ?? '{}') as { path: string; layout: { nodes: unknown[]; edges: unknown[] } }
    expect(body.path).toBe('daily-news.yaml')
    expect(body.layout.nodes).toEqual([{ id: 'skill:notebooklm', kind: 'skill', name: 'notebooklm', source: 'Claude Code', position: { x: 10, y: 20 } }])
    expect(body.layout.edges).toEqual([{ from: 'collector', to: 'skill:notebooklm' }])
  })

  it('moves a card that is already placed instead of making a second one', async () => {
    fetchMock.mockResolvedValueOnce(ok({ version: 1, nodes: [], edges: [] }))
    const view = await mounted()
    fetchMock.mockResolvedValue(ok({}))

    const payload = { kind: 'skill', name: 'notebooklm', source: 'Claude Code' } as const
    act(() => { view.result.current.place(payload, { x: 10, y: 20 }) })
    act(() => { view.result.current.place(payload, { x: 90, y: 90 }) })

    expect(view.result.current.nodes).toHaveLength(1)
    expect(view.result.current.nodes[0].position).toEqual({ x: 90, y: 90 })
  })

  it('removes a card together with every edge that reached it', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      version: 1,
      nodes: [{ id: 'skill:a', kind: 'skill', name: 'a', source: 's', position: { x: 0, y: 0 } }],
      edges: [{ from: 'collector', to: 'skill:a' }],
    }))
    const view = await mounted()
    await waitFor(() => expect(view.result.current.nodes).toHaveLength(1))
    fetchMock.mockResolvedValue(ok({}))

    act(() => { view.result.current.remove(['skill:a']) })

    expect(view.result.current.nodes).toEqual([])
    expect(view.result.current.edges).toEqual([])
  })

  /// An agent deleted or renamed in the team file must not leave an edge drawn from nothing.
  it('drops edges whose agent is no longer in the team file', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      version: 1,
      nodes: [{ id: 'skill:a', kind: 'skill', name: 'a', source: 's', position: { x: 0, y: 0 } }],
      edges: [{ from: 'collector', to: 'skill:a' }, { from: 'gone', to: 'skill:a' }],
    }))
    const view = await mounted()

    await waitFor(() => expect(view.result.current.edges).toEqual([{ from: 'collector', to: 'skill:a' }]))
    expect(view.result.current.nodes).toHaveLength(1)
  })

  // Writing the empty layout we fall back to would destroy wiring we merely failed to read.
  it('never overwrites a sidecar it could not read', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'boom', json: async () => ({ error: 'boom' }) } as Response)
    const view = await mounted()
    await waitFor(() => expect(view.result.current.error).toBe('boom'))

    act(() => { view.result.current.place({ kind: 'tool', name: 'memory', source: 'Codex' }, { x: 1, y: 1 }) })
    await new Promise((resolve) => setTimeout(resolve, 900))

    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false)
  })

  it('starts empty and saves nothing when no document is open', async () => {
    const view = renderHook(() => useComposerLayout(null, []))
    mountedViews.push(view)
    expect(view.result.current.nodes).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
