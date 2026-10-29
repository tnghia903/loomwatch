import { describe, expect, it } from 'vitest'

import type { RunRecord, ScheduleEntry } from '../runs/client'
import type { UsageReport } from '../usage/client'
import { costWords, finishedToday, isMadeThing, lastFinished, madeHere, monthCost, monthSpend, needsYou, nextWork, workingNow, type MonthCost } from './glance'
import type { TeamShape } from './studio'

const ROOT = '/teams'

function run(teamPath: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `run-${Math.random()}`, sessionId: 's', teamPath, prompt: 'p', status: 'running', mode: 'pipeline', entrypoint: 'writer', responder: 'writer',
    agentIds: [], createdAt: '2026-10-28T09:00:00Z', startedAt: '2026-10-28T09:00:00Z', finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null,
    ...extra,
  } as RunRecord
}

const shape = (path: string, name: string, seats: TeamShape['seats']): TeamShape => ({ path, name, project: 'm', seats, schedule: null })
// A project lists its teams by their paths under the teams folder, as the runs name them; a run
// started from a full path names it in full.
const LAUNCH = shape('launch.yaml', 'Launch posts', [{ kind: 'agent', id: 'researcher', name: 'Researcher' }, { kind: 'you', id: 'check', name: 'You check' }, { kind: 'agent', id: 'writer', name: 'Writer' }])
const LANDING = shape('landing.yaml', 'Landing page', [{ kind: 'agent', id: 'illustrator', name: 'Illustrator' }])
const WATCH = shape('watch.yaml', 'Competitor watch', [{ kind: 'agent', id: 'scout', name: 'Scout' }])
const SHAPES = [LAUNCH, LANDING, WATCH]
const ROOM = SHAPES.map((team) => team.path)

