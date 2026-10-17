import { describe, expect, it } from 'vitest'

import type { LessonRun } from '../team-file/runLessons'
import type { AgentConfig } from '../team-file/types'
import type { Evidence, ProjectedAgent } from '../watch/events'
import type { TeamMessage } from '../watch/messages'
import { AREAS, QUESTS } from './catalog'
import { questsEarned, wholeCraft, type QuestFacts } from './rules'

const agent = (id: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), role: 'Do it.', ...extra })
const ran = (id: string, extra: Partial<ProjectedAgent> = {}) => ({ id, status: 'succeeded', reply: 'Done.', ...extra }) as unknown as ProjectedAgent
const evidence = (agentId: string, extra: Partial<Evidence>) => ({ id: `e-${Math.random()}`, agentId, kind: 'file', relation: 'read file', status: 'succeeded', locations: [], rawInput: null, ...extra }) as unknown as Evidence
const message = (kind: TeamMessage['kind'], from: string, to: string, extra: Partial<TeamMessage> = {}) => ({ id: 'm', kind, from, to, text: 'x', carried: false, state: 'answered', ...extra }) as unknown as TeamMessage

function lesson(id: string, agentIds: string[], extra: Partial<LessonRun> = {}): LessonRun {
  return { runId: id, succeeded: true, mode: 'team', entrypoint: agentIds[0], agentIds, messages: [], failed: new Map(), usage: new Map(), ...extra }
}

function facts(extra: Partial<QuestFacts> & { agents?: AgentConfig[] } = {}): QuestFacts {
  const agents = extra.agents ?? [agent('lead')]
  const ids = agents.map((one) => one.id)
  return {
    run: { runId: 'now', createdAt: '2026-10-15T10:00:00Z', trigger: 'manual' },
    succeeded: true,
    agents,
    projection: { agents: ids.map((id) => ran(id)), evidence: [], messages: [], checks: [] },
    current: lesson('now', ids),
    earlier: [],
    benched: new Set(),
    ...extra,
  }
}

const items = (from: QuestFacts) => questsEarned(from).map((award) => award.item)

