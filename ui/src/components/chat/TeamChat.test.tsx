import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PASS_BEAT_MS } from '../../lib/chat/baton'
import type { ChatItem, ChatMessage } from '../../lib/chat/client'
import type { Lesson } from '../../lib/lessons/client'
import type { RunRecord } from '../../lib/runs/client'
import { FileReaderContext } from '../../lib/files/reader'
import type { TeamMessage } from '../../lib/watch/messages'
import { cascaded, goldFilled, heightOf, isGoldFill, PHONE } from '../../test/cascade'
import { ChatComposer } from './ChatComposer'
import { TeamChat } from './TeamChat'
import type { TeamView } from './WorkPiece'

// The pieces read their own record and events only while live or shown; a still session here,
// saying what the agents said when a test gives it messages.
const said = vi.hoisted(() => ({ messages: [] as TeamMessage[], read: false, agents: [] as unknown[], events: [] as unknown[] }))
vi.mock('../../lib/runs/useRunSession', () => ({
  useRunSession: (runId: string | null) => ({
    record: null, applyRecord: vi.fn(), missing: false, events: runId && said.events.length > 0 ? said.events : runId && (said.read || said.messages.length > 0) ? [{ id: 'e0' }] : [], error: null, connected: false,
    projection: { agents: runId ? said.agents : [], evidence: [], messages: runId ? said.messages : [], delegations: [], attention: [], coverage: {}, prompt: null, promptAgentId: null, phase: said.read ? 'succeeded' : 'queued' },
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
  said.agents = []
  said.events = []
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
    // Who worked on each finished piece, and how long it took: their faces on its request, not a line.
    expect(within(log).getAllByRole('button', { name: /^Researcher and Writer worked on this · \d+ min$/ })).toHaveLength(2)
    expect(within(log).queryByText(/worked on this/)).not.toBeInTheDocument()
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
    expect(memberRow('Researcher')).toHaveTextContent('Researcherworking')
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

  it('a hello the team answered: each agent answers for itself, no work starts, and the team can still be started', async () => {
    const hello = message({
      id: 'hi-1', text: 'hi @team', route: 'team_note', runId: null,
      answers: {
        waiting: [],
        said: [
          { from: 'researcher', text: 'Hi! I find today’s news. What should we cover?', at: '2026-10-06T02:00:03.000Z' },
          { from: 'writer', text: 'Hello! I turn it into the digest.', at: '2026-10-06T02:00:04.000Z' },
        ],
      },
    })
    answer = (url) => url.endsWith('/start')
      ? new Response(JSON.stringify({ route: 'team', message: { ...hello, route: 'team', runId: 'run-2' }, run: run({ runId: 'run-2', status: 'queued', reply: null, finishedAt: null }) }), { status: 202 })
      : new Response(JSON.stringify({ route: 'team_note', message: hello }), { status: 200 })
    const { props } = renderChat()
    await screen.findByRole('heading', { name: 'Talk to News desk' })
    fireEvent.change(box(), { target: { value: 'hi @team' } })
    // Enter would pick from the @ list the message ends on; the button sends.
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    const researcher = (await screen.findByText('Hi! I find today’s news. What should we cover?')).closest('li')!
    expect(within(researcher).getByText('Researcher')).toBeInTheDocument()
    const writer = screen.getByText('Hello! I turn it into the digest.').closest('li')!
    expect(within(writer).getByText('Writer')).toBeInTheDocument()
    expect(screen.getByText('You → the team')).toBeInTheDocument()
    expect(screen.getByText('No work started')).toBeInTheDocument()
    expect(screen.queryByText(/team note/)).not.toBeInTheDocument()
    // The answers say what happened; no notice about the route on top of them.
    expect(props.announce).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start the team on this' }))
    await waitFor(() => expect(posted.at(-1)?.url).toBe('/api/chat/messages/hi-1/start'))
  })

  it('an agent still answering is shown writing, and the chat keeps reading until it is done', async () => {
    page = [{
      kind: 'note',
      message: message({
        id: 'hi-3', text: 'hi @team', route: 'team_note', runId: null, createdAt: new Date().toISOString(),
        answers: { waiting: ['writer'], said: [{ from: 'researcher', text: 'Hi there!', at: new Date().toISOString() }] },
      }),
    }]
    renderChat()
    expect(await screen.findByText('Hi there!')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Writer is writing' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start the team on this' })).not.toBeInTheDocument()
  })

  it('an answer that stopped long ago is not shown as still writing', async () => {
    page = [{
      kind: 'note',
      message: message({ id: 'hi-4', text: 'hi @team', route: 'team_note', runId: null, answers: { waiting: ['writer'], said: [] } }),
    }]
    renderChat()
    expect(await screen.findByText('No work started')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Writer is writing' })).not.toBeInTheDocument()
  })

  it('a hello one agent answered offers to start that agent', async () => {
    page = [{
      kind: 'note',
      message: message({ id: 'hi-2', text: '@Writer thanks!', route: 'team_note', runId: null, agentId: 'writer', answers: { waiting: [], said: [{ from: 'writer', text: 'Any time!', at: '2026-10-06T02:00:02.000Z' }] } }),
    }]
    renderChat()
    expect(await screen.findByText('You → Writer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start Writer on this' })).toBeInTheDocument()
  })

  it('an empty chat suggests an @team first message, and starts nothing until you send it', async () => {
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: '@team today’s AI news digest' }))
    expect(box()).toHaveValue('@team today’s AI news digest')
    expect(posted).toHaveLength(0)
  })

  it('Run team starts the box with @team, so what you write starts the team rather than leaving a note', async () => {
    const onStartTeamTaken = vi.fn()
    renderChat({ startTeam: true, onStartTeamTaken })
    await waitFor(() => expect(box()).toHaveValue('@team '))
    expect(onStartTeamTaken).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Starts the team · 3 steps')).toBeInTheDocument()
    expect(posted).toHaveLength(0)
  })

  it('Run team leaves a box that cannot send yet empty', async () => {
    const onStartTeamTaken = vi.fn()
    renderChat({ startTeam: true, onStartTeamTaken, blocked: 'Researcher’s app isn’t installed.' })
    await waitFor(() => expect(onStartTeamTaken).toHaveBeenCalled())
    expect(box()).toHaveValue('')
  })

  it('opening the chat any other way starts with an empty box', async () => {
    renderChat()
    await screen.findByRole('heading', { name: 'Talk to News desk' })
    expect(box()).toHaveValue('')
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

/** One agent's row in the team list: its face, its name and what it is doing. */
function memberRow(name: string, list: HTMLElement = screen.getByRole('list', { name: 'Who is on the team' })): HTMLElement {
  const row = within(list).getByRole('button', { name: `${name}: mention in your message` }).closest('li')
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

describe('who is on the team', () => {
  afterEach(() => { window.localStorage.clear() })

  it('folds to one line of faces and what they are doing, and stays folded in this browser', async () => {
    const first = renderChat()
    const toggle = screen.getByRole('button', { name: 'News desk' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: 'Who is on the team' })).toBeVisible()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Who is on the team' })).toBeNull()
    expect(screen.getByRole('button', { name: '2 ready. Show who is on the team' })).toBeInTheDocument()
    first.unmount()
    renderChat()
    expect(screen.getByRole('button', { name: 'News desk' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: '2 ready. Show who is on the team' }))
    expect(screen.getByRole('list', { name: 'Who is on the team' })).toBeVisible()
  })

  it('says the agent its newest piece of work stopped at has failed, until it works again', async () => {
    const stopped = run({ status: 'failed', reply: null, error: 'pipeline node researcher failed: Codex reported an error instead of an answer: Quota exceeded.' })
    page = [{ kind: 'work', run: stopped, request: message({}), notes: [] }]
    const first = renderChat()
    const list = await screen.findByRole('list', { name: 'Who is on the team' })
    await waitFor(() => expect(memberRow('Researcher', list)).toHaveTextContent('Researcherfailed'))
    expect(memberRow('Researcher', list)).toHaveClass('failed')
    expect(memberRow('Writer', list)).toHaveTextContent('Writerready')
    first.unmount()
    // A newer piece the researcher is at clears it.
    page = [...page, { kind: 'work', run: run({ runId: 'run-2', createdAt: '2026-10-06T03:00:00.000Z', status: 'running', reply: null, finishedAt: null, working: ['researcher'] }), request: message({ id: 'm-2' }), notes: [] }]
    renderChat()
    const again = await screen.findByRole('list', { name: 'Who is on the team' })
    await waitFor(() => expect(memberRow('Researcher', again)).toHaveTextContent('Researcherworking'))
  })

  it('says an agent that asked your permission is waiting for you, not working', async () => {
    const asked = { id: 'p1', agent: 'researcher', name: 'Researcher', title: 'mcp__claude_ai_Notion__notion-fetch', kind: 'other', switch: null, since: '2026-10-06T02:01:00.000Z', expiresAt: new Date(Date.now() + 9 * 60000).toISOString() }
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, working: ['researcher'], permissionRequests: [asked] }), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify(run({ status: 'running' })), { status: 200 })
    renderChat()
    const list = await screen.findByRole('list', { name: 'Who is on the team' })
    await waitFor(() => expect(memberRow('Researcher', list)).toHaveTextContent('Researcherwaiting for you'))
    expect(screen.getByText(/Researcher asks your permission/)).toBeInTheDocument()
    // A team of more than one agent can be let through at once, for that one tool.
    fireEvent.click(screen.getByRole('button', { name: 'Allow for the whole team' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/runs/run-1/permissions', body: { requestId: 'p1', decision: 'allow_team' } }))
  })

  // Answered on its message, a request is over at once; the run's record, polled each second, still
  // lists it for a moment. That moment used to pop up a second card asking the same thing again,
  // saying the agent was paused while it was already back at work.
  it('asks nothing again once a request is answered on its message, while the record catches up', async () => {
    const asked = { id: 'p1', agent: 'researcher', name: 'Researcher', title: 'Run: ls -la', kind: 'execute', switch: 'commands' as const, since: '2026-10-06T02:01:00.000Z', expiresAt: new Date(Date.now() + 9 * 60000).toISOString() }
    said.messages = [{
      id: 'permission:p1', kind: 'permission', from: 'researcher', to: 'operator', handedBy: null, text: 'Run: ls -la', context: null, eventId: 'e1', evidenceId: null,
      seq: 3, ts: new Date().toISOString(), offsetMs: 0, state: 'answered', error: null, carried: false,
      reply: { from: 'operator', text: 'ls', seq: 4, ts: new Date().toISOString(), offsetMs: 0, eventId: 'e2', source: null, sentBackTo: null },
      permission: { requestId: 'p1', switch: 'commands', detail: 'ls -la', outcome: 'edited', written: 'ls', settled: { eventId: 'e2', seq: 4, ts: new Date().toISOString(), offsetMs: 0 } },
    }]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, working: ['researcher'], permissionRequests: [asked] }), request: message({}), notes: [] }]
    renderChat()
    await screen.findByText(/You changed it, then allowed it/)
    expect(screen.queryByRole('region', { name: 'Waiting for your permission' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })
})

describe('who has the work', () => {
  afterEach(() => { window.localStorage.clear() })

  const talk = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
    from: null, handedBy: null, to: null, text: 'x', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: new Date().toISOString(),
    offsetMs: 0, state: 'delivered', error: null, reply: null, carried: false, ...extra,
  })
  const working = (overrides: Partial<RunRecord> = {}): ChatItem[] => [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, working: ['writer'], ...overrides }), request: message({}), notes: [] }]
  const pill = () => document.querySelector('.tc-baton.on')
  const fold = () => window.localStorage.setItem('loomwatch.chatRoster', 'folded')

  it('grows the face of the agent asked into a pill, for as long as the ask is open', async () => {
    fold()
    // The bus resolves the name only once the ask settles; while it is open the pill does.
    said.messages = [talk({ id: 'a1', kind: 'ask', from: 'writer', to: 'researcher', state: 'pending', seq: 3, ts: '2026-10-06T02:01:00.000Z' })]
    said.messages[0].to = 'Researcher'
    page = working()
    renderChat()
    await waitFor(() => expect(pill()).toHaveTextContent('Asking Researcher…'))
    const face = screen.getByRole('button', { name: 'Researcher: mention in your message' })
    expect(face).toContainElement(pill() as HTMLElement)
    expect(face).toHaveAccessibleDescription('Writer is asking Researcher')
    // The pill says what the count would, so the count gives way while someone has the work.
    expect(screen.queryByRole('button', { name: /Show who is on the team/ })).toBeNull()
    // Open, the list says it beside the agent's name.
    fireEvent.click(screen.getByRole('button', { name: 'News desk' }))
    expect(memberRow('Researcher')).toHaveTextContent('asked by Writer')
  })

  it('names a pass for a moment, then says who is working', async () => {
    fold()
    said.messages = [talk({ id: 'h1', kind: 'handover', to: 'writer', handedBy: { from: ['researcher'], via: ['review'] }, ts: new Date(Date.now() - PASS_BEAT_MS + 900).toISOString() })]
    page = working()
    renderChat()
    await waitFor(() => expect(pill()).toHaveTextContent('Passing to Writer…'))
    expect(screen.getByRole('button', { name: 'Writer: mention in your message' })).toHaveAccessibleDescription('Researcher passed the work to Writer')
    await waitFor(() => expect(pill()).toHaveTextContent('working…'), { timeout: 2500 })
    expect(pill()).not.toHaveTextContent('Passing')
  })

  it('puts whoever waits on you first, in gold and without the typing dots', async () => {
    fold()
    said.messages = [talk({ id: 'a1', kind: 'ask', from: 'writer', to: 'researcher', state: 'pending' })]
    page = working({ waitingOn: { node: 'writer', name: 'Writer', kind: 'question', since: '2026-10-06T02:01:00.000Z', question: 'Which market?', context: null, handoverFrom: null, park: 'reloadable', parkNote: '', sendBackAvailable: false } })
    renderChat()
    await waitFor(() => expect(pill()).toHaveTextContent('needs you'))
    expect(pill()).toHaveClass('waiting')
    expect(pill()?.querySelector('.chat-dots')).toBeNull()
  })

  it('names each agent at work in its own colour, as its messages do, with green dots for the work', async () => {
    fold()
    page = working({ working: ['researcher', 'writer'] })
    renderChat()
    const line = await within(screen.getByRole('log')).findByText(/are working/)
    expect(line).toHaveTextContent('Researcher and Writer are working')
    expect([...line.querySelectorAll('b')].map((name) => [name.textContent, name.className])).toEqual([['Researcher', 'chat-name hue-1'], ['Writer', 'chat-name hue-2']])
    expect(line.querySelector('.chat-dots')).not.toBeNull()
    // Two agents are a thread, not one knot in the gutter.
    expect(document.querySelector('.tc-weft')).not.toHaveClass('one')
  })

  it('flashes nothing between two agents, and brings the count back once the work is done', async () => {
    fold()
    page = working({ working: [] })
    const between = renderChat()
    await screen.findByText(/Starting…|Handing over…/)
    expect(pill()).toBeNull()
    expect(screen.queryByRole('button', { name: /Show who is on the team/ })).toBeNull()
    between.unmount()
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    renderChat()
    expect(await screen.findByRole('button', { name: '2 ready. Show who is on the team' })).toBeInTheDocument()
    expect(pill()).toBeNull()
  })
})

