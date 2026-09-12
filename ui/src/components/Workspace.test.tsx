import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../lib/watch/events'
import { Workspace } from './Workspace'

const flowRuntime = vi.hoisted(() => ({
  onNodesChange: null as ((...args: unknown[]) => void) | null,
  onNodeDragStart: null as ((...args: unknown[]) => void) | null,
  onNodeDragStop: null as ((...args: unknown[]) => void) | null,
}))

const documentState = vi.hoisted(() => ({
  path: '/teams/demo.yaml',
  nodes: [
    { id: 'researcher', type: 'agent', position: { x: 0, y: 0 }, selected: false, data: { label: 'Researcher', agent: { id: 'researcher', name: 'Researcher', role: 'Research', model: 'demo', status: 'idle', spawn: { cmd: 'fake', args: [], env: {}, cwd: '.' }, budget: { limitUsd: 5 } }, isEntrypoint: true } },
    { id: 'reviewer', type: 'agent', position: { x: 300, y: 0 }, selected: false, data: { label: 'Reviewer', agent: { id: 'reviewer', name: 'Reviewer', role: 'Review', model: 'demo', status: 'idle', spawn: { cmd: 'fake', args: [], env: {}, cwd: '.' }, budget: { limitUsd: 3 } } } },
  ],
  edges: [{ id: 'researcher->reviewer', source: 'researcher', target: 'reviewer', data: { kind: 'sequence', ts: '' }, selected: false }],
  entrypoint: 'researcher', entrypointProblem: null, teamGuards: null, teamBudget: null, teamSchedule: null,
  saveState: 'clean', documentChipState: 'clean', saveError: null, documentProblems: [], fieldProblemsByAgent: new Map(), isValid: true,
  readOnlyReason: null, fileGone: false, loadFailure: null, externalChange: null, diskNotice: null, yamlPreview: 'a: 1', loadedYaml: 'a: 1',
  canUndo: false, canRedo: false, refusal: null, mode: 'pipeline',
  pipelineSteps: [{ id: 'researcher', step: 1, joinFrom: [] }, { id: 'reviewer', step: 2, joinFrom: [] }],
  modeSwitchBanner: false, pendingEdgeRemoval: null,
  createNewDocument: vi.fn(), reloadFromDisk: vi.fn(), keepMine: vi.fn(), useDisk: vi.fn(), saveCopy: vi.fn(), layoutNodes: vi.fn(),
  settleNodeCollision: vi.fn(), capturePositionHistory: vi.fn(), undo: vi.fn(), redo: vi.fn(), onNodesChange: vi.fn(), onEdgesChange: vi.fn(),
  onConnect: vi.fn(), addAgentFromDrop: vi.fn(), save: vi.fn(async () => true), touchField: vi.fn(), renameAgent: vi.fn(), updateAgentModel: vi.fn(),
  updateAgentCwd: vi.fn(), updateAgentBudget: vi.fn(), updateAgentWarnAt: vi.fn(), updateAgentAllowRecruiting: vi.fn(), promoteEntrypoint: vi.fn(),
  removeAgent: vi.fn(), updateTeamGuards: vi.fn(), updateTeamBudget: vi.fn(), updateTeamSchedule: vi.fn(), dismissRefusal: vi.fn(), keepLastEdgeRemoval: vi.fn(), undoLastEdgeRemoval: vi.fn(),
  checkDiskRevision: vi.fn(async () => {}), currentRevision: () => 'rev-7',
}))

const sessionState = vi.hoisted(() => ({ events: [] as RunEvent[] }))

