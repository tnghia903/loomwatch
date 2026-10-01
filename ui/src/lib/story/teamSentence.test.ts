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
  it('keeps a cron the editor cannot express', () => {
    expect(scheduleWords({ cron: '*/5 * * * *' })).toBe('On its schedule (*/5 * * * *)')
  })
})
