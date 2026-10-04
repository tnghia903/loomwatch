import { afterEach, expect, it, vi } from 'vitest'

import { approveTeam, RunApiError, startRun, TEAM_NEEDS_REVIEW } from './client'

afterEach(() => vi.unstubAllGlobals())

it('carries the review when the daemon holds a team back until the operator has seen it', async () => {
  const body = {
    error: 'Review what this team runs before it starts.',
    code: TEAM_NEEDS_REVIEW,
    teamPath: 'downloaded.yaml',
    teamName: 'Morning digest',
    teamRevision: 'sha256:abc',
    review: [{ text: 'Researcher runs Claude Code.', warn: false }, { text: 'odd', warn: true }, { nope: 1 }],
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 409 })))
  const refused = await startRun('downloaded.yaml', 'go', { startKey: 'k', expectedRevision: null }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(RunApiError)
  const error = refused as RunApiError
  expect(error.code).toBe(TEAM_NEEDS_REVIEW)
  expect(error.review).toEqual({
    teamPath: 'downloaded.yaml',
    teamName: 'Morning digest',
    teamRevision: 'sha256:abc',
    review: [{ text: 'Researcher runs Claude Code.', warn: false }, { text: 'odd', warn: true }],
  })
})

it('approves exactly the revision the operator was shown', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ teamPath: 'downloaded.yaml', teamRevision: 'sha256:abc' }), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  await approveTeam('downloaded.yaml', 'sha256:abc')
  expect(fetch).toHaveBeenCalledWith('/api/team/approve', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ teamPath: 'downloaded.yaml', teamRevision: 'sha256:abc' }),
  }))
})
