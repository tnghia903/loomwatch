import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../lib/watch/events'
import type { AgentConfig } from '../lib/team-file/types'
import { Workspace } from './Workspace'

const flowRuntime = vi.hoisted(() => ({
  onNodesChange: null as ((...args: unknown[]) => void) | null,
  onEdgesChange: null as ((...args: unknown[]) => void) | null,
  onNodeDragStart: null as ((...args: unknown[]) => void) | null,
  onNodeDragStop: null as ((...args: unknown[]) => void) | null,
  onConnect: null as ((connection: { source: string | null; target: string | null }) => void) | null,
  onDragOver: null as ((event: unknown) => void) | null,
  onDrop: null as ((event: unknown) => void) | null,
}))

const documentState = vi.hoisted(() => ({
  path: '/teams/demo.yaml',
  nodes: [
    { id: 'researcher', type: 'agent', position: { x: 0, y: 0 }, selected: false, data: { label: 'Researcher', agent: { id: 'researcher', name: 'Researcher', role: 'Research', model: 'demo', status: 'idle', spawn: { cmd: 'fake', args: [] as string[], env: {}, cwd: '.' } }, isEntrypoint: true } },
    { id: 'reviewer', type: 'agent', position: { x: 300, y: 0 }, selected: false, data: { label: 'Reviewer', agent: { id: 'reviewer', name: 'Reviewer', role: 'Review', model: 'demo', status: 'idle', spawn: { cmd: 'fake', args: [] as string[], env: {}, cwd: '.' } } } },
  ],
  edges: [{ id: 'researcher->reviewer', source: 'researcher', target: 'reviewer', data: { kind: 'sequence', ts: '' }, selected: false }],
  entrypoint: 'researcher', responder: null as string | null, entrypointProblem: null, teamSchedule: null,
  saveState: 'clean', documentChipState: 'clean', saveError: null, documentProblems: [], fieldProblemsByAgent: new Map(), isValid: true,
  readOnlyReason: null, fileGone: false, loadFailure: null, externalChange: null, diskNotice: null, yamlPreview: 'a: 1', loadedYaml: 'a: 1',
  canUndo: false, canRedo: false, refusal: null, mode: 'pipeline',
  pipelineSteps: [{ id: 'researcher', step: 1, joinFrom: [] }, { id: 'reviewer', step: 2, joinFrom: [] }],
  modeSwitchBanner: false, pendingEdgeRemoval: null,
  createNewDocument: vi.fn(), applyYaml: vi.fn(() => true), closeDocument: vi.fn(), teamsRoot: null as string | null, reloadFromDisk: vi.fn(), keepMine: vi.fn(), useDisk: vi.fn(), saveCopy: vi.fn(), layoutNodes: vi.fn(),
  settleNodeCollision: vi.fn(), capturePositionHistory: vi.fn(), undo: vi.fn(), redo: vi.fn(), onNodesChange: vi.fn(), onEdgesChange: vi.fn(),
  onConnect: vi.fn(), addAgentFromDrop: vi.fn(), save: vi.fn(async () => true), touchField: vi.fn(), renameAgent: vi.fn(), updateAgentModel: vi.fn(),
  updateAgentCwd: vi.fn(), updateAgentAllowRecruiting: vi.fn(), promoteEntrypoint: vi.fn(), promoteResponder: vi.fn(),
  removeAgent: vi.fn(), updateTeamSchedule: vi.fn(), removeTeamSchedule: vi.fn(), dismissRefusal: vi.fn(), keepLastEdgeRemoval: vi.fn(), undoLastEdgeRemoval: vi.fn(),
  updateAgentMemory: vi.fn(), addBriefEntry: vi.fn(), removeBriefEntry: vi.fn(),
  // ADR 0016: `memory.inherits` is what the canvas draws memory cards from, and agent positions
  // arrive from the sidecar through `applyPositions` — neither dirties the document.
  memoryInherits: [] as Array<{ team?: string; pack?: string; appliesTo?: string[] }>,
  briefPaths: [] as string[], renameTeam: vi.fn(),
  applyPositions: vi.fn(), addMemoryInherit: vi.fn(), removeMemoryInherit: vi.fn(), excludeInheritedBrief: vi.fn(),
  setAgentCapabilities: vi.fn(), updateAgentThinkingEffort: vi.fn(),
  checkDiskRevision: vi.fn(async () => {}), currentRevision: () => 'rev-7',
}))

const sessionState = vi.hoisted(() => ({ events: [] as RunEvent[] }))
const composerLayoutState = vi.hoisted(() => ({
  nodes: [] as Array<{ id: string; kind: 'skill' | 'tool' | 'knowledge'; name: string; source: string; position: { x: number; y: number }; memory?: { team?: string; pack?: string } }>,
  edges: [] as Array<{ from: string; to: string }>,
  agents: {} as Record<string, { x: number; y: number }>,
  /** The path whose sidecar is in hand, so position hydration knows when the read has landed. */
  loadedFor: '/teams/demo.yaml' as string | null,
}))

