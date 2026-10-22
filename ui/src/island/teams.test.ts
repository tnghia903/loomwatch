import { describe, expect, it } from 'vitest'

import { answering, at, failed, iso, OUT_OF_CREDITS, permission, question, run, said } from './fixtures'
import { firstLine, momentsBetween, teamsNow, tucked, workedFor } from './teams'

const none = new Set<string>()
const nobody = new Map<string, string>()

describe('what the island shows of each team', () => {
  it('puts what waits for you first, then a stop, then a result, then work', () => {
    const teams = teamsNow([
      run('working', { working: ['researcher'] }),
      run('done', { status: 'succeeded', finishedAt: iso(5), reply: '# Kyoto\nFive days, three hotels.' }),
      run('stopped', { status: 'failed', finishedAt: iso(5), error: 'Your OpenRouter credit ran out.' }),
      run('asking', { permissionRequests: [permission('p1')] }),
    ], at(1), none, nobody)
    expect(teams.map((team) => [team.runId, team.moment])).toEqual([['asking', 'ask'], ['stopped', 'fail'], ['done', 'done'], ['working', 'work']])
    expect(teams.find((team) => team.runId === 'done')?.result).toBe('Kyoto')
    expect(teams.find((team) => team.runId === 'stopped')?.result).toBe('Your OpenRouter credit ran out.')
  })

  it('shows a result only while it is news: ended since the island started watching, and not yet seen', () => {
    const records = [
      run('before', { status: 'succeeded', finishedAt: iso(0) }),
      run('after', { status: 'succeeded', finishedAt: iso(6) }),
      run('looked', { status: 'succeeded', finishedAt: iso(7) }),
      run('cancelled', { status: 'cancelled', finishedAt: iso(8) }),
    ]
    expect(teamsNow(records, at(5), new Set(['looked']), nobody).map((team) => team.runId)).toEqual(['after'])
  })

  it('keeps teams with the same news in the order they started', () => {
    const teams = teamsNow([run('newer', { startedAt: iso(5), working: ['writer'] }), run('older', { startedAt: iso(1), working: ['writer'] })], 0, none, nobody)
    expect(teams.map((team) => team.runId)).toEqual(['older', 'newer'])
  })

  it('draws the agent that asks, the one at work, or the last one that worked between turns', () => {
    const [asking] = teamsNow([run('a', { working: ['writer'], permissionRequests: [permission('p1', 'researcher')] })], 0, none, nobody)
    expect(asking.agent).toBe('researcher')
    expect(asking.agentName).toBe('Researcher')
    expect(asking.asks[0].text).toBe('Researcher wants to use the web')
    const [between] = teamsNow([run('b')], 0, none, new Map([['b', 'writer']]))
    expect(between.agent).toBe('writer')
    const [questioned] = teamsNow([run('c', { waitingOn: question() })], 0, none, nobody)
    expect([questioned.moment, questioned.agent, questioned.asks[0].kind]).toEqual(['ask', 'writer', 'question'])
  })

  it('lets a permission for the web be answered at a glance, but not a command, an Auto mode ask or an edit', () => {
    const [team] = teamsNow([run('a', { permissionRequests: [
      permission('web'),
      permission('command', 'writer', { switch: 'commands', kind: 'execute' }),
      permission('auto', 'writer', { switch: 'web', auto: 'it publishes' }),
      permission('edit', 'writer', { switch: 'web', edit: { field: 'url', value: 'https://x.test' } }),
    ] })], 0, none, nobody)
    expect(team.quick).toEqual(['a:permission:web'])
  })

  it('takes the first line of an answer as its words, without the Markdown', () => {
    expect(firstLine('\n## **Five days** in [Kyoto](https://x.test)\nmore')).toBe('Five days in Kyoto')
    expect(firstLine('---\n- one hotel')).toBe('one hotel')
    expect(firstLine('a'.repeat(200))).toHaveLength(120)
    expect(firstLine(null)).toBe('')
  })
})

