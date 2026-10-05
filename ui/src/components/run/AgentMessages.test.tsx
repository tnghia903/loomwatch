import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import type { Evidence } from '../../lib/watch/events'
import type { MessageReply, TeamMessage } from '../../lib/watch/messages'
import { AgentMessages } from './AgentMessages'

const at = (seconds: number) => new Date(Date.parse('2026-10-05T09:00:00Z') + seconds * 1000).toISOString()
const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
  from: null, to: null, handedBy: null, text: '', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: at(0), offsetMs: 0, state: 'delivered', error: null, reply: null, ...extra,
})
const answer = (from: string, text: string, seconds: number, extra: Partial<MessageReply> = {}): MessageReply => ({
  from, text, eventId: `r${seconds}`, seq: seconds, ts: at(seconds), offsetMs: seconds * 1000, source: null, sentBackTo: null, ...extra,
})

// Numbered as the stage cards are.
const order = [
  { id: 'researcher', name: 'Researcher', operator: false },
  { id: 'writer', name: 'Writer', operator: false },
  { id: 'review', name: 'Your review', operator: true },
  { id: 'editor', name: 'Editor', operator: false },
]

const handover = message({ id: 'handover:e5', kind: 'handover', to: 'writer', text: 'ACP is JSON-RPC.', handedBy: { from: ['researcher'], via: [] }, seq: 5, offsetMs: 40_000, ts: at(40) })
const askBack = message({
  id: 'writer:q1', kind: 'ask', from: 'writer', to: 'researcher', text: 'Which spec version did you read?', evidenceId: 'writer:q1', seq: 8, offsetMs: 52_000, ts: at(52), state: 'answered',
  reply: answer('researcher', 'Version 0.4.', 61, { seq: 12, source: 'open' }),
})
const fetched = { id: 'researcher:c1', agentId: 'researcher', seq: 10, kind: 'source', relation: 'consulted source', name: 'Fetch https://agentclientprotocol.com/spec', status: 'succeeded' } as unknown as Evidence
const reviewed = (reply: MessageReply) => message({ id: 'handover:e20', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['writer'], via: [] }, seq: 20, state: 'answered', reply })

afterEach(cleanup)

function setup(messages: TeamMessage[], extra: Partial<Parameters<typeof AgentMessages>[0]> = {}) {
  const onInspectEvidence = vi.fn()
  const onInspectHandover = vi.fn()
  render(<AgentMessages messages={messages} order={order} evidence={[fetched]} live={false} onInspectEvidence={onInspectEvidence} onInspectHandover={onInspectHandover} {...extra} />)
  return { onInspectEvidence, onInspectHandover }
}
const bubbles = () => screen.queryAllByRole('listitem').filter((item) => item.hasAttribute('data-bubble'))
const bubble = (name: RegExp) => screen.getByRole('listitem', { name })
/** The columns a bubble stretches over, as CSS grid lines, and the side its speaker is on. */
const placed = (item: HTMLElement) => ({ from: item.style.getPropertyValue('--from'), to: item.style.getPropertyValue('--to'), side: item.classList.contains('side-end') ? 'end' : 'start' })

