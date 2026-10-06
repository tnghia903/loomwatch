import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem, ChatMessage } from '../../lib/chat/client'
import type { RunRecord } from '../../lib/runs/client'
import type { TeamMessage } from '../../lib/watch/messages'
import { ChatComposer } from './ChatComposer'
import { TeamChat } from './TeamChat'
import type { TeamView } from './WorkPiece'

// The pieces read their own record and events only while live or shown; a still session here,
// saying what the agents said when a test gives it messages.
const said = vi.hoisted(() => ({ messages: [] as TeamMessage[], read: false }))
vi.mock('../../lib/runs/useRunSession', () => ({
  useRunSession: (runId: string | null) => ({
    record: null, applyRecord: vi.fn(), missing: false, events: runId && (said.read || said.messages.length > 0) ? [{ id: 'e0' }] : [], error: null, connected: false,
    projection: { agents: [], evidence: [], messages: runId ? said.messages : [], delegations: [], attention: [], coverage: {}, prompt: null, promptAgentId: null, phase: said.read ? 'succeeded' : 'queued' },
    latest: null, cursor: null, setCursor: vi.fn(), lastSeq: -1, mode: 'replay', terminal: true, evidenceComplete: true,
  }),
}))
vi.mock('../../lib/notion/useNotionSend', () => ({ useNotionSend: () => ({ hidden: true }) }))
vi.mock('../run/NotionSend', () => ({ NotionOutcome: () => null, NotionOffer: () => null }))

const agents = [
  { id: 'researcher', name: 'Researcher' },
  { id: 'review', name: 'Your review', operator: true },
  { id: 'writer', name: 'Writer' },
]
const team: TeamView = {
  names: new Map([['researcher', 'Researcher'], ['review', 'You'], ['writer', 'Writer']]),
  hues: new Map([['researcher', 1], ['review', 0], ['writer', 2]]),
  parties: agents.map((agent) => ({ id: agent.id, name: agent.name, operator: Boolean(agent.operator) })),
  predecessors: new Map([['review', ['researcher']], ['writer', ['review']]]),
  order: ['researcher', 'review', 'writer'],
  operators: new Set(['review']),
}

const run = (overrides: Partial<RunRecord>): RunRecord => ({
  runId: 'run-1', sessionId: 'run-1', teamPath: 'news.yaml', prompt: 'today’s digest', status: 'succeeded', mode: 'pipeline',
  entrypoint: 'researcher', responder: 'writer', agentIds: ['researcher', 'review', 'writer'], createdAt: '2026-10-06T02:00:00.000Z',
  startedAt: '2026-10-06T02:00:00.000Z', finishedAt: '2026-10-06T02:04:00.000Z', error: null, exitCode: 0, eventCount: 10,
  reply: '# Digest\nThe chip story.', trigger: 'manual', ...overrides,
})
const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm-1', teamKey: 'news', teamPath: 'news.yaml', text: '@team today’s digest', createdAt: '2026-10-06T02:00:00.000Z', route: 'team',
  runId: 'run-1', agentId: null, deliveredAt: null, now: false, ...overrides,
})

let page: ChatItem[] = []
let posted: { url: string; body: unknown }[] = []
let answer: (url: string, body: unknown) => Response | Promise<Response> = () => new Response('{}', { status: 500 })