describe('the piece’s line and the header’s pill', () => {
  // The line is watched against the chat's scroller; here the test says when it is on screen.
  const watchers: FakeObserver[] = []
  class FakeObserver {
    targets: Element[] = []
    callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
      watchers.push(this)
    }
    observe(target: Element) { this.targets.push(target) }
    unobserve() {}
    disconnect() { watchers.splice(watchers.indexOf(this), 1) }
    takeRecords() { return [] }
  }
  const scrollLine = (visible: boolean) => act(() => {
    for (const watcher of [...watchers]) {
      for (const target of watcher.targets.filter((element) => element.classList.contains('tc-talk'))) {
        watcher.callback([{ isIntersecting: visible, target } as unknown as IntersectionObserverEntry], watcher as unknown as IntersectionObserver)
      }
    }
  })
  // Each flight's animation, finished when the test says so.
  const flights: { keyframes: Keyframe[]; finish: () => void }[] = []
  const motion = (welcome: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: welcome === query.includes('no-preference'), media: query, addEventListener() {}, removeEventListener() {} }))
  beforeEach(() => {
    watchers.length = 0
    flights.length = 0
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    motion(true)
    Element.prototype.animate = function animate(keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
      const animation = { onfinish: null as null | (() => void), cancel: vi.fn() }
      flights.push({ keyframes: keyframes as Keyframe[], finish: () => animation.onfinish?.() })
      return animation as unknown as Animation
    }
  })
  afterEach(() => {
    window.localStorage.clear()
    delete (Element.prototype as Partial<Element>).animate
  })

  const asking = () => {
    said.messages = [{
      id: 'a1', kind: 'ask', from: 'writer', to: 'researcher', handedBy: null, text: 'Which outlet?', context: null, eventId: 'e1', evidenceId: null,
      seq: 3, ts: new Date().toISOString(), offsetMs: 0, state: 'pending', error: null, reply: null, carried: false,
    }]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, working: ['writer'] }), request: message({}), notes: [] }]
  }
  const pill = () => document.querySelector('.tc-faces .tc-baton.on')
  const ghost = () => document.querySelector('.tc-baton-ghost')
  const line = () => document.querySelector('.tc-talk')

  it('says who has the work on the piece while it is on screen, and flies it up into the pill once it is not', async () => {
    window.localStorage.setItem('loomwatch.chatRoster', 'folded')
    asking()
    renderChat()
    await waitFor(() => expect(line()?.querySelector('.tc-talk-line')).toHaveTextContent('Writer is asking Researcher'))
    expect([...line()!.querySelectorAll('.tc-talk-line b')].map((name) => name.className)).toEqual(['chat-name hue-2', 'chat-name hue-1'])
    scrollLine(true)
    expect(pill()).toBeNull()
    // Scrolled away: the line sets off from the chat's edge, and the pill waits hidden until it lands.
    scrollLine(false)
    expect(ghost()).toHaveTextContent('Asking Researcher…')
    expect(pill()).toHaveClass('landing')
    expect(flights.at(-1)?.keyframes[0]).toMatchObject({ opacity: 0, backgroundColor: 'transparent' })
    act(() => flights.at(-1)?.finish())
    expect(ghost()).toBeNull()
    expect(pill()).not.toHaveClass('landing')
    expect(pill()).toHaveTextContent('Asking Researcher…')
    // Back on screen: the pill flies down into the line, which waits hidden until it lands.
    scrollLine(true)
    expect(pill()).toBeNull()
    expect(ghost()).toHaveTextContent('Asking Researcher…')
    expect(line()).toHaveClass('tc-talk-landing')
    expect(flights.at(-1)?.keyframes.at(-1)).toMatchObject({ opacity: 0 })
    act(() => flights.at(-1)?.finish())
    expect(line()).not.toHaveClass('tc-talk-landing')
    expect(ghost()).toBeNull()
  })

  it('lands on the open list’s words too', async () => {
    asking()
    renderChat()
    await waitFor(() => expect(line()?.querySelector('.tc-talk-line')).toHaveTextContent('Writer is asking Researcher'))
    scrollLine(true)
    // Answering from the session it kept open, Researcher is not counted as working.
    expect(memberRow('Researcher')).toHaveTextContent('Researcherready')
    scrollLine(false)
    const words = within(memberRow('Researcher')).getByText('asked by Writer')
    expect(words).toHaveClass('landing')
    act(() => flights.at(-1)?.finish())
    expect(words).not.toHaveClass('landing')
  })

  it('swaps without flying where motion is not welcome', async () => {
    window.localStorage.setItem('loomwatch.chatRoster', 'folded')
    motion(false)
    asking()
    renderChat()
    await waitFor(() => expect(line()?.querySelector('.tc-talk-line')).toHaveTextContent('Writer is asking Researcher'))
    scrollLine(true)
    scrollLine(false)
    expect(ghost()).toBeNull()
    expect(pill()).toHaveTextContent('Asking Researcher…')
    expect(pill()).not.toHaveClass('landing')
    expect(flights).toHaveLength(0)
  })
})

