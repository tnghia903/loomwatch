import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '../../lib/runs/client'
import type { AgentConfig } from '../../lib/team-file/types'
import type { ProjectedAgent, RunProjection } from '../../lib/watch/events'
import { benchedBefore, earlierRecords, useRunQuests } from './useRunQuests'

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

describe('a finished run’s quests', () => {
  it('puts what it earned in the wardrobe once its record is complete, and shows it on its receipt', async () => {
    const now = record('now', 'research.yaml', '2026-10-15T10:00:00Z', { status: 'succeeded', mode: 'team', entrypoint: 'writer', agentIds: ['writer'] })
    let wardrobe: Record<string, unknown> = {}
    const posted: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/runs') return json([now])
      if (url === '/api/wardrobe') return json({ earned: wardrobe })
      if (url === '/api/wardrobe/earned') {
        const body = JSON.parse(String(init?.body)) as { item: string }
        posted.push(body)
        wardrobe = { ...wardrobe, [body.item]: { at: '2026-10-15T10:05:00Z', runId: 'now', agentId: 'writer' } }
        return json(wardrobe[body.item], 201)
      }
      return json({}, 404)
    }))
    const agents: AgentConfig[] = [{ id: 'writer', name: 'Writer', role: 'Write.', doneWhen: ['Under 300 words'] }, { id: 'checker', name: 'Checker', role: 'Check it.', checks: 'writer' }]
    const projection = {
      agents: [
        { id: 'writer', status: 'succeeded', reply: 'Here it is.', tokens: null },
        { id: 'checker', status: 'succeeded', reply: '## Check\n- Met — Under 300 words — 212 words', tokens: null },
      ] as unknown as ProjectedAgent[],
      evidence: [], messages: [],
      checks: [{ checker: 'checker', checked: 'writer', round: 1, items: [{ verdict: 'met', item: 'Under 300 words', evidence: '212 words' }] }],
      coverage: { agents: { level: 'complete', reason: 'observed' } },
    } as unknown as RunProjection
    const { result, rerender } = renderHook((props: { complete: boolean }) => useRunQuests({
      record: now, agents, phase: 'succeeded',
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
})