vi.mock('../lib/team-file/useTeamDocument', () => ({ useTeamDocument: () => documentState, slugifyTeamName: (name: string) => name }))
vi.mock('../lib/watch/useSessionEvents', () => ({
  readArchive: vi.fn(async () => []),
  useSessionEvents: (sessionId: string) => ({ sessionId, events: sessionId ? sessionState.events : [], error: null, connected: true }),
}))
vi.mock('../lib/runs/useRunHistory', () => ({ useRunHistory: () => ({ records: [], sessions: [], error: null, unavailable: null, loaded: true, refresh: vi.fn() }) }))
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  useReactFlow: () => ({ fitView: vi.fn(), screenToFlowPosition: vi.fn((point: { x: number; y: number }) => point), setViewport: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), getNodes: () => [], getNode: () => undefined }),
  ReactFlow: ({ nodes, edges, nodeTypes, onNodesChange, onEdgesChange, onNodeDragStart, onNodeDragStop, onConnect, onDragOver, onDrop }: { nodes: Array<{ id: string; type: string; data: unknown; position: { x: number; y: number }; selected?: boolean; ariaLabel?: string; measured?: { width: number; height: number }; initialWidth?: number; initialHeight?: number }>; edges: Array<{ id: string; ariaLabel?: string }>; nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown; selected: boolean }>>; onNodesChange?: (...args: unknown[]) => void; onEdgesChange?: (...args: unknown[]) => void; onNodeDragStart?: (...args: unknown[]) => void; onNodeDragStop?: (...args: unknown[]) => void; onConnect?: (connection: { source: string | null; target: string | null }) => void; onDragOver?: (event: unknown) => void; onDrop?: (event: unknown) => void }) => {
    flowRuntime.onNodesChange = onNodesChange ?? null
    flowRuntime.onEdgesChange = onEdgesChange ?? null
    flowRuntime.onNodeDragStart = onNodeDragStart ?? null
    flowRuntime.onNodeDragStop = onNodeDragStop ?? null
    flowRuntime.onConnect = onConnect ?? null
    flowRuntime.onDragOver = onDragOver ?? null
    flowRuntime.onDrop = onDrop ?? null
    return <div data-testid="flow">
      {nodes.map((node) => { const Card = nodeTypes[node.type]; return <div key={node.id} data-node={node.type} data-position={`${node.position.x}x${node.position.y}`} data-measured={node.measured ? `${node.measured.width}x${node.measured.height}` : undefined} data-initial-size={node.initialWidth ? `${node.initialWidth}x${node.initialHeight}` : undefined} aria-label={node.ariaLabel}><Card id={node.id} data={node.data} selected={node.selected ?? false} /></div> })}
      {edges.map((edge) => <span key={edge.id} data-edge={edge.id}>{edge.ariaLabel}</span>)}
    </div>
  },
}))

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 11, 0, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'researcher'): RunEvent => ({ id: `e${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })
const runRecord = { runId: 'run-1', sessionId: 'run-1', teamPath: 'demo.yaml', prompt: 'Summarise the repo', status: 'running', mode: 'pipeline', entrypoint: 'researcher', responder: 'reviewer', agentIds: ['researcher', 'reviewer'], createdAt: at(0), startedAt: at(0), finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null }

function renderWorkspace(runId: string | null = null, presentation: 'trace' | 'delivery' = 'trace') {
  const view = render(<Workspace harnesses={[]} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onDocumentOpen={vi.fn()} initialRunId={runId} />)
  // Existing graph regressions exercise the preserved Full trace surface.
  if (runId && presentation === 'trace') fireEvent.click(screen.getByRole('button', { name: 'Full trace' }))
  return view
}

async function openRunTrace() {
  const opener = await screen.findByRole('button', { name: 'Full trace' })
  fireEvent.click(opener)
  expect(screen.getByRole('application', { name: 'Run graph' })).toBeInTheDocument()
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?path=demo.yaml')
  // Ask LoomWatch keeps its panel open across pages in a tab; each test starts with it closed.
  window.sessionStorage.clear()
  sessionState.events = []
  composerLayoutState.nodes = []
  composerLayoutState.edges = []
  composerLayoutState.agents = {}
  documentState.responder = null
  flowRuntime.onNodesChange = null
  flowRuntime.onEdgesChange = null
  flowRuntime.onNodeDragStart = null
  flowRuntime.onNodeDragStop = null
  flowRuntime.onConnect = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/team/layout') && init?.method === 'PUT') return new Response(JSON.stringify({}), { status: 200 })
    // A **version-1** sidecar on purpose: the daemon stamps it forward, and every test in this
    // file therefore exercises the migration path as well as whatever it is about.
    if (url.startsWith('/api/team/layout?')) return new Response(JSON.stringify({ version: 1, nodes: composerLayoutState.nodes, edges: composerLayoutState.edges, agents: composerLayoutState.agents }), { status: 200 })
    if (url.startsWith('/api/runs/') && url.includes('/checkpoints')) return new Response(JSON.stringify([]), { status: 200 })
    if (url.endsWith('/api/runs') && init?.method === 'POST') return new Response(JSON.stringify({ ...runRecord, prompt: JSON.parse(String(init.body)).prompt, status: 'queued' }), { status: 202 })
    if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
    if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'] }), { status: 200 })
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('Workspace', () => {
  it('opens Ask LoomWatch from the header, ⌘J and the palette, where Build’s own words are suggested', async () => {
    renderWorkspace()
    const ask = () => screen.queryByRole('complementary', { name: 'Ask LoomWatch' })
    fireEvent.click(screen.getByRole('button', { name: 'Ask LoomWatch' }))
    expect(await screen.findByRole('complementary', { name: 'Ask LoomWatch' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message to Ask LoomWatch' })).toHaveAttribute('placeholder', 'Ask for a change, or say “run it”')
    expect(screen.getByRole('button', { name: 'Add a fact-checker before the last step' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(ask()).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: /Ask LoomWatch…/ }))
    expect(ask()).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  // ADR 0051: Run team opens the team's chat, where work starts only when you send @team.
  it('opens the team’s chat from Run team without starting work', async () => {
    renderWorkspace(undefined, 'delivery')
    expect(screen.queryByRole('button', {name: 'Preview next run'})).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: 'Run team'}))
    expect(screen.getByRole('region', {name: /chat$/})).toBeInTheDocument()
    expect(screen.getByRole('textbox', {name: 'Message the team'})).toBeInTheDocument()
    expect(await screen.findByRole('heading', {name: /^Talk to /})).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', {name: 'Build'}))
    expect(screen.getByRole('application', {name: 'Team canvas'})).toBeInTheDocument()
  })

  // ADR 0051: Details opens by default beside the chat, on the newest piece of work, and stays
  // closed once you close it.
  it('opens Details on the newest piece by default, and keeps it closed once closed', async () => {
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/chat?')) {
        return new Response(JSON.stringify({ teamKey: 'demo', teamPath: 'demo.yaml', more: false, items: [{ kind: 'work', run: runRecord, request: null, notes: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return fallback(input, init)
    }))
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    const details = await screen.findByRole('complementary', { name: 'Details of this piece of work' })
    expect(within(details).getByRole('main', { name: 'Run workspace' })).toBeInTheDocument()
    expect(window.location.search).toContain('run=run-1')
    fireEvent.click(within(details).getByRole('button', { name: 'Close details' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /chat$/ })).toBeInTheDocument()
  })

  // ADR 0051: a long answer is a document. Following the newest work, the pane beside the chat opens
  // on it once it is finished; its record is the other tab, and the card in the chat opens it again.
  it('opens a finished long answer on its Answer tab beside the chat, with its record a tab away', async () => {
    const fallback = globalThis.fetch
    const report = `# Market brief\n\n${'The market moved again today. '.repeat(40)}`
    const finished = { ...runRecord, runId: 'run-2', sessionId: 'run-2', status: 'succeeded', finishedAt: at(60), reply: report }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/chat?')) return new Response(JSON.stringify({ teamKey: 'demo', teamPath: 'demo.yaml', more: false, items: [{ kind: 'work', run: finished, request: null, notes: [] }] }), { status: 200 })
      if (url.includes('/api/runs/run-2')) return new Response(JSON.stringify(finished), { status: 200 })
      return fallback(input, init)
    }))
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    const pane = await screen.findByRole('complementary', { name: 'Details of this piece of work' })
    await waitFor(() => expect(within(pane).getByRole('tab', { name: 'Answer' })).toHaveAttribute('aria-selected', 'true'))
    expect(await within(pane).findByRole('heading', { name: 'Market brief', level: 1 })).toBeInTheDocument()
    fireEvent.click(within(pane).getByRole('tab', { name: 'Details' }))
    expect(within(pane).getByRole('main', { name: 'Run workspace' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Market brief, .* Open$/ }))
    expect(within(pane).getByRole('tab', { name: 'Answer' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /^Market brief, .* Showing beside the chat$/ })).toHaveAttribute('aria-pressed', 'true')
  })

  // A run opened by link is the chat with that piece's Details beside it; the Run tab comes back
  // to the chat, the one place you work with the team.
  it('opens a run’s Details beside the chat, and Run comes back to the chat after Build', async () => {
    // As a reloaded chat's address has it: the chat, and the piece open in Details.
    window.history.replaceState({}, '', '/?path=demo.yaml&view=chat&run=run-1')
    renderWorkspace('run-1', 'delivery')
    expect(screen.queryByText('Not started')).not.toBeInTheDocument()
    const details = screen.getByRole('complementary', { name: 'Details of this piece of work' })
    expect(within(details).getByRole('main', { name: 'Run workspace' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /chat$/ })).toBeInTheDocument()
    // The answer is read in the chat; Details is the record of how it was made, without a copy.
    expect(within(details).queryByRole('complementary', { name: 'Team output' })).toBeNull()
    // The chat's edge can be dragged, or moved with the keyboard, to give either side more room.
    expect(screen.getByRole('separator', { name: 'Resize the chat' })).toBeInTheDocument()
    // Esc closes Details, even on work still going, and keeps the chat: leaving the chat is the
    // Build tab's job. Its close button does the same.
    expect(within(details).getByRole('button', { name: 'Close details' })).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /chat$/ })).toBeInTheDocument()
    expect(window.location.search).not.toContain('run=run-1')
    fireEvent.click(screen.getByRole('button', { name: 'Build' }))
    expect(screen.getByRole('application', { name: 'Team canvas' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByRole('region', { name: /chat$/ })).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })


  /**
   * Decision 3: review, never auto — and never on a failed run.
   *
   * The counterfactual is the same fixture with `status: 'failed'`. A run that failed is precisely
   * the one whose observations are least likely to be right, so its notes stay as evidence of that
   * run rather than being offered for promotion, and the strip must not appear at all.
   */
  it('offers an after-run review only for a run that succeeded', async () => {
    const notebook = {
      teamId: 'demo', enabled: true, keep: 'review', inherited: [], inheritedTeams: [],
      notes: [{
        id: 'n1', noteKey: 'n1', teamId: 'demo', runId: 'run-1', authorAgentId: 'researcher',
        kind: 'decision', title: 'Hermes adapter is out of scope', body: 'Its OAuth path fails.',
        sources: [], state: 'active', revision: 1, revisedBy: 'researcher',
        createdAt: '2026-09-13T14:32:00.000Z',
      }],
    }
    const withStatus = (status: string) => vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/memory/notes')) return new Response(JSON.stringify(notebook), { status: 200 })
      if (url.startsWith('/api/memory?')) return new Response(JSON.stringify({ enabled: true, entries: [], budgetChars: 8000, usedChars: 0, deliverAs: 'native-file', inherited: [], inheritedTeams: [], notebookEnabled: true }), { status: 200 })
      if (url.startsWith('/api/team/layout?')) return new Response(JSON.stringify({ version: 1, nodes: [], edges: [] }), { status: 200 })
      if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify({ ...runRecord, status, finishedAt: at(10), reply: 'done' }), { status: 200 })
      if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
    })

    vi.stubGlobal('fetch', withStatus('succeeded'))
    renderWorkspace('run-1')
    await waitFor(() => expect(screen.getByTestId('review-strip')).toBeInTheDocument())
    expect(screen.getByTestId('review-strip')).toHaveTextContent('1 new note the next run could use')

    cleanup()
    vi.stubGlobal('fetch', withStatus('failed'))
    renderWorkspace('run-1')
    if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()
    expect(screen.queryByTestId('review-strip')).not.toBeInTheDocument()
  })

  it('shows the team canvas with the document chip, composer and the configured pipeline', () => {
    renderWorkspace()
    expect(screen.getByRole('application', { name: 'Team canvas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /demo.yaml, .*open team switcher/ })).toBeInTheDocument()
    expect(screen.getByText('2 steps in order')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Run ↵/ })).toBeDisabled()
    expect(screen.getByText('sequence from Researcher to Reviewer')).toBeInTheDocument()
  })

  it('keeps a capability card at each live drag position', async () => {
    composerLayoutState.nodes = [{ id: 'skill:claude-design', kind: 'skill', name: 'claude-design', source: 'Claude Code + OpenCode', position: { x: 10, y: 20 } }]
    renderWorkspace()
    const card = await screen.findByLabelText(/claude-design, skill from Claude Code \+ OpenCode/)

    act(() => flowRuntime.onNodesChange?.([{ id: 'skill:claude-design', type: 'position', position: { x: 122, y: 88 }, dragging: true }]))

    expect(card.closest('[data-node="capability"]')).toHaveAttribute('data-position', '122x88')
  })

  it('wires a Claude-discovered skill to a Codex agent', async () => {
    composerLayoutState.nodes = [{ id: 'skill:claude-design', kind: 'skill', name: 'claude-design', source: 'Claude Code', position: { x: 10, y: 20 } }]
    const reviewer = documentState.nodes[1].data.agent as AgentConfig
    const originalSpawn = reviewer.spawn
    reviewer.spawn = { cmd: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'], env: {}, cwd: '.' }
    renderWorkspace()
    await screen.findByLabelText(/claude-design, skill from Claude Code/)

    act(() => flowRuntime.onConnect?.({ source: 'reviewer', target: 'skill:claude-design' }))

    expect(documentState.setAgentCapabilities).toHaveBeenCalledWith('reviewer', [{ kind: 'skill', name: 'claude-design' }])
    reviewer.spawn = originalSpawn
  })

  it('removes only the selected skill edge from executable agent configuration', async () => {
    composerLayoutState.nodes = [{ id: 'skill:claude-design', kind: 'skill', name: 'claude-design', source: 'Claude Code', position: { x: 10, y: 20 } }]
    const reviewer = documentState.nodes[1].data.agent as AgentConfig
    const originalCapabilities = reviewer.capabilities
    reviewer.capabilities = [{ kind: 'skill', name: 'claude-design' }]
    const view = renderWorkspace()
    try {
      await screen.findByText('Reviewer uses skill claude-design')
      act(() => flowRuntime.onEdgesChange?.([{ id: 'capability:reviewer->skill:claude-design', type: 'select', selected: true }]))
      fireEvent.keyDown(window, { key: 'Delete' })

      expect(documentState.setAgentCapabilities).toHaveBeenCalledWith('reviewer', [])
    } finally {
      view.unmount()
      reviewer.capabilities = originalCapabilities
    }
  })

  it('removes a tool or connector edge from the canvas sidecar', async () => {
    composerLayoutState.nodes = [{ id: 'tool:computer', kind: 'tool', name: 'Computer', source: 'Claude Code', position: { x: 10, y: 20 } }]
    composerLayoutState.edges = [{ from: 'reviewer', to: 'tool:computer' }]
    const view = renderWorkspace()
    try {
      await screen.findByText('Reviewer invokes Computer')
      act(() => flowRuntime.onEdgesChange?.([{ id: 'capability:reviewer->tool:computer', type: 'remove' }]))

      await waitFor(() => {
        const writes = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/api/team/layout') && init?.method === 'PUT')
        expect(JSON.parse(String(writes.at(-1)?.[1]?.body)).layout.edges).toEqual([])
      }, { timeout: 2000 })
    } finally {
      view.unmount()
    }
  })

  /**
   * A card records the provenance the Library showed when it was placed. When another app later
   * turns out to hold the same skill, the Library's source changes; the card must still open the
   * Library's row, or the inspector asks the daemon for the card's own id and reports a stale daemon.
   */
  it('opens the Library row for a card whose recorded source has since changed', async () => {
    composerLayoutState.nodes = [{ id: 'skill:claude-design', kind: 'skill', name: 'claude-design', source: 'Claude Code + OpenCode', position: { x: 10, y: 20 } }]
    const inventory = { tools: [], sources: [], skills: [{ id: 'skill-a1eb6eeb', name: 'claude-design', source: 'Claude Code + Hermes + OpenCode', detail: 'Design one-off HTML artifacts.', status: 'Ready' as const }] }
    const view = render(<Workspace harnesses={[]} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onDocumentOpen={vi.fn()} initialRunId={null} capabilityInventory={inventory} />)
    try {
      await screen.findByLabelText(/claude-design, skill from Claude Code \+ OpenCode/)
      act(() => flowRuntime.onNodesChange?.([{ id: 'skill:claude-design', type: 'select', selected: true }]))

      const inspector = await screen.findByRole('complementary', { name: 'Selected resource settings' })
      expect(inspector).toHaveTextContent('Claude Code + Hermes + OpenCode')
      expect(inspector).not.toHaveTextContent('Planned capability on this canvas.')
    } finally {
      view.unmount()
    }
  })

  /**
   * ADR 0029: a tool is executable configuration, like a skill. A knowledge card that is not memory
   * was placed from the Library before ADR 0036; its name points at nothing the daemon can read, so
   * wiring it is refused with where knowledge is chosen now, and the team file is left alone.
   */
  it('wires a tool into the team file, and refuses a knowledge card that names no folder', async () => {
    composerLayoutState.nodes = [
      { id: 'tool:computer', kind: 'tool', name: 'Computer', source: 'Claude Code', position: { x: 10, y: 20 } },
      { id: 'knowledge:demo', kind: 'knowledge', name: 'demo project', source: 'LoomWatch', position: { x: 10, y: 120 } },
    ]
    const view = renderWorkspace()
    try {
      await screen.findByLabelText(/^Computer, .*from Claude Code/)
      act(() => flowRuntime.onConnect?.({ source: 'reviewer', target: 'tool:computer' }))
      expect(documentState.setAgentCapabilities).toHaveBeenLastCalledWith('reviewer', [{ kind: 'tool', name: 'Computer' }])
      vi.mocked(documentState.setAgentCapabilities).mockClear()
      act(() => flowRuntime.onConnect?.({ source: 'reviewer', target: 'knowledge:demo' }))
      expect(screen.getByText(/Knowledge is a folder or file you choose/)).toBeInTheDocument()
      expect(documentState.setAgentCapabilities).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })

  /**
   * ADR 0042: everything an agent is given is on the canvas. A folder two agents read is one card
   * with a line from each, drawn from the team file with no sidecar card, however each agent labels
   * it; a skill named only in the team file gets its card too.
   */
  it('draws one card for a folder its agents share, and a card for a skill only the team file names', async () => {
    const [researcher, reviewer] = documentState.nodes
    Object.assign(researcher.data.agent, { capabilities: [{ kind: 'knowledge', name: 'reports', path: '/Users/me/reports' }, { kind: 'skill', name: 'claude-design' }] })
    Object.assign(reviewer.data.agent, { capabilities: [{ kind: 'knowledge', name: 'Q3 reports', path: '/Users/me/reports/' }] })
    const view = renderWorkspace()
    try {
      expect(await screen.findAllByLabelText(/^reports, linked folder at \/Users\/me\/reports, used by 2 agents$/)).toHaveLength(1)
      expect(screen.getByText('Researcher reads reports')).toBeInTheDocument()
      expect(screen.getByText('Reviewer reads reports')).toBeInTheDocument()
      expect(screen.getByLabelText(/^claude-design, skill from Not found on this computer, used by 1 agent$/)).toBeInTheDocument()
      expect(screen.getByText('Researcher uses skill claude-design')).toBeInTheDocument()

      // Taking one agent's line away disconnects that agent only, by path, whatever its label.
      act(() => flowRuntime.onEdgesChange?.([{ id: 'capability:reviewer->knowledge@/Users/me/reports', type: 'remove' }]))
      expect(documentState.setAgentCapabilities).toHaveBeenLastCalledWith('reviewer', [])
    } finally {
      view.unmount()
      Reflect.deleteProperty(researcher.data.agent, 'capabilities')
      Reflect.deleteProperty(reviewer.data.agent, 'capabilities')
    }
  })

  /**
   * ADR 0042: drawing a line from an agent to a folder card connects that agent to the same path,
   * and taking away the card's last line keeps the card where it is, saved in the sidecar.
   */
  it('connects another agent to a folder card by its path, and keeps the card once nobody reads it', async () => {
    const [researcher] = documentState.nodes
    Object.assign(researcher.data.agent, { capabilities: [{ kind: 'knowledge', name: 'reports', path: '/Users/me/reports' }] })
    const view = renderWorkspace()
    try {
      await screen.findByLabelText(/^reports, linked folder at \/Users\/me\/reports, used by 1 agent$/)
      act(() => flowRuntime.onConnect?.({ source: 'reviewer', target: 'knowledge@/Users/me/reports' }))
      expect(documentState.setAgentCapabilities).toHaveBeenLastCalledWith('reviewer', [{ kind: 'knowledge', name: 'reports', path: '/Users/me/reports' }])

      act(() => flowRuntime.onEdgesChange?.([{ id: 'capability:researcher->knowledge@/Users/me/reports', type: 'remove' }]))
      expect(documentState.setAgentCapabilities).toHaveBeenLastCalledWith('researcher', [])
      await waitFor(() => {
        const writes = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/api/team/layout') && init?.method === 'PUT')
        expect(JSON.parse(String(writes.at(-1)?.[1]?.body)).layout.nodes).toEqual([
          expect.objectContaining({ id: 'knowledge@/Users/me/reports', kind: 'knowledge', name: 'reports', source: 'Linked folder', path: '/Users/me/reports' }),
        ])
      }, { timeout: 2000 })
    } finally {
      view.unmount()
      Reflect.deleteProperty(researcher.data.agent, 'capabilities')
    }
  })

  /**
   * ADR 0042: a row from the add panel dropped onto an agent connects it to that agent, whatever
   * it is, and the agent's card says it will take it while the row is over it. Dropped anywhere
   * else, it is only placed.
   */
  it('connects a folder, skill or memory dropped onto an agent, and lights the agent it is over', async () => {
    const view = renderWorkspace()
    const drag = (payload: object, x: number, y: number) => ({
      preventDefault: () => {}, clientX: x, clientY: y,
      dataTransfer: { types: ['application/loomwatch-capability'], dropEffect: '', getData: (mime: string) => (mime === 'application/loomwatch-capability' ? JSON.stringify(payload) : '') },
    })
    try {
      await waitFor(() => expect(flowRuntime.onDrop).toBeTruthy())
      const folder = { kind: 'knowledge', name: 'reports', source: 'Linked folder', path: '/Users/me/reports' }
      act(() => flowRuntime.onDragOver?.(drag(folder, 320, 20)))
      expect(screen.getByText('Reviewer', { selector: '.node-name' }).closest('article')).toHaveClass('drop-target')
      expect(screen.getByText('Researcher', { selector: '.node-name' }).closest('article')).not.toHaveClass('drop-target')

      act(() => flowRuntime.onDrop?.(drag(folder, 320, 20)))
      expect(documentState.setAgentCapabilities).toHaveBeenLastCalledWith('reviewer', [{ kind: 'knowledge', name: 'reports', path: '/Users/me/reports' }])
      expect(screen.getByText('Reviewer', { selector: '.node-name' }).closest('article')).not.toHaveClass('drop-target')

      act(() => flowRuntime.onDrop?.(drag({ kind: 'skill', name: 'claude-design', source: 'Claude Code' }, 20, 20)))
      expect(documentState.setAgentCapabilities).toHaveBeenLastCalledWith('researcher', [{ kind: 'skill', name: 'claude-design' }])

      act(() => flowRuntime.onDrop?.(drag({ kind: 'knowledge', name: 'Research team · memory', source: 'LoomWatch', memory: { team: 'research-team' } }, 320, 20)))
      expect(documentState.addMemoryInherit).toHaveBeenLastCalledWith({ team: 'research-team', appliesTo: ['reviewer'] })

      vi.mocked(documentState.setAgentCapabilities).mockClear()
      act(() => flowRuntime.onDrop?.(drag(folder, 1200, 900)))
      expect(documentState.setAgentCapabilities).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })

  /**
   * Wiring drawn before ADR 0029 lives only in the sidecar: drawn, never delivered. The canvas says
   * so and one click writes it to the team file — and redrawing it is not refused as a duplicate.
   * A knowledge card's edge is not offered: it could only fail the run (ADR 0036).
   */
  it('offers to deliver sidecar-only wiring and lets it be redrawn', async () => {
    composerLayoutState.nodes = [
      { id: 'tool:computer', kind: 'tool', name: 'Computer', source: 'Claude Code', position: { x: 10, y: 20 } },
      { id: 'knowledge:demo', kind: 'knowledge', name: 'demo project', source: 'LoomWatch', position: { x: 10, y: 120 } },
      { id: 'knowledge:memory', kind: 'knowledge', name: 'Research · memory', source: 'LoomWatch', position: { x: 10, y: 220 }, memory: { team: 'research' } },
    ]
    composerLayoutState.edges = [{ from: 'reviewer', to: 'tool:computer' }, { from: 'reviewer', to: 'knowledge:demo' }]
    const view = renderWorkspace()
    try {
      const deliver = await screen.findByRole('button', { name: 'Deliver on the next run' })
      expect(deliver.closest('p')).toHaveTextContent('One connection on the canvas is drawn but not delivered to agents yet.')
      fireEvent.click(deliver)
      expect(documentState.setAgentCapabilities).toHaveBeenLastCalledWith('reviewer', [{ kind: 'tool', name: 'Computer' }])

      vi.mocked(documentState.setAgentCapabilities).mockClear()
      act(() => flowRuntime.onConnect?.({ source: 'reviewer', target: 'tool:computer' }))
      expect(screen.queryByText('That agent already reaches this capability.')).not.toBeInTheDocument()
      expect(documentState.setAgentCapabilities).toHaveBeenCalledWith('reviewer', [{ kind: 'tool', name: 'Computer' }])
    } finally {
      view.unmount()
    }
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

  it('puts the getting-started guide’s example in the request box without running it', () => {
    renderWorkspace()
    act(() => { window.dispatchEvent(new CustomEvent('loomwatch:compose', { detail: 'Give me three ideas' })) })
    expect(screen.getByLabelText('What should the team do?')).toHaveValue('Give me three ideas')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('starts a run from the composer and rewires the canvas into the prompt-to-output story', async () => {
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
    if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()
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
    if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()
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
    fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Saving demo.yaml/)).not.toBeInTheDocument()
    await act(async () => { release(new Response(JSON.stringify({ ...runRecord, status: 'queued' }), { status: 202 })) })
    if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()
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
    fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
    // A dropped connection is said in plain words, not as the browser's TypeError.
    expect(await screen.findByRole('alert')).toHaveTextContent('Can’t reach the LoomWatch server')
    expect(screen.getByLabelText('What should the team do?')).toHaveValue('Summarise the repo')
    fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
    await waitFor(() => expect(startKeys).toHaveLength(2))
    expect(startKeys[1]).toBe(startKeys[0])
    expect(startKeys[0]).toMatch(/\S/)
  })

  // §1.6: "the client re-`GET`s by start key." The POST started a run and the answer was lost;
  // the operator must end up in that run, not looking at an error for work that is under way.
  it('recovers the run a lost submit actually started, by start key (§1.6)', async () => {
    let posted: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/runs') && init?.method === 'POST') { posted = JSON.parse(String(init.body)).startKey; throw new TypeError('connection lost') }
      if (url.includes('/api/runs?startKey=')) {
        return posted && url.includes(encodeURIComponent(posted))
          ? new Response(JSON.stringify({ ...runRecord, status: 'queued' }), { status: 200 })
          : new Response(JSON.stringify({ error: 'no run exists for that start key' }), { status: 404 })
      }
      if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
      if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
    }))
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
    if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('What should the team do?')).toHaveValue('')
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
    fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
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
    // TNG89 §15.2.3: evidence folds to a count on the agent card and fans for one agent at a
    // time, so the cards are a disclosure now — the count, its owner and the fan are what the
    // canvas offers first. Everything below this line is what §12 row 28 still requires of a
    // fanned card, unchanged.
    const fan = await screen.findByRole('button', { name: '1 event from Researcher · lead; fan its evidence' })
    expect(fan).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /Inspect command: \$ cargo test/ })).not.toBeInTheDocument()
    fireEvent.click(fan)
    await waitFor(() => expect(screen.getByRole('button', { name: /Inspect command: \$ cargo test, recorded, Researcher · lead, succeeded, event 1/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /fold its evidence/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText(/Researcher, Researcher · lead, DONE, Reply delivered/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Reviewer, Reviewer · final answer, STREAMING/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Output response from Reviewer, Streaming/)).toHaveTextContent('Looks good.')
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
    expect(screen.getByRole('complementary', { name: /cargo test/ })).toHaveTextContent('Researcher · lead')
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

  it('keeps the schedule card measured, so React Flow does not leave it hidden', async () => {
    // The regression: `__schedule` changes were filtered out wholesale before reaching the
    // document, which also threw away the `dimensions` change React Flow emits after measuring
    // it. A controlled `nodes` prop rebuilt each render then had no size to hand back, and the
    // card settled at `visibility: hidden` — present, positioned, and invisible.
    Object.assign(documentState, { teamSchedule: { cron: '0 8 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the daily digest.' } })
    renderWorkspace()

    const card = () => screen.getByLabelText(/Schedule trigger, Daily/).closest('[data-node]')
    // React Flow's `nodeHasDimensions` accepts measured OR declared size, so the card carries its
    // own CSS size from the first frame and can never wait, invisible, to be measured.
    expect(card()).toHaveAttribute('data-initial-size', '276x96')

    act(() => flowRuntime.onNodesChange?.([{ id: '__schedule', type: 'dimensions', dimensions: { width: 276, height: 112 } }]))

    // The real measurement still refines it.
    expect(card()).toHaveAttribute('data-measured', '276x112')
    // The team document still never hears about a node it does not own.
    expect(documentState.onNodesChange).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: '__schedule' })]))

    Object.assign(documentState, { teamSchedule: null })
  })

  it('rewrites a schedule the editor cannot show, instead of saving the problem straight back', async () => {
    // The regression: "Save schedule" spread the loaded block back into the document, so a key
    // the friendly editor never renders (here a non-boolean `enabled`) survived every save — the
    // node stayed red and the composer stayed blocked with nothing to click.
    Object.assign(documentState, {
      isValid: false,
      documentChipState: 'invalid',
      saveState: 'dirty',
      teamSchedule: { cron: '0 8 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the daily digest.', enabled: 'yes-please', retries: 3 },
      documentProblems: [{ message: '/schedule/enabled must be boolean', yamlPath: ['schedule', 'enabled'] }],
      yamlPreview: 'schedule:\n  cron: "0 8 * * *"\n',
    })
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: /Schedule trigger.*Needs attention/ }))

    // The panel names the problem in the operator's language and warns about the doomed key.
    expect(screen.getByRole('alert')).toHaveTextContent('A schedule is either on or off')
    expect(screen.getByRole('form', { name: 'Edit schedule' })).toHaveTextContent('Saving removes retries')

    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    expect(documentState.updateTeamSchedule).toHaveBeenLastCalledWith({ cron: '0 8 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the daily digest.', enabled: true })

    // Once validation comes back clean the panel switches to the *other* meaning of "saved".
    Object.assign(documentState, { isValid: true, documentChipState: 'dirty', documentProblems: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(screen.getByRole('form', { name: 'Edit schedule' })).toHaveTextContent('The team file still needs saving'))
    fireEvent.click(screen.getByRole('button', { name: /Save team file/ }))
    expect(documentState.save).toHaveBeenCalled()

    Object.assign(documentState, { isValid: true, documentChipState: 'clean', saveState: 'clean', teamSchedule: null, documentProblems: [], yamlPreview: 'a: 1' })
  })

  it('adds a schedule from the Build heading, and only once its task is written', async () => {
    // The regression: a team without a `schedule:` block had no way to get one short of editing
    // the YAML by hand, because the schedule card — the only way into the editor — needs one.
    documentState.updateTeamSchedule.mockClear()
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))

    // The card appears where the schedule will live, and the editor opens on it.
    expect(screen.getByLabelText(/Schedule trigger, Weekdays at/)).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Edit schedule' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument()
    // Nothing to remove yet: the schedule is not on the team until it is saved.
    expect(screen.queryByRole('button', { name: 'Remove schedule' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled()
    expect(screen.getByRole('form', { name: 'Edit schedule' })).toHaveTextContent('Not added yet')

    fireEvent.change(screen.getByLabelText('Scheduled task'), { target: { value: 'Prepare the morning digest.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
    expect(documentState.updateTeamSchedule).toHaveBeenCalledWith(expect.objectContaining({ cron: '0 8 * * 1-5', prompt: 'Prepare the morning digest.' }))
  })

  it('drops an unsaved schedule when its editor closes', async () => {
    documentState.updateTeamSchedule.mockClear()
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByLabelText(/Schedule trigger/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument()
    expect(documentState.updateTeamSchedule).not.toHaveBeenCalled()
  })

  it('removes a saved schedule from its panel, and offers no second way in while it exists', async () => {
    Object.assign(documentState, { teamSchedule: { cron: '0 8 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the daily digest.' } })
    renderWorkspace()
    // The card is the schedule's one control (ADR 0043).
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Schedule trigger.*Daily/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove schedule' }))
    expect(documentState.removeTeamSchedule).toHaveBeenCalled()
    expect(screen.queryByRole('form', { name: 'Edit schedule' })).not.toBeInTheDocument()

    Object.assign(documentState, { teamSchedule: null })
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
      if (url.includes('/checkpoints')) return new Response(JSON.stringify([]), { status: 200 })
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
  // ---- Canvas A: one canvas (TNG89 §15, acceptance rows 40–45) --------------------------
  //
  // The rule under test throughout: the configured graph never moves; a run is drawn onto it.

  const nodeKinds = (container: HTMLElement) => [...container.querySelectorAll('[data-node]')].map((node) => node.getAttribute('data-node'))
  const positionOf = (name: string) => screen.getByText(name, { selector: '.node-name' }).closest('[data-node]')!.getAttribute('data-position')

  describe('one canvas', () => {
    it('opens a run without moving a single configured node (row 40)', async () => {
      renderWorkspace()
      // The document's own positions, which the retired story column replaced with a computed
      // causal stack the moment a run started.
      expect(positionOf('Researcher')).toBe('0x0')
      expect(positionOf('Reviewer')).toBe('300x0')

      fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
      fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
      if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()

      expect(positionOf('Researcher')).toBe('0x0')
      expect(positionOf('Reviewer')).toBe('300x0')
    })

    it('docks the Prompt first and the Output last, with and without a run (rows 23, 24, 42)', async () => {
      const { container } = renderWorkspace()
      expect(nodeKinds(container)[0]).toBe('agent')
      expect(nodeKinds(container).at(-1)).toBe('response')

      fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
      fireEvent.click(screen.getByRole('button', { name: /^Run ↵/ }))
      if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()

      const kinds = nodeKinds(container)
      expect(kinds[0]).toBe('prompt')
      expect(kinds.at(-1)).toBe('response')
      // Docked, not stacked: the anchors are one gutter either side of the agents the operator
      // placed, computed from those positions rather than from a layout of their own.
      expect(screen.getByLabelText(/Prompt, original user request/).closest('[data-node]')).toHaveAttribute('data-position', '-460x0')
      expect(screen.getByLabelText(/Output response|Output,/).closest('[data-node]')).toHaveAttribute('data-position', '760x0')
    })

    it('opens the Run request from Build without adding a prompt node to the canvas', () => {
      const { container } = renderWorkspace()
      expect(nodeKinds(container)).not.toContain('prompt')
      fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Message the team' }), { target: { value: '@team Audit the harnesses' } })
      expect(screen.getByRole('textbox', { name: 'Message the team' })).toHaveValue('@team Audit the harnesses')
      expect(screen.getByText(/^Starts the team/)).toBeInTheDocument()
      expect(nodeKinds(container)).not.toContain('prompt')
    })

    it('draws the planned Output and names the stage that will fill it', () => {
      renderWorkspace()
      const output = screen.getByLabelText('Output, No run yet.')
      expect(output).toHaveTextContent("The team's answer appears here when Reviewer replies.")
      expect(output).toHaveClass('planned')
      // No attempt exists, so nothing claims a live channel or credits a producer.
      expect(output).not.toHaveTextContent('Live')
      expect(output).not.toHaveTextContent('Replay')
    })

    it('connects Output to the responder explicitly chosen by the operator', () => {
      documentState.responder = 'researcher'
      const view = renderWorkspace()
      try {
        expect(screen.getByLabelText('Output, No run yet.')).toHaveTextContent("The team's answer appears here when Researcher replies.")
        expect(screen.getByText('responds with from Researcher to the output')).toBeInTheDocument()
      } finally {
        view.unmount()
        documentState.responder = null
      }
    })

    // ADR 0034: the Inspector no longer repeats the Output wire, the Output editor and "Final
    // response owner" with a fourth responder control. It says where the agent sits instead.
    it('says in the agent Inspector where the agent sits, instead of a fourth responder control', () => {
      const researcher = documentState.nodes[0]
      researcher.selected = true
      const view = renderWorkspace()
      try {
        expect(screen.getByRole('region', { name: 'Context' })).toHaveTextContent(/Step 1 of \d · receives your request first/)
        fireEvent.click(screen.getByRole('button', { name: 'Model and more settings' }))
        expect(screen.queryByRole('button', { name: /Produces the team output/ })).not.toBeInTheDocument()
        expect(screen.getByText(/Step 1 of \d · receives your request first/)).toBeInTheDocument()
      } finally {
        view.unmount()
        researcher.selected = false
      }
    })

    it('lets the operator wire an agent directly to Output to choose the responder', () => {
      renderWorkspace()
      act(() => flowRuntime.onConnect?.({ source: 'researcher', target: '__output' }))
      expect(documentState.promoteResponder).toHaveBeenCalledWith('researcher')
    })

    it('does not reconnect Output when a newly added agent is still disconnected', () => {
      const originalNodes = documentState.nodes
      const originalSteps = documentState.pipelineSteps
      documentState.nodes = [...originalNodes, {
        id: 'new-agent', type: 'agent', position: { x: 600, y: 0 }, selected: false,
        data: { label: 'New Agent', agent: { id: 'new-agent', name: 'New Agent', role: 'Unwired', model: 'demo', status: 'idle', spawn: { cmd: 'fake', args: [], env: {}, cwd: '.' } } },
      }]
      // This is intentionally how pipelineOrder represents an invalid draft: the orphan remains
      // inspectable at the end of the list, but it is not part of the entrypoint's execution path.
      documentState.pipelineSteps = [...originalSteps, { id: 'new-agent', step: 3, joinFrom: [] }]
      const view = renderWorkspace()
      try {
        expect(screen.getByLabelText('Output, No run yet.')).toHaveTextContent("The team's answer appears here when Reviewer replies.")
        expect(screen.getByText('responds with from Reviewer to the output')).toBeInTheDocument()
        expect(screen.queryByText('responds with from New Agent to the output')).not.toBeInTheDocument()
      } finally {
        view.unmount()
        documentState.nodes = originalNodes
        documentState.pipelineSteps = originalSteps
      }
    })

    it('fans one agent at a time, folding the other, and keeps every card exact (row 43)', async () => {
      sessionState.events = [
        event(0, 'process', { phase: 'spawned', pid: 1 }),
        event(1, 'tool_call', { callId: 'c1', title: '$ cargo test', name: 'terminal', toolKind: 'execute', status: 'in_progress' }),
        event(2, 'tool_update', { callId: 'c1', status: 'completed' }),
        event(3, 'message', { role: 'agent', content: { type: 'text', text: 'Lead done.' } }),
        event(4, 'tool_call', { callId: 'c2', title: '$ cargo clippy', name: 'terminal', toolKind: 'execute', status: 'in_progress' }, 'reviewer'),
        event(5, 'tool_update', { callId: 'c2', status: 'completed' }, 'reviewer'),
      ]
      const { container } = renderWorkspace('run-1')
      const lead = await screen.findByRole('button', { name: '1 event from Researcher · lead; fan its evidence' })
      const responder = screen.getByRole('button', { name: '1 event from Reviewer · final answer; fan its evidence' })
      // Folded is the default: the count is on the card and no evidence node is rendered.
      expect(container.querySelectorAll('[data-node="evidence"]')).toHaveLength(0)

      fireEvent.click(lead)
      expect(container.querySelectorAll('[data-node="evidence"]')).toHaveLength(1)
      // Row 28 / §15.3: owner, ordinal, time and state are properties of the record, so they are
      // unchanged by being fanned.
      expect(screen.getByRole('button', { name: 'Inspect command: $ cargo test, recorded, Researcher · lead, succeeded, event 1, 01.0s' })).toBeInTheDocument()

      fireEvent.click(responder)
      expect(container.querySelectorAll('[data-node="evidence"]')).toHaveLength(1)
      expect(screen.queryByRole('button', { name: /cargo test/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Inspect command: $ cargo clippy, recorded, Reviewer · final answer, succeeded, event 2, 04.0s' })).toBeInTheDocument()

      // Esc folds the fan; it does not clear the run.
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(container.querySelectorAll('[data-node="evidence"]')).toHaveLength(0)
      expect(screen.getByRole('application', { name: 'Run graph' })).toBeInTheDocument()
    })

    // The replay bar's Clear did what the Build tab does (ADR 0043).
    it('returns to Build from the full trace through the Build tab', async () => {
      sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
      const { container } = renderWorkspace('run-1')
      await waitFor(() => expect(screen.getByRole('group', { name: 'Lifecycle summary' })).toBeInTheDocument())
      expect(container.querySelector('.lw-shell')).toHaveClass('run-shown')

      expect(screen.queryByRole('button', { name: 'Clear this run and show the design alone' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back to output' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Build' }))

      expect(screen.getByRole('application', { name: 'Team canvas' })).toBeInTheDocument()
      expect(container.querySelector('.lw-shell')).not.toHaveClass('run-shown')
      expect(container.querySelector('.lw-shell')).not.toHaveClass('compose-view')
      // The design is intact, and the two docked nodes are back to their pre-run state.
      expect(positionOf('Researcher')).toBe('0x0')
      expect(nodeKinds(container)).not.toContain('run')
      expect(screen.queryByRole('button', { name: /Prompt, your draft/ })).not.toBeInTheDocument()
      expect(window.location.search).not.toContain('run=')

      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      expect(screen.queryByRole('button', { name: /Back to the team canvas/ })).not.toBeInTheDocument()
    })

    it('treats a drag during a run as the edit it is, not as view state (row 41)', async () => {
      sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
      renderWorkspace('run-1')
      if (!screen.queryByRole('application', { name: 'Run graph' })) await openRunTrace()
      documentState.onNodesChange.mockClear()

      const change = { id: 'researcher', type: 'position', position: { x: 64, y: 24 }, dragging: true }
      act(() => flowRuntime.onNodeDragStart?.(new MouseEvent('mousedown'), { id: 'researcher' }))
      act(() => flowRuntime.onNodesChange?.([change]))
      act(() => flowRuntime.onNodeDragStop?.(new MouseEvent('mouseup'), { id: 'researcher', position: { x: 64, y: 24 } }))

      // The document hears the drag, exactly as it does outside a run — the old run branch
      // swallowed it into local `runPositions` instead.
      expect(documentState.onNodesChange).toHaveBeenCalledWith([change])
      expect(documentState.capturePositionHistory).toHaveBeenCalled()
      expect(documentState.settleNodeCollision).toHaveBeenCalledWith('researcher', { x: 64, y: 24 })
    })

    it('keeps the output and capabilities reader below 768 px', async () => {
      const width = window.innerWidth
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420, writable: true })
      sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
      renderWorkspace('run-1', 'delivery')
      await waitFor(() => expect(screen.getByRole('main', { name: 'Run workspace' })).toBeInTheDocument())
      expect(screen.queryByRole('application', { name: 'Run graph' })).not.toBeInTheDocument()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true })
    })

    it('opens the packet inspector for the entry point, which was handed nothing', async () => {
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/context')) {
          return new Response(JSON.stringify([{ agentId: 'researcher', invocation: 0, createdAt: at(0), text: '## What the team knows\nShip on ACP v1.', sections: [{ kind: 'brief', label: 'Brief', rationale: '1 entry · pinned', chars: 21 }], budgetChars: 8000, usedChars: 21 }]), { status: 200 })
        }
        if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
        return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
      })
      sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
      renderWorkspace('run-1')

      const chips = await screen.findAllByRole('button', { name: 'What it was given' })
      fireEvent.click(chips[0])
      const panel = await screen.findByRole('region', { name: /What Researcher was given/ })
      expect(panel).toHaveTextContent('no preceding stage')
      expect(panel).toHaveTextContent('1 entry · pinned')
    })
  })
  // ---- ADR 0016: positions in the sidecar, contract in the team file -------------------------

  /**
   * TNG89 §15 acceptance row 41 becomes literal: a drag writes the **sidecar**, never the team
   * file, and the position survives a reload.
   *
   * Before this, node positions were nowhere: not in the team file (`additionalProperties: false`
   * at every level) and not in the sidecar either, so a drag was session-only view state and the
   * row was unsatisfiable as written. The two assertions here are the whole decision — the sidecar
   * `PUT` carries the position, and the team `PUT` never happens.
   */
  it('saves an agent drag to the layout sidecar and never to the team file (row 41)', async () => {
    renderWorkspace()
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/team/layout?'))).toBe(true))

    act(() => flowRuntime.onNodesChange?.([{ id: 'reviewer', type: 'position', position: { x: 480, y: 240 }, dragging: false }]))
    // The document took the drag as the ordinary edit it is — the same call a compose-view drag
    // makes — and the sidecar is where it lands.
    expect(documentState.onNodesChange).toHaveBeenCalled()

    await waitFor(() => {
      const written = vi.mocked(fetch).mock.calls.find(([url, init]) =>
        String(url).endsWith('/api/team/layout') && init?.method === 'PUT')
      expect(written).toBeDefined()
      expect(JSON.parse(String(written![1]!.body)).layout.agents).toEqual({
        researcher: { x: 0, y: 0 },
        reviewer: { x: 300, y: 0 },
      })
    }, { timeout: 2000 })
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).startsWith('/api/team') && !String(url).includes('layout') && init?.method === 'PUT')).toBe(false)
  })

  /** On load the positions come from the sidecar; an agent it says nothing about keeps its seed. */
  it('restores saved positions on load and leaves an unsaved agent on its seeded position', async () => {
    composerLayoutState.agents = { reviewer: { x: 640, y: 320 } }
    renderWorkspace()
    await waitFor(() => expect(documentState.applyPositions).toHaveBeenCalledWith({ reviewer: { x: 640, y: 320 } }))
    // Exactly once per document: hydrating on every render would fight a drag in progress.
    expect(vi.mocked(documentState.applyPositions).mock.calls).toHaveLength(1)
  })

  /**
   * An agent that left the team file must not keep a saved position — the same rule that prunes
   * an orphaned capability edge. It falls out of writing *today's* agents rather than from a
   * deletion path that could be forgotten, and this is the test that says so.
   */
  it('drops the saved position of an agent that left the team file', async () => {
    composerLayoutState.agents = { researcher: { x: 0, y: 0 }, reviewer: { x: 300, y: 0 }, retired: { x: 900, y: 900 } }
    renderWorkspace()
    await waitFor(() => {
      const written = vi.mocked(fetch).mock.calls.find(([url, init]) =>
        String(url).endsWith('/api/team/layout') && init?.method === 'PUT')
      expect(written).toBeDefined()
      expect(Object.keys(JSON.parse(String(written![1]!.body)).layout.agents).sort()).toEqual(['researcher', 'reviewer'])
    }, { timeout: 2000 })
  })

  // ---- §7 finish: wiring a memory knowledge card ---------------------------------------------

  /**
   * Drawing an edge from an agent to a memory card writes `memory.inherits[].appliesTo` in the
   * **team file** — executable configuration, through the byte-preserving document model — and
   * taking the card off the canvas removes the entry again.
   *
   * Before this the edge went through `composerLayout.connect`, which writes the *sidecar*: the
   * operator drew a line and the daemon supplied nothing. The missing link was that a sidecar card
   * had no field for a team id, which ADR 0016 adds.
   */
  it('wires a memory card into memory.inherits, and removing the card removes the entry', async () => {
    composerLayoutState.nodes = [{
      id: 'knowledge:research-team-memory', kind: 'knowledge', name: 'Research team · memory',
      source: 'LoomWatch', position: { x: 0, y: 300 }, memory: { team: 'research-team' },
    }]
    renderWorkspace()
    await screen.findByLabelText(/Research team · memory, knowledge source from LoomWatch/)

    // An agent reads it: `appliesTo` names that agent and nothing else.
    act(() => flowRuntime.onConnect?.({ source: 'reviewer', target: 'knowledge:research-team-memory' }))
    expect(documentState.addMemoryInherit).toHaveBeenCalledWith({ team: 'research-team', appliesTo: ['reviewer'] })

    // The Prompt node is the operator, so wiring from it is the whole-team form — written as the
    // **absence** of `appliesTo`, never as a list of today's agents.
    act(() => flowRuntime.onConnect?.({ source: '__prompt', target: 'knowledge:research-team-memory' }))
    expect(documentState.addMemoryInherit).toHaveBeenCalledWith({ team: 'research-team', appliesTo: undefined })

    // Taking the card off the canvas stops the daemon supplying it.
    act(() => flowRuntime.onNodesChange?.([{ id: 'knowledge:research-team-memory', type: 'remove' }]))
    expect(documentState.removeMemoryInherit).toHaveBeenCalledWith({ team: 'research-team' })
  })

  /**
   * A `memory.inherits` entry written by hand in the YAML draws a card and its edges, so the
   * canvas and the team file are one picture rather than two.
   */
  it('draws a card for a memory.inherits entry the sidecar knows nothing about', async () => {
    documentState.memoryInherits = [{ team: 'research-team', appliesTo: ['reviewer'] }]
    try {
      renderWorkspace()
      const card = await screen.findByLabelText(/research-team · memory, knowledge source from LoomWatch, used by 1 agent/)
      expect(card).toBeInTheDocument()
      expect(screen.getByText('Reviewer reads research-team · memory')).toBeInTheDocument()
    } finally {
      documentState.memoryInherits = []
    }
  })

  /** A whole-team inherit is drawn from the permanent Prompt node, because that node is you. */
  it('draws a whole-team inherit from the Prompt node', async () => {
    documentState.memoryInherits = [{ pack: 'packs/onboarding.memory' }]
    try {
      renderWorkspace()
      await screen.findByLabelText(/packs\/onboarding.memory, knowledge source from imported/)
      expect(screen.getByText('the whole team reads packs/onboarding.memory')).toBeInTheDocument()
    } finally {
      documentState.memoryInherits = []
    }
  })
})