describe('agents answering a message in the chat', () => {
  // "Explain" on a part of a file is mostly answered in the chat, where nothing runs.
  it('shows the agent answering at work, then its answer while that is news, opening the chat', () => {
    const [writing] = teamsNow([], 0, none, nobody, [answering('m1')])
    expect(writing).toMatchObject({ runId: 'm1', teamName: 'Trip planner', moment: 'work', agent: 'writer', agentName: 'Writer', agents: ['writer'], startedAt: iso(0), asks: [], result: null, chat: true, link: '/?path=trip.yaml&view=chat' })
    const answered = answering('m1', { answers: { waiting: [], said: [said('**Every item** keeps one number.\nMore')] }, finishedAt: iso(1) })
    const [done] = teamsNow([], at(0), none, nobody, [answered])
    expect(done).toMatchObject({ runId: 'm1', moment: 'done', agent: 'writer', result: 'Every item keeps one number.', chat: true })
    // Not news: answered before the island watched, or looked at.
    expect(teamsNow([], at(2), none, nobody, [answered])).toEqual([])
    expect(teamsNow([], 0, new Set(['m1']), nobody, [answered])).toEqual([])
    // Nobody had anything to add: nothing to show.
    expect(teamsNow([], 0, none, nobody, [answering('m2', { answers: { waiting: [], said: [] }, finishedAt: iso(1) })])).toEqual([])
  })

  it('says an agent that could not answer stopped, and why, opening the chat; one with nothing to add says nothing', () => {
    const stopped = answering('m1', { answers: { waiting: [], said: [], failed: [failed(OUT_OF_CREDITS)] }, finishedAt: iso(1) })
    const [fail] = teamsNow([], at(0), none, nobody, [stopped])
    expect(fail).toMatchObject({ runId: 'm1', moment: 'fail', agent: 'writer', agentName: 'Writer', result: OUT_OF_CREDITS, chat: true, link: '/?path=trip.yaml&view=chat' })
    // A stop before the island watched, or one looked at, is not news either.
    expect(teamsNow([], at(2), none, nobody, [stopped])).toEqual([])
    expect(teamsNow([], 0, new Set(['m1']), nobody, [stopped])).toEqual([])
    // It stands with the runs that stopped: before answers and work.
    const teams = teamsNow([run('done', { status: 'succeeded', finishedAt: iso(1), reply: 'Day 1' })], at(0), none, nobody, [stopped, answering('m2')])
    expect(teams.map((team) => [team.runId, team.moment])).toEqual([['m1', 'fail'], ['done', 'done'], ['m2', 'work']])
    // An app's error it can't put plainly is said as it is, on its first line.
    const [own] = teamsNow([], at(0), none, nobody, [answering('m3', { answers: { waiting: [], said: [], failed: [failed('OpenRouter reported an error: busy\nretry later')] }, finishedAt: iso(1) })])
    expect(own.result).toBe('OpenRouter reported an error: busy')
    // Two who didn't answer are named, as the chat names them; for three or more, the team is.
    const both = { agentNames: { researcher: 'Researcher', writer: 'Writer' } }
    const [two] = teamsNow([], at(0), none, nobody, [answering('m4', { ...both, answers: { waiting: [], said: [], failed: [failed(OUT_OF_CREDITS, 'researcher'), failed(OUT_OF_CREDITS)] }, finishedAt: iso(1) })])
    expect(two).toMatchObject({ moment: 'fail', agent: 'researcher', agentName: 'Researcher and Writer' })
    const all = { agentNames: { ...both.agentNames, checker: 'Checker' } }
    const [three] = teamsNow([], at(0), none, nobody, [answering('m6', { ...all, answers: { waiting: [], said: [], failed: [failed(OUT_OF_CREDITS, 'researcher'), failed(OUT_OF_CREDITS), failed(OUT_OF_CREDITS, 'checker')] }, finishedAt: iso(1) })])
    expect(three).toMatchObject({ moment: 'fail', agent: 'researcher', agentName: null })
    // Someone answered: that is the news, and the chat says who else didn't.
    const [answered] = teamsNow([], at(0), none, nobody, [answering('m5', { ...both, answers: { waiting: [], said: [said('Hi!', 'researcher')], failed: [failed(OUT_OF_CREDITS)] }, finishedAt: iso(1) })])
    expect(answered).toMatchObject({ moment: 'done', agent: 'researcher', result: 'Hi!' })
  })

  it('pops out a stop when an agent answering in the chat could not answer', () => {
    const writing = teamsNow([], 0, none, nobody, [answering('m1')])
    const stopped = teamsNow([], 0, none, nobody, [answering('m1', { answers: { waiting: [], said: [], failed: [failed(OUT_OF_CREDITS)] }, finishedAt: iso(1) })])
    expect(momentsBetween(writing, stopped)).toEqual([{ kind: 'fail', runId: 'm1', key: 'm1' }])
    expect(tucked(stopped).right).toBe('slip')
  })

  it('stands among the runs by what it is doing', () => {
    const teams = teamsNow([run('asking', { permissionRequests: [permission('p1')] }), run('working', { startedAt: iso(2), working: ['researcher'] })], 0, none, nobody, [answering('m1', { createdAt: iso(1) })])
    expect(teams.map((team) => team.runId)).toEqual(['asking', 'm1', 'working'])
  })

  it('pops out when an agent starts answering and when the answer comes, with no handover between agents answering together', () => {
    const both = { agentNames: { researcher: 'Researcher', writer: 'Writer' } }
    const one = teamsNow([], 0, none, nobody, [answering('m1', { ...both, answers: { waiting: ['researcher', 'writer'], said: [] } })])
    expect(momentsBetween([], one)).toEqual([{ kind: 'start', runId: 'm1', key: 'researcher' }])
    const two = teamsNow([], 0, none, nobody, [answering('m1', { ...both, answers: { waiting: ['writer'], said: [said('Hi!', 'researcher')] } })])
    expect(two[0].agent).toBe('writer')
    expect(momentsBetween(one, two)).toEqual([])
    const three = teamsNow([], 0, none, nobody, [answering('m1', { ...both, answers: { waiting: [], said: [said('Hi!', 'researcher'), said('Hello.')] }, finishedAt: iso(2) })])
    expect(three[0]).toMatchObject({ agent: 'researcher', result: 'Hi!' })
    expect(momentsBetween(two, three)).toEqual([{ kind: 'done', runId: 'm1', key: 'm1' }])
  })
})