describe('quests', () => {
  // LoomWatch configures agents, it doesn't teach them: a hint, one sentence of why, and no links.
  it('cover every part, each with a one-line hint and one sentence of why, and link nowhere', () => {
    for (const area of AREAS) expect(QUESTS.some((quest) => quest.area === area)).toBe(true)
    for (const quest of QUESTS) {
      expect(quest.practice && quest.hint && quest.why && quest.earnedWhen).toBeTruthy()
      expect(quest.hint).not.toContain('\n')
      expect(quest.why.split(/(?<=[.!?])\s+/)).toHaveLength(1)
      expect(quest.why).toMatch(/\.$/)
      expect(JSON.stringify(quest)).not.toMatch(/https?:\/\//)
    }
  })

  it('earn nothing for a run that did not finish, or for one agent’s turn', () => {
    const agents = [agent('writer', { doneWhen: ['Under 300 words'] }), agent('checker', { checks: 'writer' })]
    const checked = { agents: agents.map((one) => ran(one.id)), evidence: [], messages: [], checks: [{ checker: 'checker', checked: 'writer', round: 1, items: [{ verdict: 'met' as const, item: 'Under 300 words', evidence: '212 words' }] }] }
    expect(items(facts({ agents, projection: checked, succeeded: false }))).toEqual([])
    expect(items(facts({ agents, projection: checked, run: { runId: 'now', createdAt: '', onlyAgent: 'writer' } }))).toEqual([])
    expect(items(facts({ agents, projection: checked }))).toEqual(['chalk'])
  })

  it('chalk: a check step found every item of a Done when met on its first look, whatever the agent said', () => {
    const writer = agent('writer', { doneWhen: ['Under 300 words', 'Cites a source'] })
    const agents = [writer, agent('checker', { checks: 'writer' })]
    const verdict = (item: string, met: 'met' | 'not_met' | 'not_sure' = 'met') => ({ verdict: met, item, evidence: '' })
    const checked = (rounds: { round: number; items: ReturnType<typeof verdict>[]; checker?: string }[], reply = 'Done.') => facts({
      agents,
      projection: { agents: [ran('writer', { reply }), ran('checker')], evidence: [], messages: [], checks: rounds.map(({ checker = 'checker', ...round }) => ({ checker, checked: 'writer', ...round })) },
    })
    const both = [verdict('Under 300 words'), verdict('Cites a source')]
    expect(questsEarned(checked([{ round: 1, items: both }]))).toEqual([{ item: 'chalk', agentId: 'writer', line: 'Checker checked Writer’s work and found all 2 items of its Done when met on the first pass.' }])
    // The agent's own reply is its account of itself: "Done." with nothing under "Not met" earns
    // nothing without a check, and a reply listing a miss does not outweigh a check that found none.
    expect(items(checked([]))).toEqual([])
    expect(items(checked([{ round: 1, items: both }], 'Draft.\n\n## Not met\n- Cites a source'))).toEqual(['chalk'])
    // Every item needs a verdict, and every verdict has to be Met.
    expect(items(checked([{ round: 1, items: [verdict('Under 300 words')] }]))).toEqual([])
    expect(items(checked([{ round: 1, items: [verdict('Under 300 words'), verdict('Cites a source', 'not_sure')] }]))).toEqual([])
    // Work a check step had to send back was not met the first time; an agent cannot check itself.
    expect(items(checked([{ round: 2, items: both }]))).not.toContain('chalk')
    expect(items(checked([{ round: 1, items: both }, { round: 2, items: both, checker: 'editor' }]))).not.toContain('chalk')
    expect(items(checked([{ round: 1, items: both, checker: 'writer' }]))).toEqual([])
    // No Done when, nothing to meet.
    expect(items(facts({ agents: [agent('writer'), agents[1]], projection: checked([{ round: 1, items: both }]).projection }))).toEqual([])
  })

  it('band: every folder an agent was given was read from', () => {
    const analyst = agent('analyst', { capabilities: [{ kind: 'knowledge', name: 'Reports', path: '/Users/me/reports' }, { kind: 'knowledge', name: 'Notes', path: 'trip.files/notes.md' }] })
    const read = evidence('analyst', { locations: [{ path: '/Users/me/reports/q3.md' }] })
    const [award] = questsEarned(facts({ agents: [analyst], projection: { agents: [ran('analyst')], evidence: [read], messages: [], checks: [] } }))
    expect(award).toMatchObject({ item: 'band', agentId: 'analyst', line: 'Analyst was given 1 folder and read from every one, 1 file in all.' })
    // A folder given and never opened is context it did not need.
    const two = agent('analyst', { capabilities: [...(analyst.capabilities ?? []), { kind: 'knowledge', name: 'Old', path: '/Users/me/old' }] })
    expect(items(facts({ agents: [two], projection: { agents: [ran('analyst')], evidence: [read], messages: [], checks: [] } }))).toEqual([])
    // A read that failed is not a read; a folder under your home folder is matched by its tail.
    expect(items(facts({ agents: [analyst], projection: { agents: [ran('analyst')], evidence: [{ ...read, status: 'failed' }], messages: [], checks: [] } }))).toEqual([])
    const relative = agent('analyst', { capabilities: [{ kind: 'knowledge', name: 'Docs', path: '~/docs' }] })
    expect(items(facts({ agents: [relative], projection: { agents: [ran('analyst')], evidence: [evidence('analyst', { rawInput: { file_path: '/Users/me/docs/a.md' } })], messages: [], checks: [] } }))).toEqual(['band'])
    // Windows names a file in any case: an app may read `c:\users\…` from a folder given as `C:\Users\…`.
    const windows = agent('analyst', { capabilities: [{ kind: 'knowledge', name: 'Reports', path: 'C:\\Users\\me\\Reports' }] })
    expect(items(facts({ agents: [windows], projection: { agents: [ran('analyst')], evidence: [evidence('analyst', { locations: [{ path: 'c:\\users\\me\\reports\\q3.md' }] })], messages: [], checks: [] } }))).toEqual(['band'])
    // A Mac's names keep their case.
    const mac = agent('analyst', { capabilities: [{ kind: 'knowledge', name: 'Reports', path: '/Users/me/Reports' }] })
    expect(items(facts({ agents: [mac], projection: { agents: [ran('analyst')], evidence: [read], messages: [], checks: [] } }))).toEqual([])
  })

  it('pin: a scheduled run that never asked, and used every key it held', () => {
    const scout = agent('scout', { allow: { web: true } })
    const searched = evidence('scout', { kind: 'search', relation: 'searched' })
    const scheduled = { runId: 'now', createdAt: '', trigger: 'schedule' as const }
    const base = facts({ agents: [scout], run: scheduled, projection: { agents: [ran('scout')], evidence: [searched], messages: [], checks: [] } })
    expect(questsEarned(base)).toEqual([{ item: 'pin', agentId: null, line: 'This scheduled run never had to ask for a permission, and every key it held was used (search the web).' }])
    expect(items({ ...base, run: { ...scheduled, trigger: 'manual' } })).toEqual([])
    // A key it held and never used is more than it needed.
    expect(items({ ...base, agents: [agent('scout', { allow: { web: true, commands: true } })] })).toEqual([])
    // Having to ask is what setting the keys beforehand avoids.
    expect(items({ ...base, projection: { ...base.projection, messages: [message('permission', 'scout', 'operator')] } })).toEqual([])
    expect(items({ ...base, agents: [agent('scout')] })).toEqual([])
  })

  it('cushion: an agent from Your agents that had a test bench run first', () => {
    const placed = agent('writer', { from: { agent: 'house-writer', version: 2 } })
    expect(questsEarned(facts({ agents: [placed], benched: new Set(['house-writer']) }))).toEqual([{ item: 'cushion', agentId: 'writer', line: 'Writer was tried on its test bench before this team used it.' }])
    expect(items(facts({ agents: [placed] }))).toEqual([])
    expect(items(facts({ agents: [agent('writer')], benched: new Set(['writer']) }))).toEqual([])
  })

  it('shuttle: one agent asked another and got an answer', () => {
    const agents = [agent('lead'), agent('scout')]
    const asked = (extra: Partial<TeamMessage>) => facts({ agents, projection: { agents: agents.map((one) => ran(one.id)), evidence: [], messages: [message('ask', 'lead', 'scout', extra)], checks: [] } })
    expect(questsEarned(asked({}))).toEqual([{ item: 'shuttle', agentId: 'lead', line: 'Lead asked Scout a question over the Team Bus and got an answer.' }])
    expect(items(asked({ state: 'failed' }))).toEqual([])
    expect(items(asked({ carried: true }))).toEqual([])
    // Stopped at a spending limit before it answered: its reply says why, and is no answer.
    const stopped = { from: 'scout', text: '(Scout stopped here.)', eventId: 'e', seq: 1, ts: '', offsetMs: 0, source: 'fresh' as const, sentBackTo: null, stopped: true as const }
    expect(items(asked({ reply: stopped }))).toEqual([])
  })

  it('monocle: a check sent the work back, and the second pass met everything', () => {
    const agents = [agent('writer'), agent('checker', { checks: 'writer', sendBackOnce: true })]
    const round = (number: number, verdict: 'met' | 'not_met') => ({ checker: 'checker', checked: 'writer', round: number, items: [{ verdict, item: 'Cites a source', evidence: '' }] })
    const checked = (rounds: ReturnType<typeof round>[]) => facts({ agents, projection: { agents: agents.map((one) => ran(one.id)), evidence: [], messages: [], checks: rounds } })
    expect(questsEarned(checked([round(2, 'met')]))).toEqual([{ item: 'monocle', agentId: 'checker', line: 'Checker sent Writer’s work back once, and the second pass met all 1 item it checks.' }])
    expect(items(checked([round(2, 'not_met')]))).toEqual([])
    expect(items(checked([round(1, 'met')]))).toEqual([])
  })

  it('patch: a habit of the last runs that this run did not repeat', () => {
    const scout = agent('scout')
    const asked = (id: string) => lesson(id, ['scout'], { messages: [{ kind: 'permission', from: 'scout', to: 'operator', text: 'x', carried: false, permission: { requestId: 'r', switch: 'web', detail: null, outcome: 'allow_once', settled: null } }] })
    const [award] = questsEarned(facts({ agents: [scout], earlier: [asked('b'), asked('a')] }))
    expect(award).toEqual({ item: 'patch', agentId: 'scout', line: 'Scout asked to search the web in 2 recent runs, and didn’t need to this time.' })
    expect(items(facts({ agents: [scout], earlier: [asked('a')] }))).toEqual([])
    expect(items(facts({ agents: [scout], earlier: [asked('b'), asked('a')], current: asked('now') }))).toEqual([])

    const failing = (id: string) => lesson(id, ['scout'], { succeeded: false, failed: new Map([['scout', 'timeout']]) })
    expect(questsEarned(facts({ agents: [scout], earlier: [failing('b'), failing('a')] }))[0].line).toBe('Scout failed in 2 recent runs, and finished its part this time.')

    const team = [agent('lead'), agent('scout')]
    const idle = ['a', 'b', 'c'].map((id) => lesson(id, ['lead', 'scout']))
    const handed = lesson('now', ['lead', 'scout'], { messages: [{ kind: 'dispatch', from: 'lead', to: 'scout', text: 'x', carried: false }] })
    expect(questsEarned(facts({ agents: team, earlier: idle, current: handed }))[0]).toMatchObject({ item: 'patch', agentId: 'lead' })
  })

  it('scissors: fewer agents than the last finished run, for fewer tokens', () => {
    const agents = [agent('lead'), agent('writer')]
    const usage = (tokens: number) => new Map([['lead', { tokens, opening: null }]])
    const last = lesson('b', ['lead', 'scout', 'writer'], { usage: usage(90_000) })
    const now = lesson('now', ['lead', 'writer'], { usage: usage(60_000) })
    expect(questsEarned(facts({ agents, current: now, earlier: [last] }))).toEqual([{ item: 'scissors', agentId: null, line: 'This team ran with 2 agents instead of 3, and used 33% fewer tokens than its last run.' }])
    expect(items(facts({ agents, current: lesson('now', ['lead', 'writer'], { usage: usage(95_000) }), earlier: [last] }))).toEqual([])
    expect(items(facts({ agents, current: now, earlier: [{ ...last, succeeded: false }] }))).toEqual([])
  })

  it('vest: an agent asked you a question, and your answer came back', () => {
    const agents = [agent('writer')]
    const asked = (extra: Partial<TeamMessage>) => facts({ agents, projection: { agents: [ran('writer')], evidence: [], messages: [message('question', 'writer', 'operator', { reply: { from: 'operator', text: 'The 2026 one.' } as TeamMessage['reply'], ...extra })], checks: [] } })
    expect(questsEarned(asked({}))).toEqual([{ item: 'vest', agentId: 'writer', line: 'Writer asked you a question instead of guessing, and your answer saw the run through.' }])
    expect(items(asked({ state: 'pending', reply: null }))).toEqual([])
    expect(items(asked({ carried: true }))).toEqual([])
    // A permission request is its app asking, not the agent weighing a choice; a run that failed earns nothing.
    expect(items(asked({ kind: 'permission' }))).toEqual([])
    expect(items({ ...asked({}), succeeded: false })).toEqual([])
  })

  it('apron: an agent opened a skill it was given, as the daemon recorded', () => {
    const writer = agent('writer', { capabilities: [{ kind: 'skill', name: 'house-style' }] })
    const opened = (extra: Partial<Evidence>) => facts({ agents: [writer], projection: { agents: [ran('writer')], evidence: [evidence('writer', { kind: 'skill', relation: 'opened by the agent', name: 'house-style', ...extra })], messages: [], checks: [] } })
    expect(questsEarned(opened({}))).toEqual([{ item: 'apron', agentId: 'writer', line: 'Writer opened its “house-style” skill when the work called for it.' }])
    // Loaded into its prompt is delivery, not use; a tool's title naming a skill is not the record.
    expect(items(opened({ relation: 'loaded into prompt' }))).toEqual([])
    expect(items(opened({ relation: 'used skill' }))).toEqual([])
    // A skill it was not given, or another agent's opening, does not count for it.
    expect(items(opened({ name: 'pdf' }))).toEqual([])
    expect(items(facts({ agents: [writer, agent('editor')], projection: { agents: [ran('writer'), ran('editor')], evidence: [evidence('editor', { kind: 'skill', relation: 'opened by the agent', name: 'house-style' })], messages: [], checks: [] } }))).toEqual([])
  })

  it('overalls: two teammates handed work by one agent worked at the same time, and both finished', () => {
    const agents = [agent('lead'), agent('scout'), agent('writer')]
    const step = (agentId: string, offsetMs: number) => evidence(agentId, { kind: 'search', relation: 'searched', offsetMs })
    const run = (steps: Evidence[], extra: Partial<Omit<QuestFacts, 'agents'>> & { agents?: AgentConfig[] } = {}) => facts({
      agents,
      projection: { agents: agents.map((one) => ran(one.id)), evidence: steps, messages: [message('dispatch', 'lead', 'scout', { state: 'delivered', offsetMs: 1_000 }), message('dispatch', 'lead', 'writer', { state: 'delivered', offsetMs: 2_000 })], checks: [] },
      current: lesson('now', ['lead', 'scout', 'writer']),
      ...extra,
    })
    expect(questsEarned(run([step('scout', 1_500), step('scout', 9_000), step('writer', 3_000), step('writer', 8_000)]))).toEqual([{ item: 'overalls', agentId: 'lead', line: 'Lead dispatched work to Scout and Writer, who worked on it at the same time and both finished.' }])
    // One after the other is not side by side: the scout was done before the writer was handed its part.
    expect(items(run([step('scout', 1_200), step('scout', 1_800), step('writer', 3_000), step('writer', 8_000)]))).toEqual([])
    // A teammate that failed did not finish its part; steps from before the dispatch are not its work on it.
    expect(items(run([step('scout', 1_500), step('scout', 9_000), step('writer', 3_000), step('writer', 8_000)], { current: lesson('now', ['lead', 'scout', 'writer'], { failed: new Map([['writer', null]]) }) }))).toEqual([])
    expect(items(run([step('scout', 500), step('scout', 900), step('writer', 3_000), step('writer', 8_000)]))).toEqual([])
  })

  it('tee: a pipeline of three or more stages, each after the first handed what came before', () => {
    const agents = [agent('scout'), agent('writer'), agent('editor')]
    const handed = (to: string) => ({ ...message('handover', 'scout', to, { state: 'delivered' }), from: null })
    const pipeline = (messages: TeamMessage[], extra: Partial<Omit<QuestFacts, 'agents'>> & { agents?: AgentConfig[] } = {}) => facts({
      agents,
      projection: { agents: agents.map((one) => ran(one.id)), evidence: [], messages, checks: [] },
      current: lesson('now', ['scout', 'writer', 'editor'], { mode: 'pipeline' }),
      ...extra,
    })
    expect(questsEarned(pipeline([handed('writer'), handed('editor')]))).toEqual([{ item: 'tee', agentId: null, line: 'This run passed the work along 3 stages, each starting from what the one before handed it.' }])
    expect(items(pipeline([handed('writer')]))).toEqual([])
    // Two stages and a review step are a chain of two; a team that talks is not a pipeline.
    const reviewed = [agent('scout'), agent('review', { kind: 'operator' }), agent('writer')]
    expect(items(pipeline([handed('review'), handed('writer')], { agents: reviewed, current: lesson('now', ['scout', 'review', 'writer'], { mode: 'pipeline' }) }))).toEqual([])
    expect(items(pipeline([handed('writer'), handed('editor')], { current: lesson('now', ['scout', 'writer', 'editor']) }))).toEqual([])
  })

  it('bobbin: one item from each of the five parts', () => {
    expect(wholeCraft(['chalk', 'band', 'pin', 'shuttle', 'monocle'])).toBe(true)
    expect(wholeCraft(['chalk', 'band', 'cushion', 'scissors', 'patch'])).toBe(true)
    expect(wholeCraft(['chalk', 'band', 'pin', 'shuttle'])).toBe(false)
  })
})
