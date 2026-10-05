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
  reply: answer('researcher', '**Version 0.4**, the one on the site.', 61, { seq: 12, source: 'open' }),
})
const fetched = { id: 'researcher:c1', agentId: 'researcher', seq: 10, kind: 'source', relation: 'consulted source', name: 'Fetch https://agentclientprotocol.com/spec', status: 'succeeded' } as unknown as Evidence
const reviewed = (reply: MessageReply) => message({ id: 'handover:e20', kind: 'handover', to: 'review', text: '## Draft\nLead with the rule.', handedBy: { from: ['writer'], via: [] }, seq: 20, state: 'answered', reply })
const passedOn = message({ id: 'handover:e31', kind: 'handover', to: 'editor', text: '## Draft\nLead with the rule.', handedBy: { from: ['writer'], via: ['review'] }, seq: 31 })

afterEach(cleanup)

function setup(messages: TeamMessage[], extra: Partial<Parameters<typeof AgentMessages>[0]> = {}) {
  const onInspectEvidence = vi.fn()
  const onInspectHandover = vi.fn()
  render(<AgentMessages messages={messages} order={order} evidence={[fetched]} live={false} onInspectEvidence={onInspectEvidence} onInspectHandover={onInspectHandover} {...extra} />)
  return { onInspectEvidence, onInspectHandover }
}
const said = () => screen.queryAllByRole('listitem').filter((item) => item.hasAttribute('data-bubble'))
const msg = (name: RegExp) => screen.getByRole('listitem', { name })

