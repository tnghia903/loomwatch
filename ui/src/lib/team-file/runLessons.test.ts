import { describe, expect, it } from 'vitest'

import type { TeamMessage } from '../watch/messages'
import { appendToRole, checkup, type CheckupInput } from './checkup'
import { lessonRun, mergeFindings, runLessons, teamUsage, type AgentRunUsage, type LessonRun } from './runLessons'
import type { AgentConfig } from './types'

const CLAUDE = { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' }
const agent = (id: string, role: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), role, spawn: CLAUDE, model: 'm', ...extra })

type Message = LessonRun['messages'][number]
const message = (kind: TeamMessage['kind'], from: string, to: string, text = 'x', extra: Partial<Message> = {}): Message => ({ kind, from, to, text, carried: false, ...extra })
const permission = (from: string, key: string, outcome: NonNullable<TeamMessage['permission']>['outcome'] = 'allow_once'): Message =>
  message('permission', from, 'operator', 'Search', { permission: { requestId: 'r', switch: key, detail: null, outcome, settled: null } })

function run(id: string, mode: 'team' | 'pipeline', agentIds: string[], messages: Message[] = [], failed: [string, string | null][] = [], usage: [string, AgentRunUsage][] = []): LessonRun {
  return { runId: id, succeeded: failed.length === 0, mode, entrypoint: agentIds[0], agentIds, messages, failed: new Map(failed), usage: new Map(usage) }
}

const LEAD_ROLE = 'You plan product launches. Reply with the plan as a checklist grouped by week.'
const team = (agents: AgentConfig[], edges: CheckupInput['edges'] = [], extra: Partial<CheckupInput> = {}): CheckupInput =>
  ({ agents, edges, entrypoint: agents[0].id, responder: edges.length ? agents.at(-1)?.id ?? null : agents[0].id, ...extra })

describe('runLessons', () => {
  it('notices a lead that never hands a teammate anything, and clears once told to', () => {
    const agents = [agent('lead', LEAD_ROLE), agent('scout', 'Find launches.'), agent('writer', 'Write copy.')]
    const runs = ['a', 'b', 'c'].map((id) => run(id, 'team', ['lead', 'scout', 'writer'], [message('dispatch', 'lead', 'writer')]))
    const [lesson] = runLessons(runs, team(agents))
    expect(lesson).toMatchObject({ rule: 'idle-teammate', agentId: 'lead', agentIds: ['lead', 'scout'], learned: 3, title: 'Lead never gave Scout any work' })
    const fix = lesson.fix?.change
    const told = agents.map((one) => (fix?.kind === 'append-role' && one.id === fix.agentId ? { ...one, role: appendToRole(one.role, fix.text) } : one))
    expect(runLessons(runs, team(told))).toEqual([])
    // Two runs are not a habit, and a run led by someone else says nothing about this lead.
    expect(runLessons(runs.slice(0, 2), team(agents))).toEqual([])
    expect(runLessons(runs.map((one) => ({ ...one, entrypoint: 'writer' })), team(agents))).toEqual([])
    // A run that failed may have stopped before the lead could hand anything out.
    expect(runLessons(runs.map((one) => ({ ...one, succeeded: false })), team(agents))).toEqual([])
  })

  it('quotes what a later stage keeps asking an earlier one, and offers to put it in the handover', () => {
    const agents = [agent('researcher', 'Find facts.'), agent('writer', 'Write it.')]
    const runs = [
      run('a', 'pipeline', ['researcher', 'writer'], [message('ask', 'writer', 'researcher', 'Which year is the revenue figure from?'), message('ask', 'writer', 'researcher', 'Is the source paywalled?')]),
      run('b', 'pipeline', ['researcher', 'writer'], [message('ask', 'writer', 'researcher', 'Which year is the revenue figure from?\nThanks'), message('ask', 'writer', 'researcher', 'Can you give the link?', { carried: true })]),
    ]
    const [lesson] = runLessons(runs, team(agents, [{ from: 'researcher', to: 'writer' }]))
    expect(lesson).toMatchObject({ rule: 'asked-again', agentId: 'researcher', title: 'Writer keeps asking Researcher for more', learned: 2 })
    expect(lesson.why).toBe('Writer asked Researcher 3 questions, such as “Which year is the revenue figure from?”. What it asks for belongs in Researcher\'s handover.')
    expect(lesson.fix?.change).toMatchObject({ kind: 'append-role', agentId: 'researcher', text: 'Writer works from your handover and has had to ask you for more, such as: “Which year is the revenue figure from?”; “Is the source paywalled?”. Put that kind of detail in your handover from the start.' })
    // In team mode an ask is how a lead hands out work, not a sign of a thin handover.
    expect(runLessons(runs.map((one) => ({ ...one, mode: 'team' as const })), team(agents, [{ from: 'researcher', to: 'writer' }]))).toEqual([])
  })

  it('counts the same permission asked run after run, and replaces the guess from the instructions', () => {
    const scout = agent('scout', 'Look through news websites for AI agents this week and reply with five bullets.')
    const runs = [run('a', 'team', ['scout'], [permission('scout', 'web', 'timed_out')]), run('b', 'team', ['scout'], [permission('scout', 'web')]), run('c', 'team', ['scout'])]
    const lessons = runLessons(runs, team([scout]))
    expect(lessons).toEqual([expect.objectContaining({
      id: 'needs-web:scout', learned: 3,
      title: 'Scout asked to search the web in 2 of 3 runs',
      why: 'Each time, the run waited for your answer, and one was declined or not answered. Allow it here if you trust Scout with it.',
    })])
    const merged = mergeFindings(checkup(team([scout])), lessons)
    expect(merged.filter((finding) => finding.id === 'needs-web:scout')).toEqual([lessons[0]])
    expect(runLessons(runs, team([{ ...scout, allow: { web: true } }]))).toEqual([])
    expect(runLessons(runs, team([{ ...scout, spawn: { ...CLAUDE, cmd: 'opencode', args: ['acp'] } }]))).toEqual([])
  })

  it('says when an agent fails again, with the last reason the record gives', () => {
    const agents = [agent('coder', 'Fix the bug and run the tests, then reply with what changed.')]
    const runs = [run('a', 'team', ['coder'], [], [['coder', 'refusal']]), run('b', 'team', ['coder']), run('c', 'team', ['coder'], [], [['coder', null]])]
    expect(runLessons(runs, team(agents))).toEqual([expect.objectContaining({ rule: 'keeps-failing', severity: 'fix', title: 'Coder failed in 2 of 3 runs', why: 'Last time: refusal. Check its AI app and model first, then its instructions.' })])
  })

  it('reads only the most recent runs', () => {
    const scout = agent('scout', 'Reply with five bullets about the topic, each with its source.')
    const old = [run('x', 'team', ['scout'], [permission('scout', 'web')]), run('y', 'team', ['scout'], [permission('scout', 'web')])]
    const recent = Array.from({ length: 5 }, (_, index) => run(`r${index}`, 'team', ['scout']))
    expect(runLessons([...recent, ...old], team([scout]))).toEqual([])
  })
})