it.each(['review_stop', 'question'] as const)('answers a %s from the live workspace and shows Attention without starting another run', async (kind) => {
  const waiting = { node: 'reviewer', name: 'Reviewer', kind, since: at(4), question: 'Approve the smaller budget?', park: 'kept_alive', parkNote: 'Researcher is kept alive', handoverFrom: kind === 'review_stop' ? 'researcher' : null, sendBackAvailable: kind === 'review_stop', context: 'The budget is 20.', questionId: 'q-1' }
  const fallback = globalThis.fetch
  const calls: Array<{ url: string; body: unknown }> = []
  let answered = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') calls.push({ url, body: JSON.parse(String(init.body)) })
    if (url === '/api/runs/run-1/answers') {
      answered = true
      return new Response(JSON.stringify({ ...runRecord, waitingOn: null }), { status: 202 })
    }
    if (url === '/api/runs/run-1') return new Response(JSON.stringify({ ...runRecord, waitingOn: answered ? null : waiting }), { status: 200 })
    return fallback(input, init)
  }))
  renderWorkspace('run-1')
  // A review stop's box is the operator's note; a question's is the answer to whoever asked.
  const label = kind === 'review_stop' ? 'Your note to the team' : 'Answer to Reviewer'
  const textbox = await screen.findByLabelText(label)
  expect(screen.getAllByText(/waiting for you/i).length).toBeGreaterThan(0)
  expect(screen.getAllByText('Approve the smaller budget?').length).toBeGreaterThan(0)
  fireEvent.change(textbox, { target: { value: 'Proceed with the smaller budget.' } })
  fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true })
  await waitFor(() => expect(calls).toEqual([{ url: '/api/runs/run-1/answers', body: { node: 'reviewer', text: 'Proceed with the smaller budget.' } }]))
  await waitFor(() => expect(screen.queryByLabelText(label)).not.toBeInTheDocument())
})

