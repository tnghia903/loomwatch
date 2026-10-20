import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RunRecord } from './client'
import { useRunHistory } from './useRunHistory'

const run = { runId: 'r1', teamPath: 'news.yaml', status: 'succeeded', prompt: 'today’s digest', createdAt: '2026-10-21T01:00:00Z' } as RunRecord
const asked: string[] = []
beforeEach(() => {
  asked.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    asked.push(String(input))
    return new Response(JSON.stringify(String(input).startsWith('/api/runs') ? [run] : []), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

// The run view numbers attempts from the runs the daemon knows (useRunHistory.ts). The archive's
// list of sessions is not asked for: it changes no number, and it carries every run's whole prompt.
it('reads the runs, and not the archive’s session list', async () => {
  const { result, unmount } = renderHook(() => useRunHistory())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.records.map((record) => record.runId)).toEqual(['r1'])
  expect(asked.some((url) => url.startsWith('/api/runs'))).toBe(true)
  expect(asked.filter((url) => url.startsWith('/api/sessions'))).toEqual([])
  unmount()
})