vi.mock('../lib/team-file/useTeamDocument', () => ({ useTeamDocument: () => documentState, slugifyTeamName: (name: string) => name }))
vi.mock('../lib/watch/useSessionEvents', () => ({
  readArchive: vi.fn(async () => []),
  useSessionEvents: (sessionId: string) => ({ sessionId, events: sessionId ? sessionState.events : [], error: null, connected: true }),
}))
vi.mock('../lib/runs/useRunHistory', () => ({ useRunHistory: () => ({ records: [], sessions: [], error: null, unavailable: null, loaded: true, refresh: vi.fn() }) }))
vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  MarkerType: { Arrow: 'arrow', ArrowClosed: 'arrowclosed' },
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  NodeToolbar: ({ children, isVisible }: { children: React.ReactNode; isVisible?: boolean }) => isVisible ? <>{children}</> : null,
  getBezierPath: () => ['', 0, 0],
  getSmoothStepPath: () => ['', 0, 0],
  useStore: (selector: (store: { transform: number[]; minZoom: number; maxZoom: number }) => unknown) => selector({ transform: [0, 0, 1], minZoom: 0.25, maxZoom: 2 }),
  useNodesInitialized: () => true,
  useReactFlow: () => ({ fitView: vi.fn(), screenToFlowPosition: vi.fn(), setViewport: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), getNodes: () => [], getNode: () => undefined }),
  ReactFlow: ({ nodes, edges, nodeTypes, onNodesChange, onNodeDragStart, onNodeDragStop }: { nodes: Array<{ id: string; type: string; data: unknown; selected?: boolean; ariaLabel?: string; measured?: { width: number; height: number } }>; edges: Array<{ id: string; ariaLabel?: string }>; nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown; selected: boolean }>>; onNodesChange?: (...args: unknown[]) => void; onNodeDragStart?: (...args: unknown[]) => void; onNodeDragStop?: (...args: unknown[]) => void }) => {
    flowRuntime.onNodesChange = onNodesChange ?? null
    flowRuntime.onNodeDragStart = onNodeDragStart ?? null
    flowRuntime.onNodeDragStop = onNodeDragStop ?? null
    return <div data-testid="flow">
      {nodes.map((node) => { const Card = nodeTypes[node.type]; return <div key={node.id} data-node={node.type} data-measured={node.measured ? `${node.measured.width}x${node.measured.height}` : undefined} aria-label={node.ariaLabel}><Card id={node.id} data={node.data} selected={node.selected ?? false} /></div> })}
      {edges.map((edge) => <span key={edge.id} data-edge={edge.id}>{edge.ariaLabel}</span>)}
    </div>
  },
}))

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 11, 0, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'researcher'): RunEvent => ({ id: `e${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })
const runRecord = { runId: 'run-1', sessionId: 'run-1', teamPath: 'demo.yaml', prompt: 'Summarise the repo', status: 'running', mode: 'pipeline', entrypoint: 'researcher', responder: 'reviewer', agentIds: ['researcher', 'reviewer'], createdAt: at(0), startedAt: at(0), finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null }

function renderWorkspace(runId: string | null = null) {
  return render(<Workspace harnesses={[]} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onDocumentOpen={vi.fn()} initialRunId={runId} />)
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?path=demo.yaml')
  sessionState.events = []
  flowRuntime.onNodesChange = null
  flowRuntime.onNodeDragStart = null
  flowRuntime.onNodeDragStop = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/runs') && init?.method === 'POST') return new Response(JSON.stringify({ ...runRecord, prompt: JSON.parse(String(init.body)).prompt, status: 'queued' }), { status: 202 })
    if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
    if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'] }), { status: 200 })
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('Workspace', () => {
  it('shows the team canvas with the document chip, composer and the configured pipeline', () => {
    renderWorkspace()
    expect(screen.getByRole('application', { name: 'Team canvas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /demo.yaml, .*open team switcher/ })).toBeInTheDocument()
    expect(screen.getByText('Pipeline · 2 steps')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Run ⌘/ })).toBeDisabled()
    expect(screen.getByText('sequence from Researcher to Reviewer')).toBeInTheDocument()
  })

  it('leaves L inert on the compose view, where no legend names the edge layers', () => {
    const { container } = renderWorkspace()
    const shell = container.querySelector('.lw-shell')!
    expect(screen.queryByRole('group', { name: 'Edge layers' })).not.toBeInTheDocument()
    for (let press = 0; press < 3; press += 1) {
      fireEvent.keyDown(window, { key: 'l' })
      expect(screen.getByText('sequence from Researcher to Reviewer')).toBeInTheDocument()
      expect(shell).not.toHaveClass('solo-observed')
      expect(shell).not.toHaveClass('solo-configured')
    }
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.queryByRole('button', { name: /Solo edge layer/ })).not.toBeInTheDocument()
  })

  it('solos edge layers in run view while the legend names the state and offers the way back', async () => {
    sessionState.events = [
      event(0, 'process', { phase: 'spawned', pid: 1 }),
      event(1, 'tool_call', { callId: 'd1', name: 'dispatch', title: 'Team Bus: dispatch', toolKind: 'mcp', status: 'in_progress', rawInput: { agent: 'reviewer' } }),
      event(2, 'tool_update', { callId: 'd1', status: 'completed' }),
    ]
    const { container } = renderWorkspace('run-1')
    const shell = container.querySelector('.lw-shell')!
    await waitFor(() => expect(screen.getByRole('group', { name: 'Edge layers' })).toBeInTheDocument())
    expect(screen.getByText('sequence from Researcher to Reviewer')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'l' })
    expect(shell).toHaveClass('solo-configured')
    fireEvent.keyDown(window, { key: 'l' })
    expect(shell).toHaveClass('solo-observed')
    expect(screen.queryByText('sequence from Researcher to Reviewer')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Edge layers' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'l' })
    expect(shell).not.toHaveClass('solo-observed')
    expect(screen.getByText('sequence from Researcher to Reviewer')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.getByRole('button', { name: /Solo edge layer/ })).toBeInTheDocument()
  })

  it('starts a run from the composer and rewires the canvas into the prompt-to-output story', async () => {
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run ⌘/ }))
    await waitFor(() => expect(screen.getByRole('application', { name: 'Run graph' })).toBeInTheDocument())
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')!
    // §1.4/§1.6: the run is pinned to the revision on screen and carries one start key per attempt.
    expect(JSON.parse(String(post[1]!.body))).toEqual({ teamPath: '/teams/demo.yaml', prompt: 'Summarise the repo', expectedRevision: 'rev-7', startKey: expect.any(String) })
    expect(screen.getByLabelText(/Prompt, original user request/)).toHaveTextContent('Summarise the repo')
    expect(screen.getByRole('status', { name: /Run 01, queued/ })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Lifecycle summary' })).toHaveTextContent('Live')
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument()
    expect(window.location.search).toContain('run=run-1')
  })

  // TNG89 §1.2: "⌘↵ — submit — from anywhere in the app, including a focused canvas." The
  // unguarded `Enter` branch below it must keep renaming, or this reads as a pass for a handler
  // that simply stopped answering Enter at all.
  it('answers ⌘↵ from a focused canvas with a run, not with a rename (§1.2)', async () => {
    documentState.nodes[0].selected = true
    const renamed = vi.fn()
    window.addEventListener('loomwatch:rename-agent', renamed)
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    const canvas = screen.getByRole('application', { name: 'Team canvas' })
    fireEvent.keyDown(canvas, { key: 'Enter' })
    expect(renamed).toHaveBeenCalledOnce()
    fireEvent.keyDown(canvas, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(screen.getByRole('application', { name: 'Run graph' })).toBeInTheDocument())
    expect(renamed).toHaveBeenCalledOnce()
    window.removeEventListener('loomwatch:rename-agent', renamed)
    documentState.nodes[0].selected = false
  })

  // §1.4: "the two steps stay legible as two steps" — on a clean document only one of them is
  // happening, and claiming a save that is not happening is the defect this closes.
  it('holds Starting…, never Saving…, while a clean document starts a run (§1.4/§1.6)', async () => {
    let release!: (response: Response) => void
    const held = new Promise<Response>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/runs') && init?.method === 'POST') return held
      if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
      if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
    }))
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run ⌘/ }))
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Saving demo.yaml/)).not.toBeInTheDocument()
    await act(async () => { release(new Response(JSON.stringify({ ...runRecord, status: 'queued' }), { status: 202 })) })
    await waitFor(() => expect(screen.getByRole('application', { name: 'Run graph' })).toBeInTheDocument())
  })

  // §1.6: "A connection loss during submit never retries blind." The re-press is the same attempt,
  // so it carries the same key and the daemon answers with the run it already started.
  it('re-presses a lost submit with the same start key (§1.6)', async () => {
    const startKeys: string[] = []
    let failNext = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        startKeys.push(JSON.parse(String(init.body)).startKey)
        if (failNext) { failNext = false; throw new TypeError('connection lost') }
        return new Response(JSON.stringify({ ...runRecord, status: 'queued' }), { status: 200 })
      }
      if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
      if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
    }))
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run ⌘/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('connection lost')
    expect(screen.getByLabelText('What should the team do?')).toHaveValue('Summarise the repo')
    fireEvent.click(screen.getByRole('button', { name: /^Run ⌘/ }))
    await waitFor(() => expect(startKeys).toHaveLength(2))
    expect(startKeys[1]).toBe(startKeys[0])
    expect(startKeys[0]).toMatch(/\S/)
  })

  // §1.5: "No run is created." The §9.3 conflict bar takes over and the typed goal survives.
  it('creates no run when the revision moved under the start, and keeps the prompt (§1.5)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'the team file changed before the run could start', code: 'stale_team_revision', currentTeamRevision: 'rev-9' }), { status: 409 })
      }
      if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
    }))
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run ⌘/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('changed before the run could start')
    await waitFor(() => expect(documentState.checkDiskRevision).toHaveBeenCalled())
    expect(screen.queryByRole('application', { name: 'Run graph' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('What should the team do?')).toHaveValue('Summarise the repo')
  })

  it('saves a dirty document before running, and refuses to run when the save fails', async () => {
    Object.assign(documentState, { documentChipState: 'dirty', saveState: 'dirty' })
    documentState.save.mockResolvedValueOnce(false)
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Go' } })
    expect(screen.getByRole('button', { name: /Save & run/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Save & run/ }))
    await waitFor(() => expect(documentState.save).toHaveBeenCalledOnce())
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    Object.assign(documentState, { documentChipState: 'clean', saveState: 'clean' })
  })

  it('projects archived evidence into owner-tagged cards, live task rows and the response', async () => {
    sessionState.events = [
      event(0, 'process', { phase: 'spawned', pid: 1 }),
      event(1, 'message', { role: 'user', content: { type: 'text', text: '## Your assigned role\nResearch\n\n## Task\nSummarise the repo' } }),
      event(2, 'tool_call', { callId: 'c1', title: '$ cargo test', name: 'terminal', toolKind: 'execute', status: 'in_progress' }),
      event(3, 'tool_update', { callId: 'c1', status: 'completed' }),
      event(4, 'message', { role: 'agent', content: { type: 'text', text: 'Lead done.' } }),
      event(5, 'turn_end', { stopReason: 'end_turn' }),
      event(6, 'process', { phase: 'exited', exitCode: 0 }),
      event(7, 'process', { phase: 'spawned', pid: 2 }, 'reviewer'),
      event(8, 'message', { role: 'agent', content: { type: 'text', text: 'Looks good.' } }, 'reviewer'),
    ]
    renderWorkspace('run-1')
    await waitFor(() => expect(screen.getByRole('button', { name: /Inspect command: \$ cargo test, recorded, Agent A · lead, succeeded, event 1/ })).toBeInTheDocument())
    expect(screen.getByLabelText(/Researcher, Agent A · lead, DONE, Reply delivered/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Reviewer, Agent B · responder, STREAMING/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Output response from Agent B · responder, Streaming/)).toHaveTextContent('Looks good.')
    expect(screen.getByLabelText(/Prompt, original user request/)).toHaveTextContent('Summarise the repo')
    expect(screen.getByLabelText(/Inspect command: \$ cargo test/)).not.toHaveClass('nodrag')

    act(() => flowRuntime.onNodesChange?.([{ id: 'researcher:c1', type: 'dimensions', dimensions: { width: 190, height: 68 } }]))
    expect(screen.getByLabelText(/Inspect command: \$ cargo test/).closest('[data-node]')).toHaveAttribute('data-measured', '190x68')

    const shell = document.querySelector('.lw-shell')!
    act(() => flowRuntime.onNodeDragStart?.(new MouseEvent('mousedown'), { id: 'c1' }))
    expect(shell).toHaveClass('node-dragging')
    act(() => flowRuntime.onNodeDragStop?.(new MouseEvent('mouseup'), { id: 'c1', position: { x: 0, y: 0 } }))
    expect(shell).not.toHaveClass('node-dragging')

    fireEvent.click(screen.getByRole('button', { name: /Inspect command: \$ cargo test, recorded/ }))
    expect(screen.getByRole('complementary', { name: /cargo test/ })).toHaveTextContent('Agent A · lead')
    fireEvent.click(screen.getByRole('button', { name: 'Close activity details' }))
    expect(screen.queryByRole('complementary', { name: /cargo test/ })).not.toBeInTheDocument()
  })

  it('opens a document-level problem at its exact YAML line', async () => {
    Object.assign(documentState, {
      isValid: false,
      documentChipState: 'invalid',
      documentProblems: [{ message: '(document) must NOT have additional properties', yamlPath: ['unexpected'] }],
      yamlPreview: 'schemaVersion: 1\nunexpected: true\nagents: []\n',
    })
    renderWorkspace()
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' }).find((button) => button.hasAttribute('aria-controls'))!)
    fireEvent.click(screen.getByRole('button', { name: /Team.*must NOT have additional properties/ }))
    expect(await screen.findByRole('dialog', { name: 'YAML preview · line 2' })).toBeInTheDocument()
    expect(screen.getByLabelText('Problem at YAML line 2')).toHaveFocus()
    Object.assign(documentState, { isValid: true, documentChipState: 'clean', documentProblems: [], yamlPreview: 'a: 1' })
  })

  it('opens schedule problems in a friendly canvas editor instead of raw YAML', async () => {
    Object.assign(documentState, {
      isValid: false,
      documentChipState: 'invalid',
      teamSchedule: { cron: '0 8 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the daily digest.' },
      documentProblems: [{ message: '(document) must NOT have additional properties', yamlPath: ['schedule'] }],
      yamlPreview: 'schedule:\n  cron: "0 8 * * *"\n',
    })
    renderWorkspace()
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' }).find((button) => button.hasAttribute('aria-controls'))!)
    fireEvent.click(screen.getAllByRole('button', { name: /Schedule needs attention/ }).find((button) => button.classList.contains('prob-row'))!)

    expect(screen.getByRole('form', { name: 'Edit schedule' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /YAML preview/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    expect(documentState.updateTeamSchedule).toHaveBeenCalledWith(expect.objectContaining({ cron: '0 8 * * *', timezone: 'Asia/Singapore' }))
    Object.assign(documentState, { isValid: true, documentChipState: 'clean', teamSchedule: null, documentProblems: [], yamlPreview: 'a: 1' })
  })

  it('focuses the exact Inspector control for an agent-field problem', async () => {
    const originalNodes = documentState.nodes
    Object.assign(documentState, {
      nodes: documentState.nodes.map((node, index) => ({ ...node, selected: index === 0 })),
      isValid: false,
      documentChipState: 'invalid',
      fieldProblemsByAgent: new Map([['researcher', { model: { weight: 'error', message: 'Required' } }]]),
    })
    renderWorkspace()
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' }).find((button) => button.hasAttribute('aria-controls'))!)
    fireEvent.click(screen.getByRole('button', { name: /Researcher · Model.*Required/ }))
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveFocus())
    Object.assign(documentState, { nodes: originalNodes, isValid: true, documentChipState: 'clean', fieldProblemsByAgent: new Map() })
  })

  it('cancels a live run through the API', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return new Response(JSON.stringify({ ...runRecord, status: 'cancelled', finishedAt: at(9) }), { status: 200 })
      if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
      return new Response(JSON.stringify({ error: `unexpected ${url} ${init?.method ?? ''}` }), { status: 404 })
    })
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    renderWorkspace('run-1')
    await waitFor(() => expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Stop/ })) })
    await waitFor(() => expect(screen.getByRole('group', { name: 'Lifecycle summary' })).toHaveTextContent('cancelled'))
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })
})
