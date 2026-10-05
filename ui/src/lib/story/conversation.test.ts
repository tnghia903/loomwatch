import { describe, expect, it } from 'vitest'

import type { TeamMessage } from '../watch/messages'
import { converse, goesBack, lineSentence, nameList } from './conversation'

const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
  from: null, to: null, text: 't', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: '2026-10-05T09:00:00Z', offsetMs: 0, state: 'delivered', error: null, reply: null, ...extra,
})

const order = [
  { id: 'collector', name: 'Collector', operator: false },
  { id: 'editor', name: 'Editor', operator: false },
  { id: 'review', name: 'Your review', operator: true },
  { id: 'writer', name: 'Writer', operator: false },
]
const edges = new Map([['editor', ['collector']], ['review', ['editor']], ['writer', ['review']]])

describe('converse', () => {
  it('names a handover’s writer from the connections, through a review step that forwarded it', () => {
    const { lines } = converse([message({ id: 'h', kind: 'handover', to: 'writer' })], order, edges)
    expect(lines[0]).toMatchObject({ senders: ['editor'], via: ['review'], receiver: 'writer' })
    const name = (id: string) => order.find((party) => party.id === id)?.name ?? id
    expect(lineSentence(lines[0], name, (id) => id === 'review')).toBe('Editor handed over to Writer, through your review')
  })

  it('falls back to the stage before in order when it has no connections to go by', () => {
    const { lines } = converse([message({ id: 'h', kind: 'handover', to: 'editor' })], order)
    expect(lines[0].senders).toEqual(['collector'])
  })

  it('files your reserved id under the review step, and gives a recruited helper a lane of its own', () => {
    const { lanes, lines } = converse([
      message({ id: 'q', kind: 'question', from: 'editor', to: 'operator', state: 'answered', reply: { from: 'operator', text: 'yes', eventId: 'r', seq: 2, ts: '', offsetMs: 0, source: null } }),
      message({ id: 'a', kind: 'ask', from: 'editor', to: 'fact-checker' }),
    ], order, edges)
    expect(lines[0]).toMatchObject({ receiver: 'review', replier: 'review' })
    expect(lanes.map((lane) => lane.id)).toEqual(['editor', 'review', 'fact-checker'])
  })

  it('knows a question that goes back up the line', () => {
    const { lanes, lines } = converse([
      message({ id: 'back', kind: 'ask', from: 'writer', to: 'editor' }),
      message({ id: 'on', kind: 'ask', from: 'editor', to: 'writer' }),
    ], order, edges)
    expect(goesBack(lines[0], lanes)).toBe(true)
    expect(goesBack(lines[1], lanes)).toBe(false)
  })

  it('says your direction comes from the review step before the stage', () => {
    const { lines } = converse([message({ id: 'd', kind: 'direction', from: 'operator', to: 'writer' })], order, edges)
    expect(lines[0].senders).toEqual(['review'])
  })
})

describe('nameList', () => {
  it('joins names as a person would say them', () => {
    expect(nameList(['A'])).toBe('A')
    expect(nameList(['A', 'B'])).toBe('A and B')
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C')
  })
})