beforeEach(() => {
  page = []
  posted = []
  said.messages = []
  said.read = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/chat?')) return new Response(JSON.stringify({ teamKey: 'news', teamPath: 'news.yaml', items: [...page].reverse(), more: false }), { status: 200 })
    if (init?.method === 'POST') {
      const body: unknown = JSON.parse(String(init.body ?? '{}'))
      posted.push({ url, body })
      return answer(url, body)
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderChat(overrides: Partial<Parameters<typeof TeamChat>[0]> = {}) {
  const props = {
    teamPath: 'news.yaml', teamName: 'News desk', agents, team, steps: 3, suggestion: 'today’s AI news digest', detailsRunId: null, blocked: null,
    prepare: vi.fn(async () => ({ ok: true as const, revision: 'sha256:1' })), onDetails: vi.fn(), onTeamReview: vi.fn(), onStale: vi.fn(), announce: vi.fn(), onOpenFinding: vi.fn(), onOpenAnswer: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<TeamChat {...props} />) }
}

const box = () => screen.getByRole('textbox', { name: 'Message the team' })

describe('the message box says where a message goes before it is sent', () => {
  const composer = (live: RunRecord[] = [], decision = null as Parameters<typeof ChatComposer>[0]['decision']) => {
    const onSend = vi.fn(async () => true)
    const onAnswer = vi.fn(async () => true)
    function Harness() {
      const [value, setValue] = useState('')
      return <ChatComposer agents={agents} names={team.names} steps={3} live={live} decision={decision} value={value} onChange={setValue} onSend={onSend} onAnswer={onAnswer} />
    }
    render(<Harness />)
    const type = (text: string) => fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
    return { onSend, onAnswer, type }
  }

  it('names every branch of the rule: team, one agent, a note, a team note', () => {
    const working = [run({ runId: 'live', status: 'running', working: ['writer'], reply: null, finishedAt: null })]
    const idle = composer()
    idle.type('@team now do Asia')
    expect(screen.getByText('Starts the team · 3 steps')).toBeInTheDocument()
    idle.type('@Writer make the chip story the lead')
    expect(screen.getByText('Starts Writer only')).toBeInTheDocument()
    idle.type('we only cover listed companies')
    expect(screen.getByText('Team note · starts nothing')).toBeInTheDocument()
    expect(screen.getByText('Add @team or @Researcher to start work.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send note' })).toBeEnabled()
    cleanup()

    const busy = composer(working)
    busy.type('and keep it under 300 words')
    expect(screen.getByText('Note for Writer · after its current step')).toBeInTheDocument()
    // Send now is offered only where there is a turn to stop.
    expect(screen.getByRole('button', { name: /Send now/ })).toBeEnabled()
    busy.type('@team start over')
    expect(screen.queryByRole('button', { name: /Send now/ })).not.toBeInTheDocument()
  })

  it('↵ sends, ⇧↵ does not, and the @ picker is driven by the keyboard', () => {
    const { onSend, type } = composer()
    type('@wr')
    const input = box()
    expect(screen.getByRole('listbox', { name: 'Who to write to' })).toBeInTheDocument()
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringMatching(/^@Writer/)])
    fireEvent.keyDown(input, { key: 'Escape' })
    type('@team digest')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('@team digest', { kind: 'team' }, false)
  })

  it('a review is decided with its buttons: ↵ never approves, and Esc writes to the team instead', () => {
    const { onSend, onAnswer, type } = composer([], { runId: 'r', node: 'review', kind: 'review_stop', from: 'researcher', fromName: 'Researcher' })
    type('looks good but add a source')
    expect(screen.getByText(/A note to go with your review of Researcher's work/)).toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(onAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Write to the team instead/ }))
    expect(screen.getByText('Team note · starts nothing')).toBeInTheDocument()
  })
})

describe('the team’s chat', () => {
  it('reads oldest first, by day, with each answer in full and the talk folded to one line', async () => {
    page = [
      { kind: 'work', run: run({ runId: 'old', createdAt: '2026-10-05T02:00:00.000Z', startedAt: '2026-10-05T02:00:00.000Z', finishedAt: '2026-10-05T02:03:00.000Z', reply: 'Yesterday’s digest.', trigger: 'schedule' }), request: null, notes: [] },
      { kind: 'note', message: message({ id: 'note-1', text: 'we only cover listed companies', route: 'team_note', runId: null, createdAt: '2026-10-05T05:00:00.000Z' }) },
      { kind: 'work', run: run({}), request: message({}), notes: [message({ id: 'n-2', route: 'note', agentId: 'writer', text: 'keep it short', deliveredAt: '2026-10-06T02:03:00.000Z', createdAt: '2026-10-06T02:02:00.000Z' })] },
    ]
    renderChat()
    const log = await screen.findByRole('log', { name: 'Messages' })
    await waitFor(() => expect(within(log).getByText('The chip story.')).toBeInTheDocument())
    const text = log.textContent ?? ''
    expect(text.indexOf('Yesterday’s digest.')).toBeLessThan(text.indexOf('we only cover listed companies'))
    expect(text.indexOf('we only cover listed companies')).toBeLessThan(text.indexOf('The chip story.'))
    expect(within(log).getByText('The schedule')).toBeInTheDocument()
    expect(within(log).getByText('Writer took it in its next turn')).toBeInTheDocument()
    expect(within(log).getAllByText(/Researcher and Writer worked on this · \d+ min/)).toHaveLength(2)
    // The newest piece shows what they said; the one before folds it to one line.
    expect(within(log).getAllByRole('button', { name: 'What they said' })).toHaveLength(1)
    expect(within(log).getByRole('button', { name: 'Hide what they said' })).toHaveAttribute('aria-expanded', 'true')
    // The chat speaks the team's words: no "run", "session" or "stage" (those live in Details).
    expect(screen.getByRole('region', { name: 'News desk chat' }).textContent).not.toMatch(/\b(run|runs|session|stage|stages)\b/i)
  })

  // ADR 0051: the answer lives in the chat only, so what its record says about it sits under it.
  it('puts the answer’s status and what you do with it under the answer', async () => {
    said.read = true
    page = [{ kind: 'work', run: run({ reply: 'Done — I tightened the lead.' }), request: message({}), notes: [] }]
    renderChat()
    const log = await screen.findByRole('log', { name: 'Messages' })
    expect(await within(log).findByRole('button', { name: 'Nothing flagged' })).toBeInTheDocument()
    expect(within(log).getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    // Saving and sending wait behind Share, so the row stays short.
    expect(within(log).queryByRole('button', { name: /Download/ })).toBeNull()
    fireEvent.click(within(log).getByRole('button', { name: 'Share' }))
    expect(within(screen.getByRole('group', { name: 'Share this answer' })).getByRole('button', { name: 'Download as Markdown' })).toBeInTheDocument()
  })

  // Older work is quiet: only the newest piece is marked to keep its actions in view.
  it('marks the newest piece, which keeps what you can do with it in view', async () => {
    page = [
      { kind: 'work', run: run({ runId: 'older', createdAt: '2026-10-06T01:00:00.000Z' }), request: message({ id: 'm-older' }), notes: [] },
      { kind: 'work', run: run({ runId: 'newer' }), request: message({ id: 'm-newer' }), notes: [] },
    ]
    const { container } = renderChat()
    await screen.findAllByText('The chip story.')
    expect(container.querySelector('[data-run="older"]')).not.toHaveClass('newest')
    expect(container.querySelector('[data-run="newer"]')).toHaveClass('newest')
  })

  // A long answer is a document: not a wall of text in a chat bubble, but a card read beside it.
  it('shows a short answer as a message, and a long one as a document card that opens beside the chat', async () => {
    const report = `# Today’s AI digest\n\n**Lead:** chipmakers rally on the export rule.\n\n## Chips\n${'Shares rose after the new rule. '.repeat(20)}\n\n## Models\nAn open model for code.`
    page = [
      { kind: 'work', run: run({ runId: 'short', reply: 'Done — I tightened the lead.' }), request: message({ id: 'm-short' }), notes: [] },
      { kind: 'work', run: run({ runId: 'long', reply: report }), request: message({ id: 'm-long' }), notes: [] },
    ]
    const { props } = renderChat({ answerRunId: null })
    const log = await screen.findByRole('log', { name: 'Messages' })
    expect(await within(log).findByText('Done — I tightened the lead.')).toBeInTheDocument()
    const card = within(log).getByRole('button', { name: /^Today’s AI digest, \d+ words · 2 sections\. Open$/ })
    expect(card).toHaveTextContent('Lead: chipmakers rally on the export rule.')
    // The report itself is not in the chat: its sections are read in the pane.
    expect(within(log).queryByRole('heading', { name: 'Chips' })).toBeNull()
    fireEvent.click(card)
    expect(props.onOpenAnswer).toHaveBeenCalledWith('long')
  })

  it('marks the document card that is open beside the chat', async () => {
    page = [{ kind: 'work', run: run({ runId: 'long', reply: `# Report\n\n${'Words. '.repeat(120)}` }), request: message({}), notes: [] }]
    renderChat({ detailsRunId: 'long', answerRunId: 'long' })
    const card = await screen.findByRole('button', { name: /^Report, .* Showing beside the chat$/ })
    expect(card).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows your message at once, then what it started', async () => {
    let release: (response: Response) => void = () => {}
    answer = () => new Promise((resolve) => { release = resolve })
    renderChat()
    await screen.findByRole('heading', { name: 'Talk to News desk' })
    fireEvent.change(box(), { target: { value: '@team today’s digest' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Sending…')).toBeInTheDocument()
    expect(within(screen.getByRole('log')).getByText('@team today’s digest')).toBeInTheDocument()
    expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { teamPath: 'news.yaml', to: { kind: 'team' }, expectedRevision: 'sha256:1' } })
    await act(async () => {
      release(new Response(JSON.stringify({ route: 'team', message: message({}), run: run({ status: 'running', reply: null, finishedAt: null, working: ['researcher'] }) }), { status: 202 }))
    })
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument()
    const working = await within(screen.getByRole('log')).findByText(/is working/)
    expect(working).toHaveTextContent('Researcher is working')
    // The member list says so too, beside the name.
    expect(screen.getByTitle('Researcher · working')).toBeInTheDocument()
    expect(box()).toHaveValue('')
  })

  it('keeps a message the daemon refused, with Try again and Edit', async () => {
    answer = () => new Response(JSON.stringify({ error: 'Writer is not an agent of this team.' }), { status: 400 })
    renderChat()
    await screen.findByRole('heading', { name: 'Talk to News desk' })
    fireEvent.change(box(), { target: { value: 'a note for later' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Not sent')).toBeInTheDocument()
    expect(screen.getByText('Writer is not an agent of this team.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(box()).toHaveValue('a note for later')
  })

  it('never lets a note dead-end: a team note can start the team', async () => {
    page = [{ kind: 'note', message: message({ id: 'note-1', text: 'today’s digest please', route: 'team_note', runId: null }) }]
    answer = () => new Response(JSON.stringify({ route: 'team', message: message({ id: 'note-1', text: 'today’s digest please' }), run: run({ status: 'queued', reply: null, finishedAt: null }) }), { status: 202 })
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: 'Start the team on this' }))
    await waitFor(() => expect(posted[0]?.url).toBe('/api/chat/messages/note-1/start'))
    expect(await screen.findByText(/Starting…/)).toBeInTheDocument()
  })

  it('an empty chat suggests an @team first message, and starts nothing until you send it', async () => {
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: '@team today’s AI news digest' }))
    expect(box()).toHaveValue('@team today’s AI news digest')
    expect(posted).toHaveLength(0)
  })

  it('hands a team that needs checking to the review, holding the message', async () => {
    answer = () => new Response(JSON.stringify({ error: 'review it', code: 'team_needs_review', teamPath: 'news.yaml', teamName: 'News desk', teamRevision: 'sha256:2', review: [] }), { status: 409 })
    const { props } = renderChat()
    await screen.findByRole('heading', { name: 'Talk to News desk' })
    fireEvent.change(box(), { target: { value: '@team today’s digest' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(props.onTeamReview).toHaveBeenCalled())
    expect(box()).toHaveValue('@team today’s digest')
    expect(screen.queryByText('Not sent')).not.toBeInTheDocument()
  })
})

describe('a chat that is alive', () => {
  it('draws history still, and moves only what arrives while you watch', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify({ route: 'team_note', message: message({ id: 'n-9', text: 'a note', route: 'team_note', runId: null }) }), { status: 200 })
    const { props } = renderChat({ onNewest: vi.fn(), onStarted: vi.fn() })
    const piece = await screen.findByText('The chip story.')
    expect(piece.closest('.tc-piece')).not.toHaveClass('tc-appear-soft')
    expect(piece.closest('.tc-answer')).not.toHaveClass('tc-appear')
    await waitFor(() => expect(props.onNewest).toHaveBeenCalledWith('run-1'))
    // Let the first page paint; what comes after is news.
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })
    fireEvent.change(box(), { target: { value: 'a note' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    const note = await within(screen.getByRole('log')).findByText('a note')
    expect(note.closest('.chat-msg')).toHaveClass('tc-appear')
    expect(props.onStarted).not.toHaveBeenCalled()
  })

  it('says when you started work, so Details can follow it', async () => {
    answer = () => new Response(JSON.stringify({ route: 'team', message: message({ id: 'm-2' }), run: run({ runId: 'run-2', status: 'queued', reply: null }) }), { status: 202 })
    const { props } = renderChat({ onStarted: vi.fn() })
    await screen.findByRole('heading', { name: 'Talk to News desk' })
    fireEvent.change(box(), { target: { value: '@team today’s digest' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(props.onStarted).toHaveBeenCalledWith('run-2'))
  })
})

describe('a piece of work', () => {
  it('asks for your review with buttons: Approve needs no words, Send back needs them', async () => {
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, waitingOn: { node: 'review', name: 'Your review', kind: 'review_stop', since: '2026-10-06T02:01:00.000Z', question: 'Check it', context: '## Summary\nThree stories', handoverFrom: 'researcher', park: 'kept_alive', parkNote: '', sendBackAvailable: true } }), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify(run({ status: 'running' })), { status: 200 })
    renderChat()
    expect(await screen.findByText(/handed over its work for your review/)).toBeInTheDocument()
    expect(screen.getByText('Three stories')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send back to Researcher' })).toBeDisabled()
    expect(screen.getByText('To send it back, write what to change in the box below.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/runs/run-1/answers', body: { node: 'review', text: 'Approved. Continue as planned.' } }))
  })

  it('puts the review on the handover it decides, in what the agents said', async () => {
    said.messages = [{
      id: 'h-1', kind: 'handover', from: null, handedBy: { from: ['researcher'], via: [] }, to: 'review', text: 'Three stories, sourced.', context: null,
      eventId: 'e0', evidenceId: null, seq: 0, ts: '2026-10-06T02:01:00.000Z', offsetMs: 60_000, state: 'pending', error: null, reply: null, carried: false,
    }]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, waitingOn: { node: 'review', name: 'Your review', kind: 'review_stop', since: '2026-10-06T02:01:00.000Z', question: 'Check it', context: 'Three stories, sourced.', handoverFrom: 'researcher', park: 'kept_alive', parkNote: '', sendBackAvailable: true } }), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify(run({ status: 'running' })), { status: 200 })
    renderChat()
    const talk = await screen.findByRole('region', { name: 'What the agents said' })
    const review = within(talk).getByRole('group', { name: "Review Researcher's work" })
    // One place to decide: the buttons stand where you would answer, not in a card of their own.
    expect(screen.queryByText(/handed over its work for your review/)).not.toBeInTheDocument()
    expect(within(talk).getByText('Three stories, sourced.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1)
    fireEvent.click(within(review).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/runs/run-1/answers', body: { node: 'review', text: 'Approved. Continue as planned.' } }))
  })

  it('offers Continue with the team under one agent’s new version, counting as the review it passes', async () => {
    page = [{ kind: 'work', run: run({ runId: 'turn', onlyAgent: 'researcher', responder: 'researcher', reply: 'Three stories, one more source.' }), request: message({ route: 'agent', agentId: 'researcher', text: '@Researcher add a source', runId: 'turn' }), notes: [] }]
    answer = () => new Response(JSON.stringify({ route: 'team', run: run({ runId: 'next', status: 'queued', startAt: 'writer', followsRunId: 'turn', reply: null }) }), { status: 202 })
    renderChat()
    expect(await screen.findByText('You → Researcher')).toBeInTheDocument()
    expect(screen.getByText('Counts as your review, then Writer picks up from this version.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Continue with the team/ }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/continue', body: { runId: 'turn', expectedRevision: 'sha256:1' } }))
  })

  it('says plainly when work stopped, and offers Try again on the same route', async () => {
    page = [{ kind: 'work', run: run({ status: 'failed', reply: null, error: 'timed out after 600s waiting for ACP response to session/prompt' }), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify({ route: 'team', message: message({ id: 'm-2' }), run: run({ runId: 'run-2', status: 'queued', reply: null }) }), { status: 202 })
    renderChat()
    expect(await screen.findByText('The work stopped.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { text: '@team today’s digest', to: { kind: 'team' } } }))
  })
})