describe('what a room shows at a glance', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z')
  const NONE = new Set<string>()

  it('puts what waits for you first, then the work that stopped, says why and the fix, and keeps to the room', () => {
    const waitingOn = (since: string) => ({ node: 'check', name: 'You', kind: 'review_stop' as const, since, question: 'Check it', handoverFrom: 'illustrator', park: 'none' as const, parkNote: '', sendBackAvailable: true })
    // Two teams of another project: one whose run waits for you, one whose run stopped.
    const OTHERS = [shape('wait.yaml', 'Elsewhere', [{ kind: 'agent', id: 'illustrator', name: 'Illustrator' }]), shape('stop.yaml', 'Stopped elsewhere', [{ kind: 'agent', id: 'writer', name: 'Writer' }])]
    const runs = [
      run('watch.yaml', { status: 'failed', createdAt: '2026-10-28T07:00:00Z', finishedAt: '2026-10-28T07:02:00Z', responder: 'scout', error: 'Your OpenRouter account is out of credits. Add credits on openrouter.ai, then try again.' }),
      run('/teams/landing.yaml', { waitingOn: waitingOn('2026-10-28T09:20:00Z') }),
      run('wait.yaml', { waitingOn: waitingOn('2026-10-28T08:00:00Z') }),
      run('stop.yaml', { status: 'failed', createdAt: '2026-10-28T06:00:00Z' }),
    ]
    // Home sees them all; the room only its own.
    expect(needsYou(runs, [...SHAPES, ...OTHERS], ROOT, null, NONE, NOW).map((item) => item.teamName)).toEqual(['Elsewhere', 'Landing page', 'Stopped elsewhere', 'Competitor watch'])
    const items = needsYou(runs, [...SHAPES, ...OTHERS], ROOT, ROOM, NONE, NOW)
    expect(items.map((item) => [item.kind, item.teamName, item.seat.name, item.says, item.asks])).toEqual([
      ['waiting', 'Landing page', 'Illustrator', 'brought work for you to check', 'check'],
      ['failed', 'Competitor watch', 'Scout', 'didn’t finish', undefined],
    ])
    // Why it stopped, in plain words, and the fix LoomWatch knows for it.
    expect(items[1].reason).toMatch(/out of credits/)
    expect(items[1].fix).toMatchObject({ label: 'Add OpenRouter credits', external: true })
  })

  it('counts stopped work as the bell does: not after a day, not once dismissed, not while it is tried again', () => {
    const runs = [
      run('watch.yaml', { runId: 'old', status: 'failed', createdAt: '2026-10-27T07:00:00Z', finishedAt: '2026-10-27T07:00:00Z' }),
      run('watch.yaml', { runId: 'dismissed', status: 'failed', finishedAt: '2026-10-28T08:00:00Z' }),
      run('landing.yaml', { runId: 'routine', status: 'failed', finishedAt: '2026-10-28T09:00:00Z', nextTryAt: '2026-10-28T10:00:00Z' }),
      run('launch.yaml', { runId: 'shown', status: 'failed', finishedAt: '2026-10-28T11:00:00Z' }),
    ]
    expect(needsYou(runs, SHAPES, ROOT, ROOM, new Set(['dismissed']), NOW).map((item) => item.runId)).toEqual(['shown'])
  })

  it('names who is working and in which team, and a run that is starting by its first agent', () => {
    const runs = [
      run('launch.yaml', { working: ['writer'], startedAt: '2026-10-28T09:10:00Z' }),
      run('watch.yaml', { status: 'starting', responder: 'scout', startedAt: '2026-10-28T09:00:00Z' }),
      run('launch.yaml', { status: 'succeeded' }),
    ]
    expect(workingNow(runs, SHAPES, ROOT, ROOM).map((at) => `${at.seat.name} · ${at.teamName}`)).toEqual(['Scout · Competitor watch', 'Writer · Launch posts'])
  })

  it('says the next runs on a schedule, soonest first, and leaves out a paused one', () => {
    const entry = (teamPath: string, teamName: string, nextAt: string | null, enabled = true) => ({ teamPath, teamName, nextAt, enabled, problem: null }) as ScheduleEntry
    const entries = [
      entry('watch.yaml', 'Competitor watch', '2026-10-30T07:00:00Z'),
      entry('newsletter.yaml', 'Weekly newsletter', '2026-11-02T09:00:00Z'),
      entry('launch.yaml', 'Launch posts', '2026-10-29T08:00:00Z', false),
      entry('landing.yaml', 'Landing page', '2026-10-29T12:00:00Z'),
    ]
    expect(nextWork(entries, ROOT, ROOM).map((next) => next.teamName)).toEqual(['Landing page', 'Competitor watch'])
    expect(nextWork(entries, ROOT, null, 5).map((next) => next.teamName)).toEqual(['Landing page', 'Competitor watch', 'Weekly newsletter'])
  })

  it('adds up this month’s runs by team, and says “at least” when one counted nothing', () => {
    const now = new Date(2026, 9, 29, 12)
    const runs = [
      run('launch.yaml', { createdAt: new Date(2026, 9, 3).toISOString(), spend: { spentUsd: 0.5 } }),
      run('launch.yaml', { createdAt: new Date(2026, 9, 20).toISOString(), spend: { spentUsd: 0.02 } }),
      run('landing.yaml', { createdAt: new Date(2026, 9, 28).toISOString(), spend: { spentUsd: 0.31 } }),
      run('landing.yaml', { createdAt: new Date(2026, 8, 30).toISOString(), spend: { spentUsd: 9 } }),
      run('elsewhere.yaml', { createdAt: new Date(2026, 9, 28).toISOString(), spend: { spentUsd: 4 } }),
    ]
    const spend = monthSpend(runs, ROOT, ROOM, now)
    expect(spend.usd).toBeCloseTo(0.83)
    expect(spend.runs).toBe(3)
    expect(spend.atLeast).toBe(false)
    expect(spend.byTeam.get('launch.yaml')).toEqual({ usd: 0.52, runs: 2 })
    expect(monthSpend([...runs, run('watch.yaml', { createdAt: new Date(2026, 9, 28).toISOString() })], ROOT, ROOM, now).atLeast).toBe(true)
  })

  it('says this month’s cost by where it was paid: a ChatGPT plan as a plan, a list-price estimate as one', () => {
    const tally = (costUsd: number, calls = 1, costEstimated = false) => ({ calls, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd, costEstimated })
    const report = {
      since: '2026-10-01',
      days: [],
      sources: [{ source: 'openrouter', total: tally(0.4) }, { source: 'anthropic', total: tally(0.2, 1, true) }, { source: 'chatgpt', total: tally(0, 12) }],
      agents: [
        { ...tally(0.4), team: 'Launch posts', ask: false, agentId: 'writer', source: 'openrouter', runs: 2 },
        { ...tally(0, 12), team: 'Landing page', ask: false, agentId: 'illustrator', source: 'chatgpt', runs: 1 },
        { ...tally(0.2, 1, true), team: 'Elsewhere', ask: false, agentId: 'x', source: 'anthropic', runs: 1 },
      ],
    } as unknown as UsageReport
    const home = monthCost(report, null)
    expect(home).toEqual({ usd: 0.6000000000000001, estimated: true, plan: true })
    expect(costWords(home as MonthCost)).toBe('≈ $0.6 + ChatGPT plan')
    expect(costWords(monthCost(report, ['Launch posts']) as MonthCost)).toBe('$0.4')
    // Never "$0" for work a plan paid for.
    expect(costWords(monthCost(report, ['Landing page']) as MonthCost)).toBe('ChatGPT plan')
    expect(costWords({ usd: 0, estimated: false, plan: false })).toBe('$0')
    expect(monthCost(null, null)).toBeNull()
  })

  it('lists what the agents made, newest work first, each file once, and leaves out code and logs', () => {
    const runs = [
      run('launch.yaml', { status: 'succeeded', finishedAt: '2026-10-28T08:00:00Z', made: ['/w/post ideas.md', '/w/build.py', '/w/run.log'] }),
      run('landing.yaml', { status: 'succeeded', finishedAt: '2026-10-28T09:00:00Z', made: ['/w/hero.png', '/w/post ideas.md'] }),
      run('launch.yaml', { status: 'running', made: ['/w/draft.md'] }),
      run('elsewhere.yaml', { status: 'succeeded', finishedAt: '2026-10-28T10:00:00Z', made: ['/w/other.md'] }),
    ]
    expect(madeHere(runs, ROOT, ROOM).map((file) => [file.path, file.team])).toEqual([
      ['/w/hero.png', 'landing.yaml'],
      ['/w/post ideas.md', 'landing.yaml'],
    ])
    expect(isMadeThing('/w/brief.docx')).toBe(true)
    expect(isMadeThing('/w/app.ts')).toBe(false)
  })

  it('finds the last work that went well and what it made first, and today’s', () => {
    const now = new Date(2026, 9, 28, 18)
    const older = run('launch.yaml', { status: 'succeeded', finishedAt: new Date(2026, 9, 27, 9).toISOString(), made: ['/w/old.md'] })
    const newest = run('landing.yaml', { status: 'succeeded', finishedAt: new Date(2026, 9, 28, 9).toISOString(), made: ['/w/code.ts', '/w/hero.png'] })
    const failed = run('watch.yaml', { status: 'failed', finishedAt: new Date(2026, 9, 28, 10).toISOString() })
    expect(lastFinished([older, newest, failed], ROOT, ROOM)).toEqual({ run: newest, file: '/w/hero.png' })
    expect(finishedToday([older, newest, failed], ROOT, ROOM, now)).toEqual([newest])
  })
})
