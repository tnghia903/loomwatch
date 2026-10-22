import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSavedJobs } from '../library/jobs'
import { useNeedsYou } from '../story/useNeedsYou'
import { markMovedInPlace } from './inPlace'
import { useTeamList } from './useTeamList'

const RUN = { runId: 'run-1', sessionId: 's-1', teamPath: '/teams/trip.yaml', prompt: 'Plan it', status: 'running', mode: 'pipeline', createdAt: '2026-10-22T08:00:00Z' }
const JOB = { id: 'planner', name: 'Planner', version: 1 }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function useAppData() {
  return { needsYou: useNeedsYou(), teams: useTeamList(), jobs: useSavedJobs() }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The header's mark, the tray, the tab title, the rail's glow and its figures come from these. A
// page that moved to another team in place starts them from what it last read, so none of them
// blinks empty while they are read again.
describe('the app’s own data on a team page moved in place', () => {
  it('starts from the last read, where a page load starts empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/runs')) return jsonResponse([RUN])
      if (url === '/api/teams') return jsonResponse({ root: '/teams', files: ['trip.yaml'], teams: [{ path: 'trip.yaml', name: 'Trip', agentCount: 1 }], trashed: ['old.yaml'] })
      if (url === '/api/jobs') return jsonResponse({ folder: '/jobs', jobs: [JOB], problems: [] })
      return new Response('{}', { status: 404 })
    }))
    const first = renderHook(useAppData)
    await waitFor(() => {
      expect(first.result.current.needsYou.records).toHaveLength(1)
      expect(first.result.current.teams.teams).toHaveLength(1)
      expect(first.result.current.jobs.jobs).toHaveLength(1)
    })
    first.unmount()

    // Nothing answers now: what shows is only what each part starts from.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const loaded = renderHook(useAppData)
    expect(loaded.result.current.needsYou.records).toEqual([])
    expect(loaded.result.current.teams.teams).toBeNull()
    expect(loaded.result.current.jobs.jobs).toEqual([])
    loaded.unmount()

    markMovedInPlace()
    const moved = renderHook(useAppData)
    expect(moved.result.current.needsYou.records.map((record) => record.runId)).toEqual(['run-1'])
    expect(moved.result.current.needsYou.working).toBe(1)
    expect(moved.result.current.teams.teams?.map((team) => team.path)).toEqual(['trip.yaml'])
    // A deleted team's name stays taken, so a new team is never filed under it.
    expect(moved.result.current.teams.trashed).toEqual(['old.yaml'])
    expect(moved.result.current.jobs.jobs.map((job) => job.id)).toEqual(['planner'])
    // And each is read again at once.
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining(['/api/teams', '/api/jobs']))
  })
})