describe('Team chat', () => {
  it('lists who said what to whom, in order, under a header naming everyone in it', () => {
    setup([handover, askBack])
    expect(said().map((item) => item.getAttribute('aria-label'))).toEqual([
      '0:40, Researcher to Writer: handover',
      '0:52, Writer to Researcher: question',
      '1:01, Researcher to Writer: answer',
    ])
    expect(screen.getByRole('heading', { name: 'Team chat' })).toBeInTheDocument()
    expect(screen.getByText('Researcher and Writer · 3 messages')).toBeInTheDocument()
  })

  it('addresses a question with an @mention, and the answer quotes the question instead', () => {
    setup([askBack])
    const question = msg(/Writer to Researcher: question/)
    expect(within(question).getByText('@Researcher')).toBeInTheDocument()
    const reply = msg(/Researcher to Writer: answer/)
    expect(within(reply).getByRole('blockquote')).toHaveTextContent('WriterWhich spec version did you read?')
    // The quote says whom it answers, so the reply does not name them again.
    expect(within(reply).queryByText('@Writer')).not.toBeInTheDocument()
    // What the agent wrote is formatted, as a chat shows it.
    expect(within(reply).getByText('Version 0.4').tagName).toBe('STRONG')
  })

  it('shows a handover as a document shared with the stage it was for', () => {
    setup([handover])
    expect(within(msg(/handover/)).getByText(/Handover/)).toHaveTextContent('Handover to @Writer')
  })

  it('puts your words on your side, quoting the handover you answered and saying where it went', () => {
    setup([reviewed(answer('review', 'Shorter, please.', 30, { sentBackTo: 'writer' }))])
    const back = msg(/You to Writer: sent back/)
    expect(back).toHaveClass('mine')
    expect(within(back).getByRole('blockquote')).toHaveTextContent('Handover: Draft Lead with the rule.')
    expect(within(back).getByText('sent back')).toBeInTheDocument()
  })

  it('names the stage your approved note went on to, and folds away what only repeats it', () => {
    const direction = message({ id: 'direction:e31', kind: 'direction', from: 'operator', to: 'editor', text: 'Keep it short.', handedBy: { from: ['review'], via: [] }, seq: 31 })
    setup([reviewed(answer('review', 'Keep it short.', 30)), direction, passedOn])
    expect(said()).toHaveLength(2)
    const approved = msg(/You to Editor: approved, with a note/)
    expect(within(approved).getByText('@Editor')).toBeInTheDocument()
    expect(within(approved).getByText('approved · passed on to Editor')).toBeInTheDocument()
  })

  it('tells a plain approval as a note in the chat, not as words you typed', () => {
    setup([reviewed(answer('review', APPROVAL_TEXT, 30)), passedOn])
    expect(msg(/You: approved$/)).toHaveTextContent('You approved Writer’s handover · passed on to Editor')
    expect(screen.queryByText(APPROVAL_TEXT)).not.toBeInTheDocument()
  })

  it('groups one member’s messages in a row under one name and avatar', () => {
    // Tasks wait for no answer, so nothing comes between them.
    const task = (id: string, seconds: number) => message({ id, kind: 'dispatch', from: 'writer', to: 'researcher', text: `Task ${id}`, seq: seconds, offsetMs: seconds * 1000, ts: at(seconds) })
    setup([task('t1', 50), task('t2', 51)])
    const [first, next] = said()
    expect(first).not.toHaveClass('continued')
    expect(next).toHaveClass('continued')
  })

  it('shows who is writing an answer while the run is live, and says when none came', () => {
    const waiting = { ...askBack, state: 'pending' as const, reply: null }
    setup([waiting], { live: true })
    expect(msg(/Researcher to Writer: thinking…/)).toHaveTextContent('Researcher is writing an answer')
    cleanup()
    setup([waiting], { live: false })
    expect(msg(/Researcher to Writer: no answer/)).toHaveTextContent('No answer')
    cleanup()
    // An answer you owe waits on you.
    setup([message({ id: 'h', kind: 'handover', to: 'review', text: 'DRAFT', handedBy: { from: ['writer'], via: [] }, state: 'pending' })], { live: true })
    expect(msg(/You to Writer: waiting for your review/)).toHaveTextContent('Waiting for your review')
  })

  it('marks a message the Team Bus refused, in its own words', () => {
    setup([{ ...askBack, state: 'failed', reply: null, error: 'cycle detected: writer -> researcher -> writer' }])
    expect(msg(/question/)).toHaveClass('failed')
    expect(screen.getByRole('note')).toHaveTextContent('Not delivered: cycle detected')
  })

  it('cuts a long message to its first lines, with the rest a click away', () => {
    setup([{ ...handover, text: Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n\n') }])
    const more = screen.getByRole('button', { name: 'Read more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps the record behind a message under its info', () => {
    const { onInspectEvidence } = setup([askBack])
    fireEvent.click(within(msg(/question/)).getByRole('button', { name: 'Info' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open the record' }))
    expect(onInspectEvidence).toHaveBeenCalledWith('writer:q1')
    fireEvent.click(within(msg(/answer/)).getByRole('button', { name: 'Info' }))
    expect(screen.getByText(/from the work it had already done/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Researcher made one call before answering'))
    fireEvent.click(screen.getByRole('button', { name: /Researcher opened agentclientprotocol.com/ }))
    expect(onInspectEvidence).toHaveBeenLastCalledWith('researcher:c1')
  })

  it('opens what a stage was given from a handover to it, and says when its sender was not recorded', () => {
    const { onInspectHandover } = setup([{ ...handover, handedBy: null }])
    fireEvent.click(screen.getByRole('button', { name: 'Info' }))
    fireEvent.click(screen.getByRole('button', { name: /Everything Writer was given/ }))
    expect(onInspectHandover).toHaveBeenCalledWith('writer')
    expect(screen.getByText(/this run did not record it/)).toBeInTheDocument()
  })

  it('shows the message the timeline points at, even one folded into your review', () => {
    setup([reviewed(answer('review', 'Keep it short.', 30)), passedOn], { reveal: { id: 'handover:e31', at: 1 } })
    expect(msg(/Writer to you: handover/)).toHaveClass('flash')
  })

  it('names who a follow-up of yours went to, and their answer', () => {
    setup([message({ id: 'note:e7', kind: 'note', from: 'operator', to: 'writer', text: 'Also check the footnotes.', state: 'answered', reply: answer('writer', 'Two links fixed.', 15) })])
    expect(within(msg(/You to Writer: note/)).getByText('@Writer')).toBeInTheDocument()
    expect(msg(/Writer to you: answer/)).toHaveTextContent('Two links fixed.')
  })

  it('shows nothing for a finished run in which nothing passed between the agents', () => {
    const { container } = render(<AgentMessages messages={[]} order={order} evidence={[]} live={false} onInspectEvidence={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    cleanup()
    setup([], { live: true })
    expect(screen.getByText(/Nothing has passed between the agents yet/)).toBeInTheDocument()
  })
})