describe("an agent's face", () => {
  afterEach(() => { window.localStorage.clear() })

  const described: TeamView = {
    ...team,
    configs: new Map([
      ['researcher', { id: 'researcher', name: 'Researcher', role: 'Finds the three stories that matter today, with a source for each.', model: 'anthropic/claude-opus-5.5', capabilities: [{ kind: 'skill', name: 'eli5' }, { kind: 'tool', name: 'notion' }, { kind: 'knowledge', name: 'Notes', path: 'notes' }, { kind: 'knowledge', name: 'Brief', path: 'brief.md' }] }],
      ['writer', { id: 'writer', name: 'Writer', role: 'Writes the digest.' }],
    ]),
    models: new Map([['researcher', 'Claude Opus 5.5'], ['writer', 'Claude Sonnet 5.5']]),
  }

  it('shows rough details on hover: what it is doing, its model, its job and what it works with', async () => {
    renderChat({ team: described })
    const face = within(screen.getByRole('list', { name: 'Who is on the team' })).getByRole('button', { name: 'Researcher: mention in your message' })
    fireEvent.pointerEnter(face, { pointerType: 'mouse' })
    const card = await screen.findByRole('tooltip')
    expect(face).toHaveAttribute('aria-describedby', card.id)
    expect(card).toHaveTextContent('Researcher')
    expect(card).toHaveTextContent('ready · step 1 of 3')
    expect(card).toHaveTextContent('Claude Opus 5.5')
    expect(card).toHaveTextContent('Finds the three stories that matter today')
    expect(card).toHaveTextContent('1 skill · 1 tool · 2 sources')
    expect(card).toHaveTextContent('Click to mention Researcher')
    fireEvent.pointerLeave(face)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    // Passing over a face on the way somewhere else opens nothing.
    fireEvent.pointerEnter(face, { pointerType: 'mouse' })
    fireEvent.pointerLeave(face)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('puts @name in the message box when clicked, in place of whoever the message was for', async () => {
    renderChat({ team: described })
    const list = screen.getByRole('list', { name: 'Who is on the team' })
    fireEvent.click(within(list).getByRole('button', { name: 'Writer: mention in your message' }))
    expect(box()).toHaveValue('@Writer ')
    await waitFor(() => expect(box()).toHaveFocus())
    expect(screen.getByText('Starts Writer only')).toBeInTheDocument()

    fireEvent.change(box(), { target: { value: '@Writer make the chip story the lead' } })
    fireEvent.click(within(list).getByRole('button', { name: 'Researcher: mention in your message' }))
    expect(box()).toHaveValue('@Researcher make the chip story the lead')
    // A message for no one yet gets the name in front.
    fireEvent.change(box(), { target: { value: 'check the sources' } })
    fireEvent.click(within(list).getByRole('button', { name: 'Writer: mention in your message' }))
    expect(box()).toHaveValue('@Writer check the sources')
  })

  it('does both from the folded team list, whose words still open it', async () => {
    renderChat({ team: described })
    fireEvent.click(screen.getByRole('button', { name: 'News desk' }))
    const face = screen.getByRole('button', { name: 'Researcher: mention in your message' })
    face.focus()
    fireEvent.focus(face)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude Opus 5.5')
    fireEvent.keyDown(face, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    fireEvent.click(face)
    expect(box()).toHaveValue('@Researcher ')
    fireEvent.click(screen.getByRole('button', { name: '2 ready. Show who is on the team' }))
    expect(screen.getByRole('list', { name: 'Who is on the team' })).toBeVisible()
  })
})

describe('a piece of work', () => {
  // lib/watch/workPhase.ts: while its own words come in, its figure types at the bench and the
  // message box says it is typing; while it thinks or uses a tool, it doesn't.
  it('says who is typing while its words come in, and not while it thinks', async () => {
    const event = (kind: string, payload: Record<string, unknown>) => ({ id: `e-${kind}`, sessionId: 'run-1', agentId: 'researcher', seq: 1, ts: new Date().toISOString(), kind, payload })
    said.events = [event('message', { role: 'agent', content: { text: 'Looking at' } })]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, working: ['researcher'] }), request: message({}), notes: [] }]
    renderChat()
    expect(await screen.findByText('Researcher is typing')).toHaveAttribute('role', 'status')
    cleanup()
    said.events = [event('thought', { role: 'thought', content: { text: 'Which stories matter' } })]
    renderChat()
    expect(await within(screen.getByRole('log')).findByText(/is working/)).toBeInTheDocument()
    expect(screen.queryByText(/is typing/)).not.toBeInTheDocument()
  })

  it('asks for your review with buttons: Approve needs no words, Send back needs them', async () => {
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, waitingOn: { node: 'review', name: 'Your review', kind: 'review_stop', since: '2026-10-06T02:01:00.000Z', question: 'Check it', context: '## Summary\nThree stories', handoverFrom: 'researcher', park: 'reloadable', parkNote: '', sendBackAvailable: true } }), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify(run({ status: 'running' })), { status: 200 })
    renderChat()
    expect(await screen.findByText(/handed over its work for your review/)).toBeInTheDocument()
    expect(screen.getByText('Three stories')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send back to Researcher' })).toBeDisabled()
    expect(screen.getByText('To send it back, write what to change in the box below.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/runs/run-1/answers', body: { node: 'review', text: 'Approved. Continue as planned.' } }))
  })

  // One gold fill per screen (DESIGN_LANGUAGE §8): with two pieces waiting for your review, the
  // newer one's Approve is the fill, the older one's a gold ring; each 32 px. When the newer one asks
  // a question instead, the box below answers it, so the older Approve is a ring too.
  it('fills only the newest waiting piece’s Approve, at least 32 px, and rings an older one’s', async () => {
    const waitingOn = { node: 'review', name: 'Your review', kind: 'review_stop' as const, since: '2026-10-06T02:01:00.000Z', question: 'Check it', context: 'Three stories', handoverFrom: 'researcher', park: 'reloadable' as const, parkNote: '', sendBackAvailable: true }
    const older = run({ runId: 'run-old', sessionId: 'run-old', prompt: 'Moon facts', status: 'running', reply: null, finishedAt: null, createdAt: '2026-10-06T02:00:00.000Z', waitingOn })
    const newer = run({ runId: 'run-new', sessionId: 'run-new', prompt: 'Mars facts', status: 'running', reply: null, finishedAt: null, createdAt: '2026-10-06T02:03:00.000Z', waitingOn: { ...waitingOn, since: '2026-10-06T02:04:00.000Z' } })
    page = [
      { kind: 'work', run: older, request: message({ id: 'm-old', runId: 'run-old', text: '@team Moon facts' }), notes: [] },
      { kind: 'work', run: newer, request: message({ id: 'm-new', runId: 'run-new', text: '@team Mars facts', createdAt: '2026-10-06T02:03:00.000Z' }), notes: [] },
    ]
    renderChat()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2))
    const [first, second] = screen.getAllByRole('button', { name: 'Approve' })
    expect(first.closest('[data-run]')).toHaveAttribute('data-run', 'run-old')
    expect(goldFilled()).toEqual(['Approve'])
    expect(isGoldFill(second)).toBe(true)
    expect(isGoldFill(first)).toBe(false)
    expect(cascaded(first, 'border-color')).toBe('var(--color-accent)')
    expect(cascaded(first, 'color')).toBe('var(--color-ink)')
    for (const approve of [first, second]) expect(heightOf(approve)).toBe(32)
    expect(heightOf(second, PHONE)).toBe(44)

    cleanup()
    page[1] = { ...page[1], run: { ...newer, waitingOn: { ...newer.waitingOn!, kind: 'question', node: 'writer', name: 'Writer', question: 'Short or long?', handoverFrom: null } } } as ChatItem
    renderChat()
    expect(await screen.findByText(/Answer in the box below/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1)
    expect(goldFilled()).toEqual([])
  })

  // ADR 0062, `whenStillNotMet: ask`: the check step's stop leads with what is still not met, and
  // decides like a review: Approve as it is needs no words, Send back needs them.
  // ADR 0062: work a check step checks may yet go back, or wait for you to approve it, so while
  // the run is live it is not shown as the team's answer.
  it('holds back work a check step checks until the run is done, and shows other work as it comes', async () => {
    said.agents = [{ id: 'writer', reply: 'Draft three: three times as often.', taskState: 'COMPLETED' }]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null }), request: message({}), notes: [] }]
    renderChat()
    expect(await screen.findByText(/Draft three: three times as often/)).toBeInTheDocument()
    cleanup()
    renderChat({ team: { ...team, configs: new Map([['checker', { id: 'checker', name: 'Checker', role: 'Check it.', checks: 'writer' }]]) } })
    expect((await screen.findAllByText(/today’s digest/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Draft three/)).not.toBeInTheDocument()
  })

  const checkStop = async () => {
    const check = { checked: 'researcher', rounds: 2, reason: 'rounds' as const, met: 2, problems: 'Two figures are from 2023.', items: [{ verdict: 'not_met' as const, item: 'Cites the 2025 report', evidence: 'cites the 2023 one' }, { verdict: 'not_sure' as const, item: 'Under 200 words', evidence: '' }] }
    const waitingOn = { node: 'writer', name: 'Writer', kind: 'review_stop' as const, since: '2026-10-06T02:01:00.000Z', question: 'Researcher’s work still misses 2 checks after going back 2 times.', context: 'Draft three.', handoverFrom: 'researcher', park: 'reloadable' as const, parkNote: '', sendBackAvailable: true, check }
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, waitingOn }), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify(run({ status: 'running' })), { status: 200 })
    renderChat()
    return screen.findByRole('group', { name: "Decide on Researcher's work" })
  }

  it('offers a file the answering agent made with a command and linked from its folder', async () => {
    const folder = '/teams/.loomwatch/news/writer'
    said.agents = [{ id: 'writer', folder, reply: '', taskState: 'COMPLETED' }]
    page = [{ kind: 'work', run: run({ reply: 'Made the page.\n\n[Open the digest](./digest.html)' }), request: message({}), notes: [] }]
    const chatFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith('/api/files/stat')) return chatFetch(input, init)
      return Promise.resolve(new Response(JSON.stringify({
        path: new URL(url, 'http://x').searchParams.get('path'), name: 'digest.html', exists: true, isDir: false, sizeBytes: 2_048,
        modifiedAt: null, kind: 'web', folder: '.loomwatch/news/writer', openable: true,
      }), { status: 200 }))
    }))
    renderChat()
    const chip = await screen.findByRole('button', { name: 'Open digest.html (Web page)' })
    expect(chip).toBeEnabled()
    expect(chip.getAttribute('title')?.split('\n')[0]).toBe(`${folder}/digest.html`)
    const files = screen.getByRole('group', { name: 'Files in this answer' })
    expect(await within(files).findByRole('button', { name: 'Open digest.html' })).toBeEnabled()
  })

  it('shows a check step’s stop with what is still not met, and approves the work as it is', async () => {
    const card = await checkStop()
    expect(card).toHaveTextContent('Researcher’s work still misses 2 checks after going back 2 times.')
    expect(screen.getByText('Waiting for you').parentElement).toHaveTextContent('Waiting for you · Researcher’s work still misses 2 checks after going back 2 times')
    expect(within(card).getByRole('list', { name: 'Checks still not met' })).toHaveTextContent('Not met Cites the 2025 report — cites the 2023 one')
    expect(within(card).getByRole('list', { name: 'Checks still not met' })).toHaveTextContent('Not sure Under 200 words')
    expect(within(card).getByText('What Writer wrote about it')).toBeInTheDocument()
    expect(within(card).getByText('Read Researcher’s work')).toBeInTheDocument()
    // Not the plain review's card.
    expect(screen.queryByText(/handed over its work for your review/)).not.toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Send back to Researcher' })).toBeDisabled()
    expect(card).toHaveTextContent('Researcher revises, and Writer checks it again.')
    fireEvent.click(within(card).getByRole('button', { name: 'Approve as it is' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/runs/run-1/answers', body: { node: 'writer', text: 'Approved. Continue as planned.' } }))
  })

  it('sends the work back from a check step’s stop with what you wrote', async () => {
    const card = await checkStop()
    fireEvent.change(box(), { target: { value: 'Use the 2025 report.' } })
    expect(within(card).getByRole('button', { name: 'Approve with your note' })).toBeEnabled()
    fireEvent.click(within(card).getByRole('button', { name: 'Send back to Researcher' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/runs/run-1/answers', body: { node: 'writer', text: 'Use the 2025 report.', sendBack: 'researcher' } }))
  })

  it('puts the review on the handover it decides, in what the agents said', async () => {
    said.messages = [{
      id: 'h-1', kind: 'handover', from: null, handedBy: { from: ['researcher'], via: [] }, to: 'review', text: 'Three stories, sourced.', context: null,
      eventId: 'e0', evidenceId: null, seq: 0, ts: '2026-10-06T02:01:00.000Z', offsetMs: 60_000, state: 'pending', error: null, reply: null, carried: false,
    }]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, waitingOn: { node: 'review', name: 'Your review', kind: 'review_stop', since: '2026-10-06T02:01:00.000Z', question: 'Check it', context: 'Three stories, sourced.', handoverFrom: 'researcher', park: 'reloadable', parkNote: '', sendBackAvailable: true } }), request: message({}), notes: [] }]
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

  // 2026-10-14: Codex refused a stage's model on a ChatGPT sign-in. The chat names the stage as the
  // team does, and says what Codex said.
  it('names the stage whose app refused the work, in that app’s words', async () => {
    const error = 'pipeline node researcher failed: Codex reported an error instead of an answer: The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.'
    page = [{ kind: 'work', run: run({ status: 'failed', reply: null, error, errorCode: 'app_error' }), request: message({}), notes: [] }]
    renderChat()
    const stopped = (await screen.findByText('The work stopped.')).closest('p')
    expect(stopped).toHaveTextContent('The work stopped. Researcher stopped. Codex reported an error instead of an answer: The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.')
  })
})

describe('reactions', () => {
  const handover: TeamMessage = {
    id: 'h-1', kind: 'handover', from: null, handedBy: { from: ['researcher'], via: [] }, to: 'writer', text: 'Three stories, sourced.', context: null,
    eventId: 'e0', evidenceId: null, seq: 0, ts: '2026-10-06T02:01:00.000Z', offsetMs: 60_000, state: 'delivered', error: null, reply: null, carried: false,
  }
  const stores = () => {
    answer = (_url, body) => {
      const { target, face } = body as { target: string; face: string | null }
      return new Response(JSON.stringify({ anchor: 'run-1', reactions: face ? [{ target, face, at: '2026-10-06T02:06:00.000Z' }] : [] }), { status: 200 })
    }
  }

  it('shows the agents looking up at what they were handed, and yours with what it tells the team', async () => {
    said.messages = [handover]
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [], reactions: [{ target: 'answer', face: 'hmm', at: '2026-10-06T02:05:00.000Z' }] }]
    renderChat()
    // Both worked on the request, and Writer was handed Researcher's work.
    expect(await screen.findByRole('button', { name: 'Researcher and Writer worked on this · 4 min' })).toBeDisabled()
    const talk = await screen.findByRole('region', { name: 'What the agents said' })
    expect(within(talk).getByRole('button', { name: 'Writer picked this up. Add yours' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Not sure: you. The team looks at it again. Take yours off' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reacts to anything said: your team note, your request, your note in the work, and the agents’ words', async () => {
    page = [
      { kind: 'note', message: message({ id: 'n-1', route: 'team_note', runId: null, text: 'we only cover listed companies', createdAt: '2026-10-06T01:00:00.000Z' }) },
      { kind: 'work', run: run({}), request: message({}), notes: [message({ id: 'n-2', route: 'note', agentId: 'writer', text: 'keep it short', deliveredAt: '2026-10-06T02:02:00.000Z' })] },
    ]
    renderChat()
    expect(await screen.findByRole('button', { name: "React to Writer's answer" })).toBeInTheDocument()
    for (const yours of ['React to your note', 'React to your request', 'React to your note to Writer']) {
      expect(screen.getByRole('button', { name: yours })).toBeInTheDocument()
    }
    // The agents' receipts stay theirs: a face only they put on is not yours to pick from the chip.
    expect(screen.getByRole('button', { name: 'Researcher and Writer worked on this · 4 min' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Writer picked this up. Add yours' })).toBeEnabled()
  })

  it('reacts to your own answer in the agents’ talk, and says what a face means on your own words', async () => {
    said.messages = [{
      id: 'q-1', kind: 'question', from: 'writer', handedBy: null, to: 'operator', text: 'Which region?', context: null,
      eventId: 'e1', evidenceId: null, seq: 1, ts: '2026-10-06T02:02:00.000Z', offsetMs: 120_000, state: 'answered', error: null, carried: false,
      reply: { from: 'operator', text: 'Europe only', eventId: 'e2', seq: 2, ts: '2026-10-06T02:03:00.000Z', offsetMs: 180_000, source: null, sentBackTo: null },
    }]
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    stores()
    renderChat()
    const talk = await screen.findByRole('region', { name: 'What the agents said' })
    expect(within(talk).getByRole('button', { name: "React to Writer's question" })).toBeInTheDocument()
    expect(within(talk).getByRole('button', { name: 'Writer picked this up. Add yours' })).toBeEnabled()
    fireEvent.click(within(talk).getByRole('button', { name: 'React to your answer' }))
    const tray = screen.getByRole('toolbar', { name: 'Pick a reaction' })
    expect(within(tray).getByRole('button', { name: 'Wrong' })).toHaveAttribute('aria-description', 'You take it back')
    fireEvent.pointerEnter(within(tray).getByRole('button', { name: 'Not sure' }))
    expect(tray).toHaveTextContent('Not sure · You’re having second thoughts')
    fireEvent.click(within(tray).getByRole('button', { name: 'Not sure' }))
    await waitFor(() => expect(posted[0]).toMatchObject({
      url: '/api/chat/reactions',
      body: { anchor: 'run-1', target: 'mine:q-1:reply', face: 'hmm', about: { agent: null, what: 'answer', quote: 'Europe only' } },
    }))
    expect(within(talk).getByRole('button', { name: 'Not sure: you. You’re having second thoughts. Take yours off' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reacts to a message the agents answered and to each answer, kept on the note across a reload', async () => {
    const hello = message({
      id: 'n-1', route: 'team_note', runId: null, text: '@team hi team, I am Colin', createdAt: '2026-10-06T01:00:00.000Z',
      answers: { waiting: [], said: [{ from: 'researcher', text: 'Hi Colin, nice to meet you!', at: '2026-10-06T01:00:05.000Z' }, { from: 'writer', text: 'Hello Colin!', at: '2026-10-06T01:00:06.000Z' }] },
    })
    page = [{ kind: 'note', message: hello, reactions: [{ target: 'reply:writer', face: 'love', at: '2026-10-06T01:01:00.000Z' }] }]
    answer = (_url, body) => {
      const { target, face } = body as { target: string; face: string | null }
      return new Response(JSON.stringify({ anchor: 'n-1', reactions: [{ target: 'reply:writer', face: 'love', at: '2026-10-06T01:01:00.000Z' }, ...(face ? [{ target, face, at: '2026-10-06T01:02:00.000Z' }] : [])] }), { status: 200 })
    }
    renderChat()
    // What the page read says shows on the answer it was on.
    expect(await screen.findByRole('button', { name: 'Love it: you. Exactly right. The team keeps to it. Take yours off' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: "React to Researcher's reply" }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/reactions', body: { teamPath: 'news.yaml', anchor: 'n-1', target: 'reply:researcher', face: 'glad' } }))
    expect(await screen.findByRole('button', { name: 'Good: you. The team keeps doing this. Take yours off' })).toBeInTheDocument()
    // Your own message, on the right, says what a face means on your words.
    fireEvent.click(screen.getByRole('button', { name: 'React to your message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }))
    await waitFor(() => expect(posted[1]).toMatchObject({ body: { anchor: 'n-1', target: 'note:n-1', face: 'off' } }))
    const yours = await screen.findByRole('button', { name: 'Wrong: you. You take it back. Take yours off' })
    expect(yours.closest('.tc-reactable')).toHaveClass('mine')
  })

  it('opens a tray that says what each reaction tells the team, keeps the one you pick, and takes it off again', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    stores()
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: "React to Writer's answer" }))
    const tray = screen.getByRole('toolbar', { name: 'Pick a reaction' })
    expect(within(tray).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Good', 'Love it', 'Not sure', 'Wrong', 'Seen'])
    expect(tray).toHaveTextContent('The team reads your reaction next time')
    // The tray is the keyboard's while it is open: arrows move along it, and say each face.
    expect(within(tray).getByRole('button', { name: 'Good' })).toHaveFocus()
    fireEvent.keyDown(tray, { key: 'ArrowRight' })
    expect(within(tray).getByRole('button', { name: 'Love it' })).toHaveFocus()
    fireEvent.keyDown(tray, { key: 'ArrowRight' })
    expect(tray).toHaveTextContent('Not sure · The team looks at it again')
    fireEvent.click(within(tray).getByRole('button', { name: 'Wrong' }))
    expect(screen.queryByRole('toolbar', { name: 'Pick a reaction' })).not.toBeInTheDocument()
    const off = screen.getByRole('button', { name: /^Wrong: you\./ })
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/reactions', body: { teamPath: 'news.yaml', anchor: 'run-1', target: 'answer', face: 'off' } }))
    fireEvent.click(off)
    await waitFor(() => expect(posted[1]).toMatchObject({ url: '/api/chat/reactions', body: { target: 'answer', face: null } }))
    expect(screen.queryByRole('button', { name: /^Wrong: you/ })).not.toBeInTheDocument()
  })

  it('sends what a line of talk was with your reaction on it, for the next work to read', async () => {
    said.messages = [handover]
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    stores()
    renderChat()
    const talk = await screen.findByRole('region', { name: 'What the agents said' })
    fireEvent.click(within(talk).getByRole('button', { name: "React to Researcher's handover" }))
    fireEvent.click(screen.getByRole('button', { name: 'Not sure' }))
    await waitFor(() => expect(posted[0]).toMatchObject({
      url: '/api/chat/reactions',
      body: { anchor: 'run-1', target: 'talk:h-1:said', face: 'hmm', about: { agent: 'researcher', what: 'handover', quote: 'Three stories, sourced.' } },
    }))
  })

  it('closes the tray on Escape without the workspace hearing it', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    renderChat()
    const heard = vi.fn()
    document.addEventListener('keydown', heard)
    fireEvent.click(await screen.findByRole('button', { name: "React to Writer's answer" }))
    fireEvent.keyDown(screen.getByRole('toolbar', { name: 'Pick a reaction' }), { key: 'Escape' })
    document.removeEventListener('keydown', heard)
    expect(screen.queryByRole('toolbar', { name: 'Pick a reaction' })).not.toBeInTheDocument()
    expect(heard).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: "React to Writer's answer" })).toHaveFocus()
  })
})

// An agent's own chat in Your agents: the team chat on a team of one, where everything goes to it.
describe('one agent’s own chat', () => {
  const ada = [{ id: 'ada', name: 'Ada' }]
  const solo: TeamView = { names: new Map([['ada', 'Ada']]), hues: new Map([['ada', 3]]), parties: [{ id: 'ada', name: 'Ada', operator: false }], predecessors: new Map(), order: [], operators: new Set(), solo: 'ada' }
  const renderSolo = (overrides: Partial<Parameters<typeof TeamChat>[0]> = {}) => renderChat({ teamPath: 'ada.yaml', teamName: 'Ada', agents: ada, team: solo, steps: 1, suggestion: null, ...overrides })
  const soloBox = () => screen.getByRole('textbox', { name: 'Message Ada' })

  it('greets you by the agent’s name and sends to it without an @', async () => {
    answer = () => new Response(JSON.stringify({ route: 'agent', message: message({ text: 'sum up the report', route: 'agent', agentId: 'ada' }), run: run({ status: 'queued', reply: null, finishedAt: null, onlyAgent: 'ada', responder: 'ada' }) }), { status: 202 })
    const { props } = renderSolo()
    expect(await screen.findByRole('heading', { name: 'Talk to Ada' })).toBeInTheDocument()
    // Nothing to fold and nobody to @: its face, its name, and what it is doing.
    expect(screen.queryByRole('button', { name: /who is on the team/ })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ada, ready' })).toBeInTheDocument()
    expect(screen.getByText('To Ada')).toBeInTheDocument()

    fireEvent.change(soloBox(), { target: { value: 'sum up the report' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { teamPath: 'ada.yaml', text: 'sum up the report', to: { kind: 'agent', agent: 'ada' }, expectedRevision: 'sha256:1' } }))
    expect(props.prepare).toHaveBeenCalledTimes(1)
  })

  it('makes a message a note for its turn while it works, without saving the agent again', async () => {
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, onlyAgent: 'ada', responder: 'ada', agentIds: ['ada'], working: ['ada'] }), request: message({ text: 'sum up the report', route: 'agent', agentId: 'ada' }), notes: [] }]
    answer = () => new Response(JSON.stringify({ route: 'note', message: message({ id: 'n-1', text: 'only the first half', route: 'note', agentId: 'ada' }) }), { status: 200 })
    const { props } = renderSolo()
    expect(await screen.findByRole('heading', { name: 'Ada, working' })).toBeInTheDocument()
    expect(within(screen.getByRole('log')).getByText('You → Ada')).toBeInTheDocument()
    fireEvent.change(soloBox(), { target: { value: 'only the first half' } })
    expect(screen.getByText('Note for Ada · after its current step')).toBeInTheDocument()
    fireEvent.keyDown(soloBox(), { key: 'Enter' })
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { to: { kind: 'agent', agent: 'ada' } } }))
    expect(props.prepare).not.toHaveBeenCalled()
  })

  it('says it is working in its own colour, its face one knot in the gutter', async () => {
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, onlyAgent: 'ada', responder: 'ada', agentIds: ['ada'], working: ['ada'] }), request: message({ text: 'sum up the report', route: 'agent', agentId: 'ada' }), notes: [] }]
    renderSolo()
    const line = await within(screen.getByRole('log')).findByText(/is working/)
    expect(line).toHaveTextContent('Ada is working')
    expect(line.querySelector('b')).toHaveClass('chat-name', 'hue-3')
    expect(document.querySelector('.tc-weft')).toHaveClass('one')
    expect(document.querySelector('.tc-weft .chat-avatar')).toHaveClass('hue-3', 'working')
  })

  it('reports the newest piece’s run, for the figure at the bench', async () => {
    const working = run({ status: 'running', reply: null, finishedAt: null, onlyAgent: 'ada', responder: 'ada', agentIds: ['ada'], working: ['ada'] })
    page = [{ kind: 'work', run: working, request: message({ text: 'sum up the report', route: 'agent', agentId: 'ada' }), notes: [] }]
    const onNewestRun = vi.fn()
    renderSolo({ onNewestRun })
    await waitFor(() => expect(onNewestRun).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-1', status: 'running' })))
  })
})

