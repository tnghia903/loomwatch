import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../runs/client'
import { destination, findMention, mentionChoices, mentionQuery, type ChatAgent } from './route'

const agents: ChatAgent[] = [
  { id: 'researcher', name: 'Researcher' },
  { id: 'writer', name: 'News Writer' },
  { id: 'review', name: 'Your review', operator: true },
]
const names = new Map(agents.map((agent) => [agent.id, agent.name]))

const run = (runId: string, createdAt: string, working: string[]): RunRecord => ({
  runId, sessionId: runId, teamPath: 'news.yaml', prompt: 'go', status: 'running', mode: 'pipeline', entrypoint: 'researcher',
  responder: 'writer', agentIds: ['researcher', 'writer'], createdAt, startedAt: createdAt, finishedAt: null, error: null,
  exitCode: null, eventCount: null, reply: null, working,
})

describe('findMention', () => {
  it('finds @team and agents by name or id, longest name first, case-insensitive', () => {
    expect(findMention('@team now do Asia', agents)?.target).toEqual({ kind: 'team' })
    expect(findMention('@news writer make the chip story the lead', agents)?.target).toEqual({ kind: 'agent', agent: 'writer' })
    expect(findMention('please @Researcher, add a source', agents)?.target).toEqual({ kind: 'agent', agent: 'researcher' })
    expect(findMention('@writer shorter', agents)?.target).toEqual({ kind: 'agent', agent: 'writer' })
  })

  it('needs the name to end where the word does, and the @ to start a word', () => {
    expect(findMention('@teamwork matters', agents)).toBeNull()
    expect(findMention('mail me at me@team.com', agents)).toBeNull()
    expect(findMention('no mention here', agents)).toBeNull()
  })

  it('never addresses a review step: that is you', () => {
    expect(findMention('@Your review approve it', agents)).toBeNull()
  })
})

describe('the picker', () => {
  it('offers @team first, then agents matching what was typed', () => {
    expect(mentionChoices('', agents).map((choice) => choice.label)).toEqual(['team', 'Researcher', 'News Writer'])
    expect(mentionChoices('wr', agents).map((choice) => choice.id)).toEqual(['writer'])
    expect(mentionChoices('ne', agents).map((choice) => choice.insert)).toEqual(['@News Writer '])
  })

  it('opens only for an @ that starts a word at the caret', () => {
    expect(mentionQuery('hello @wr', 9)).toEqual({ start: 6, query: 'wr' })
    expect(mentionQuery('me@x', 4)).toBeNull()
    expect(mentionQuery('no at sign', 5)).toBeNull()
    // A finished mention, a space typed after it, closes the picker; a two-word name keeps it open.
    expect(mentionQuery('@team today', 6)).toBeNull()
    expect(mentionQuery('@News W', 7)).toEqual({ start: 0, query: 'News W' })
  })
})

describe('destination', () => {
  const idle: RunRecord[] = []
  const busy = [run('old', '2026-10-06T01:00:00.000Z', ['researcher']), run('new', '2026-10-06T02:00:00.000Z', ['writer'])]

  it('@team always starts the whole team', () => {
    expect(destination({ kind: 'team' }, idle, names, 3)).toMatchObject({ route: 'team', label: 'Starts the team · 3 steps' })
    expect(destination({ kind: 'team' }, busy, names, 1)).toMatchObject({ route: 'team', label: 'Starts the team' })
  })

  it('@agent starts it alone when idle, and is a note for its next turn while it works', () => {
    expect(destination({ kind: 'agent', agent: 'writer' }, idle, names, 3)).toMatchObject({ route: 'agent', agent: 'writer', label: 'Starts News Writer only' })
    expect(destination({ kind: 'agent', agent: 'researcher' }, busy, names, 3)).toMatchObject({ route: 'note', agent: 'researcher', runId: 'old', label: 'Note for Researcher · after its current step' })
  })

  it('no @ is a note to the agent at work in the newest run, else a team note', () => {
    expect(destination(null, busy, names, 3)).toMatchObject({ route: 'note', agent: 'writer', runId: 'new' })
    expect(destination(null, busy, names, 3, true).label).toBe('Note for News Writer now · stops its current step')
    expect(destination(null, idle, names, 3)).toMatchObject({ route: 'team_note', label: 'Team note · starts nothing' })
  })
})
