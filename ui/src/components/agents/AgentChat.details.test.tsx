import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedJob } from '../../lib/library/jobs'
import type { RunRecord } from '../../lib/runs/client'
import { projectRun, type RunEvent } from '../../lib/watch/events'
import { forgetYou } from '../../lib/you/client'
import type { ComponentProps } from 'react'
import type { TeamChat } from '../chat/TeamChat'
import type { AgentFigureProps } from './AgentFigure'
import { draftFromJob } from '../../lib/library/draft'
import { AgentChat } from './AgentChat'
import { AgentsPage } from './AgentsPage'

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels.
vi.mock('./AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

// The chat itself is the team chat's (TeamChat.test.tsx); here it is only the ways it asks for a
// piece's record (its Details, and a finding of its answer's review, at a record or at an agent's
// work) and for its chat file to be looked over before it runs.
type TeamChatProps = ComponentProps<typeof TeamChat>
const chat = vi.hoisted(() => ({ props: null as TeamChatProps | null, retry: (() => {}) as () => void }))
vi.mock('../chat/TeamChat', () => ({
  TeamChat: (props: TeamChatProps) => {
    chat.props = props
    return (
      <section aria-label="Chat">
        <button type="button" aria-pressed={props.detailsRunId === 'run-1'} onClick={() => props.onDetails('run-1')}>Details</button>
        <button type="button" onClick={() => props.onOpenFinding('run-1', { tone: 'bad', text: 'Maya’s command failed, and carried on without it', agentId: 'maya', evidenceId: 'maya:c1' })}>Open the finding</button>
        <button type="button" onClick={() => props.onOpenFinding('run-1', { tone: 'warn', text: 'Maya was given the skill “apple-notes” but the record never shows it opened', agentId: 'maya' })}>Open the agent finding</button>
        <button type="button" onClick={() => props.onTeamReview({ teamPath: '.jobs/.bench/maya.yaml', teamName: 'Maya · chat', teamRevision: 'r9', review: [{ text: 'Runs Maya on fake/offline', warn: false }] }, chat.retry)}>Send</button>
      </section>
    )
  },
}))

// Maya's run: a command that failed, then her answer.
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 26, 4, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent => ({ id: `event-${seq}`, sessionId: 'run-1', agentId: 'maya', seq, ts: at(seq), kind, payload })
const events: RunEvent[] = [
  event(0, 'process', { phase: 'spawned', pid: 7 }),
  event(1, 'tool_call', { callId: 'c1', name: 'Bash', title: 'osascript check_calendar.scpt', toolKind: 'execute', status: 'pending', rawInput: { command: 'osascript check_calendar.scpt' } }),
  event(2, 'tool_update', { callId: 'c1', status: 'failed', content: 'execution error: Not authorised to send Apple events to Calendar. (-1743)' }),
  event(3, 'message', { text: 'You’re free all week.' }),
  event(4, 'turn_end', { stopReason: 'end_turn' }),
  event(5, 'process', { phase: 'exited', exitCode: 0 }),
]
const record: RunRecord = {
  runId: 'run-1', sessionId: 'run-1', teamPath: '.jobs/.bench/maya.yaml', prompt: 'check my availability', status: 'succeeded', mode: 'team',
  entrypoint: 'maya', responder: 'maya', agentIds: ['maya'], createdAt: at(0), startedAt: at(0), finishedAt: at(5), error: null, exitCode: 0, eventCount: events.length,
  reply: 'You’re free all week.', trigger: 'manual',
}
vi.mock('../../lib/runs/useRunSession', () => ({
  useRunSession: (runId: string | null) => {
    const projection = projectRun(runId ? events : [])
    return { record: runId ? record : null, applyRecord: vi.fn(), missing: false, events: runId ? events : [], error: null, connected: true, loading: false, projection, latest: projection, cursor: null, setCursor: vi.fn(), lastSeq: 5, mode: 'replay', terminal: true, evidenceComplete: true }
  },
}))

const approved: unknown[] = []
const maya: SavedJob = { id: 'maya', file: '.jobs/maya.yaml', name: 'Maya', instructions: 'Help me with my day.', model: 'fake/offline', figure: { kind: 'spool', color: 'lilac' } }
const opened = vi.fn()

beforeEach(() => {
  chat.props = null
  chat.retry = vi.fn()
  approved.length = 0
  opened.mockReset()
  vi.stubGlobal('open', opened)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [maya], problems: [] }), { status: 200 })
    if (url === '/api/bench') return new Response(JSON.stringify({ folder: '.jobs/.bench' }), { status: 200 })
    if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: '.jobs/.bench/maya.yaml', revision: 'r1', yaml: 'name: Maya · chat\nagents: []\n' }), { status: 200 })
    if (url === '/api/team' && init?.method === 'PUT') return new Response(JSON.stringify({ path: '.jobs/.bench/maya.yaml', revision: 'r2', yaml: '' }), { status: 200 })
    if (url.startsWith('/api/runs?')) return new Response(JSON.stringify([record]), { status: 200 })
    if (url === '/api/runs/run-1/context') return new Response(JSON.stringify([]), { status: 200 })
    if (url === '/api/team/approve' && init?.method === 'POST') { approved.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }) }
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: [], teams: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