// ADR 0051: Reply under something said — a handover, a question, an answer — writes to whoever said
// it, by the same rule as an @, with the quote kept on the message and handed to the agent.
describe('replying to something said', () => {
  const talk = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'id' | 'kind'>): TeamMessage => ({
    from: null, handedBy: null, to: null, text: 'x', context: null, eventId: extra.id, evidenceId: null, seq: 1, ts: '2026-10-06T02:01:00.000Z',
    offsetMs: 60_000, state: 'delivered', error: null, reply: null, carried: false, ...extra,
  })
  const replied = { runId: 'run-1', messageId: 'answer:run-1', from: 'writer', to: null, kind: 'answer' as const, text: 'Done — I tightened the lead.' }

  it('a reply to the answer starts the agent that gave it, with the answer quoted, and the quote shows it again', async () => {
    said.read = true
    page = [{ kind: 'work', run: run({ reply: 'Done — I tightened the lead.' }), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify({
      route: 'agent',
      message: message({ id: 'm-2', text: '@Writer shorter', route: 'agent', agentId: 'writer', runId: 'run-2', createdAt: '2026-10-06T03:00:00.000Z', replyTo: replied }),
      run: run({ runId: 'run-2', status: 'queued', onlyAgent: 'writer', reply: null, finishedAt: null, createdAt: '2026-10-06T03:00:00.000Z' }),
    }), { status: 202 })
    const { props } = renderChat()
    const log = await screen.findByRole('log', { name: 'Messages' })
    fireEvent.click(await within(log).findByRole('button', { name: "Reply to Writer's answer" }))
    expect(box()).toHaveValue('@Writer ')
    await waitFor(() => expect(box()).toHaveFocus())
    expect(screen.getByRole('group', { name: "Replying to Writer's answer" })).toHaveTextContent('Done — I tightened the lead.')
    expect(screen.getByText('Starts Writer only')).toBeInTheDocument()
    expect(box()).toHaveAttribute('placeholder', 'Reply to Writer…')

    fireEvent.change(box(), { target: { value: '@Writer shorter' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { text: '@Writer shorter', to: { kind: 'agent', agent: 'writer' }, replyTo: replied } }))
    expect(props.prepare).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull()

    // The new piece says what it replied to; a click shows that answer where it was given.
    const quote = await within(log).findByRole('button', { name: "Replying to Writer's answer. Show it" })
    fireEvent.click(quote)
    await waitFor(() => expect(document.querySelector('[data-run="run-1"] .tc-answer')).toHaveClass('flash'))
  })

  it('a reply to an agent at work is a note for its turn, and a handover’s reply can go to either agent', async () => {
    said.messages = [talk({ id: 'h1', kind: 'handover', to: 'writer', handedBy: { from: ['researcher'], via: [] }, text: 'Three stories, sourced.' })]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, working: ['writer'] }), request: message({}), notes: [] }]
    renderChat()
    const said_ = await screen.findByRole('region', { name: 'What the agents said' })
    fireEvent.click(within(said_).getByRole('button', { name: 'Reply to Researcher: handover' }))
    expect(box()).toHaveValue('@Researcher ')
    expect(screen.getByText('Starts Researcher only')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'To Writer instead' }))
    expect(box()).toHaveValue('@Writer ')
    expect(screen.getByText('Note for Writer · after its current step')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'To Researcher instead' })).toBeInTheDocument()

    // Esc lets go of the reply and keeps the words.
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull()
    expect(box()).toHaveValue('@Writer ')
  })

  it('Reply on the question the team waits on you for goes back to answering it', async () => {
    said.messages = [
      talk({ id: 'h1', kind: 'handover', to: 'review', handedBy: { from: ['researcher'], via: [] }, text: 'Three stories, sourced.', seq: 0 }),
      talk({ id: 'question:e1', kind: 'question', from: 'researcher', to: 'operator', text: 'Which market?', state: 'pending', seq: 2 }),
    ]
    page = [{ kind: 'work', run: run({ status: 'running', reply: null, finishedAt: null, working: ['researcher'], waitingOn: { node: 'researcher', name: 'Researcher', kind: 'question', since: '2026-10-06T02:01:00.000Z', question: 'Which market?', park: 'reloadable', parkNote: '', sendBackAvailable: false } }), request: message({}), notes: [] }]
    renderChat()
    expect(await screen.findByPlaceholderText('Answer Researcher…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Write to the team instead' }))
    expect(screen.queryByPlaceholderText('Answer Researcher…')).toBeNull()
    const said_ = await screen.findByRole('region', { name: 'What the agents said' })
    fireEvent.click(within(said_).getByRole('button', { name: 'Reply to Researcher: question' }))
    expect(screen.getByPlaceholderText('Answer Researcher…')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull()
    // A reply to anything else is a message of its own, not your answer to the question.
    fireEvent.click(within(said_).getByRole('button', { name: 'Reply to Researcher: handover' }))
    expect(screen.getByRole('group', { name: "Replying to Researcher's handover" })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Answer Researcher…')).toBeNull()
    expect(screen.getByPlaceholderText('Reply to Researcher…')).toBeInTheDocument()
  })

  it('shows a note and a team note with what they replied to, and Try again sends the same reply', async () => {
    const quoted = { runId: 'run-1', messageId: 'h1:said', from: 'researcher', to: 'writer', kind: 'handover' as const, text: 'Three stories, sourced.' }
    page = [
      { kind: 'work', run: run({ status: 'failed', reply: null, error: 'it broke' }), request: message({ replyTo: quoted }), notes: [message({ id: 'n-1', text: 'only Asia', route: 'note', agentId: 'writer', replyTo: quoted })] },
      { kind: 'note', message: message({ id: 'n-2', text: 'and Europe', route: 'team_note', runId: null, createdAt: '2026-10-06T03:00:00.000Z', replyTo: quoted }) },
    ]
    answer = () => new Response(JSON.stringify({ error: 'no' }), { status: 500 })
    renderChat()
    const log = await screen.findByRole('log', { name: 'Messages' })
    await within(log).findByText('only Asia')
    expect(within(log).getAllByRole('button', { name: "Replying to Researcher's handover to Writer. Show it" })).toHaveLength(3)
    fireEvent.click(within(log).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { replyTo: quoted } }))
  })
})

