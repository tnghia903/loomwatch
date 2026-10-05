import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const order = [
  { id: 'researcher', name: 'Researcher', operator: false },
  { id: 'writer', name: 'Writer', operator: false },
  { id: 'review', name: 'Your review', operator: true },
  { id: 'editor', name: 'Editor', operator: false },
]

const handover = message({ id: 'handover:e5', kind: 'handover', to: 'writer', text: '## Findings\nACP is JSON-RPC.', handedBy: { from: ['researcher'], via: [] }, seq: 5, offsetMs: 40_000, ts: at(40) })
const askBack = message({
  id: 'writer:q1', kind: 'ask', from: 'writer', to: 'researcher', text: 'Which spec version did you read?', evidenceId: 'writer:q1', seq: 8, offsetMs: 52_000, ts: at(52), state: 'answered',
  reply: answer('researcher', 'Version 0.4.', 61, { seq: 12, source: 'open' }),
})
const fetched = { id: 'researcher:c1', agentId: 'researcher', seq: 10, kind: 'source', relation: 'consulted source', name: 'Fetch https://agentclientprotocol.com/spec', status: 'succeeded' } as unknown as Evidence

afterEach(cleanup)

function setup(messages: TeamMessage[], extra: Partial<Parameters<typeof AgentMessages>[0]> = {}) {
  const onInspectEvidence = vi.fn()
  const onInspectHandover = vi.fn()
  render(<AgentMessages messages={messages} order={order} evidence={[fetched]} live={false} onInspectEvidence={onInspectEvidence} onInspectHandover={onInspectHandover} {...extra} />)
  return { onInspectEvidence, onInspectHandover }
}
const row = (name: RegExp) => screen.getByRole('button', { name })
const rows = () => screen.queryAllByRole('button', { expanded: false }).concat(screen.queryAllByRole('button', { expanded: true }))

