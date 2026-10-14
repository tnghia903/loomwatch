import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../../lib/runs/client'
import { lessonRecords } from './useRunLessons'

function record(runId: string, createdAt: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId, sessionId: runId, teamPath: 'launch.yaml', prompt: 'p', status: 'succeeded', mode: 'team', entrypoint: 'lead', responder: 'lead',
    agentIds: ['lead'], createdAt, startedAt: createdAt, finishedAt: createdAt, error: null, exitCode: 0, eventCount: 1, reply: 'r', ...extra,
  }
}

describe('lessonRecords', () => {
  it('reads this team’s whole-team runs that ran to an end, newest first, five at most', () => {
    const records = [
      record('old', '2026-10-01T00:00:00Z'),
      ...['02', '03', '04', '05', '06'].map((day) => record(day, `2026-10-${day}T00:00:00Z`, day === '04' ? { status: 'failed' } : {})),
      record('other-team', '2026-10-09T00:00:00Z', { teamPath: 'other.yaml' }),
      record('cancelled', '2026-10-09T00:00:00Z', { status: 'cancelled' }),
      record('running', '2026-10-09T00:00:00Z', { status: 'running' }),
      record('one-agent', '2026-10-09T00:00:00Z', { onlyAgent: 'lead' }),
      record('follow-up', '2026-10-09T00:00:00Z', { startAt: 'writer' }),
    ]
    expect(lessonRecords(records, 'launch.yaml').map((one) => one.runId)).toEqual(['06', '05', '04', '03', '02'])
    expect(lessonRecords(records, 'nested/launch.yaml').map((one) => one.runId)).toHaveLength(5)
  })
})
