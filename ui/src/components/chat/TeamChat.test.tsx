import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PASS_BEAT_MS } from '../../lib/chat/baton'
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
    page = working({ waitingOn: { node: 'writer', name: 'Writer', kind: 'question', since: '2026-10-06T02:01:00.000Z', question: 'Which market?', context: null, handoverFrom: null, park: 'kept_alive', parkNote: '', sendBackAvailable: false } })
    renderChat()
    await waitFor(() => expect(pill()).toHaveTextContent('needs you'))
    expect(pill()).toHaveClass('waiting')
    expect(pill()?.querySelector('.chat-dots')).toBeNull()
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
      ['researcher', { id: 'researcher', name: 'Researcher', role: 'Finds the three stories that matter today, with a source for each.', model: 'claude-opus-4-5', capabilities: [{ kind: 'skill', name: 'eli5' }, { kind: 'tool', name: 'notion' }, { kind: 'knowledge', name: 'Notes', path: 'notes' }, { kind: 'knowledge', name: 'Brief', path: 'brief.md' }] }],
      ['writer', { id: 'writer', name: 'Writer', role: 'Writes the digest.' }],
    ]),
    apps: new Map([['researcher', 'Claude'], ['writer', 'Codex']]),
  }

  it('shows rough details on hover: what it is doing, its app and model, its job and what it works with', async () => {
    renderChat({ team: described })
    const face = within(screen.getByRole('list', { name: 'Who is on the team' })).getByRole('button', { name: 'Researcher: mention in your message' })
    fireEvent.pointerEnter(face, { pointerType: 'mouse' })
    const card = await screen.findByRole('tooltip')
    expect(face).toHaveAttribute('aria-describedby', card.id)
    expect(card).toHaveTextContent('Researcher')
    expect(card).toHaveTextContent('ready · step 1 of 3')
    expect(card).toHaveTextContent('Claude · claude-opus-4-5')
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
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude · claude-opus-4-5')
    fireEvent.keyDown(face, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    fireEvent.click(face)
    expect(box()).toHaveValue('@Researcher ')
    fireEvent.click(screen.getByRole('button', { name: '2 ready. Show who is on the team' }))
    expect(screen.getByRole('list', { name: 'Who is on the team' })).toBeVisible()
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

  it('reports the newest piece’s run, for the figure at the bench', async () => {
    const working = run({ status: 'running', reply: null, finishedAt: null, onlyAgent: 'ada', responder: 'ada', agentIds: ['ada'], working: ['ada'] })
    page = [{ kind: 'work', run: working, request: message({ text: 'sum up the report', route: 'agent', agentId: 'ada' }), notes: [] }]
    const onNewestRun = vi.fn()
    renderSolo({ onNewestRun })
    await waitFor(() => expect(onNewestRun).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-1', status: 'running' })))
  })
})