describe('Messages between agents', () => {
  it('lists a question to an earlier stage with the answer right under it', () => {
    setup([handover, askBack])
    const ask = row(/Writer asked Researcher/)
    expect(ask).toHaveTextContent('Which spec version did you read?')
    expect(ask).toHaveTextContent('↳ Researcher: Version 0.4.')
    expect(ask).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a row to the whole text, how it was answered, and its record', () => {
    const { onInspectEvidence } = setup([askBack])
    fireEvent.click(row(/Writer asked Researcher/))
    expect(row(/Writer asked Researcher/)).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/from the work it had already done/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open the record' }))
    expect(onInspectEvidence).toHaveBeenCalledWith('writer:q1')
    // What the asked agent did before answering is one more click, each call opening its record.
    expect(screen.getByText('Researcher made one call before answering')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Researcher opened agentclientprotocol.com/ }))
    expect(onInspectEvidence).toHaveBeenLastCalledWith('researcher:c1')
  })

  it('opens what a stage was given from its handover', () => {
    const { onInspectHandover } = setup([handover])
    fireEvent.click(row(/Researcher handed over to Writer/))
    fireEvent.click(screen.getByRole('button', { name: /Everything Writer was given/ }))
    expect(onInspectHandover).toHaveBeenCalledWith('writer')
  })

  it('folds an approved review into one row, saying where it went on to', () => {
    const reviewed = message({
      id: 'handover:e20', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['writer'], via: [] }, seq: 20, state: 'answered',
      reply: answer('review', 'Keep it short.', 30),
    })
    const direction = message({ id: 'direction:e31', kind: 'direction', from: 'operator', to: 'editor', text: 'Keep it short.', handedBy: { from: ['review'], via: [] }, seq: 31 })
    const passedOn = message({ id: 'handover:e31', kind: 'handover', to: 'editor', text: 'DRAFT', handedBy: { from: ['writer'], via: ['review'] }, seq: 31 })
    setup([reviewed, direction, passedOn])
    expect(screen.getByText('One message')).toBeInTheDocument()
    expect(row(/Writer handed over to you for review/)).toHaveTextContent('↳ You approved · passed on to Editor with your note: Keep it short.')
  })

  it('says a plain approval without quoting the words it was sent as', () => {
    setup([message({ id: 'h', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['writer'], via: [] }, state: 'answered', reply: answer('review', APPROVAL_TEXT, 5) })])
    expect(row(/for review/)).toHaveTextContent('↳ You approved')
    expect(row(/for review/)).not.toHaveTextContent(APPROVAL_TEXT)
  })

  it('says a review answer sent the work back, and to whom', () => {
    setup([message({ id: 'h', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['writer'], via: [] }, state: 'answered', reply: answer('review', 'Shorter, please.', 5, { sentBackTo: 'writer' }) })])
    expect(row(/for review/)).toHaveTextContent('↳ You sent it back to Writer: Shorter, please.')
  })

  it('labels only what needs attention: still waiting while live, never answered after', () => {
    const waiting = { ...askBack, state: 'pending' as const, reply: null }
    setup([waiting], { live: true })
    expect(row(/Writer asked Researcher/)).toHaveTextContent('Waiting for an answer')
    cleanup()
    setup([waiting], { live: false })
    expect(row(/Writer asked Researcher/)).toHaveTextContent('No answer')
    expect(screen.getByText(/1 never answered/)).toBeInTheDocument()
    cleanup()
    // An answered question carries no label: the answer under it says it all.
    setup([askBack])
    expect(row(/Writer asked Researcher/)).not.toHaveTextContent(/Answered|Waiting/)
  })

  it('keeps a refused message with the Team Bus’s own words', () => {
    setup([{ ...askBack, state: 'failed', reply: null, error: 'cycle detected: writer -> researcher -> writer' }])
    expect(row(/Writer asked Researcher/)).toHaveTextContent('Failed')
    fireEvent.click(row(/Writer asked Researcher/))
    expect(screen.getByRole('note')).toHaveTextContent('cycle detected')
  })

  it('offers a choice of questions only when there is something to choose between', () => {
    setup([askBack])
    expect(screen.queryByRole('group', { name: 'Show' })).not.toBeInTheDocument()
    cleanup()
    setup([handover, askBack])
    fireEvent.click(screen.getByRole('button', { name: 'Questions' }))
    expect(screen.queryByRole('button', { name: /handed over/ })).not.toBeInTheDocument()
    expect(row(/Writer asked Researcher/)).toBeInTheDocument()
  })

  it('shows one agent’s messages when a stage card asks, and lets you clear it', () => {
    setup([handover, askBack], { focus: { laneId: 'writer', at: 1 } })
    expect(screen.getByRole('button', { name: /Showing messages with Writer/ })).toBeInTheDocument()
    cleanup()
    const question = message({ id: 'question:e9', kind: 'question', from: 'researcher', to: 'operator', text: 'Which budget?', state: 'pending' })
    setup([handover, question], { focus: { laneId: 'writer', at: 1 } })
    expect(screen.queryByRole('button', { name: /asked you/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Showing messages with Writer/ }))
    expect(row(/Researcher asked you/)).toBeInTheDocument()
  })

  it('opens the message the timeline points at, even one folded into a review', () => {
    const reviewed = message({ id: 'handover:e20', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['writer'], via: [] }, seq: 20, state: 'answered', reply: answer('review', APPROVAL_TEXT, 30) })
    const passedOn = message({ id: 'handover:e31', kind: 'handover', to: 'editor', text: 'DRAFT', handedBy: { from: ['writer'], via: ['review'] }, seq: 31 })
    setup([reviewed, passedOn], { reveal: { id: 'handover:e31', at: 1 } })
    expect(row(/for review/)).toHaveAttribute('aria-expanded', 'true')
  })

  it('names who a follow-up of yours went to, and shows its answer', () => {
    setup([message({ id: 'note:e7', kind: 'note', from: 'operator', to: 'writer', text: 'Also check the footnotes.', state: 'answered', reply: answer('writer', 'Two links fixed.', 15) })])
    expect(row(/You wrote to Writer/)).toHaveTextContent('↳ Writer: Two links fixed.')
  })

  it('says when a sender was taken from the team file rather than recorded', () => {
    setup([{ ...handover, handedBy: null }])
    fireEvent.click(row(/handed over to Writer/))
    expect(screen.getByText(/this run did not record it/)).toBeInTheDocument()
  })

  it('says plainly when nothing passed between the agents', () => {
    setup([], { live: false })
    expect(screen.getByText('No messages passed between the agents in this run.')).toBeInTheDocument()
    expect(rows()).toHaveLength(0)
  })
})
