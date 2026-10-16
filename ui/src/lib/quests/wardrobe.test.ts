import { afterEach, describe, expect, it, vi } from 'vitest'

import { earnItem, fetchWardrobe, WARDROBE_CHANGED_EVENT } from './wardrobe'

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('the wardrobe client', () => {
  it('reads what was earned and leaves out what this app cannot draw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ earned: { monocle: { at: '2026-10-15T10:00:00Z', runId: 'run-1', agentId: 'checker' }, crown: { at: 'x', runId: 'y' } } })))
    expect(await fetchWardrobe()).toEqual({ monocle: { at: '2026-10-15T10:00:00Z', runId: 'run-1', agentId: 'checker' } })
  })

  it('says a daemon older than the wardrobe has none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })))
    expect(await fetchWardrobe()).toBeNull()
  })

  it('earns an item for a run, and tells the page only when it is new', async () => {
    const calls: { url: string; body: unknown }[] = []
    let status = 201
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return json({ at: '2026-10-15T10:00:00Z', runId: 'run-1' }, status)
    }))
    const heard = vi.fn()
    window.addEventListener(WARDROBE_CHANGED_EVENT, heard)
    expect(await earnItem('band', { runId: 'run-1', teamPath: 'trip.yaml' })).toEqual({ at: '2026-10-15T10:00:00Z', runId: 'run-1' })
    expect(calls[0]).toEqual({ url: '/api/wardrobe/earned', body: { item: 'band', runId: 'run-1', teamPath: 'trip.yaml', agentId: null } })
    status = 200
    await earnItem('band', { runId: 'run-2' })
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(WARDROBE_CHANGED_EVENT, heard)
  })
})