// ADR 0077: a part of a file marked in the reader beside the chat is asked about here, as a reply.
describe('asking about a part of a file', () => {
  const part = { runId: 'run-1', messageId: 'passage:abc', from: 'writer', to: null, kind: 'passage' as const, text: 'Sales grew 12% in Q3.', file: '/w/market.md' }

  it('Ask puts the part in the box as what the message is about, addressed to the agent who made it', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    const onPassages = vi.fn()
    renderChat({ ask: { reply: part, at: 1 }, onPassages })
    await waitFor(() => expect(box()).toHaveValue('@Writer '))
    expect(screen.getByRole('group', { name: 'Asking about a part of market.md from Writer' })).toHaveTextContent('Sales grew 12% in Q3.')
    expect(box()).toHaveAttribute('placeholder', 'Ask Writer about this part…')
    await waitFor(() => expect(onPassages).toHaveBeenLastCalledWith([], 'Sales grew 12% in Q3.'))
    // Letting go of it lets go of the part the reader lights.
    fireEvent.keyDown(box(), { key: 'Escape' })
    await waitFor(() => expect(onPassages).toHaveBeenLastCalledWith([], null))
  })

  it('Explain sends at once, to that agent, with the part and its file', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify({ error: 'later' }), { status: 500 })
    renderChat({ ask: { reply: part, words: 'Explain this part in plain words.', at: 2 } })
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { text: '@Writer Explain this part in plain words.', to: { kind: 'agent', agent: 'writer' }, replyTo: part } }))
  })

  it('a teammate chosen in the reader is asked about the part, which stays the maker’s', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    renderChat({ ask: { reply: part, agent: 'researcher', at: 3 } })
    await waitFor(() => expect(box()).toHaveValue('@Researcher '))
    expect(screen.getByRole('group', { name: 'Asking about a part of market.md from Writer' })).toBeInTheDocument()
    expect(box()).toHaveAttribute('placeholder', 'Ask Researcher about this part…')
  })

  it('Explain goes at once to a teammate chosen in the reader', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
    answer = () => new Response(JSON.stringify({ error: 'later' }), { status: 500 })
    renderChat({ ask: { reply: part, words: 'Explain this part in plain words.', agent: 'researcher', at: 4 } })
    await waitFor(() => expect(posted[0]).toMatchObject({ url: '/api/chat/messages', body: { text: '@Researcher Explain this part in plain words.', to: { kind: 'agent', agent: 'researcher' }, replyTo: part } }))
  })

  it('says which parts were asked about, from what the chat holds', async () => {
    page = [{ kind: 'work', run: run({ runId: 'run-2' }), request: message({ id: 'm-2', runId: 'run-2', text: '@Writer why?', replyTo: part }), notes: [] }]
    const onPassages = vi.fn()
    renderChat({ onPassages })
    await waitFor(() => expect(onPassages).toHaveBeenLastCalledWith([{ file: '/w/market.md', text: 'Sales grew 12% in Q3.', from: 'writer', asked: '@Writer why?', runId: 'run-2', messageId: 'm-2' }], null))
    // The quote under the message says what it asked about.
    expect(await screen.findByLabelText('Replying to a part of market.md from Writer')).toHaveTextContent('Sales grew 12% in Q3.')
  })

  it('the quote of a part opens its file in the reader beside the chat', async () => {
    page = [{ kind: 'work', run: run({ runId: 'run-2' }), request: message({ id: 'm-2', runId: 'run-2', text: '@Writer why?', replyTo: part }), notes: [] }]
    const open = vi.fn()
    const props = {
      teamPath: 'news.yaml', teamName: 'News desk', agents, team, steps: 3, suggestion: null, detailsRunId: null, blocked: null,
      prepare: vi.fn(async () => ({ ok: true as const, revision: 'sha256:1' })), onDetails: vi.fn(), onTeamReview: vi.fn(), onStale: vi.fn(), announce: vi.fn(), onOpenFinding: vi.fn(), onOpenAnswer: vi.fn(),
    }
    render(<FileReaderContext.Provider value={open}><TeamChat {...props} /></FileReaderContext.Provider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Replying to a part of market.md from Writer. Show it' }))
    expect(open).toHaveBeenCalledWith({ path: '/w/market.md', runId: 'run-1', from: 'writer' })
  })
})

