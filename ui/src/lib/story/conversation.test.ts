import { describe, expect, it } from 'vitest'

import type { TeamMessage } from '../watch/messages'
import { converse, fold, itemTouches, lineSentence, nameList } from './conversation'

const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
  from: null, to: null, handedBy: null, text: 't', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: '2026-10-05T09:00:00Z', offsetMs: 0, state: 'delivered', error: null, reply: null, ...extra,
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

  it('takes the senders the run recorded over the team file as it is now', () => {
    // The team has since been rewired (the editor now feeds the writer), but this run recorded
    // that the collector's work reached the writer through your review.
    const { lines } = converse([message({ id: 'h', kind: 'handover', to: 'writer', handedBy: { from: ['collector'], via: ['review'] } })], order, new Map([['writer', ['editor']]]))
    expect(lines[0]).toMatchObject({ senders: ['collector'], via: ['review'], derived: false })
  })

  it('marks a sender read from the team file, for a run that predates the record', () => {
    const { lines } = converse([message({ id: 'h', kind: 'handover', to: 'editor' })], order, edges)
    expect(lines[0]).toMatchObject({ senders: ['collector'], derived: true })
  })

  it('falls back to the stage before in order when it has no connections to go by', () => {
    const { lines } = converse([message({ id: 'h', kind: 'handover', to: 'editor' })], order)
    expect(lines[0].senders).toEqual(['collector'])
  })

  it('files your reserved id under the review step, and gives a recruited helper a lane of its own', () => {
    const { lanes, lines } = converse([
      message({ id: 'q', kind: 'question', from: 'editor', to: 'operator', state: 'answered', reply: { from: 'operator', text: 'yes', eventId: 'r', seq: 2, ts: '', offsetMs: 0, source: null, sentBackTo: null } }),
      message({ id: 'a', kind: 'ask', from: 'editor', to: 'fact-checker' }),
    ], order, edges)
    expect(lines[0]).toMatchObject({ receiver: 'review', replier: 'review' })
    expect(lanes.map((lane) => lane.id)).toEqual(['editor', 'review', 'fact-checker'])
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

describe('fold', () => {
  const reviewed = message({ id: 'h1', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['editor'], via: [] }, seq: 10, state: 'answered', reply: { from: 'review', text: 'Shorter.', eventId: 'r', seq: 12, ts: '', offsetMs: 0, source: null, sentBackTo: null } })
  const direction = message({ id: 'd', kind: 'direction', from: 'operator', to: 'writer', text: 'Shorter.', handedBy: { from: ['review'], via: [] }, seq: 13 })
  const passedOn = message({ id: 'h2', kind: 'handover', to: 'writer', text: 'DRAFT', handedBy: { from: ['editor'], via: ['review'] }, seq: 13 })

  it('folds the direction and the passed-on handover into the review you approved', () => {
    const { lines, lanes } = converse([reviewed, direction, passedOn], order, edges)
    const items = fold(lines, lanes)
    expect(items).toHaveLength(1)
    expect(items[0].ids).toEqual(['h1', 'd', 'h2'])
    expect(items[0].passedOn).toEqual([expect.objectContaining({ to: 'writer' })])
    expect(itemTouches(items[0], 'writer')).toBe(true)
  })

  it('keeps anything that is not an exact repeat', () => {
    const other = { ...direction, text: '### At the review stop\n\nShorter.' }
    const sentBack = { ...reviewed, reply: { ...reviewed.reply!, sentBackTo: 'editor' } }
    expect(fold(...(() => { const c = converse([reviewed, other, passedOn], order, edges); return [c.lines, c.lanes] as const })()).map((item) => item.ids)).toEqual([['h1', 'h2'], ['d']])
    expect(fold(...(() => { const c = converse([sentBack, direction, passedOn], order, edges); return [c.lines, c.lanes] as const })())).toHaveLength(3)
  })
})
