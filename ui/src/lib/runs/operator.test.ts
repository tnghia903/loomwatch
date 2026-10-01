import { afterEach, expect, it, vi } from 'vitest'
import { answerRun, startRun } from './client'
import { mergeHistory } from './history'

const record = { runId: 'r', status: 'running', prompt: 'go', createdAt: '2026-09-13', teamPath: 'demo.yaml', waitingOn: { node: 'review', question: 'Approve?' } }
afterEach(() => vi.unstubAllGlobals())
it('answers the addressed stop and carries send-back without starting a new run', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ...record, waitingOn: null }), { status: 202 }))
  vi.stubGlobal('fetch', fetch)
  await answerRun('r/a', 'review', 'Fix the numbers', 'researcher')
  expect(fetch).toHaveBeenCalledWith('/api/runs/r%2Fa/answers', expect.objectContaining({ method: 'POST', body: JSON.stringify({ node: 'review', text: 'Fix the numbers', sendBack: 'researcher' }) }))
})
it('preserves the server conflict instead of claiming an answer was accepted', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'A different stop is waiting.' }), { status: 409 })))
  await expect(answerRun('r', 'wrong', 'yes')).rejects.toThrow('A different stop is waiting.')
})
it('sends retry lineage to the daemon and reads waiting from the recorded run', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(record), { status: 202 }))
  vi.stubGlobal('fetch', fetch)
  const next = await startRun('demo.yaml', 'go', { startKey: 'k', expectedRevision: 'rev', retryOfRunId: 'parent' })
  expect(fetch).toHaveBeenCalledWith('/api/runs', expect.objectContaining({ body: expect.stringContaining('"retryOfRunId":"parent"') }))
  expect(mergeHistory([next], [])[0]).toMatchObject({ status: 'waiting', statusWord: 'waiting for you', live: true })
})
