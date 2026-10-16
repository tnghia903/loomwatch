import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '../../lib/runs/client'
import type { ProjectedAgent, RunProjection } from '../../lib/watch/events'
import { agentsRunWith, benchedBefore, earlierRecords, useRunQuests } from './useRunQuests'

afterEach(() => vi.unstubAllGlobals())

const record = (runId: string, teamPath: string, createdAt: string, extra: Partial<RunRecord> = {}) => ({ runId, teamPath, createdAt, status: 'succeeded', ...extra }) as RunRecord

describe('the runs a quest reads', () => {
  it('knows which saved agents had a test bench run that finished before this run', () => {
    const records = [
      record('a', '.jobs/.bench/writer.yaml', '2026-10-15T09:00:00Z'),
      record('b', '/teams/.jobs/.bench/scout.yaml', '2026-10-15T09:00:00Z', { status: 'failed' }),
      record('c', '.jobs/.bench/editor.yaml', '2026-10-15T11:00:00Z'),
      record('d', 'research.yaml', '2026-10-15T09:00:00Z'),
    ]
    expect([...benchedBefore(records, '2026-10-15T10:00:00Z')]).toEqual(['writer'])
  })

  it('reads the same team’s whole-team runs before this one, newest first', () => {
    const now = record('now', 'research.yaml', '2026-10-15T10:00:00Z')
    const records = [
      now,
      record('old', 'research.yaml', '2026-10-15T08:00:00Z'),
      record('newer', './research.yaml', '2026-10-15T09:00:00Z'),
      record('later', 'research.yaml', '2026-10-15T11:00:00Z'),
      record('other', 'trip.yaml', '2026-10-15T09:30:00Z'),
      record('one', 'research.yaml', '2026-10-15T09:40:00Z', { onlyAgent: 'writer' }),
      record('stopped', 'research.yaml', '2026-10-15T09:50:00Z', { status: 'cancelled' }),
    ]
    expect(earlierRecords(records, now).map((run) => run.runId)).toEqual(['newer', 'old'])
  })
})

const WRITER_TEAM = `schemaVersion: 1
entrypoint: writer
agents:
  - id: writer
    name: Writer
    role: Write.
    doneWhen:
      - Under 300 words
  - id: checker
    name: Checker
    role: Check it.
    checks: writer
`
// The same team after a Done when was added to it.
const LATER_TEAM = WRITER_TEAM.replace('      - Under 300 words\n', '      - Under 300 words\n      - Cites a source\n')

/** A daemon with one run, a team file on disk at `revision`, and a wardrobe that records earns. */
function daemon(run: RunRecord, file: { yaml: string; revision: string }) {
  let wardrobe: Record<string, unknown> = {}
  const posted: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/runs') return json([run])
    if (url === `/api/team?${new URLSearchParams({ path: run.teamPath })}`) return json({ path: run.teamPath, ...file })
    if (url === '/api/wardrobe') return json({ earned: wardrobe })
    if (url === '/api/wardrobe/earned') {
      const body = JSON.parse(String(init?.body)) as { item: string }
      posted.push(body)
      wardrobe = { ...wardrobe, [body.item]: { at: '2026-10-15T10:05:00Z', runId: run.runId, agentId: 'writer' } }
      return json(wardrobe[body.item], 201)
    }
    return json({}, 404)
  }))
  return posted
}

const ran = record('now', 'research.yaml', '2026-10-15T10:00:00Z', { status: 'succeeded', mode: 'team', entrypoint: 'writer', agentIds: ['writer', 'checker'], teamRevision: 'sha256:ran' })
const projection = {
  agents: [
    { id: 'writer', status: 'succeeded', reply: 'Here it is.', tokens: null },
    { id: 'checker', status: 'succeeded', reply: '## Check\n- Met — Under 300 words — 212 words', tokens: null },
  ] as unknown as ProjectedAgent[],
  evidence: [], messages: [],
  checks: [{ checker: 'checker', checked: 'writer', round: 1, items: [{ verdict: 'met', item: 'Under 300 words', evidence: '212 words' }] }],
  coverage: { agents: { level: 'complete', reason: 'observed' } },
} as unknown as RunProjection

describe('the team file a run is judged against', () => {
  it('is the file on disk only while it is still the revision the run executed', async () => {
    daemon(ran, { yaml: WRITER_TEAM, revision: 'sha256:ran' })
    expect((await agentsRunWith(ran))?.map((agent) => [agent.id, agent.doneWhen])).toEqual([['writer', ['Under 300 words']], ['checker', undefined]])
    // Edited since: the settings it ran with are gone, so it is not judged at all.
    daemon(ran, { yaml: LATER_TEAM, revision: 'sha256:later' })
    expect(await agentsRunWith(ran)).toBeNull()
    // A run from before the daemon kept the revision ran settings nobody can know.
    daemon(ran, { yaml: WRITER_TEAM, revision: 'sha256:ran' })
    expect(await agentsRunWith({ ...ran, teamRevision: undefined })).toBeNull()
  })
})

describe('a finished run’s quests', () => {
  it('puts what it earned in the wardrobe once its record is complete, and shows it on its receipt', async () => {
    const posted = daemon(ran, { yaml: WRITER_TEAM, revision: 'sha256:ran' })
    const { result, rerender } = renderHook((props: { complete: boolean }) => useRunQuests({
      record: ran, phase: 'succeeded',
      projection: props.complete ? projection : { ...projection, coverage: { ...projection.coverage, agents: { level: 'partial', reason: 'agents_awaiting_terminal_evidence' } } as unknown as RunProjection['coverage'] },
    }), { initialProps: { complete: false } })
    // Half a record is not judged.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posted).toEqual([])
    rerender({ complete: true })
    await waitFor(() => expect(result.current.map((earned) => earned.quest.item)).toEqual(['chalk']))
    expect(posted).toEqual([{ item: 'chalk', runId: 'now', teamPath: 'research.yaml', agentId: 'writer' }])
    expect(result.current[0].line).toBe('Checker checked Writer’s work and found all 1 item of its Done when met on the first pass.')
  })

  it('earns nothing for an old run whose team file has changed since, so a setting added later never counts', async () => {
    // The run's writer had no Done when; one was added after it. Judged against today's file, the
    // check that met the request would read as a Done when met, and chalk is earned for good.
    const posted = daemon(ran, { yaml: WRITER_TEAM, revision: 'sha256:edited-after-the-run' })
    const { result } = renderHook(() => useRunQuests({ record: ran, phase: 'succeeded', projection }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posted).toEqual([])
    expect(result.current).toEqual([])
  })
})
