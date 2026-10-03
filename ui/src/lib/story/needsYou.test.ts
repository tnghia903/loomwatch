import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../runs/client'
import { ago, teamLabel, ticketsFrom } from './needsYou'

const NOW = Date.parse('2026-10-01T04:00:00Z')

function run(id: string, extra: Partial<RunRecord>): RunRecord {
  return { runId: id, sessionId: id, teamPath: 'daily-news.yaml', prompt: '', status: 'succeeded', mode: 'pipeline', entrypoint: 'a', responder: 'b', agentIds: [], createdAt: '2026-10-01T03:00:00Z', startedAt: null, finishedAt: null, error: null, exitCode: null, eventCount: 0, reply: null, ...extra }
}

const waiting = (kind: 'review_stop' | 'question', since: string) => ({ node: 'review', name: 'Editor', kind, since, question: 'Send these 5 stories on?', park: 'reloadable' as const, parkNote: '', sendBackAvailable: true, handoverFrom: 'editor' })

describe('ticketsFrom', () => {
  const names = new Map([['daily-news.yaml', 'Daily news']])

  it('turns a parked run into a review or question ticket, oldest first, before failures', () => {
    const tickets = ticketsFrom([
      run('f1', { status: 'failed', error: 'Coder could not open slides.pptx\nstack…', finishedAt: '2026-10-01T03:30:00Z' }),
      run('r2', { status: 'running', waitingOn: waiting('question', '2026-10-01T03:50:00Z') }),
      run('r1', { status: 'running', waitingOn: waiting('review_stop', '2026-10-01T03:40:00Z') }),
    ], names, new Set(), NOW)
    expect(tickets.map((ticket) => [ticket.kind, ticket.runId])).toEqual([['review', 'r1'], ['question', 'r2'], ['failed', 'f1']])
    expect(tickets[0]).toMatchObject({ teamName: 'Daily news', node: 'review', sendBackTo: 'editor', text: 'Send these 5 stories on?' })
    expect(tickets[2].text).toBe('Coder could not open slides.pptx')
  })

  it('drops dismissed and day-old failures, and finished runs', () => {
    const tickets = ticketsFrom([
      run('old', { status: 'failed', finishedAt: '2026-09-29T03:00:00Z' }),
      run('gone', { status: 'failed', finishedAt: '2026-10-01T03:59:00Z' }),
      run('ok', { status: 'succeeded' }),
    ], names, new Set(['gone']), NOW)
    expect(tickets).toEqual([])
  })

  it('turns each permission request into its own ticket, ahead of failures (ADR 0040)', () => {
    const request = (id: string, since: string) => ({ id, agent: 'researcher', name: 'Researcher', title: 'Web search', kind: 'fetch', switch: 'web' as const, detail: 'model cards 2019', since, expiresAt: '2026-10-01T04:10:00Z' })
    const tickets = ticketsFrom([
      run('f1', { status: 'failed', finishedAt: '2026-10-01T03:30:00Z' }),
      run('r1', { status: 'running', permissionRequests: [request('p2', '2026-10-01T03:58:00Z'), request('p1', '2026-10-01T03:55:00Z')] }),
    ], names, new Set(), NOW)
    expect(tickets.map((ticket) => [ticket.kind, ticket.requestId ?? null])).toEqual([['permission', 'p1'], ['permission', 'p2'], ['failed', null]])
    expect(tickets[0]).toMatchObject({ teamName: 'Daily news', node: 'researcher', asker: 'Researcher', text: 'Researcher wants to use the web', context: 'Web search · model cards 2019' })
  })

  it('offers no send-back when the daemon does not allow it', () => {
    const [ticket] = ticketsFrom([run('r1', { status: 'running', waitingOn: { ...waiting('review_stop', '2026-10-01T03:40:00Z'), sendBackAvailable: false } })], names, new Set(), NOW)
    expect(ticket.sendBackTo).toBeNull()
  })
})

describe('labels', () => {
  it('falls back to the file name for an unknown team', () => {
    expect(teamLabel('nested/blog-writer.yaml', new Map())).toBe('blog-writer')
  })
  it('says how long ago', () => {
    expect(ago('2026-10-01T03:59:40Z', NOW)).toBe('just now')
    expect(ago('2026-10-01T03:48:00Z', NOW)).toBe('12 min ago')
    expect(ago('2026-10-01T01:00:00Z', NOW)).toBe('3 h ago')
  })
})
