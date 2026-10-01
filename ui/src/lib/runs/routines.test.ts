import { describe, expect, it } from 'vitest'

import { describeNextFire, scheduleForPath, type RunRecord, type ScheduleEntry } from './client'
import { mergeHistory } from './history'
import type { SessionSummary } from '../watch/events'

const entry: ScheduleEntry = {
  teamPath: 'daily-news.yaml', teamName: 'Daily news', cron: '0 8 * * *', timezone: 'Asia/Singapore', describe: 'daily at 08:00 Asia/Singapore',
  prompt: 'Prepare the digest.', enabled: true, nextAt: null, lastRunId: null, lastStatus: null, lastFiredAt: null, lastDelivery: null, deliver: { notion: { title: 'News — {{date}}' } }, problem: null,
}

const record = (overrides: Partial<RunRecord>): RunRecord => ({
  runId: 'r1', sessionId: 'r1', teamPath: 'daily-news.yaml', prompt: 'Prepare the digest.', status: 'succeeded', mode: 'pipeline', entrypoint: 'a', responder: 'c', agentIds: ['a', 'b', 'c'],
  createdAt: '2026-09-11T00:00:00Z', startedAt: '2026-09-11T00:00:01Z', finishedAt: '2026-09-11T00:03:00Z', error: null, exitCode: 0, eventCount: 40, reply: 'Digest', ...overrides,
})

describe('routines in the UI', () => {
  /**
   * A history row for a run the daemon has forgotten now reads the recorded task section, so a new
   * run never needs the regex that split the composed prompt back apart.
   *
   * The fixture is the failure the regex was always going to have: a Brief file whose own Markdown
   * contains a line that looks like one of LoomWatch's headings. The split takes the *first*
   * `## Task` and hands back the Brief's tail as the operator's prompt; the recorded section is
   * simply correct. The second session has no `task` at all — archived before phase 1 started
   * recording the sections — and is the only case the fallback is still for.
   */
  it('labels an archive-only row from the recorded task, not by splitting the prompt', () => {
    const session = (id: string, extra: Partial<SessionSummary>): SessionSummary => ({
      sessionId: id, startedAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:01:00Z',
      eventCount: 12, agentCount: 2, ...extra,
    })
    const composed = [
      '## Your assigned role', 'You research.', '',
      '## What the team knows', '### House constraints', '',
      // The operator's own Brief, quoting a heading LoomWatch also uses.
      '## Task', 'Never touch main.', '',
      '## Task', 'compare the adapters',
    ].join('\n')
    const [recorded, legacy] = mergeHistory([], [
      session('recorded', { prompt: composed, task: 'compare the adapters' }),
      session('legacy', { prompt: composed, updatedAt: '2026-09-12T00:01:00Z' }),
    ])
    expect(recorded.prompt).toBe('compare the adapters')
    // What the split produces instead, for a session that has no record to read.
    expect(legacy.prompt).toContain('Never touch main.')
    expect(legacy.prompt).not.toBe('compare the adapters')
  })

  it('matches a routine to the open document by its root-relative path', () => {
    expect(scheduleForPath([entry], '/Users/me/loomwatch/teams/daily-news.yaml')).toBe(entry)
    expect(scheduleForPath([entry], 'daily-news.yaml')).toBe(entry)
    expect(scheduleForPath([entry], '/Users/me/loomwatch/teams/other.yaml')).toBeNull()
    expect(scheduleForPath(null, 'daily-news.yaml')).toBeNull()
  })

  it('describes the next fire in the operator\'s units', () => {
    const now = Date.parse('2026-09-11T00:00:00Z')
    expect(describeNextFire(null)).toBe('not scheduled')
    expect(describeNextFire('2026-09-11T00:20:00Z', now)).toBe('in 20m')
    expect(describeNextFire('2026-09-11T09:00:00Z', now)).toBe('in 9h')
    expect(describeNextFire('2026-09-14T00:00:00Z', now)).toBe('in 3d')
    expect(describeNextFire('2026-09-10T00:00:00Z', now)).toBe('due now')
  })

  it('marks routine runs and their Notion delivery in history', () => {
    const [published, failed, manual] = mergeHistory([
      record({ runId: 'r1', trigger: 'schedule', delivery: { target: 'notion', status: 'published', url: 'https://www.notion.so/abc', pageId: 'abc', message: 'ok', deliveredAt: '2026-09-11T00:03:05Z' }, finishedAt: '2026-09-11T00:03:00Z' }),
      record({ runId: 'r2', trigger: 'schedule', delivery: { target: 'notion', status: 'failed', url: null, pageId: null, message: 'Notion is not connected.', deliveredAt: '2026-09-11T00:02:05Z' }, finishedAt: '2026-09-11T00:02:00Z' }),
      record({ runId: 'r3', trigger: 'manual', finishedAt: '2026-09-11T00:01:00Z' }),
    ], [])
    expect(published.sub).toContain('routine')
    expect(published.sub).toContain('published to Notion')
    expect(failed.sub).toContain('delivery failed')
    expect(manual.sub).not.toContain('routine')
  })
})
