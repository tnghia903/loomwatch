import { describe, expect, it } from 'vitest'

import type { PermissionRequest, RunRecord, WaitingOn } from '../runs/client'
import { agentPresence, benchChatId, presenceOf, teamPresence } from './presence'

function run(id: string, extra: Partial<RunRecord>): RunRecord {
  return { runId: id, sessionId: id, teamPath: 'blog.yaml', prompt: '', status: 'succeeded', mode: 'pipeline', entrypoint: 'a', responder: 'a', agentIds: ['a'], createdAt: '2026-10-20T03:00:00Z', startedAt: null, finishedAt: null, error: null, exitCode: null, eventCount: 0, reply: null, ...extra }
}

const stop: WaitingOn = { node: 'review', name: 'You', kind: 'review_stop', since: '2026-10-20T03:10:00Z', question: 'Send it on?', park: 'reloadable', parkNote: '', sendBackAvailable: true }
const asking = { id: 'p1' } as unknown as PermissionRequest

describe('presenceOf', () => {
  it('rests when nothing has run, or the newest run ended well', () => {
    expect(presenceOf([])).toBe('ready')
    expect(presenceOf([run('old', { status: 'failed', createdAt: '2026-10-20T01:00:00Z' }), run('new', { status: 'succeeded', createdAt: '2026-10-20T02:00:00Z' })])).toBe('ready')
  })

  it('works while a run is under way, whatever came before', () => {
    expect(presenceOf([run('done', { status: 'failed' }), run('now', { status: 'running', createdAt: '2026-10-20T04:00:00Z' })])).toBe('working')
    expect(presenceOf([run('queued', { status: 'queued' })])).toBe('working')
  })

  // Gold outranks blue: a question, a permission or a spend limit is your turn even while other work runs.
  it('waits for you when a live run asks you anything', () => {
    expect(presenceOf([run('busy', { status: 'running' }), run('stop', { status: 'running', waitingOn: stop })])).toBe('waiting')
    expect(presenceOf([run('perm', { status: 'running', permissionRequests: [asking] })])).toBe('waiting')
    expect(presenceOf([run('spend', { status: 'running', spendStops: [{ id: 's1' } as never] })])).toBe('waiting')
  })

  it('stays failed until the next run starts, and a finished run that once asked asks no more', () => {
    expect(presenceOf([run('ok', { createdAt: '2026-10-20T01:00:00Z' }), run('broke', { status: 'failed', createdAt: '2026-10-20T02:00:00Z' })])).toBe('failed')
    expect(presenceOf([run('was-asking', { status: 'succeeded', waitingOn: stop })])).toBe('ready')
  })

  it('rests while the schedule waits to try a run again that couldn’t reach its AI', () => {
    expect(presenceOf([run('waking', { status: 'failed', trigger: 'schedule', nextTryAt: '2026-10-20T03:01:00Z' })])).toBe('ready')
  })
})

describe('benchChatId', () => {
  it('names the agent whose own chat a team file is, on any platform', () => {
    expect(benchChatId('/Users/ana/LoomWatch/teams/.jobs/.bench/writer.yaml')).toBe('writer')
    expect(benchChatId('C:\\Users\\ana\\LoomWatch\\teams\\.jobs\\.bench\\writer.yaml')).toBe('writer')
    expect(benchChatId('.jobs/.bench/trip-planner.yml')).toBe('trip-planner')
  })

  it('is no one for a team, or a file that only looks close', () => {
    expect(benchChatId('/teams/blog.yaml')).toBeNull()
    expect(benchChatId('/teams/.jobs/writer.yaml')).toBeNull()
    expect(benchChatId('/teams/.bench/writer.yaml')).toBeNull()
    expect(benchChatId('/teams/.jobs/old/writer.yaml')).toBeNull()
    expect(benchChatId('/teams/.jobs/.bench/notes.txt')).toBeNull()
  })
})

describe('agentPresence and teamPresence', () => {
  const runs = [
    run('w', { teamPath: '/Users/ana/LoomWatch/teams/.jobs/.bench/writer.yaml', status: 'running' }),
    run('e', { teamPath: '/Users/ana/LoomWatch/teams/.jobs/.bench/editor.yaml', status: 'running', permissionRequests: [asking] }),
    run('b', { teamPath: '/Users/ana/LoomWatch/teams/blog.yaml', status: 'running', waitingOn: stop }),
    run('t', { teamPath: 'trip.yaml', status: 'failed' }),
  ]

  it('reads each agent from its own chat only', () => {
    expect(agentPresence(runs, 'writer')).toBe('working')
    expect(agentPresence(runs, 'editor')).toBe('waiting')
    expect(agentPresence(runs, 'blog')).toBe('ready')
  })

  // The running app names a team by its full path; the list names it under the teams folder.
  it('matches a team listed under the folder to runs that name it either way', () => {
    expect(teamPresence(runs, 'blog.yaml', '/Users/ana/LoomWatch/teams')).toBe('waiting')
    expect(teamPresence(runs, 'trip.yaml', '/Users/ana/LoomWatch/teams')).toBe('failed')
    expect(teamPresence(runs, 'writer.yaml', '/Users/ana/LoomWatch/teams')).toBe('ready')
    expect(teamPresence([run('win', { teamPath: 'C:\\Users\\ana\\LoomWatch\\teams\\blog.yaml', status: 'running' })], 'blog.yaml', 'C:\\Users\\ana\\LoomWatch\\teams')).toBe('working')
  })
})
