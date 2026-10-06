import { describe, expect, it } from 'vitest'

import type { TeamMessage } from '../watch/messages'
import { bubbles, converse, fold } from './conversation'

const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
  from: null, to: null, handedBy: null, text: 't', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: '2026-10-05T09:00:00Z', offsetMs: 0, state: 'delivered', error: null, reply: null, carried: false, ...extra,
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
  })

  it('keeps anything that is not an exact repeat', () => {
    const other = { ...direction, text: '### At the review stop\n\nShorter.' }
    const sentBack = { ...reviewed, reply: { ...reviewed.reply!, sentBackTo: 'editor' } }
    expect(fold(...(() => { const c = converse([reviewed, other, passedOn], order, edges); return [c.lines, c.lanes] as const })()).map((item) => item.ids)).toEqual([['h1', 'h2'], ['d']])
    expect(fold(...(() => { const c = converse([sentBack, direction, passedOn], order, edges); return [c.lines, c.lanes] as const })())).toHaveLength(3)
  })
})

describe('bubbles', () => {
  const lay = (messages: TeamMessage[], live = false) => {
    const { lines, lanes } = converse(messages, order, edges)
    return bubbles(fold(lines, lanes), lanes, live, 'APPROVED').map(({ part, from, to, word, text }) => ({ part, from, to, word, text }))
  }
  const asked = message({ id: 'a', kind: 'ask', from: 'writer', to: 'editor', text: 'Which source?', state: 'answered', reply: { from: 'editor', text: 'Reuters.', eventId: 'r', seq: 2, ts: '', offsetMs: 0, source: 'open', sentBackTo: null } })

  it('makes a question and its answer two bubbles, the answer going back to whoever asked', () => {
    expect(lay([asked])).toEqual([
      { part: 'said', from: ['writer'], to: ['editor'], word: 'question', text: 'Which source?' },
      { part: 'reply', from: ['editor'], to: ['writer'], word: 'answer', text: 'Reuters.' },
    ])
  })

  it('shows an answer still owed as one on its way from whoever owes it, and as none once the run is over', () => {
    const owed = { ...asked, state: 'pending' as const, reply: null }
    expect(lay([owed], true)[1]).toEqual({ part: 'waiting', from: ['editor'], to: ['writer'], word: 'thinking…', text: '' })
    expect(lay([owed], false)[1]).toMatchObject({ word: 'no answer' })
    // Work handed on expects no answer, so nothing is owed for it.
    expect(lay([message({ id: 'd', kind: 'dispatch', from: 'writer', to: 'editor', text: 'Go.', state: 'pending' })])).toHaveLength(1)
  })

  it('sends your review answer where it went: back to a stage, or on to the next', () => {
    const reviewed = (sentBackTo: string | null, text: string) => message({ id: 'h', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['editor'], via: [] }, seq: 10, state: 'answered', reply: { from: 'review', text, eventId: 'r', seq: 12, ts: '', offsetMs: 0, source: null, sentBackTo } })
    const onward = message({ id: 'h2', kind: 'handover', to: 'writer', text: 'DRAFT', handedBy: { from: ['editor'], via: ['review'] }, seq: 13 })
    expect(lay([reviewed('editor', 'Shorter.')])[1]).toMatchObject({ from: ['review'], to: ['editor'], word: 'sent back', text: 'Shorter.' })
    expect(lay([reviewed(null, 'APPROVED'), onward])[1]).toMatchObject({ to: ['writer'], word: 'approved', text: '' })
    expect(lay([reviewed(null, 'Keep it short.'), onward])[1]).toMatchObject({ word: 'approved, with a note', text: 'Keep it short.' })
  })
})
