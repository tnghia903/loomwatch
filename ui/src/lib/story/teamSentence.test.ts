import { describe, expect, it } from 'vitest'

import { scheduleWords, sentenceText, teamSentence, verbFor, type SentenceAgent } from './teamSentence'

const researcher: SentenceAgent = { id: 'researcher', name: 'Researcher', role: 'Research the request.', model: 'claude-sonnet-5' }
const review: SentenceAgent = { id: 'review', name: 'You', role: 'Approve it.', kind: 'operator' }
const writer: SentenceAgent = { id: 'writer', name: 'Writer', role: 'Turn it into the result.', model: 'gpt-5.6-luna' }

describe('teamSentence', () => {
  it('says a single agent does the whole task', () => {
    const parts = teamSentence({ agents: [{ id: 'a', name: 'Assistant', role: 'Complete the request.' }], edges: [], steps: [{ id: 'a', joinFrom: [] }], entrypoint: 'a', responder: 'a' })
    expect(sentenceText(parts)).toBe('When you ask, Assistant does the whole task and replies.')
  })

  it('reads a pipeline in order, with the review step as "you"', () => {
    const parts = teamSentence({
      agents: [researcher, review, writer],
      edges: [{ from: 'researcher', to: 'review' }, { from: 'review', to: 'writer' }],
      steps: [{ id: 'researcher', joinFrom: [] }, { id: 'review', joinFrom: [] }, { id: 'writer', joinFrom: [] }],
      entrypoint: 'researcher',
      responder: 'writer',
    })
    expect(sentenceText(parts)).toBe('When you ask, Researcher researches, then you approve or send it back, and finally Writer writes the answer.')
    const names = parts.filter((part) => part.kind === 'agent')
    expect(names.map((part) => part.kind === 'agent' && part.id)).toEqual(['researcher', 'review', 'writer'])
    expect(names[0]).toMatchObject({ title: 'researcher · claude-sonnet-5' })
  })

  it('opens with the schedule and says where scheduled answers go', () => {
    const parts = teamSentence({
      agents: [researcher, writer],
      edges: [{ from: 'researcher', to: 'writer' }],
      steps: [{ id: 'researcher', joinFrom: [] }, { id: 'writer', joinFrom: [] }],
      entrypoint: 'researcher',
      responder: 'writer',
      schedule: { cron: '0 8 * * 1-5', prompt: 'Go', deliver: { notion: {} } },
    })
    const text = sentenceText(parts)
    expect(text).toMatch(/^Every weekday at 8:00/)
    expect(text).toMatch(/Scheduled answers go to Notion\.$/)
    expect(parts[0].kind).toBe('schedule')
  })

  it('says every answer goes to Notion when the team sends them all (ADR 0038)', () => {
    const base = { agents: [researcher], edges: [], steps: [{ id: 'researcher', joinFrom: [] }], entrypoint: 'researcher', responder: null }
    expect(sentenceText(teamSentence({ ...base, deliver: { notion: {} } }))).toMatch(/Answers also go to Notion\.$/)
    expect(sentenceText(teamSentence({ ...base, deliver: { notion: {} }, schedule: { cron: '0 8 * * *', prompt: 'Go', deliver: { notion: {} } } }))).toMatch(/Answers also go to Notion\.$/)
    expect(sentenceText(teamSentence({ ...base, deliver: null }))).not.toMatch(/Notion/)
  })

  it('ignores a paused schedule', () => {
    const parts = teamSentence({ agents: [researcher], edges: [], steps: [{ id: 'researcher', joinFrom: [] }], entrypoint: 'researcher', responder: null, schedule: { cron: '0 8 * * *', prompt: 'Go', enabled: false } })
    expect(sentenceText(parts)).toMatch(/^When you ask,/)
  })

  it('names agents that are not connected, so they are not silently skipped', () => {
    const parts = teamSentence({
      agents: [researcher, writer, { id: 'designer', name: 'Designer', role: 'Make slides.' }],
      edges: [{ from: 'researcher', to: 'writer' }],
      steps: [{ id: 'researcher', joinFrom: [] }, { id: 'writer', joinFrom: [] }, { id: 'designer', joinFrom: [] }],
      entrypoint: 'researcher',
      responder: 'writer',
    })
    expect(sentenceText(parts)).toMatch(/Designer isn’t connected yet, so it won’t run\.$/)
    expect(parts.some((part) => part.kind === 'warning')).toBe(true)
    expect(parts.at(-1)).toEqual({ kind: 'fix', text: 'Put Designer after Writer', connect: [{ from: 'writer', to: 'designer' }] })
  })

  it('offers a relay when several agents are not wired', () => {
    const parts = teamSentence({ agents: [researcher, writer, review], edges: [], steps: [], entrypoint: 'researcher', responder: 'researcher' })
    expect(parts.at(-1)).toEqual({ kind: 'fix', text: 'Hand work along in this order instead', connect: [{ from: 'researcher', to: 'writer' }, { from: 'writer', to: 'review' }] })
  })

  it('describes a lead that recruits in team mode', () => {
    const parts = teamSentence({ agents: [researcher, writer], edges: [], steps: [{ id: 'researcher', joinFrom: [] }, { id: 'writer', joinFrom: [] }], entrypoint: 'researcher', responder: 'researcher' })
    expect(sentenceText(parts)).toBe('When you ask, Researcher takes the request, brings in Writer when it needs help, and replies.')
    expect(parts.at(-1)?.kind).toBe('fix')
  })

  it('names a join', () => {
    const parts = teamSentence({
      agents: [{ id: 'a', name: 'Scout', role: '' }, { id: 'b', name: 'Analyst', role: '' }, { id: 'c', name: 'Editor', role: '' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }],
      steps: [{ id: 'a', joinFrom: [] }, { id: 'b', joinFrom: [] }, { id: 'c', joinFrom: ['a', 'b'] }],
      entrypoint: 'a',
      responder: 'c',
    })
    expect(sentenceText(parts)).toBe('When you ask, Scout collects what is needed, then Analyst analyses, and finally Editor brings together Scout’s and Analyst’s work and edits the answer.')
  })

  it('is empty for an empty team', () => {
    expect(teamSentence({ agents: [], edges: [], steps: [], entrypoint: '', responder: null })).toEqual([])
  })

  it('says whose work a check step checks and how the work goes back (ADR 0062)', () => {
    const say = (checker: Partial<SentenceAgent>) => sentenceText(teamSentence({
      agents: [writer, { id: 'checker', name: 'Checker', role: 'Check the work.', checks: 'writer', ...checker }],
      edges: [{ from: 'writer', to: 'checker' }],
      steps: [{ id: 'writer', joinFrom: [] }, { id: 'checker', joinFrom: [] }],
      entrypoint: 'writer',
      responder: 'writer',
    }))
    const opening = 'When you ask, Writer writes, and finally Checker checks Writer’s work'
    const closing = '. The answer you see comes from Writer.'
    expect(say({})).toBe(`${opening}${closing}`)
    expect(say({ sendBackOnce: true })).toBe(`${opening} and sends it back once if a check isn’t met${closing}`)
    expect(say({ sendBack: { rounds: 1 } })).toBe(`${opening} and sends it back once if a check isn’t met${closing}`)
    expect(say({ sendBack: { rounds: 3, whenStillNotMet: 'answer' } })).toBe(`${opening} and sends it back up to 3 times if a check isn’t met${closing}`)
    expect(say({ sendBack: { rounds: 2, whenStillNotMet: 'ask' } })).toBe(`${opening}, sends it back up to 2 times, and asks you if a check still isn’t met${closing}`)
    expect(say({ sendBack: { rounds: 1, whenStillNotMet: 'ask' } })).toBe(`${opening}, sends it back once, and asks you if a check still isn’t met${closing}`)
  })

  it('makes the checked agent in a check step’s phrase a button, and keeps a stray checks quiet', () => {
    const parts = teamSentence({
      agents: [writer, { id: 'checker', name: 'Checker', role: 'Check the work.', checks: 'writer', sendBack: { rounds: 2, whenStillNotMet: 'ask' } }],
      edges: [{ from: 'writer', to: 'checker' }],
      steps: [{ id: 'writer', joinFrom: [] }, { id: 'checker', joinFrom: [] }],
      entrypoint: 'writer',
      responder: 'writer',
    })
    expect(parts.filter((part) => part.kind === 'agent').map((part) => part.kind === 'agent' && part.name)).toEqual(['Writer', 'Checker', 'Writer’s', 'Writer'])
    const stray = teamSentence({
      agents: [writer, { id: 'checker', name: 'Checker', role: 'Check the work.', checks: 'ghost' }],
      edges: [{ from: 'writer', to: 'checker' }],
      steps: [{ id: 'writer', joinFrom: [] }, { id: 'checker', joinFrom: [] }],
      entrypoint: 'writer',
      responder: 'checker',
    })
    expect(sentenceText(stray)).toBe('When you ask, Writer writes, and finally Checker checks the work and replies.')
  })
})

