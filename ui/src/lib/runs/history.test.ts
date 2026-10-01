import { describe, expect, it } from 'vitest'

import type { RunRecord } from './client'
import { historyRunUrl, mergeHistory, threadHistory } from './history'

const record = (overrides: Partial<RunRecord>): RunRecord => ({
  runId: 'r1',
  sessionId: 'r1',
  teamPath: 'research-team.yaml',
  prompt: 'Compare the adapters.',
  status: 'succeeded',
  mode: 'pipeline',
  entrypoint: 'researcher',
  responder: 'writer',
  agentIds: ['researcher', 'reviewer', 'writer'],
  createdAt: '2026-09-13T00:00:00Z',
  startedAt: '2026-09-13T00:00:01Z',
  finishedAt: '2026-09-13T00:03:00Z',
  error: null,
  exitCode: 0,
  eventCount: 40,
  reply: 'A comparison.',
  ...overrides,
})

describe('run history as a thread (Canvas B)', () => {
  /**
   * "The run history reads as a thread": a follow-up sits under the run it follows, at the depth
   * its chain gives it, rather than at the position its timestamp would give it.
   *
   * A **retry** is labelled and *not* indented, deliberately: it is the same prompt from zero, so
   * it is a sibling attempt rather than a continuation, and indenting it would claim it built on
   * something it explicitly did not.
   */
  it('indents follow-ups under the run they follow and labels retries in place', () => {
    const threaded = threadHistory(mergeHistory([
      record({ runId: 'run-1', finishedAt: '2026-09-13T00:03:00Z' }),
      record({
        runId: 'run-2',
        prompt: 'Shorter.',
        followsRunId: 'run-1',
        startAt: 'writer',
        finishedAt: '2026-09-13T00:06:00Z',
      }),
      record({
        runId: 'run-3',
        prompt: 'Shorter still.',
        followsRunId: 'run-2',
        startAt: null,
        finishedAt: '2026-09-13T00:09:00Z',
      }),
      record({
        runId: 'run-4',
        prompt: 'Compare the adapters.',
        retryOfRunId: 'run-1',
        finishedAt: '2026-09-13T00:12:00Z',
      }),
    ], []))

    expect(threaded.map((entry) => [entry.id, entry.depth, entry.lineage])).toEqual([
      // Newest first at the top level: the retry, then run-1 with its thread hanging off it.
      ['run-4', 0, 'retry'],
      ['run-1', 0, null],
      ['run-2', 1, 'follow-up from writer'],
      ['run-3', 2, 'follow-up'],
    ])
  })

  /**
   * The window is bounded, so a follow-up's parent can be outside it. It must stay visible at the
   * top level with its label intact rather than disappearing into a thread that is not there.
   */
  it('keeps an orphaned follow-up at the top level rather than dropping it', () => {
    const threaded = threadHistory(mergeHistory([
      record({ runId: 'run-9', prompt: 'Shorter.', followsRunId: 'a-run-outside-the-window' }),
    ], []))
    expect(threaded).toHaveLength(1)
    expect(threaded[0].depth).toBe(0)
    expect(threaded[0].lineage).toBe('follow-up')
  })

  /** A run with no lineage is exactly what it was: no label, no indent, nothing added. */
  it('leaves a run with no lineage alone', () => {
    const threaded = threadHistory(mergeHistory([record({ runId: 'run-1' })], []))
    expect(threaded[0].depth).toBe(0)
    expect(threaded[0].lineage).toBeNull()
  })

  /** The lineage fields come off the record, so they survive a page reload. */
  it('carries the record lineage fields onto the history row', () => {
    const [row] = mergeHistory([
      record({ runId: 'run-2', followsRunId: 'run-1', retryOfRunId: 'run-0', startAt: 'writer' }),
    ], [])
    expect([row.followsRunId, row.retryOfRunId, row.startAt]).toEqual(['run-1', 'run-0', 'writer'])
  })

  it('opens a run against the team file it executed', () => {
    const [row] = mergeHistory([record({ runId: 'run 16', teamPath: 'daily-news.yaml' })], [])
    expect(historyRunUrl(row)).toBe('/?path=daily-news.yaml&run=run+16')
  })
})
