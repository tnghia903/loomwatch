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
  it('teach one practice each, cover every part, and say where the practice comes from', () => {
    for (const area of AREAS) expect(QUESTS.some((quest) => quest.area === area)).toBe(true)
    for (const quest of QUESTS) {
      expect(quest.practice && quest.hint && quest.teach && quest.earnedWhen).toBeTruthy()
      if (quest.area !== 'all') expect(quest.source?.url).toMatch(/^https:\/\//)
    }
  })

  it('earn nothing for a run that did not finish, or for one agent’s turn', () => {
    const writer = agent('writer', { doneWhen: ['Under 300 words'] })
    expect(items(facts({ agents: [writer], succeeded: false }))).toEqual([])
    expect(items(facts({ agents: [writer], run: { runId: 'now', createdAt: '', onlyAgent: 'writer' } }))).toEqual([])
    expect(items(facts({ agents: [writer] }))).toEqual(['chalk'])
  })

  it('chalk: a Done when met on the first pass, and not one the agent says it missed', () => {
    const writer = agent('writer', { doneWhen: ['Under 300 words', 'Cites a source'] })
    const [award] = questsEarned(facts({ agents: [writer] }))
    expect(award).toEqual({ item: 'chalk', agentId: 'writer', line: 'Writer met all 2 items of its Done when on the first pass.' })
    const missed = facts({ agents: [writer], projection: { agents: [ran('writer', { reply: 'Draft.\n\n## Not met\n- Cites a source' })], evidence: [], messages: [], checks: [] } })
    expect(items(missed)).toEqual([])
    // A check step that had to send it back means it was not met the first time.
    const resent = facts({ agents: [writer], projection: { agents: [ran('writer')], evidence: [], messages: [], checks: [{ checker: 'checker', checked: 'writer', round: 2, items: [{ verdict: 'met', item: 'Cites a source', evidence: '' }] }] } })
    expect(items(resent)).not.toContain('chalk')
    expect(items(facts({ agents: [agent('writer')] }))).toEqual([])
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

  it('bobbin: one item from each of the five parts', () => {
    expect(wholeCraft(['chalk', 'band', 'pin', 'shuttle', 'monocle'])).toBe(true)
    expect(wholeCraft(['chalk', 'band', 'cushion', 'scissors', 'patch'])).toBe(true)
    expect(wholeCraft(['chalk', 'band', 'pin', 'shuttle'])).toBe(false)
  })
})