it('organizes execution and resources without changing the team, and restores the old arrangement', async () => {
  composerLayoutState.nodes = [{ id: 'knowledge:source', kind: 'knowledge', name: 'source', source: 'local', position: { x: -400, y: -200 } }]
  composerLayoutState.edges = [{ from: 'researcher', to: 'knowledge:source' }]
  renderWorkspace()
  // Organize and its undo live in the view bar only (ADR 0043).
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  expect(screen.queryByRole('menuitem', { name: /Organize/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  const organize = await screen.findByRole('button', { name: /^Organize$/ })
  await waitFor(() => expect(organize).toBeEnabled())
  fireEvent.click(organize)
  const positions = vi.mocked(documentState.applyPositions).mock.calls.at(-1)![0]
  expect(positions.reviewer.x).toBeGreaterThan(positions.researcher.x)
  expect(positions.reviewer.y).toBe(positions.researcher.y)
  await waitFor(() => {
    const writes = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/api/team/layout') && init?.method === 'PUT')
    const layout = JSON.parse(String(writes.at(-1)?.[1]?.body)).layout
    expect(layout.nodes[0].position.x).toBe(positions.researcher.x)
    expect(layout.nodes[0].position.y).toBeGreaterThan(positions.researcher.y + 150)
  }, { timeout: 2000 })
  fireEvent.click(await screen.findByRole('button', { name: 'Undo organize' }))
  expect(documentState.applyPositions).toHaveBeenLastCalledWith({ researcher: { x: 0, y: 0 }, reviewer: { x: 300, y: 0 } })
  expect(documentState.save).not.toHaveBeenCalled()
  expect(documentState.onEdgesChange).not.toHaveBeenCalled()
})

// One canvas anatomy: Full trace draws the team the operator composed, so it draws the Build
// cards. Before this, Run had a second agent card of its own, and a run looked like a different
// application from the team that produced it.
describe('the Full trace canvas and the Build canvas draw the same cards', () => {
  const agentCards = () => [...document.querySelectorAll('[data-node="agent"] > *')].map((card) => card.className)

  it('draws Build agent cards on Full trace, carrying the run state the trace exists to show', async () => {
    composerLayoutState.nodes = [{ id: 'skill:design', kind: 'skill', name: 'claude-design', source: 'Claude Code', position: { x: 0, y: 240 } }]
    composerLayoutState.edges = [{ from: 'researcher', to: 'skill:design' }]
    sessionState.events = [
      event(0, 'process', { phase: 'spawned', pid: 1 }),
      event(1, 'message', { role: 'agent', content: { type: 'text', text: 'Lead done.' } }),
    ]
    renderWorkspace('run-1')
    await waitFor(() => expect(agentCards()).toHaveLength(2))
    for (const card of agentCards()) expect(card).toContain('build-node')
    // The run's own facts are on that card, not on a card of Run's own.
    expect(document.querySelector('.build-node.has-run .build-node-task')).toHaveTextContent('Researcher · lead')
    expect(document.querySelector('[data-node="capability"] > *')).toHaveClass('build-node')
    expect(document.querySelector('.lw-shell')).toHaveClass('build-graph')
  })

  it('draws the same cards on the Build canvas, with no run state to claim', async () => {
    composerLayoutState.nodes = []
    composerLayoutState.edges = []
    renderWorkspace()
    await waitFor(() => expect(agentCards()).toHaveLength(2))
    for (const card of agentCards()) expect(card).toContain('build-node')
    expect(document.querySelector('.build-node.has-run')).toBeNull()
    expect(document.querySelector('.lw-shell')).toHaveClass('build-workspace', 'build-graph')
  })
})

// An Attention alert used to be a dead label beside a Dismiss button: it named the agent and the
// failure and left the operator to find both the call and the thing to change. A run is a record,
// so "fix it" can only mean the team that produced it — repair leads, evidence stays reachable.
describe('an Attention alert routes to the repair and to the record', () => {
  const busFailure = () => [
    event(0, 'process', { phase: 'spawned', pid: 1 }),
    event(1, 'tool_call', { callId: 'ask1', title: 'Team Bus: ask', name: 'ask', toolKind: 'other', rawInput: { agent: 'market-researcher' } }),
    event(2, 'tool_update', { callId: 'ask1', status: 'failed', rawOutput: { error: 'agent "market-researcher" is not on this team' } }),
  ]

  function withRealSelection() {
    const original = documentState.nodes
    vi.mocked(documentState.onNodesChange).mockImplementation((changes: Array<{ id: string; type: string; selected?: boolean }>) => {
      documentState.nodes = documentState.nodes.map((node) => {
        const change = changes.find((candidate) => candidate.id === node.id)
        return change && change.type === 'select' ? { ...node, selected: change.selected ?? false } : node
      })
    })
    return () => { documentState.nodes = original; vi.mocked(documentState.onNodesChange).mockReset() }
  }

  it('takes "Fix in Build" to the field that has to change, and says why', async () => {
    const restore = withRealSelection()
    sessionState.events = busFailure()
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Build/ }))
    // Out of the run: Build is the only editing surface.
    await waitFor(() => expect(screen.getByRole('heading', { name: /^(Your team is ready|Finish setting up|Add your first agent)$/ })).toBeInTheDocument())
    // On the agent that did the asking, in its full settings, with the instructions focused.
    await waitFor(() => expect(screen.getByLabelText('Role and instructions')).toHaveFocus())
    // Inside the panel the operator is looking at — not floating behind the page chrome.
    const inspector = screen.getByRole('region', { name: 'Inspector' })
    expect(inspector).toContainElement(screen.getByRole('note'))
    expect(inspector).toContainElement(screen.getByLabelText('Role and instructions'))
    // It says what to write, not only what is wrong.
    expect(screen.getByRole('note')).toHaveTextContent('These instructions ask for “market-researcher”, which is not on this team. This team has: Researcher, Reviewer.')
    restore()
  })

  // The note is wayfinding, not validation: nothing can check that new prose names a real
  // teammate, so it retires when it has done its job instead of sitting there looking unfixed.
  it('retires the note once the operator edits the field it pointed at', async () => {
    const restore = withRealSelection()
    sessionState.events = busFailure()
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Build/ }))
    const field = await screen.findByLabelText('Role and instructions')
    expect(screen.getByRole('note')).toBeInTheDocument()
    fireEvent.change(field, { target: { value: 'You are an agent receiving the report from Research.' } })
    await waitFor(() => expect(screen.queryByRole('note')).not.toBeInTheDocument())
    expect(documentState.renameAgent).toHaveBeenCalledWith('researcher', 'role', 'You are an agent receiving the report from Research.')
    restore()
  })

  // Editing something else is not acting on the note, so it stays until the named field changes.
  it('keeps the note when a different field is edited', async () => {
    const restore = withRealSelection()
    sessionState.events = busFailure()
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Build/ }))
    await screen.findByRole('note')
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Report Designer' } })
    await waitFor(() => expect(documentState.renameAgent).toHaveBeenCalledWith('researcher', 'name', 'Report Designer'))
    expect(screen.getByRole('note')).toBeInTheDocument()
    restore()
  })

  it('lets the operator dismiss the note without editing anything', async () => {
    const restore = withRealSelection()
    sessionState.events = busFailure()
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Build/ }))
    await screen.findByRole('note')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this note' }))
    await waitFor(() => expect(screen.queryByRole('note')).not.toBeInTheDocument())
    expect(documentState.renameAgent).not.toHaveBeenCalled()
    restore()
  })

  it('offers no repair for a failure the team file cannot cause', async () => {
    sessionState.events = [
      event(0, 'process', { phase: 'spawned', pid: 1 }),
      event(1, 'process', { phase: 'crashed', message: 'Exited unexpectedly' }),
    ]
    renderWorkspace('run-1')
    const panel = await screen.findByRole('region', { name: /^Attention/ })
    expect(panel).toHaveTextContent('Exited unexpectedly')
    expect(screen.queryByRole('button', { name: /Fix in Build/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show the agent' })).toBeInTheDocument()
  })

  // A delegation that resolved is not a naming mistake, so it gets no repair route either.
  it('offers no repair when the agent it asked for is on the team', async () => {
    sessionState.events = [
      event(0, 'process', { phase: 'spawned', pid: 1 }),
      event(1, 'tool_call', { callId: 'ask2', title: 'Team Bus: ask', name: 'ask', toolKind: 'other', rawInput: { agent: 'reviewer' } }),
      event(2, 'tool_update', { callId: 'ask2', status: 'failed', rawOutput: { error: 'budget exhausted' } }),
    ]
    renderWorkspace('run-1')
    const panel = await screen.findByRole('region', { name: /^Attention/ })
    expect(panel).toHaveTextContent('budget exhausted')
    expect(screen.queryByRole('button', { name: /Fix in Build/ })).not.toBeInTheDocument()
  })

  it('keeps the record reachable: "Show evidence" opens the failing call', async () => {
    sessionState.events = busFailure()
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Show evidence' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: /ask → market-researcher/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /fold its evidence/ })).toBeInTheDocument()
  })

  it('opens the same call from the delivery lane, without opening the node inspector over it', async () => {
    sessionState.events = busFailure()
    renderWorkspace('run-1', 'delivery')
    fireEvent.click(await screen.findByRole('button', { name: 'Show evidence' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: /ask → market-researcher/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Researcher/, pressed: true })).toHaveClass('delivery-stage-select')
    expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument()
  })
})

// Selecting an agent in Build and switching to Run used to leave the editing panel floating over
// the deliverable. A tab switch is a change of task, so the panel closes with it — and closes for
// good, rather than lying in wait behind the selection.
describe('switching workspace tab closes the node inspector', () => {
  // Build opens the short panel, Run the full one; either is "the node panel is open".
  const nodePanel = () => screen.queryByLabelText('Selected node settings') ?? screen.queryByLabelText('Inspector')

  function selectionBackedByState(selectedId: string | null) {
    const original = documentState.nodes
    documentState.nodes = documentState.nodes.map((node) => ({ ...node, selected: node.id === selectedId }))
    vi.mocked(documentState.onNodesChange).mockImplementation((changes: Array<{ id: string; type: string; selected?: boolean }>) => {
      documentState.nodes = documentState.nodes.map((node) => {
        const change = changes.find((candidate) => candidate.id === node.id)
        return change && change.type === 'select' ? { ...node, selected: change.selected ?? false } : node
      })
    })
    return () => { documentState.nodes = original; vi.mocked(documentState.onNodesChange).mockReset() }
  }

  it('closes it on Build → Run, and it stays closed on the way back', async () => {
    const restore = selectionBackedByState('researcher')
    renderWorkspace()
    expect(nodePanel()).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(nodePanel()).not.toBeInTheDocument())

    // Closed, not merely hidden behind a selection that is still set.
    fireEvent.click(screen.getByRole('button', { name: 'Build' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: /^(Your team is ready|Finish setting up|Add your first agent)$/ })).toBeInTheDocument())
    expect(nodePanel()).not.toBeInTheDocument()
    restore()
  })

  // The Run tab cleared the selection itself; Build's own "Run team" did not, and the panel then sat
  // over the next run. Every way into a run must close it, not just the tab.
  it('closes it when Build’s Run team opens the next run', async () => {
    const restore = selectionBackedByState('researcher')
    renderWorkspace()
    expect(nodePanel()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    expect(screen.getByRole('region', { name: /chat$/ })).toBeInTheDocument()
    await waitFor(() => expect(nodePanel()).not.toBeInTheDocument())
    restore()
  })

  it('closes it on Run → Build too', async () => {
    const restore = selectionBackedByState('researcher')
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    renderWorkspace('run-1')
    expect(nodePanel()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Build' }))
    await waitFor(() => expect(nodePanel()).not.toBeInTheDocument())
    restore()
  })

  // The delivery lane has its own route into this panel; closing on a tab switch must not take it.
  it('leaves the delivery lane’s own "Agent details" route working', async () => {
    const restore = selectionBackedByState(null)
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    renderWorkspace('run-1', 'delivery')
    fireEvent.click(await screen.findByRole('button', { name: 'Agent details' }))
    await waitFor(() => expect(nodePanel()).toBeInTheDocument())
    restore()
  })
})

// A scheduled delivery fails with "Open Connections and choose a destination page", so the
// route has to be reachable without knowing the URL or the ⌘K palette. Before this, the
// workspace menu was the only chrome that could carry it and it did not.
describe('Connections entry point', () => {
  it('offers Connections in the workspace menu and navigates to the settings surface', async () => {
    // jsdom makes location.assign non-configurable, so stand in a whole location.
    // `search` is kept because Workspace reads it for the ?path= it is rendered with.
    const real = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { href: real.href, pathname: real.pathname, search: real.search, assign } })
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: 'Menu' }))
    const item = screen.getByRole('menuitem', { name: 'Connections…' })
    fireEvent.click(item)
    expect(assign).toHaveBeenCalledWith('/connections')
    // The menu closes behind it, like every other item here.
    expect(screen.queryByRole('menuitem', { name: 'Connections…' })).not.toBeInTheDocument()
    Object.defineProperty(window, 'location', { configurable: true, value: real })
  })
})

