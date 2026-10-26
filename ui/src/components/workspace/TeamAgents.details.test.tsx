import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { figureFor, figureStill } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import type { RunRecord } from '../../lib/runs/client'
import type { AgentConfig } from '../../lib/team-file/types'
import { projectRun, type RunEvent } from '../../lib/watch/events'
import type { TeamChat } from '../chat/TeamChat'
import type { AgentFigureProps } from '../agents/AgentFigure'
import { TeamAgents, type TeamAgentsProps } from './TeamAgents'

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels.
vi.mock('../agents/AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

// The chat is the team chat's (TeamChat.test.tsx); here it is only its way to a piece's Details.
type TeamChatProps = ComponentProps<typeof TeamChat>
vi.mock('../chat/TeamChat', () => ({
  TeamChat: (props: TeamChatProps) => <section aria-label="Chat"><button type="button" onClick={() => props.onDetails('run-1')}>Details</button></section>,
}))

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 26, 4, 0, seconds)).toISOString()
const agentId = 'team-digest-scope'
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent => ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })
const events: RunEvent[] = [
  event(0, 'process', { phase: 'spawned', pid: 7 }),
  event(1, 'message', { text: 'The scope is set.' }),
  event(2, 'turn_end', { stopReason: 'end_turn' }),
  event(3, 'process', { phase: 'exited', exitCode: 0 }),
]
const record: RunRecord = {
  runId: 'run-1', sessionId: 'run-1', teamPath: `.jobs/.bench/${agentId}.yaml`, prompt: 'Set the scope', status: 'succeeded', mode: 'team',
  entrypoint: agentId, responder: agentId, agentIds: [agentId], createdAt: at(0), startedAt: at(0), finishedAt: at(3), error: null, exitCode: 0, eventCount: events.length,
  reply: 'The scope is set.', trigger: 'manual',
}
vi.mock('../../lib/runs/useRunSession', () => ({
  useRunSession: (runId: string | null) => {
    const projection = projectRun(runId ? events : [])
    return { record: runId ? record : null, applyRecord: vi.fn(), missing: false, events: runId ? events : [], error: null, connected: true, loading: false, projection, latest: projection, cursor: null, setCursor: vi.fn(), lastSeq: 3, mode: 'replay', terminal: true, evidenceComplete: true }
  },
}))

const scoper: AgentConfig = { id: 'scope', name: 'Project scope', role: 'Establish the project scope.', model: 'anthropic/claude-opus-5.5' }
const opened = vi.fn()

beforeEach(() => {
  opened.mockReset()
  vi.stubGlobal('open', opened)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/bench') return new Response(JSON.stringify({ folder: '.jobs/.bench' }), { status: 200 })
    if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: record.teamPath, revision: 'r1', yaml: 'agents: []\n' }), { status: 200 })
    if (url === '/api/team' && init?.method === 'PUT') return new Response(JSON.stringify({ path: record.teamPath, revision: 'r2', yaml: '' }), { status: 200 })
    if (url.startsWith('/api/runs?')) return new Response(JSON.stringify([record]), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderTeamAgents(extra: Partial<TeamAgentsProps> = {}) {
  render(<TeamAgents agents={[scoper]} responder={null} selected="scope" onSelect={vi.fn()} teamName="Digest" teamPath="digest.yaml" editable skills={[]} skillsLoading={false} savedJobs={[]} onEdit={vi.fn()} onAgentSaved={vi.fn()} onShowWorkflow={vi.fn()} {...extra} />)
}

// The owner (2026-10-26): Details and a finding of an answer's review open where the agent is, over
// its bench, in a team's own agent's chat as in My agents.
describe('a team’s own agent’s chat', () => {
  it('opens a piece’s Details over its bench, with no Agent details to send you elsewhere', async () => {
    renderTeamAgents()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Agent view' })).getByRole('button', { name: 'Chat' }))
    fireEvent.click(within(await screen.findByRole('region', { name: 'Chat' })).getByRole('button', { name: 'Details' }))
    const details = await screen.findByRole('region', { name: 'Details of this piece of work' })
    expect(within(details).getByRole('region', { name: 'Run receipt' })).toBeInTheDocument()
    // Its settings are this page's Build tab: the record offers no second way to them.
    expect(within(details).queryByRole('button', { name: 'Agent details' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to Project scope at the bench' })).toBeInTheDocument()
    expect(opened).not.toHaveBeenCalled()
  })
})

describe('an agent’s own chat, opened as a team', () => {
  it('shows its agent in the figure it wears in My agents', () => {
    const reader: SavedJob = { id: 'reader', file: '.jobs/reader.yaml', name: 'Reader', instructions: 'Read.', figure: { kind: 'button', color: 'sage' } }
    expect(figureStill(figureFor('reader'))).not.toBe(figureStill(reader.figure!))
    renderTeamAgents({ agents: [{ id: 'reader', name: 'Reader', role: 'Read.' }], selected: 'reader', teamPath: '/teams/.jobs/.bench/reader.yaml', savedJobs: [reader] })
    const strip = screen.getByRole('navigation', { name: 'Digest’s agents' })
    expect(strip.querySelector('.team-agents-figure')).toHaveAttribute('src', figureStill(reader.figure!))
  })
})
