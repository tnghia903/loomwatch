import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Evidence } from '../../lib/watch/events'
import type { TeamMessage } from '../../lib/watch/messages'
import { AgentMessages } from './AgentMessages'

const at = (seconds: number) => new Date(Date.parse('2026-10-05T09:00:00Z') + seconds * 1000).toISOString()
const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
  from: null, to: null, text: '', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: at(0), offsetMs: 0, state: 'delivered', error: null, reply: null, ...extra,
})

const order = [
  { id: 'researcher', name: 'Researcher', operator: false },
  { id: 'writer', name: 'Writer', operator: false },
  { id: 'review', name: 'Your review', operator: true },
]

const handover = message({ id: 'handover:e5', kind: 'handover', to: 'writer', text: '## Findings\nACP is JSON-RPC.', seq: 5, offsetMs: 40_000, ts: at(40) })
const askBack = message({
  id: 'writer:q1', kind: 'ask', from: 'writer', to: 'researcher', text: 'Which spec version did you read?', evidenceId: 'writer:q1', seq: 8, offsetMs: 52_000, ts: at(52), state: 'answered',
  reply: { from: 'researcher', text: 'Version 0.4.', eventId: 'e12', seq: 12, ts: at(61), offsetMs: 61_000, source: 'open' },
})
const fetched = { id: 'researcher:c1', agentId: 'researcher', seq: 10, kind: 'source', relation: 'consulted source', name: 'Fetch https://agentclientprotocol.com/spec', status: 'succeeded' } as unknown as Evidence

afterEach(cleanup)

function setup(messages: TeamMessage[], extra: Partial<Parameters<typeof AgentMessages>[0]> = {}) {
  const onInspectEvidence = vi.fn()
  const onInspectHandover = vi.fn()
  render(<AgentMessages messages={messages} order={order} evidence={[fetched]} live={false} pipeline onInspectEvidence={onInspectEvidence} onInspectHandover={onInspectHandover} {...extra} />)
  return { onInspectEvidence, onInspectHandover }
}

describe('Messages between agents', () => {
  it('shows a question put back to an earlier stage beside the answer it got', () => {
    setup([handover, askBack])
    const ask = screen.getByRole('listitem', { name: /Writer asked Researcher/ })
    expect(within(ask).getByText('Which spec version did you read?')).toBeInTheDocument()
    expect(within(ask).getByText('Version 0.4.')).toBeInTheDocument()
    expect(within(ask).getByText('earlier stage')).toBeInTheDocument()
    expect(within(ask).getByText('Answered after 9 seconds')).toBeInTheDocument()
    // How it answered is the difference between an answer and a guess, so it is said.
    expect(within(ask).getByText(/from the session it already had/)).toBeInTheDocument()
  })

  it('names who wrote a handover from the team’s connections, and opens what the stage was given', () => {
    const { onInspectHandover } = setup([handover])
    const item = screen.getByRole('listitem', { name: /Researcher handed over to Writer/ })
    fireEvent.click(within(item).getByRole('button', { name: /Everything Writer was given/ }))
    expect(onInspectHandover).toHaveBeenCalledWith('writer')
  })

  it('lists what the asked agent did before it answered, each one opening its record', () => {
    const { onInspectEvidence } = setup([askBack])
    expect(screen.getByText('Researcher made one call before answering')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Researcher opened agentclientprotocol.com/ }))
    expect(onInspectEvidence).toHaveBeenCalledWith('researcher:c1')
    fireEvent.click(screen.getByRole('button', { name: 'Open the record' }))
    expect(onInspectEvidence).toHaveBeenLastCalledWith('writer:q1')
  })

  it('says a question is waiting while the run is live, and was never answered once it is not', () => {
    const waiting = { ...askBack, state: 'pending' as const, reply: null }
    setup([waiting], { live: true })
    expect(screen.getAllByText(/Waiting for an answer/).length).toBeGreaterThan(0)
    cleanup()
    setup([waiting], { live: false })
    expect(screen.getByText('No answer recorded')).toBeInTheDocument()
    expect(screen.getByText(/1 never answered/)).toBeInTheDocument()
  })

  it('keeps a refused message with the Team Bus’s own words', () => {
    setup([{ ...askBack, state: 'failed', reply: null, error: 'cycle detected: writer -> researcher -> writer' }])
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('cycle detected')
  })

  it('filters by kind and by one agent, and says when that leaves nothing', () => {
    setup([handover, askBack])
    const shown = () => screen.queryAllByRole('listitem').filter((item) => item.hasAttribute('data-message'))
    fireEvent.click(screen.getByRole('button', { name: /Questions 1/ }))
    expect(screen.queryByRole('listitem', { name: /handed over/ })).not.toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: /asked/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /All 2/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Show only messages with Researcher' }))
    expect(shown()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Show only messages with Writer' }))
    fireEvent.click(screen.getByRole('button', { name: /Handovers 1/ }))
    expect(shown()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Showing messages with Writer/ }))
    expect(shown()).toHaveLength(1)
    // You were asked a question but handed nothing: that pairing is empty, and it says so.
    cleanup()
    setup([handover, message({ id: 'question:e9', kind: 'question', from: 'writer', to: 'operator', text: 'Which budget?', state: 'pending' })])
    fireEvent.click(screen.getByRole('button', { name: 'Show only messages with you' }))
    expect(shown()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Handovers 1/ }))
    expect(shown()).toHaveLength(0)
    expect(screen.getByText('No handovers with you.')).toBeInTheDocument()
  })

  it('folds a long message to its first lines, with the rest one click away', () => {
    const long = { ...handover, text: Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n') }
    setup([long])
    const more = screen.getByRole('button', { name: /Show all/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    // Folding is presentation only: the whole text is always in the page, verbatim.
    expect(screen.getByText(/Line 12/)).toBeInTheDocument()
  })

  it('reads a question for you and your answer as an exchange with you', () => {
    setup([message({
      id: 'question:e3', kind: 'question', from: 'writer', to: 'operator', text: 'Which budget applies?', context: 'The brief names two.', state: 'answered',
      reply: { from: 'operator', text: 'The 2026 one.', eventId: 'e9', seq: 9, ts: at(120), offsetMs: 120_000, source: null },
    })])
    const item = screen.getByRole('listitem', { name: /Writer asked you/ })
    expect(within(item).getByText('The brief names two.')).toBeInTheDocument()
    expect(within(item).getByText('You answered')).toBeInTheDocument()
  })

  it('says plainly when nothing passed between the agents', () => {
    setup([], { live: false })
    expect(screen.getByText('No messages passed between the agents in this run.')).toBeInTheDocument()
  })
})

describe('Messages between agents, counting what is waiting', () => {
  it('does not count a task still being sent as a question waiting for an answer', () => {
    setup([message({ id: 'd', kind: 'dispatch', from: 'writer', to: 'researcher', text: 'Collect sources.', state: 'pending' })], { live: false })
    expect(screen.getByText('One message')).toBeInTheDocument()
    expect(screen.queryByText(/never answered/)).not.toBeInTheDocument()
  })
})