// A team shared by a colleague names an app this computer does not have. Build used to say "Your
// team is ready" and the run failed at once with `spawn_failed`; now the daemon is asked first.
describe('an agent whose app is not on this computer', () => {
  function answerCommands(status: 'not_found' | 'found') {
    const fallback = globalThis.fetch
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/commands?')) {
        asked.push(url)
        return new Response(JSON.stringify({ commands: [{ cmd: 'fake', status }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return fallback(input, init)
    }))
    return asked
  }

  it('is named on its card and in the heading, and Run is blocked with the reason', async () => {
    const asked = answerCommands('not_found')
    renderWorkspace()
    expect(await screen.findByRole('heading', { name: 'Finish setting up' })).toBeInTheDocument()
    expect(asked).toEqual(['/api/commands?cmd=fake'])
    expect(screen.getByText('2 agents’ apps can’t start on this computer: Researcher, Reviewer. Open the list at the top to see what to change.')).toBeInTheDocument()
    expect(screen.getByText('Researcher’s app “fake” isn’t installed on this computer.')).toHaveClass('build-node-app-problem')
    expect(screen.getByText('Reviewer’s app “fake” isn’t installed on this computer.')).toHaveClass('build-node-app-problem')
    expect(screen.getByRole('button', { name: /2 things to finish, open team switcher/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    // The team's chat says so before you write, rather than offering a box that cannot start work.
    const reason = '2 agents’ apps can’t start on this computer: Researcher, Reviewer.'
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message the team' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send note' })).toBeDisabled()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  // The counterfactual: the same team, with its app installed, is ready and runs.
  it('leaves a team whose apps are installed ready to run', async () => {
    const asked = answerCommands('found')
    renderWorkspace()
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(await screen.findByRole('heading', { name: 'Your team is ready' })).toBeInTheDocument()
    expect(document.querySelector('.build-node-app-problem')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the team' }), { target: { value: '@team Summarise the repo' } })
    // Ready, the box says where the message goes and starts the team with it.
    expect(screen.getByText(/^Starts the team/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(screen.queryByText(/can’t start on this computer/)).not.toBeInTheDocument()
  })
})

// ADR 0043: Home's way into Ask is "Describe the job", so its header has no Ask button too.
describe('Home', () => {
  it('asks through Describe the job only, with no second Ask button in the header', async () => {
    const path = documentState.path
    documentState.path = ''
    try {
      renderWorkspace()
      expect(await screen.findByRole('heading', { name: 'Put AI agents to work as a team.' })).toBeInTheDocument()
      expect(screen.getByLabelText('Or describe the job')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Ask LoomWatch/ })).not.toBeInTheDocument()
    } finally {
      documentState.path = path
    }
  })
})
