import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { figureHue } from '../../lib/library/figures'
import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import { TeamFiguresContext } from '../agents/figureContext'
import type { Evidence } from '../../lib/watch/events'
import type { MessageReply, TeamMessage } from '../../lib/watch/messages'
import { AgentMessages } from './AgentMessages'

const at = (seconds: number) => new Date(Date.parse('2026-10-05T09:00:00Z') + seconds * 1000).toISOString()
const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
  from: null, to: null, handedBy: null, text: '', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: at(0), offsetMs: 0, state: 'delivered', error: null, reply: null, carried: false, ...extra,
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
  it('colours each agent with its figure’s colour, the same as its avatar and its figure', () => {
    const figures = new Map([['editor', { kind: 'pincushion' as const, color: 'rose' as const }], ['writer', { kind: 'spool' as const, color: 'sky' as const }]])
    render(
      <TeamFiguresContext.Provider value={figures}>
        <AgentMessages messages={[message({ id: 'editor:q9', kind: 'ask', from: 'editor', to: 'writer', text: 'Is the headline too long?', evidenceId: 'editor:q9', seq: 3 })]} order={order} evidence={[]} live={false} onInspectEvidence={vi.fn()} />
      </TeamFiguresContext.Provider>,
    )
    const bubble = screen.getByText('Is the headline too long?').closest('.chat-msg')
    expect(bubble).toHaveClass(`hue-${figureHue({ kind: 'pincushion', color: 'rose' })}`)
    expect(bubble?.querySelector('.chat-avatar')).toHaveClass('has-figure')
  })

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

  // ADR 0051: inside the team's chat, the talk wears the time of day as every other message there
  // does; "0:40" beside "12:35 PM" read as two clocks.
  it('tells the time of day inside the team’s chat', () => {
    setup([handover], { bare: true })
    const time = new Date(at(40)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    expect(said()[0]).toHaveAttribute('aria-label', `${time}, Researcher to Writer: handover`)
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

  // ADR 0062: approved at a check step's stop, the line says whose work it kept and what was open.
  it('tells an approval at a check step’s stop as the work kept as it was', () => {
    const stop = message({ id: 'check-stop:e40', kind: 'question', from: 'editor', to: 'operator', text: 'Writer’s work still misses 2 checks.', seq: 40, state: 'answered', checkStop: { checked: 'writer', open: 2 }, reply: answer('operator', APPROVAL_TEXT, 41) })
    setup([handover, stop])
    expect(msg(/You: approved$/)).toHaveTextContent('You approved Writer’s work as it was, with 2 checks not met')
    expect(screen.queryByText(/handover/)).not.toBeInTheDocument()
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

  it('shows each round of a clarification, in order, with who asked whom', () => {
    const round = (id: string, seq: number, text: string, reply: MessageReply, clarifies = false) => message({ id, kind: 'ask', from: 'writer', to: 'researcher', text, seq, offsetMs: seq * 1000, ts: at(seq), state: 'answered', reply, ...(clarifies ? { clarifies: true as const } : {}) })
    setup([
      round('q1', 50, 'How many did it sell?', answer('researcher', 'It depends.\n\n## Question back\nWhich year?', 55, { seq: 55, asksBack: true })),
      round('q2', 60, '2025.', answer('researcher', '42 in 2025.', 65, { seq: 65 }), true),
    ])
    expect(said().map((item) => item.getAttribute('aria-label')?.replace(/^[^,]+, /, ''))).toEqual([
      'Writer to Researcher: question',
      'Researcher to Writer: asks back',
      'Writer to Researcher: clarifies',
      'Researcher to Writer: answer',
    ])
    // Each round says what it is under it, and the question back is shown as the agent wrote it.
    expect(within(msg(/asks back/)).getByText('asks back')).toBeInTheDocument()
    expect(within(msg(/asks back/)).getByText('Which year?')).toBeInTheDocument()
    expect(within(msg(/clarifies/)).getByText('clarifies')).toBeInTheDocument()
    expect(within(msg(/clarifies/)).getByText('@Researcher')).toBeInTheDocument()
    // The answer quotes the clarification it answers.
    expect(within(msg(/Researcher to Writer: answer/)).getByRole('blockquote')).toHaveTextContent('Writer2025.')
  })

  // A team-mode helper is brought in fresh for each round; the chat reads the same.
  it('reads a clarification with a helper brought in for it the same way', () => {
    const helperOrder = [{ id: 'lead', name: 'Research lead', operator: false }, { id: 'writer', name: 'Writer', operator: false }]
    render(<AgentMessages messages={[
      message({ id: 'q1', kind: 'ask', from: 'lead', to: 'writer', text: 'Write the note.', seq: 1, state: 'answered', reply: answer('writer', '## Question back\nFor whom?', 5, { seq: 5, source: 'fresh', asksBack: true }) }),
      message({ id: 'q2', kind: 'ask', from: 'lead', to: 'writer', text: 'First-time users.', seq: 6, state: 'answered', clarifies: true, reply: answer('writer', 'The note.', 9, { seq: 9, source: 'fresh' }) }),
    ]} order={helperOrder} evidence={[]} live={false} onInspectEvidence={vi.fn()} />)
    expect(said().map((item) => item.getAttribute('aria-label')?.replace(/^[^,]+, /, ''))).toEqual([
      'Research lead to Writer: question',
      'Writer to Research lead: asks back',
      'Research lead to Writer: clarifies',
      'Writer to Research lead: answer',
    ])
  })

  it('says under work handed to a teammate, and under its answer, whether it carried on or a fresh copy took it', () => {
    const teamOrder = [{ id: 'lead', name: 'Editor', operator: false }, { id: 'writer', name: 'Writer', operator: false }]
    render(<AgentMessages messages={[
      message({ id: 'd1', kind: 'dispatch', from: 'lead', to: 'writer', text: 'Draft it.', seq: 1 }),
      message({ id: 'd2', kind: 'dispatch', from: 'lead', to: 'writer', text: 'Fix the date.', seq: 2, reached: 'continued' }),
      message({ id: 'd3', kind: 'dispatch', from: 'lead', to: 'writer', text: 'And the title.', seq: 3, reached: 'busy' }),
      message({ id: 'q1', kind: 'ask', from: 'lead', to: 'writer', text: 'Which line backs it?', seq: 4, state: 'answered', reached: 'continued', reply: answer('writer', 'Line 12.', 6, { seq: 6, source: 'open' }) }),
    ]} order={teamOrder} evidence={[]} live={false} onInspectEvidence={vi.fn()} />)
    const captions = said().map((item) => item.querySelector('.chat-under span')?.textContent ?? null)
    expect(captions).toEqual(['task', 'task · carries on', 'task · separate copy', null, 'answer · carries on'])
  })

  it('says in one line why a question was not asked, with the Team Bus’s words a hover away', () => {
    const refusal = (reason: TeamMessage['refused']) => ({ ...askBack, id: `writer:${reason}`, state: 'failed' as const, reply: null, error: 'The Team Bus’s own words.', refused: reason })
    setup([refusal('finished'), refusal('limit')])
    const lines = said()
    expect(lines.map((item) => item.textContent?.replace(/\d+:\d+.*$/, ''))).toEqual([
      'Writer asked Researcher, but Researcher had already finished its part of this run',
      'Writer had already asked Researcher as many questions as this team allows, so this one wasn’t sent',
    ])
    expect(lines[0]).toHaveClass('chat-notice')
    expect(lines[0]).toHaveAttribute('title', 'Which spec version did you read?\n\nThe Team Bus’s own words.')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
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

  // ADR 0051: "@Writer longer" gives Writer the earlier handover and your earlier review again;
  // they were not said in this piece of work, and must not read as if you just said them.
  it('says an agent picked up the earlier handover and review, instead of drawing them as new messages', () => {
    // As the record has it when the review step did not run again: handed on by the review step.
    const carriedHandover = message({ ...handover, handedBy: { from: ['review'], via: [] }, carried: true })
    const carriedReview = message({ id: 'direction:e5', kind: 'direction', from: 'operator', to: 'writer', text: 'Approved. Continue as planned.', handedBy: { from: ['review'], via: [] }, carried: true })
    setup([carriedHandover, carriedReview], { live: true, bare: true, reveal: { id: carriedHandover.id, at: 1 }, predecessors: new Map([['review', ['researcher']], ['writer', ['review']]]) })
    const line = screen.getByText('Writer picked up Researcher’s handover and your review from earlier work')
    expect(line).toBeInTheDocument()
    // Nothing is drawn as said: no bubble from you, no handover shared now.
    expect(screen.queryByRole('listitem', { name: /You to Writer/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: /Researcher to Writer/ })).not.toBeInTheDocument()
    // The timeline asked for the handover: the line opens on what was picked up.
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Your review' })).toHaveTextContent('Approved. Continue as planned.')
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByText('ACP is JSON-RPC.')).not.toBeInTheDocument()
  })

  // ADR 0040 + 0051: the request is the agent's message to you, answered where you would reply.
  it('shows a permission request as the agent’s message to you, with its answers where you reply', () => {
    const asking = message({
      id: 'permission:p1', kind: 'permission', from: 'researcher', to: 'operator', text: 'Web search', evidenceId: 'e3', seq: 3, ts: at(3), offsetMs: 3000, state: 'pending',
      permission: { requestId: 'p1', switch: 'web', detail: 'model cards 2019', outcome: null, settled: null },
    })
    const permissionTurn = vi.fn((asked: TeamMessage) => <button type="button">Allow {asked.permission?.requestId}</button>)
    setup([asking], { live: true, bare: true, permissionTurn, yourTurn: <button type="button">Approve</button> })
    const ask = msg(/Researcher to you: asks permission/)
    expect(within(ask).getByText('Asks to use the web')).toBeInTheDocument()
    expect(within(ask).getByText('Web search · model cards 2019')).toBeInTheDocument()
    // The answers are the request's own, not a review's.
    expect(screen.getByRole('button', { name: 'Allow p1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(permissionTurn).toHaveBeenCalledWith(asking)
  })

  it('remembers how a permission request was settled: by you, or by nobody answering in time', () => {
    const settled = (id: string, outcome: 'allow_once' | 'allow_run' | 'allow_team' | 'deny' | 'timed_out', seconds: number) => message({
      id: `permission:${id}`, kind: 'permission', from: 'researcher', to: 'operator', text: 'Web search', seq: seconds, ts: at(seconds), offsetMs: seconds * 1000,
      state: outcome === 'timed_out' ? 'delivered' : 'answered', reply: outcome === 'timed_out' ? null : answer('operator', '', seconds + 5),
      permission: { requestId: id, switch: 'web', detail: null, outcome, settled: { eventId: `s${seconds}`, seq: seconds + 1, ts: at(seconds + 5), offsetMs: (seconds + 5) * 1000 } },
    })
    setup([settled('a', 'allow_once', 10), settled('b', 'allow_run', 20), settled('c', 'deny', 30), settled('d', 'timed_out', 40), settled('e', 'allow_team', 50)], { live: true, bare: true, permissionTurn: () => <button type="button">Allow</button> })
    expect(screen.getByText('You allowed it, this once')).toBeInTheDocument()
    expect(screen.getByText('You allowed it for the rest of this run')).toBeInTheDocument()
    expect(screen.getByText('You denied it. Researcher carries on without it')).toBeInTheDocument()
    expect(screen.getByText('Nobody answered in time, so it was declined')).toBeInTheDocument()
    expect(screen.getByText('You allowed the whole team to do this for the rest of this run')).toBeInTheDocument()
    // Nothing settled is asked again.
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })

  it('says a permission request got no answer once the run is over', () => {
    setup([message({ id: 'permission:p9', kind: 'permission', from: 'researcher', to: 'operator', text: 'mcp__claude_ai_Notion__notion-fetch', state: 'pending', permission: { requestId: 'p9', switch: null, detail: null, outcome: null, settled: null } })], { bare: true })
    expect(screen.getByText('Asks your permission for')).toBeInTheDocument()
    expect(screen.getByText('No answer')).toBeInTheDocument()
  })

  it('shows nothing for a finished run in which nothing passed between the agents', () => {
    const { container } = render(<AgentMessages messages={[]} order={order} evidence={[]} live={false} onInspectEvidence={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    cleanup()
    setup([], { live: true })
    expect(screen.getByText(/Nothing has passed between the agents yet/)).toBeInTheDocument()
  })
})

// ADR 0062: each round of a check step is an exchange: what it sent back, the revised work as the
// reply, and the next round's verdict; a round with nothing missing is one quiet line.
describe('a check step in the chat', () => {
  const items = (verdicts: ('met' | 'not_met')[]) => verdicts.map((verdict, index) => ({ verdict, item: `Item ${index + 1}`, evidence: verdict === 'met' ? 'seen' : 'not seen' }))
  const sentBack = message({
    id: 'check:e10', kind: 'check', from: 'editor', to: 'writer', seq: 10, offsetMs: 60_000, ts: at(60), state: 'answered',
    text: 'The piece runs long.\n\n**Not met**\n- Item 2 — not seen',
    check: { round: 1, items: items(['met', 'not_met']), readable: true, sentBack: true, problems: 'The piece runs long.' },
    reply: answer('writer', 'Shorter draft.', 90, { seq: 14, source: 'open' }),
  })
  const allMetAgain = message({
    id: 'check:e20', kind: 'check', from: 'editor', to: 'writer', seq: 20, offsetMs: 120_000, ts: at(120), text: 'All 2 met.',
    check: { round: 2, items: items(['met', 'met']), readable: true, sentBack: false, problems: null },
  })

  it('shows what was sent back, the revised work as the reply, and the round that found it all met', () => {
    setup([sentBack, allMetAgain])
    const back = msg(/Editor to Writer: sent back/)
    expect(within(back).getByText('The piece runs long.')).toBeInTheDocument()
    expect(within(back).getByText(/Item 2/)).toBeInTheDocument()
    expect(within(back).getByText('sent back')).toBeInTheDocument()
    const revised = msg(/Writer to Editor: revised/)
    expect(within(revised).getByText('Shorter draft.')).toBeInTheDocument()
    fireEvent.click(within(revised).getByRole('button', { name: 'Info' }))
    expect(within(revised).getByText(/Revised 30 seconds after it was sent back/)).toBeInTheDocument()
    // Nothing missing: a line, not a message.
    expect(screen.getByText('Editor checked Writer’s revised work: all 2 met').closest('li')).toHaveClass('chat-notice')
  })

  it('says the agent is revising while it does, and that it never did once the run is over', () => {
    const pending = { ...sentBack, state: 'pending' as const, reply: null }
    setup([pending], { live: true })
    expect(screen.getByText('Writer is revising its work')).toBeInTheDocument()
    cleanup()
    setup([pending])
    expect(screen.getByText('Not revised')).toBeInTheDocument()
  })
})


// ADR 0051: anything an agent said can be replied to from the team's chat — a handover, a question
// or a question back, an answer — and a clarification is drawn as the reply it is.
describe('Replying to what the agents said', () => {
  it('offers Reply under each agent’s message, saying what it replies to, and none under yours', () => {
    const onReply = vi.fn()
    const question = message({ id: 'question:e40', kind: 'question', from: 'editor', to: 'operator', text: 'Which market?', seq: 40, state: 'answered', reply: answer('operator', 'Asia.', 45, { seq: 45 }) })
    setup([handover, askBack, question], { bare: true, onReply })
    const replies = screen.getAllByRole('button', { name: /^Reply to/ })
    expect(replies.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Reply to Researcher: handover',
      'Reply to Writer: question',
      'Reply to Researcher: answer',
      'Reply to Editor: question',
    ])
    fireEvent.click(replies[0])
    expect(onReply).toHaveBeenLastCalledWith({ messageId: 'handover:e5:said', from: 'researcher', to: 'writer', kind: 'handover', text: 'ACP is JSON-RPC.' })
    fireEvent.click(replies[2])
    expect(onReply).toHaveBeenLastCalledWith({ messageId: 'writer:q1:reply', from: 'researcher', to: 'writer', kind: 'answer', text: '**Version 0.4**, the one on the site.' })
    // A question to you is addressed to nobody else.
    fireEvent.click(replies[3])
    expect(onReply).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'editor', to: null, kind: 'question' }))
    // Your answer is yours: nothing to reply to.
    expect(within(msg(/You to Editor/)).queryByRole('button', { name: /^Reply/ })).toBeNull()
  })

  it('names a question back as one, and quotes it above the clarification that answers it', () => {
    const onReply = vi.fn()
    const round = (id: string, seq: number, text: string, reply: MessageReply, clarifies = false) => message({ id, kind: 'ask', from: 'writer', to: 'researcher', text, seq, offsetMs: seq * 1000, ts: at(seq), state: 'answered', reply, ...(clarifies ? { clarifies: true as const } : {}) })
    setup([
      round('q1', 50, 'How many did it sell?', answer('researcher', 'It depends.\n\n## Question back\nWhich year?', 55, { seq: 55, asksBack: true })),
      round('q2', 60, '2025.', answer('researcher', '42 in 2025.', 65, { seq: 65 }), true),
    ], { bare: true, onReply })
    expect(within(msg(/clarifies/)).getByRole('blockquote')).toHaveTextContent('ResearcherWhich year?')
    fireEvent.click(within(msg(/asks back/)).getByRole('button', { name: /^Reply/ }))
    expect(onReply).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'q1:reply', kind: 'question_back', from: 'researcher', to: 'writer' }))
    fireEvent.click(within(msg(/clarifies/)).getByRole('button', { name: /^Reply/ }))
    expect(onReply).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'q2:said', kind: 'answer', from: 'writer', to: 'researcher' }))
  })

  it('shows the very bubble a reply’s quote points at', () => {
    setup([askBack], { bare: true, onReply: vi.fn(), reveal: { id: 'writer:q1:reply', at: 1 } })
    expect(msg(/Researcher to Writer: answer/)).toHaveClass('flash')
    expect(msg(/Writer to Researcher: question/)).not.toHaveClass('flash')
  })

  it('offers no Reply outside the team’s chat', () => {
    setup([handover, askBack])
    expect(screen.queryByRole('button', { name: /^Reply/ })).toBeNull()
  })
})