describe('verbFor', () => {
  it('prefers the name over the role', () => {
    expect(verbFor({ name: 'News Editor', role: 'You write summaries.' })).toBe('edits')
  })
  it('falls back to the role, then to a neutral phrase', () => {
    expect(verbFor({ name: 'Agent B', role: 'You review the draft.' })).toBe('checks the work')
    expect(verbFor({ name: 'Agent C', role: 'Do things.' })).toBe('does its part')
    expect(verbFor({ name: 'Agent C', role: 'Do things.' }, true)).toBe('finishes the answer')
  })
})

describe('scheduleWords', () => {
  it('says a schedule on days of the week, a date each month, or every so often in words', () => {
    expect(scheduleWords({ cron: '0 8 * * *' })).toMatch(/^Every day at 8:00/)
    expect(scheduleWords({ cron: '0 8 * * MON-FRI' })).toMatch(/^Every weekday at 8:00/)
    expect(scheduleWords({ cron: '0 9 * * 1' })).toMatch(/^Every Monday at 9:00/)
    expect(scheduleWords({ cron: '30 17 * * mon,thu' })).toMatch(/^Every Monday and Thursday at 5:30/)
    expect(scheduleWords({ cron: '0 9 * * 5,1,3' })).toMatch(/^Every Monday, Wednesday and Friday at 9:00/)
    expect(scheduleWords({ cron: '0 10 * * 6,7' })).toMatch(/^Every Saturday and Sunday at 10:00/)
    expect(scheduleWords({ cron: '0 17,9 * * *' })).toMatch(/^Every day at 9:00 AM and 5:00 PM$/)
    expect(scheduleWords({ cron: '0 9 1 * *' })).toMatch(/^Every month on the 1st at 9:00/)
    expect(scheduleWords({ cron: '0 9 22 * *' })).toMatch(/^Every month on the 22nd at/)
    expect(scheduleWords({ cron: '0 9 13 * *' })).toMatch(/^Every month on the 13th at/)
    expect(scheduleWords({ cron: '*/5 * * * *' })).toBe('Every 5 minutes')
    expect(scheduleWords({ cron: '0 * * * *' })).toBe('Every hour')
    expect(scheduleWords({ cron: '0 */2 * * *' })).toBe('Every 2 hours')
  })

  it('keeps a cron too rich for words', () => {
    for (const cron of ['0 9 1-7 * 1', '0 9 * 1 *', '15 */2 * * *', '0 9 * * 1/2', '0 25 * * 1', '0 9,24 * * *', '0 9-17 * * *', '0 9 * * 5-1']) {
      expect(scheduleWords({ cron })).toBe(`On its schedule (${cron})`)
    }
  })
})
