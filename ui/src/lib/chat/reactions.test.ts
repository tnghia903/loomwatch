import { describe, expect, it } from 'vitest'

import { bubbles, converse, fold, type Party } from '../story/conversation'
import { APPROVAL_TEXT } from '../story/needsYou'
import type { CheckItemResult } from '../story/checks'
import type { TeamMessage } from '../watch/messages'
import { checkReactions, chipsOf, chipWords, talkReactions, yoursOn, type AgentReaction } from './reactions'

const T0 = Date.parse('2026-10-19T04:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

let seq = 0
const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => {
  seq += 1
  return {
    from: null, handedBy: null, to: null, text: 'x', context: null, eventId: `e${seq}`, evidenceId: null,
    seq: extra.seq ?? seq, ts: extra.ts ?? at(seq), offsetMs: 0, state: 'delivered', error: null, reply: null, carried: false, ...extra,
  }
}
const reply = (from: string, s: number, text = 'yes', sentBackTo: string | null = null) => ({ from, text, eventId: `r${s}`, seq: s, ts: at(s), offsetMs: 0, source: null, sentBackTo })
const met = (item: string): CheckItemResult => ({ item, verdict: 'met', evidence: 'in the brief' })
const missed = (item: string): CheckItemResult => ({ item, verdict: 'not_met', evidence: '' })

const order: Party[] = [
  { id: 'researcher', name: 'Researcher', operator: false },
  { id: 'review', name: 'Your review', operator: true },
  { id: 'writer', name: 'Writer', operator: false },
  { id: 'checker', name: 'Checker', operator: false },
]
const operators = new Set(['review'])

/** The bubbles the chat draws for these messages, and the agents' faces on each, by bubble key. */
function faces(messages: TeamMessage[]): Record<string, string[]> {
  const { lines, lanes } = converse(messages, order)
  const checks = checkReactions(messages)
  const out: Record<string, string[]> = {}
  for (const bubble of bubbles(fold(lines, lanes), lanes, false, APPROVAL_TEXT)) {
    const on = talkReactions(bubble, operators, checks).map((reaction) => `${reaction.face}:${reaction.by}`)
    if (on.length) out[bubble.key] = on
  }
  return out
}

describe('the agents’ faces, read from what the run recorded', () => {
  it('an agent looks up at what it was handed: a handover, a task, a handoff', () => {
    expect(faces([
      message({ id: 'h1', kind: 'handover', to: 'writer', handedBy: { from: ['researcher'], via: [] } }),
      message({ id: 't1', kind: 'dispatch', from: 'writer', to: 'researcher' }),
      message({ id: 'o1', kind: 'handoff', from: 'researcher', to: 'writer' }),
    ])).toEqual({ 'h1:said': ['seen:writer'], 't1:said': ['seen:researcher'], 'o1:said': ['seen:writer'] })
  })

  it('puts no face on what has not reached anyone yet, what failed, or what was handed to you', () => {
    expect(faces([
      message({ id: 'p1', kind: 'dispatch', from: 'writer', to: 'researcher', state: 'pending' }),
      message({ id: 'f1', kind: 'dispatch', from: 'writer', to: 'researcher', state: 'failed', error: 'gone' }),
      message({ id: 'r1', kind: 'handover', to: 'review', state: 'pending', handedBy: { from: ['researcher'], via: [] } }),
    ])).toEqual({})
  })

  it('whoever asked you looks up at your answer, and your words with a review reach where you sent them', () => {
    expect(faces([
      message({ id: 'q1', kind: 'question', from: 'writer', to: 'operator', state: 'answered', reply: reply('operator', 40, 'Use the EU figures') }),
      message({ id: 'r1', kind: 'handover', to: 'review', state: 'answered', handedBy: { from: ['researcher'], via: [] }, reply: reply('review', 50, 'Add the sources', 'researcher') }),
    ])).toEqual({ 'q1:reply': ['seen:writer'], 'r1:reply': ['seen:researcher'] })
  })

  it('a check step that found everything met puts `met` on the work it checked, and only then', () => {
    const handed = message({ id: 'h1', kind: 'handover', to: 'checker', handedBy: { from: ['writer'], via: [] } })
    const passed = message({ id: 'c1', kind: 'check', from: 'checker', to: 'writer', check: { round: 1, items: [met('Has sources'), met('Under 300 words')], readable: true, sentBack: false, problems: null } })
    expect(faces([handed, passed])).toEqual({ 'h1:said': ['seen:checker', 'met:checker'] })

    const failed = message({ id: 'c2', kind: 'check', from: 'checker', to: 'writer', state: 'answered', check: { round: 1, items: [met('Has sources'), missed('Under 300 words')], readable: true, sentBack: true, problems: 'Too long' }, reply: reply('writer', 70, 'Shorter now') })
    const second = message({ id: 'c3', kind: 'check', from: 'checker', to: 'writer', check: { round: 2, items: [met('Has sources'), met('Under 300 words')], readable: true, sentBack: false, problems: null } })
    // The second round checked the revised work, which is the reply to the round before.
    expect(faces([handed, failed, second])).toEqual({ 'h1:said': ['seen:checker'], 'c2:reply': ['met:checker'] })
  })
})

describe('chips', () => {
  const agents: AgentReaction[] = [
    { face: 'seen', by: 'writer', at: at(3) },
    { face: 'seen', by: 'researcher', at: at(1) },
    { face: 'met', by: 'checker', at: at(5) },
  ]
  const name = (id: string) => ({ writer: 'Writer', researcher: 'Researcher', checker: 'Checker' })[id] ?? id

  it('gathers one chip per face, first to react first, with yours joining an agent’s', () => {
    expect(chipsOf('seen', agents)).toEqual([
      { face: 'seen', you: true, agents: ['researcher', 'writer'] },
      { face: 'met', you: false, agents: ['checker'] },
    ])
    expect(chipsOf('love', [])).toEqual([{ face: 'love', you: true, agents: [] }])
    expect(chipsOf(null, [])).toEqual([])
  })

  it('says who put a face on, and what an agent’s face means', () => {
    const [seen, checked] = chipsOf('seen', agents)
    expect(chipWords(seen, name)).toBe('Seen: you, Researcher and Writer')
    expect(chipWords(checked, name)).toBe('Checker checked this and found everything met')
    expect(chipWords(chipsOf(null, [agents[0]])[0], name)).toBe('Writer picked this up')
    const done = chipsOf(null, [{ face: 'done', by: 'researcher', at: at(8), detail: '4 min' }, { face: 'done', by: 'writer', at: at(8), detail: '4 min' }])
    expect(chipWords(done[0], name)).toBe('Researcher and Writer worked on this · 4 min')
  })

  it('finds your face on one thing said', () => {
    const reactions = [{ target: 'answer', face: 'glad' as const, at: at(1) }, { target: 'talk:h1:said', face: 'hmm' as const, at: at(2) }]
    expect(yoursOn(reactions, 'talk:h1:said')).toBe('hmm')
    expect(yoursOn(reactions, 'talk:h2:said')).toBeNull()
    expect(yoursOn(undefined, 'answer')).toBeNull()
  })
})