describe('What the agents said to each other', () => {
  it('puts each message and its answer in order, as bubbles from who said it to whom', () => {
    setup([handover, askBack])
    expect(bubbles().map((item) => item.getAttribute('aria-label'))).toEqual([
      '0:40, Researcher to Writer: handover',
      '0:52, Writer to Researcher: question',
      '1:01, Researcher to Writer: answer',
    ])
    // The columns are the stage cards, by number: whoever took part, in the cards' order.
    expect(document.querySelector('.talk-lanes')?.textContent).toBe('1Researcher2Writer')
  })

  it('draws a question to an earlier stage and its answer over the same two columns, facing each other', () => {
    setup([handover, askBack])
    const question = placed(bubble(/Writer to Researcher: question/))
    const reply = placed(bubble(/Researcher to Writer: answer/))
    expect([question.from, question.to]).toEqual(['1', '3'])
    expect([reply.from, reply.to]).toEqual(['1', '3'])
    // The square corner is on the speaker's side: Writer is the right of the two, Researcher the left.
    expect(question.side).toBe('end')
    expect(reply.side).toBe('start')
  })

  it('shows your review as your own words to where they went: on, or back', () => {
    setup([reviewed(answer('review', 'Shorter, please.', 30, { sentBackTo: 'writer' }))])
    const back = bubble(/You to Writer: sent back/)
    expect(back).toHaveClass('you')
    expect(within(back).getByText('Shorter, please.')).toBeInTheDocument()
  })

  it('folds an approved review and what only repeats it into one answer, to the stage it went on to', () => {
    const direction = message({ id: 'direction:e31', kind: 'direction', from: 'operator', to: 'editor', text: 'Keep it short.', handedBy: { from: ['review'], via: [] }, seq: 31 })
    const passedOn = message({ id: 'handover:e31', kind: 'handover', to: 'editor', text: 'DRAFT', handedBy: { from: ['writer'], via: ['review'] }, seq: 31 })
    setup([reviewed(answer('review', 'Keep it short.', 30)), direction, passedOn])
    expect(bubbles().map((item) => item.getAttribute('aria-label'))).toEqual([
      '0:00, Writer to you: handover',
      '0:30, You to Editor: approved, with a note',
    ])
  })

  it('says a plain approval in a word, without quoting the text it was sent as', () => {
    setup([reviewed(answer('review', APPROVAL_TEXT, 5))])
    const approved = bubble(/You: approved$/)
    expect(approved).not.toHaveTextContent(APPROVAL_TEXT)
  })

  it('shows an answer on its way while the run is live, and says when none came', () => {
    const waiting = { ...askBack, state: 'pending' as const, reply: null }
    setup([waiting], { live: true })
    expect(bubble(/Researcher to Writer: thinking…/)).toHaveClass('live')
    expect(screen.getByText(/1 answer on its way/)).toBeInTheDocument()
    cleanup()
    setup([waiting], { live: false })
    expect(bubble(/Researcher to Writer: no answer/)).toBeInTheDocument()
    expect(screen.getByText(/1 never answered/)).toBeInTheDocument()
  })

  it('keeps a refused message with the Team Bus’s own words', () => {
    setup([{ ...askBack, state: 'failed', reply: null, error: 'cycle detected: writer -> researcher -> writer' }])
    expect(bubble(/question/)).toHaveClass('failed')
    expect(screen.getByRole('note')).toHaveTextContent('cycle detected')
  })

  it('cuts a long message to its first lines, and shows it verbatim when read in full', () => {
    const long = { ...handover, text: ['## Findings', ...Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`)].join('\n') }
    setup([long])
    const read = screen.getByRole('button', { name: 'Read all' })
    expect(read).toHaveAttribute('aria-expanded', 'false')
    // Folded, it reads as words: no Markdown marks.
    expect(screen.getByText(/^Findings/)).toBeInTheDocument()
    fireEvent.click(read)
    expect(screen.getByText(/^## Findings/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens a question to its record, and an answer to how it was answered and what it read first', () => {
    const { onInspectEvidence } = setup([askBack])
    fireEvent.click(within(bubble(/question/)).getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open the record' }))
    expect(onInspectEvidence).toHaveBeenCalledWith('writer:q1')
    fireEvent.click(within(bubble(/answer/)).getByRole('button', { name: 'Details' }))
    expect(screen.getByText(/from the work it had already done/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Researcher made one call before answering'))
    fireEvent.click(screen.getByRole('button', { name: /Researcher opened agentclientprotocol.com/ }))
    expect(onInspectEvidence).toHaveBeenLastCalledWith('researcher:c1')
  })

  it('opens what a stage was given from a handover to it', () => {
    const { onInspectHandover } = setup([handover])
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: /Everything Writer was given/ }))
    expect(onInspectHandover).toHaveBeenCalledWith('writer')
  })

  it('opens the message the timeline points at, even one folded into your review', () => {
    const passedOn = message({ id: 'handover:e31', kind: 'handover', to: 'editor', text: 'DRAFT', handedBy: { from: ['writer'], via: ['review'] }, seq: 31 })
    setup([reviewed(answer('review', APPROVAL_TEXT, 30)), passedOn], { reveal: { id: 'handover:e31', at: 1 } })
    expect(bubble(/Writer to you: handover/)).toHaveClass('flash')
  })

  it('names who a follow-up of yours went to, and their answer', () => {
    setup([message({ id: 'note:e7', kind: 'note', from: 'operator', to: 'writer', text: 'Also check the footnotes.', state: 'answered', reply: answer('writer', 'Two links fixed.', 15) })])
    expect(bubble(/You to Writer: note/)).toBeInTheDocument()
    expect(bubble(/Writer to you: answer/)).toHaveTextContent('Two links fixed.')
  })

  it('says when a sender was taken from the team file rather than recorded', () => {
    setup([{ ...handover, handedBy: null }])
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText(/this run did not record it/)).toBeInTheDocument()
  })

  it('shows nothing for a finished run in which nothing passed between the agents', () => {
    const { container } = render(<AgentMessages messages={[]} order={order} evidence={[]} live={false} onInspectEvidence={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    cleanup()
    setup([], { live: true })
    expect(screen.getByText(/Nothing has passed between the agents yet/)).toBeInTheDocument()
  })
})