describe('lessonRun', () => {
  it('keeps what the lessons read from a projection and its events', () => {
    const reduced = lessonRun(
      { runId: 'a', status: 'failed', mode: 'pipeline', entrypoint: 'r', agentIds: ['r', 'w'] },
      { messages: [], agents: [{ id: 'r', status: 'failed', stopReason: null, exitCode: 2, tokens: null }, { id: 'w', status: 'succeeded', stopReason: null, exitCode: 0, tokens: 41_000 }] as never },
      [
        { agentId: 'w', kind: 'message', payload: {} },
        { agentId: 'w', kind: 'usage', payload: { used: 28_500, size: 200_000 } },
        { agentId: 'w', kind: 'usage', payload: { used: 39_000, size: 200_000 } },
      ],
    )
    expect([...reduced.failed]).toEqual([['r', 'its app exited with code 2']])
    expect(reduced.succeeded).toBe(false)
    // The first reading is the opening cost; an agent that reported nothing has no entry.
    expect([...reduced.usage]).toEqual([['w', { tokens: 41_000, opening: 28_500 }]])
  })

  // 2026-10-14: Codex refused the model and ended the turn `end_turn`; "Last time: end_turn" says nothing.
  it('keeps what its app said went wrong over the stop reason', () => {
    const refusal = 'The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.'
    const reduced = lessonRun(
      { runId: 'a', status: 'failed', mode: 'pipeline', entrypoint: 'g', agentIds: ['g'] },
      { messages: [], agents: [{ id: 'g', status: 'failed', stopReason: 'end_turn', error: refusal, exitCode: null, tokens: null }] as never },
    )
    expect([...reduced.failed]).toEqual([['g', refusal]])
  })
})

describe('teamUsage', () => {
  const agents = [agent('lead', LEAD_ROLE), agent('scout', 'Find launches.', { spawn: { ...CLAUDE, cmd: 'codex-acp' } }), agent('idle', 'Never runs.')]

  it('says where the tokens went, per run and per agent, most first', () => {
    const runs = [
      run('a', 'team', ['lead', 'scout'], [], [], [['lead', { tokens: 30_000, opening: 20_000 }], ['scout', { tokens: 90_000, opening: 12_000 }]]),
      run('b', 'team', ['lead', 'scout'], [], [], [['lead', { tokens: 50_000, opening: 24_000 }]]),
    ]
    expect(teamUsage(runs, agents)).toEqual({
      runs: 2, perRun: 85_000,
      agents: [
        { id: 'scout', name: 'Scout', perRun: 45_000, share: 90_000 / 170_000, opening: 12_000 },
        { id: 'lead', name: 'Lead', perRun: 40_000, share: 80_000 / 170_000, opening: 20_000 },
      ],
    })
  })

  it('has nothing to say before any run reported usage', () => {
    expect(teamUsage([run('a', 'team', ['lead'])], agents)).toBeNull()
  })
})