describe('the moments that pop out', () => {
  const reading = (records: Parameters<typeof teamsNow>[0]) => teamsNow(records, 0, none, nobody)

  it('on the first reading, only what already waits for you', () => {
    expect(momentsBetween(null, reading([run('a', { working: ['researcher'] }), run('b', { permissionRequests: [permission('p1')] })]))).toEqual([
      { kind: 'ask', runId: 'b', key: 'b:permission:p1' },
    ])
  })

  it('a team starting, a handover, a new question, a run finishing or stopping', () => {
    const one = reading([run('a', { working: ['researcher'] })])
    expect(momentsBetween([], one)).toEqual([{ kind: 'start', runId: 'a', key: 'researcher' }])
    const two = reading([run('a', { working: ['writer'] })])
    expect(momentsBetween(one, two)).toEqual([{ kind: 'handover', runId: 'a', key: 'writer' }])
    const three = reading([run('a', { working: ['writer'], permissionRequests: [permission('p1')] })])
    expect(momentsBetween(two, three)).toEqual([{ kind: 'ask', runId: 'a', key: 'a:permission:p1' }])
    // The same question, read again, is not a new moment.
    expect(momentsBetween(three, three)).toEqual([])
    const four = reading([run('a', { status: 'succeeded', finishedAt: iso(9) })])
    expect(momentsBetween(two, four)).toEqual([{ kind: 'done', runId: 'a', key: 'a' }])
    const five = reading([run('a', { status: 'failed', finishedAt: iso(9) })])
    expect(momentsBetween(two, five)).toEqual([{ kind: 'fail', runId: 'a', key: 'a' }])
    // A result read again is not a new moment: it pops out once.
    expect(momentsBetween(four, four)).toEqual([])
    expect(momentsBetween(five, five)).toEqual([])
  })

  it('a question from another agent is a question, not a handover', () => {
    const working = reading([run('a', { working: ['researcher'] })])
    const asking = reading([run('a', { working: ['researcher'], permissionRequests: [permission('p1', 'writer')] })])
    expect(momentsBetween(working, asking)).toEqual([{ kind: 'ask', runId: 'a', key: 'a:permission:p1' }])
  })
})

describe('the island tucked beside the notch', () => {
  it('one figure per team, up to three, then a count of the rest', () => {
    const teams = teamsNow(['a', 'b', 'c', 'd', 'e'].map((id) => run(id, { working: ['writer'] })), 0, none, nobody)
    const summary = tucked(teams)
    expect(summary.heads).toHaveLength(3)
    expect(summary.more).toBe(2)
    expect(tucked(teams.slice(0, 2)).more).toBe(0)
  })

  it('counts every question across teams; else a slip for a result, or one team’s time', () => {
    const asking = teamsNow([
      run('a', { permissionRequests: [permission('p1'), permission('p2')] }),
      run('b', { waitingOn: question() }),
    ], 0, none, nobody)
    expect(tucked(asking)).toMatchObject({ asks: 3, right: 'count' })
    const finished = teamsNow([run('a', { status: 'succeeded', finishedAt: iso(3) }), run('b', { working: ['writer'] })], 0, none, nobody)
    expect(tucked(finished).right).toBe('slip')
    const stopped = teamsNow([run('a', { status: 'failed', finishedAt: iso(3) }), run('b', { working: ['writer'] })], 0, none, nobody)
    expect(tucked(stopped).right).toBe('slip')
    expect(tucked(teamsNow([run('a', { working: ['writer'] })], 0, none, nobody)).right).toBe('time')
    expect(tucked(teamsNow([run('a'), run('b')], 0, none, nobody)).right).toBe('none')
  })

  it('says how long a run has worked', () => {
    expect(workedFor(iso(0), at(0.5))).toBe('')
    expect(workedFor(iso(0), at(4))).toBe('4m')
    expect(workedFor(iso(0), at(4), 'long')).toBe('4 min')
    expect(workedFor(iso(0), at(125))).toBe('2h')
  })
})