async function openChat() {
  window.history.replaceState({}, '', '/agents/maya?view=chat')
  render(<AgentsPage skills={[]} skillsLoading={false} />)
  return within(await screen.findByRole('region', { name: 'Chat' }, { timeout: 5000 }))
}

// The owner (2026-10-26): working with one agent, "2 things to check" took them to a team's
// Workflow screen in a new tab. A piece's record is read where the agent is, over its bench, as its
// long answers and files are (ADR 0077).
describe('a piece’s record, in an agent’s own chat', () => {
  it('opens Details over the bench, and Details again (or Back) shows the bench', async () => {
    const inChat = await openChat()
    fireEvent.click(inChat.getByRole('button', { name: 'Details' }))
    const details = await screen.findByRole('region', { name: 'Details of this piece of work' })
    // The record of how the answer was made: the receipt, and Maya's work.
    expect(within(details).getByRole('region', { name: 'Run receipt' })).toBeInTheDocument()
    expect(within(details).getByText('Team contributions')).toBeInTheDocument()
    // Its settings are this page's Build tab: the record offers no second way to them.
    expect(within(details).queryByRole('button', { name: 'Agent details' })).toBeNull()
    expect(inChat.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-pressed', 'true')
    // No new tab, and no team screen.
    expect(opened).not.toHaveBeenCalled()

    fireEvent.click(inChat.getByRole('button', { name: 'Details' }))
    expect(screen.queryByRole('region', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
    fireEvent.click(inChat.getByRole('button', { name: 'Details' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Maya' }))
    expect(screen.queryByRole('region', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
    expect(opened).not.toHaveBeenCalled()
  }, 15_000)

  it('opens a finding at the record it points at, beside its Details', async () => {
    const inChat = await openChat()
    fireEvent.click(inChat.getByRole('button', { name: 'Open the finding' }))
    await screen.findByRole('region', { name: 'Details of this piece of work' })
    // The failed command's record, read the way a newcomer asks about it.
    const record = await screen.findByRole('complementary', { name: /couldn’t run check_calendar/ })
    expect(record).toHaveTextContent('Didn’t work')
    expect(opened).not.toHaveBeenCalled()
    // Closing the record leaves Details open; a finding asked for again opens it again.
    await act(async () => { fireEvent.click(within(record).getByRole('button', { name: 'Close activity details' })) })
    expect(screen.queryByRole('complementary', { name: /couldn’t run check_calendar/ })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Details of this piece of work' })).toBeInTheDocument()
    fireEvent.click(inChat.getByRole('button', { name: 'Open the finding' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: /couldn’t run check_calendar/ })).toBeInTheDocument())
  }, 15_000)

  it('puts the way back in hand, shows every record behind the run, and closes on Esc', async () => {
    const inChat = await openChat()
    fireEvent.click(inChat.getByRole('button', { name: 'Details' }))
    const details = await screen.findByRole('region', { name: 'Details of this piece of work' })
    // Where the chat is below the bench, the way back is what comes into view.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to Maya' })).toHaveFocus())
    fireEvent.click(within(details).getByRole('button', { name: /What was recorded/ }))
    const recorded = await screen.findByRole('complementary', { name: 'Provenance' })
    // Esc closes what is on top first: the records, then Details.
    fireEvent.keyDown(recorded, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Provenance' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back to Maya' }), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
  }, 15_000)

  it('brings the agent a finding names into view', async () => {
    const scrolled: Element[] = []
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value(this: Element) { scrolled.push(this) } })
    try {
      const inChat = await openChat()
      fireEvent.click(inChat.getByRole('button', { name: 'Open the agent finding' }))
      await screen.findByRole('region', { name: 'Details of this piece of work' })
      await waitFor(() => expect(scrolled.map((element) => element.id)).toContain('delivery-stage-maya'))
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  }, 15_000)

  // Its chat file changed outside LoomWatch (ADR 0048): this used to be looked over on the team
  // screen Details took you to. It is looked over here, and the message goes once you trust it.
  it('asks you to look over its chat file here before it runs, and sends once you trust it', async () => {
    const inChat = await openChat()
    fireEvent.click(inChat.getByRole('button', { name: 'Send' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Check “Maya · chat” before it runs' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Trust and run' })) })
    expect(approved).toEqual([{ teamPath: '.jobs/.bench/maya.yaml', teamRevision: 'r9' }])
    expect(chat.retry).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(opened).not.toHaveBeenCalled()
  }, 15_000)
})

// Details' timeline "Read the message" shows the message in the chat beside it, as the file
// reader's "show where it was asked" does: the newer of the two is shown.
describe('a message Details asks the chat to show', () => {
  it('reaches the chat, and gives way to a newer one from the file reader', async () => {
    const file = (at: number) => ({ open: vi.fn(), ask: null, onPassages: vi.fn(), team: vi.fn(), reveal: { runId: 'run-1', id: 'from-file', at } })
    const chatOf = (reading: ReturnType<typeof file>) => <AgentChat draft={draftFromJob(maya)} model="fake/offline" chatId="maya" figure={maya.figure!} onAllow={vi.fn()} onRecord={vi.fn()} answerRunId={null} onOpenAnswer={vi.fn()} detailsRunId={null} onDetails={vi.fn()} reveal={{ runId: 'run-1', id: 'from-details', at: 2 }} file={reading} />
    const view = render(chatOf(file(1)))
    await screen.findByRole('region', { name: 'Chat' }, { timeout: 5000 })
    expect(chat.props?.reveal).toEqual({ runId: 'run-1', id: 'from-details', at: 2 })
    view.rerender(chatOf(file(3)))
    expect(chat.props?.reveal).toEqual({ runId: 'run-1', id: 'from-file', at: 3 })
  }, 15_000)
})

// A link to a run of an agent's own chat (the bell, the notch, the menu bar: `historyRunUrl`)
// opens that agent's chat, at the piece, with its Details over the bench.
describe('a link to a piece of an agent’s own chat', () => {
  it('opens the agent’s chat with that piece’s Details, and shows the piece in the chat', async () => {
    window.history.replaceState({}, '', '/agents/maya?view=chat&run=run-1')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    expect(await screen.findByRole('region', { name: 'Details of this piece of work' }, { timeout: 5000 })).toBeInTheDocument()
    await screen.findByRole('region', { name: 'Chat' }, { timeout: 5000 })
    expect(chat.props?.landAt).toBe('run-1')
    expect(opened).not.toHaveBeenCalled()
  }, 15_000)

  it('sends a chat that is none of My agents’ to the team screen, where such a link always went', async () => {
    const replaced = vi.fn()
    const real = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { href: 'http://localhost/agents/team-digest-scope?view=chat&run=run-1', origin: 'http://localhost', pathname: '/agents/team-digest-scope', search: '?view=chat&run=run-1', replace: replaced, assign: vi.fn() } })
    try {
      render(<AgentsPage skills={[]} skillsLoading={false} />)
      await waitFor(() => expect(replaced).toHaveBeenCalledWith(`/?${new URLSearchParams({ path: '.jobs/.bench/team-digest-scope.yaml', view: 'chat', run: 'run-1' })}`), { timeout: 5000 })
      expect(screen.queryByText(/There is no agent/)).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: real })
    }
  }, 15_000)
})