describe('what the agents learned', () => {
  const vietnamese = 'When replying to this person, always write in Vietnamese.'
  const lesson = (over: Partial<Lesson> = {}): Lesson => ({
    id: 'l1', scope: 'team:news#writer', agentId: 'writer', text: vietnamese, source: 'you', aboutYou: true, feedback: 'In Vietnamese, please.',
    runId: 'run-1', state: 'active', given: 0, backed: 0, missed: 0, createdAt: '2026-10-06T02:05:00.000Z', updatedAt: '2026-10-06T02:05:00.000Z', ...over,
  })
  const you = { name: 'Mai', about: vietnamese, skipped: false }

  it('tells all your agents only after Add, and Undo on the moved lesson moves it back', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [], lessons: [lesson()] }]
    answer = (url) => {
      if (url === '/api/lessons/tell-all') {
        page = [{ kind: 'work', run: run({}), request: message({}), notes: [], lessons: [lesson({ state: 'dropped', droppedBy: 'about_you' })] }]
        return new Response(JSON.stringify({ lesson: lesson({ state: 'dropped', droppedBy: 'about_you' }), lessons: [], you, added: true }), { status: 200 })
      }
      page = [{ kind: 'work', run: run({}), request: message({}), notes: [], lessons: [lesson()] }]
      return new Response(JSON.stringify({ lesson: lesson(), lessons: [lesson()], you: { ...you, about: null }, removed: true }), { status: 200 })
    }
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: `Tell all my agents: ${vietnamese}` }))
    expect(posted).toEqual([])
    fireEvent.click(within(screen.getByRole('group', { name: 'Tell all my agents' })).getByRole('button', { name: 'Add' }))
    expect(await screen.findByText(`know: ${vietnamese}`, { exact: false })).toBeInTheDocument()
    expect(posted).toEqual([{ url: '/api/lessons/tell-all', body: { teamPath: 'news.yaml', agent: 'writer', id: 'l1' } }])
    fireEvent.click(screen.getByRole('button', { name: `Undo: ${vietnamese}` }))
    expect(await screen.findByRole('button', { name: `Tell all my agents: ${vietnamese}` })).toBeInTheDocument()
    expect(posted[1]).toEqual({ url: '/api/lessons/tell-all/undo', body: { teamPath: 'news.yaml', agent: 'writer', id: 'l1' } })
  })

  it('takes back a lesson still with its agent with the plain Undo, never touching About you', async () => {
    page = [{ kind: 'work', run: run({}), request: message({}), notes: [], lessons: [lesson()] }]
    answer = () => {
      page = [{ kind: 'work', run: run({}), request: message({}), notes: [] }]
      return new Response(JSON.stringify({ undone: lesson({ state: 'dropped', droppedBy: 'you' }), lessons: [] }), { status: 200 })
    }
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: `Undo: ${vietnamese}` }))
    await waitFor(() => expect(screen.queryByText(vietnamese, { exact: false })).not.toBeInTheDocument())
    expect(posted).toEqual([{ url: '/api/lessons/undo', body: { teamPath: 'news.yaml', agent: 'writer', id: 'l1' } }])
  })
})
