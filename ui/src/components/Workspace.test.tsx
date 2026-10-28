import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetKeyStatus } from '../lib/ai/useKeyStatus'
import { forgetModels } from '../lib/ai/useModels'
import { figureFor, figureStill } from '../lib/library/figures'
import type { RunEvent } from '../lib/watch/events'
import type { AgentConfig } from '../lib/team-file/types'
import { keys } from '../lib/platform'
import { background, cascaded, DESKTOP, goldFilled, heightOf, isGoldFill, PHONE } from '../test/cascade'
import { typeInto, wordsIn } from '../test/chipField'
import { useTeamPage } from '../lib/team-file/teamPage'
import { FrameTeamRail } from './rail/TeamRail'
import { Workspace } from './Workspace'

// The Run button shows its key as this computer writes it: ↵ on a Mac, Enter elsewhere.
const RUN_BUTTON = new RegExp(`^Run ${keys('↵')}`)

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
  // ADR 0060 (taking a skill or tool off the canvas turns it off) and Your agents' links.
  turnOff: vi.fn(), turnBackOn: vi.fn(), applyAgentFields: vi.fn(),
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

vi.mock('../lib/team-file/useTeamDocument', () => ({ useTeamDocument: () => documentState, slugifyTeamName: (name: string) => name, readTeam: async () => ({ yaml: '', revision: 'r1', root: '/teams' }), handOverTeam: () => {} }))
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
  ConnectionLineType: { Bezier: 'default', Straight: 'straight', Step: 'step', SmoothStep: 'smoothstep', SimpleBezier: 'simplebezier' },
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  NodeToolbar: ({ children, isVisible }: { children: React.ReactNode; isVisible?: boolean }) => isVisible ? <>{children}</> : null,
  getBezierPath: () => ['', 0, 0],
  getSmoothStepPath: () => ['', 0, 0],
  useStore: (selector: (store: { transform: number[]; minZoom: number; maxZoom: number }) => unknown) => selector({ transform: [0, 0, 1], minZoom: 0.25, maxZoom: 2 }),
  useNodesInitialized: () => true,
  useConnection: (selector: (connection: { inProgress: boolean }) => unknown) => selector({ inProgress: false }),
  useNodeId: () => null,
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

// The team rail is the page frame's (App.tsx), drawn as the workspace sets it.
function workspaceTree(runId: string | null = null) {
  return <><FrameTeamRail /><Workspace onDocumentOpen={vi.fn()} initialRunId={runId} /></>
}

function renderWorkspace(runId: string | null = null) {
  return render(workspaceTree(runId))
}

/** Waits until a run the composer started is the one on screen. */
async function runOnScreen() {
  await waitFor(() => expect(window.location.search).toContain('run=run-1'))
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
  forgetKeyStatus()
  forgetModels()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/ai') return new Response(JSON.stringify({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz' } }), { status: 200 })
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
    // At once: the panel comes with the app, so nothing waits for its code.
    expect(screen.getByRole('complementary', { name: 'Ask LoomWatch' })).toBeInTheDocument()
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
    renderWorkspace()
    expect(screen.queryByRole('button', {name: 'Preview next run'})).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: 'Run team'}))
    expect(screen.getByRole('region', {name: /chat$/})).toBeInTheDocument()
    expect(screen.getByRole('textbox', {name: 'Message the team'})).toBeInTheDocument()
    expect(await screen.findByRole('heading', {name: /^Talk to /})).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', {name: 'Workflow'}))
    expect(screen.getByRole('application', {name: 'Team canvas'})).toBeInTheDocument()
  })

  // ADR 0051: Details opens by default beside the chat, on the newest piece of work, and stays
  // closed once you close it.
  // ADR 0051: the chat is the screen. The pane opens by itself only to hand over what work made.
  it('keeps the pane closed until a piece’s line opens its record, and closed once closed', async () => {
    // The piece's record is read, so its line knows nothing passed between the agents.
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/chat?')) {
        return new Response(JSON.stringify({ teamKey: 'demo', teamPath: 'demo.yaml', more: false, items: [{ kind: 'work', run: runRecord, request: null, notes: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return fallback(input, init)
    }))
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    const line = await within(await screen.findByRole('log', { name: 'Messages' })).findByRole('button', { name: 'Details' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
    fireEvent.click(line)
    const details = await screen.findByRole('complementary', { name: 'Details of this piece of work' })
    expect(within(details).getByRole('main', { name: 'Run workspace' })).toBeInTheDocument()
    expect(within(details).getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    expect(line).toHaveAttribute('aria-pressed', 'true')
    expect(window.location.search).toContain('run=run-1')
    fireEvent.click(within(details).getByRole('button', { name: 'Close details' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /chat$/ })).toBeInTheDocument()
  })

  // ADR 0051: a piece's replies are read beside the chat, drawn there by the piece itself.
  it('reads a piece’s replies in the pane’s first tab, drawn by the piece in the chat', async () => {
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/chat?')) {
        return new Response(JSON.stringify({ teamKey: 'demo', teamPath: 'demo.yaml', more: false, items: [{ kind: 'work', run: runRecord, request: null, notes: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return fallback(input, init)
    }))
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    fireEvent.click(await within(await screen.findByRole('log', { name: 'Messages' })).findByRole('button', { name: 'Details' }))
    const pane = await screen.findByRole('complementary', { name: 'Details of this piece of work' })
    expect(within(pane).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Replies', 'Details'])
    fireEvent.click(within(pane).getByRole('tab', { name: 'Replies' }))
    expect(within(pane).getByRole('tab', { name: 'Replies' })).toHaveAttribute('aria-selected', 'true')
    const panel = within(pane).getByRole('tabpanel')
    expect(panel).toHaveAttribute('aria-labelledby', 'tc-pane-replies')
    expect(await within(panel).findByText('No replies yet.')).toBeInTheDocument()
    expect(within(screen.getByRole('log', { name: 'Messages' })).queryByText('No replies yet.')).toBeNull()
  })

  // A newcomer's reading: on a narrow screen the pane covers the chat, where the only Approve is.
  it('steps the replies aside on a narrow screen while the work waits on you', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    const waiting = { ...runRecord, waitingOn: { node: 'reviewer', name: 'Reviewer', kind: 'question', since: at(1), question: 'Which market?', context: null, handoverFrom: null, park: 'reloadable', parkNote: '', sendBackAvailable: false } }
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/chat?')) return new Response(JSON.stringify({ teamKey: 'demo', teamPath: 'demo.yaml', more: false, items: [{ kind: 'work', run: waiting, request: null, notes: [] }] }), { status: 200 })
      if (url.includes('/api/runs/run-1') && !url.includes('/checkpoints')) return new Response(JSON.stringify(waiting), { status: 200 })
      return fallback(input, init)
    }))
    renderWorkspace('run-1')
    const pane = await screen.findByRole('complementary', { name: 'Details of this piece of work' })
    fireEvent.click(within(pane).getByRole('tab', { name: 'Replies' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument())
    expect(within(screen.getByRole('log', { name: 'Messages' })).getByText('Which market?')).toBeInTheDocument()
  })

  describe('what a piece of work made, as tabs beside the chat', () => {
    const MADE = '/teams/.loomwatch/demo/researcher/market.md'
    const GONE = '/teams/.loomwatch/demo/researcher/draft.md'
    // The person's own file, in a folder the team was given: named by the answer, not made by it.
    const OWN = '/teams/sales/q3.md'
    // Code the work wrote: a tab, but not what the pane opens on.
    const CODE = '/teams/.loomwatch/demo/researcher/make_chart.py'
    // What an earlier piece of work made.
    const EARLIER = '/teams/.loomwatch/demo/researcher/sales.md'
    /** The chat holds `items`; `market.md` is on this computer, `draft.md` is not. */
    function serve(items: unknown[], runs: Array<{ runId: string }>, sent: (body: Record<string, unknown>) => unknown = () => null) {
      const fallback = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const path = new URLSearchParams(url.split('?')[1] ?? '').get('path')
        if (url.startsWith('/api/chat?')) return new Response(JSON.stringify({ teamKey: 'demo', teamPath: 'demo.yaml', more: false, items }), { status: 200 })
        if (url === '/api/chat/messages') return new Response(JSON.stringify(sent(JSON.parse(String(init?.body)))), { status: 200 })
        if (url.startsWith('/api/files/stat?')) return new Response(JSON.stringify({ path, name: path?.split('/').pop(), exists: [MADE, OWN, CODE, EARLIER].includes(path ?? ''), isDir: false, sizeBytes: 40, modifiedAt: null, kind: 'markdown', folder: path === OWN ? 'sales' : '.loomwatch/demo/researcher', openable: true }), { status: 200 })
        if (url.startsWith('/api/files/read?')) return new Response(JSON.stringify({ path, name: 'market.md', kind: 'markdown', text: '# West region\n\nSales rose in the west.', extracted: false, truncated: false, sizeBytes: 40, modifiedAt: null }), { status: 200 })
        const run = runs.find((each) => url.includes(`/api/runs/${each.runId}`))
        if (run && !url.includes('/checkpoints')) return new Response(JSON.stringify(run), { status: 200 })
        return fallback(input, init)
      }))
    }
    const finished = (runId: string, reply: string) => ({ ...runRecord, runId, sessionId: runId, status: 'succeeded', finishedAt: at(60), reply })
    const work = (run: unknown) => ({ kind: 'work', run, request: null, notes: [] })
    const openPane = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
      return screen.findByRole('complementary', { name: 'Details of this piece of work' })
    }

    // The owner: "auto add artifacts tab here so that user can quickly refer to it. Remove the
    // Answer tab." Following the newest work, the pane opens on the first thing it made once done.
    it('adds each file the answer names as a tab, opens the first when the work is done, and has no Answer tab', async () => {
      const run = finished('run-2', `Done. The brief is in \`${MADE}\`, and the draft was \`${GONE}\`.`)
      serve([work(run)], [run])
      renderWorkspace()
      const pane = await openPane()
      const tab = await within(pane).findByRole('tab', { name: 'market.md' })
      await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'))
      expect(await within(pane).findByRole('heading', { name: 'West region' })).toBeInTheDocument()
      expect(within(pane).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tab.id)
      // A short answer is read in the chat; a file no longer on this computer is no tab.
      expect(within(pane).getAllByRole('tab').map((each) => each.textContent)).toEqual(['Replies', 'Details', 'market.md'])
      fireEvent.click(within(pane).getByRole('tab', { name: 'Details' }))
      expect(within(pane).getByRole('main', { name: 'Run workspace' })).toBeInTheDocument()
    })

    // The owner (2026-10-26): a link to a team's run opens the team's chat at that run's message.
    it('opens the chat at the message of the run its link names', async () => {
      const earlier = finished('run-2', 'Done.')
      serve([work(earlier)], [earlier])
      renderWorkspace('run-2')
      await waitFor(() => expect(document.querySelector('[data-said="request:run-2"]')).toHaveClass('flash'))
    })

    it('keeps a closed tab closed for that work, until Read opens it again in its place', async () => {
      const run = finished('run-2', `# Market brief\n\nThe brief is in \`${MADE}\`.\n\n${'The market moved again today. '.repeat(40)}`)
      serve([work(run)], [run])
      renderWorkspace()
      const pane = await openPane()
      const tabs = () => within(pane).getAllByRole('tab').map((each) => each.textContent)
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true'))
      // As a browser does, the next tab takes its place.
      fireEvent.click(within(pane).getByRole('button', { name: 'Close market.md' }))
      expect(tabs()).toEqual(['Replies', 'Details', 'Reviewer'])
      expect(within(pane).getByRole('tab', { name: 'Reviewer’s answer' })).toHaveAttribute('aria-selected', 'true')
      // Nothing after the answer to set it apart from.
      expect(pane.querySelector('.tc-pane-split')).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(tabs()).toEqual(['Replies', 'Details', 'Reviewer'])
      fireEvent.click(await screen.findByRole('button', { name: 'Read market.md here' }))
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true'))
      expect(tabs()).toEqual(['Replies', 'Details', 'Reviewer', 'market.md'])
    })

    // A long answer stays a short card in the chat and is read here. The owner: "there is no way to
    // tell what is the artifact, what is the long message". Its tab is the chat's message: who gave
    // it, by figure and name, set apart before the files; its title is said on hover.
    it('reads a long answer as a tab named by who gave it, before the files, opened again from its card', async () => {
      const report = `# Market brief\n\nThe brief is in \`${MADE}\`.\n\n${'The market moved again today. '.repeat(40)}`
      const run = finished('run-2', report)
      serve([work(run)], [run])
      renderWorkspace()
      const pane = await openPane()
      // The pane still opens on the file the work made, though the answer's tab comes first.
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true'))
      expect(within(pane).getAllByRole('tab').map((each) => each.textContent)).toEqual(['Replies', 'Details', 'Reviewer', 'market.md'])
      expect(within(pane).queryByRole('tab', { name: 'Answer' })).not.toBeInTheDocument()
      const answer = within(pane).getByRole('tab', { name: 'Reviewer’s answer' })
      expect(answer).toHaveAttribute('title', 'Reviewer’s answer\nMarket brief')
      // The figure of who said it, never a file's mark; a file has its mark and no figure.
      expect(answer.querySelector('.chat-avatar.has-figure img')).not.toBeNull()
      // Reviewer's own figure, as the chat shows beside its answer.
      const inChat = document.querySelector('.tc-answer .chat-gutter .chat-avatar')
      expect(answer.querySelector('.chat-avatar')?.className.replace(' tc-pane-face', '')).toBe(inChat?.className)
      expect(answer.querySelector('.chat-avatar img')?.getAttribute('src')).toBe(inChat?.querySelector('img')?.getAttribute('src'))
      expect(answer.querySelector('svg')).toBeNull()
      const file = within(pane).getByRole('tab', { name: 'market.md' })
      expect(file.querySelector('svg')).not.toBeNull()
      expect(file.querySelector('.chat-avatar')).toBeNull()
      // Set apart: a hairline between what was said and what was made.
      expect(answer.parentElement?.nextElementSibling).toHaveClass('tc-pane-split')
      expect(answer.parentElement?.nextElementSibling?.nextElementSibling).toContainElement(file)
      fireEvent.click(answer)
      expect(await within(pane).findByRole('heading', { name: 'Market brief', level: 1 })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Market brief, .* Showing beside the chat$/ })).toHaveAttribute('aria-pressed', 'true')
      // Its close says what it closes, never "remove Reviewer".
      expect(within(pane).getByRole('button', { name: 'Close Reviewer’s answer' })).toHaveAttribute('title', 'Close Reviewer’s answer')
      fireEvent.click(within(pane).getByRole('button', { name: 'Close Reviewer’s answer' }))
      expect(within(pane).queryByRole('tab', { name: 'Reviewer’s answer' })).not.toBeInTheDocument()
      expect(pane.querySelector('.tc-pane-split')).toBeNull()
      expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.click(screen.getByRole('button', { name: /^Market brief, .* Open$/ }))
      expect(within(pane).getByRole('tab', { name: 'Reviewer’s answer' })).toHaveAttribute('aria-selected', 'true')
    })

    // The chat names an agent since taken off the team by its id beside its answer; so does the tab.
    it('names a long answer from an agent no longer on the team as the chat does', async () => {
      const report = `# Market brief\n\n${'The market moved again today. '.repeat(40)}`
      const run = { ...finished('run-2', report), responder: 'editor', agentIds: ['researcher', 'editor'] }
      serve([work(run)], [run])
      renderWorkspace()
      const pane = await openPane()
      const tab = await within(pane).findByRole('tab', { name: 'editor’s answer' })
      expect(tab).toHaveTextContent('editor')
      expect(tab).toHaveAttribute('title', 'editor’s answer\nMarket brief')
    })

    // A newcomer's reading: the pane should land on the result, not on a file the work only read.
    it('opens by itself only on what the work made; a file it only named waits as a tab', async () => {
      const run = finished('run-2', `Done. I read \`${OWN}\`, wrote \`${CODE}\` and \`${MADE}\`.`)
      serve([work(run)], [run])
      renderWorkspace()
      const pane = await openPane()
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true'))
      expect(within(pane).getAllByRole('tab').map((each) => each.textContent)).toEqual(['Replies', 'Details', 'q3.md', 'make_chart.py', 'market.md'])
    })

    // A newcomer's run (a75f05b4): the answer named what it wrote, in the person's own folder, in
    // plain words. It is what the work came to, so the pane opens on it.
    it('opens on a file the work wrote where the answer names it in plain words', async () => {
      sessionState.events = [
        event(0, 'process', { phase: 'spawned', pid: 1 }),
        event(1, 'tool_call', { callId: 'w1', title: 'Write sales/q3.md', toolKind: 'edit', status: 'in_progress', rawInput: { path: 'sales/q3.md' }, locations: [{ path: OWN }] }),
        event(2, 'tool_update', { callId: 'w1', status: 'completed' }),
      ]
      const run = finished('run-2', `# Sales plan\n\n${'Sales rose in the west. '.repeat(40)}\n\nFiles are in /teams/sales:\n- q3.md`)
      serve([work(run)], [run])
      renderWorkspace()
      const pane = await openPane()
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'q3.md' })).toHaveAttribute('aria-selected', 'true'))
      expect(within(pane).getAllByRole('tab')).toHaveLength(4)
      // The answer read in full there names it as a file too.
      fireEvent.click(within(pane).getByRole('tab', { name: 'Reviewer’s answer' }))
      const chip = await within(within(pane).getByRole('tabpanel')).findByRole('button', { name: /q3\.md/ })
      expect(chip.getAttribute('title')?.split('\n')[0]).toBe(OWN)
    })

    it('hands over nothing when the work stopped: its line opens the record, with what it named a tab away', async () => {
      sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
      const run = { ...finished('run-2', `Partly done: \`${MADE}\`.`), status: 'failed', error: 'The model stopped answering.' }
      serve([work(run)], [run])
      renderWorkspace()
      fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
      const line = await within(await screen.findByRole('log', { name: 'Messages' })).findByRole('button', { name: 'Details' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
      fireEvent.click(line)
      const pane = await screen.findByRole('complementary', { name: 'Details of this piece of work' })
      await within(pane).findByRole('tab', { name: 'market.md' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(within(pane).getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
      expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'false')
    })

    // The owner, with a page from one piece of work open and Read on another's: "I have 2 different
    // artifacts. But they are showing only 1 tab". Every file read stays a tab until it is closed.
    it('keeps each file read from other work as its own tab, until it is closed', async () => {
      const earlier = finished('run-1', `Done. The figures are in \`${EARLIER}\`.`)
      const run = finished('run-2', `Done. The brief is in \`${MADE}\`.`)
      serve([work(earlier), work(run)], [earlier, run])
      renderWorkspace()
      const pane = await openPane()
      const tabs = () => within(pane).getAllByRole('tab').map((each) => each.textContent)
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true'))
      const mark = () => within(pane).getByRole('tab', { name: 'market.md' }).querySelector('svg')?.getAttribute('class')
      const itsMark = mark()
      expect(itsMark).toContain('lucide-file-text')
      // Read, then left for the record: still read.
      fireEvent.click(within(pane).getByRole('tab', { name: 'Details' }))
      fireEvent.click(screen.getByRole('button', { name: 'Read sales.md here' }))
      // At once, before what its work made is found, and in the place it keeps once that is found.
      expect(within(pane).getByRole('tab', { name: 'sales.md' })).toHaveAttribute('aria-selected', 'true')
      expect(window.location.search).toContain('run=run-1')
      expect(tabs()).toEqual(['Replies', 'Details', 'sales.md', 'market.md'])
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'sales.md' }).querySelector('svg')?.getAttribute('class')).toContain('lucide-file-text'))
      expect(tabs()).toEqual(['Replies', 'Details', 'sales.md', 'market.md'])
      // Its kind's mark, as when its own work was on screen.
      expect(mark()).toBe(itsMark)
      fireEvent.click(within(pane).getByRole('tab', { name: 'market.md' }))
      expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true')
      expect(await within(pane).findByRole('heading', { name: 'West region' })).toBeInTheDocument()
      // And back: the file just read stays too, not only the last one.
      fireEvent.click(screen.getByRole('button', { name: 'Read market.md here' }))
      await waitFor(() => expect(window.location.search).toContain('run=run-2'))
      await waitFor(() => expect(tabs()).toEqual(['Replies', 'Details', 'market.md', 'sales.md']))
      expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.click(within(pane).getByRole('button', { name: 'Close sales.md' }))
      expect(tabs()).toEqual(['Replies', 'Details', 'market.md'])
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(tabs()).toEqual(['Replies', 'Details', 'market.md'])
    })

    // ADR 0051: work you start shows in the chat; a closed pane stays closed while it runs.
    it('keeps a closed pane closed when work starts from the chat', async () => {
      const run = finished('run-2', 'Done.')
      const next = { ...runRecord, runId: 'run-3', sessionId: 'run-3', status: 'running', reply: null }
      serve([work(run)], [run, next], (body) => ({ route: 'team', run: next, message: { id: 'm-3', teamKey: 'demo', teamPath: 'demo.yaml', text: body.text, createdAt: at(70), route: 'team', runId: 'run-3', agentId: null, deliveredAt: null, now: false } }))
      renderWorkspace()
      fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
      const log = await screen.findByRole('log', { name: 'Messages' })
      await within(log).findByText('Done.')
      typeInto(screen.getByRole('textbox', { name: 'Message the team' }), '@team Make the west part shorter')
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })) })
      await waitFor(() => expect(log.querySelector('[data-run="run-3"]')).not.toBeNull())
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument()
      expect(window.location.search).not.toContain('run=')
    })

    // ADR 0077: asking about a part of the file starts new work; the file stays where it is.
    it('leaves the file on screen when newer work starts from the chat', async () => {
      const run = finished('run-2', `Done. The brief is in \`${MADE}\`.`)
      const next = { ...runRecord, runId: 'run-3', sessionId: 'run-3', status: 'running', reply: null }
      serve([work(run)], [run, next], (body) => ({ route: 'team', run: next, message: { id: 'm-3', teamKey: 'demo', teamPath: 'demo.yaml', text: body.text, createdAt: at(70), route: 'team', runId: 'run-3', agentId: null, deliveredAt: null, now: false } }))
      renderWorkspace()
      const pane = await openPane()
      await waitFor(() => expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true'))
      typeInto(screen.getByRole('textbox', { name: 'Message the team' }), '@team Make the west part shorter')
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })) })
      await waitFor(() => expect(window.location.search).toContain('run=run-3'))
      expect(within(pane).getByRole('tab', { name: 'market.md' })).toHaveAttribute('aria-selected', 'true')
      expect(within(pane).getByRole('heading', { name: 'West region' })).toBeInTheDocument()
    })
  })

  // A run opened by link is the chat with that piece's Details beside it; the Run tab comes back
  // to the chat, the one place you work with the team.
  it('opens a run’s Details beside the chat, and Run comes back to the chat after Build', async () => {
    // As a reloaded chat's address has it: the chat, and the piece open in Details.
    window.history.replaceState({}, '', '/?path=demo.yaml&view=chat&run=run-1')
    renderWorkspace('run-1')
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
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }))
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
    // The failed run's record and its notes are both in before the strip's absence counts.
    expect(await screen.findByRole('region', { name: 'Run receipt' })).toHaveTextContent('Failed')
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/memory/notes'))).toBe(true))
    await act(async () => {})
    expect(screen.queryByTestId('review-strip')).not.toBeInTheDocument()
  })

  it('shows the team canvas with the document chip, composer and the configured pipeline', () => {
    renderWorkspace()
    expect(screen.getByRole('application', { name: 'Team canvas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /demo.yaml, .*open team menu/ })).toBeInTheDocument()
    expect(screen.getByText('2 steps in order')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: RUN_BUTTON })).toBeDisabled()
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
    const view = render(<Workspace onDocumentOpen={vi.fn()} initialRunId={null} capabilityInventory={inventory} />)
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
      expect(screen.getByLabelText(/^claude-design, skill from Not in LoomWatch’s skills, used by 1 agent$/)).toBeInTheDocument()
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
   * ADR 0094: knowledge isn't turned off for one team, so taking one of the agent's own reads off a
   * team's canvas takes it off the agent in every team it's in. The canvas says so; a folder the
   * team gave it says nothing of the kind.
   */
  it('says when a read of the agent’s own came off it in every team it’s in', async () => {
    const [, reviewer] = documentState.nodes
    Object.assign(reviewer.data.agent, { from: { agent: 'reviewer' }, capabilities: [{ kind: 'knowledge', name: 'Style', path: '/Users/me/style' }, { kind: 'knowledge', name: 'Notes', path: '/Users/me/notes' }] })
    const stubbed = vi.mocked(fetch)
    const answer = stubbed.getMockImplementation()!
    stubbed.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/jobs'
      ? new Response(JSON.stringify({ folder: '.jobs', jobs: [{ id: 'reviewer', file: '.jobs/reviewer.yaml', name: 'Reviewer', instructions: 'Review it.', reads: [{ name: 'Style', path: '/Users/me/style' }] }], problems: [] }), { status: 200 })
      : answer(input, init))
    const view = renderWorkspace()
    try {
      // A folder's card is named by the folder.
      await screen.findByText('Reviewer reads notes')
      // My agents is read before the canvas can tell whose read it is.
      await waitFor(() => expect(stubbed.mock.calls.some(([url]) => String(url) === '/api/jobs')).toBe(true))
      await act(async () => {})
      act(() => flowRuntime.onEdgesChange?.([{ id: 'capability:reviewer->knowledge@/Users/me/notes', type: 'remove' }]))
      expect(screen.queryByText(/in every team it’s in/)).toBeNull()

      act(() => flowRuntime.onEdgesChange?.([{ id: 'capability:reviewer->knowledge@/Users/me/style', type: 'remove' }]))
      const note = (await screen.findByText(/off Reviewer in every team it’s in, since it’s one of its own reads\. To give it back, open Agents\./)).closest('[role="status"]')
      expect(note).toHaveTextContent(/^Took style off Reviewer/)
    } finally {
      view.unmount()
      Reflect.deleteProperty(reviewer.data.agent, 'from')
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

  it('puts the getting-started guide’s example in the request box without running it', () => {
    renderWorkspace()
    act(() => { window.dispatchEvent(new CustomEvent('loomwatch:compose', { detail: 'Give me three ideas' })) })
    expect(screen.getByLabelText('What should the team do?')).toHaveValue('Give me three ideas')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('starts a run from the composer and shows it in the team’s chat, with its Details beside it', async () => {
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('What should the team do?'), { target: { value: 'Summarise the repo' } })
    fireEvent.click(screen.getByRole('button', { name: RUN_BUTTON }))
    await runOnScreen()
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')!
    // §1.4/§1.6: the run is pinned to the revision on screen and carries one start key per attempt.
    expect(JSON.parse(String(post[1]!.body))).toEqual({ teamPath: '/teams/demo.yaml', prompt: 'Summarise the repo', expectedRevision: 'rev-7', startKey: expect.any(String) })
    expect(screen.getByRole('region', { name: /chat$/ })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Details of this piece of work' })).toBeInTheDocument()
    expect(screen.queryByRole('application')).not.toBeInTheDocument()
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
    await runOnScreen()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
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
    fireEvent.click(screen.getByRole('button', { name: RUN_BUTTON }))
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Saving demo.yaml/)).not.toBeInTheDocument()
    await act(async () => { release(new Response(JSON.stringify({ ...runRecord, status: 'queued' }), { status: 202 })) })
    await runOnScreen()
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
    fireEvent.click(screen.getByRole('button', { name: RUN_BUTTON }))
    // A dropped connection is said in plain words, not as the browser's TypeError.
    expect(await screen.findByRole('alert')).toHaveTextContent('Can’t reach the LoomWatch server')
    expect(screen.getByLabelText('What should the team do?')).toHaveValue('Summarise the repo')
    fireEvent.click(screen.getByRole('button', { name: RUN_BUTTON }))
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
    fireEvent.click(screen.getByRole('button', { name: RUN_BUTTON }))
    await runOnScreen()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The request went into that run, so the box it was typed in is empty again.
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }))
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
    fireEvent.click(screen.getByRole('button', { name: RUN_BUTTON }))
    expect(await screen.findByRole('alert')).toHaveTextContent('changed before the run could start')
    await waitFor(() => expect(documentState.checkDiskRevision).toHaveBeenCalled())
    expect(window.location.search).not.toContain('run=')
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

  // A newcomer never meets the team file's raw YAML: there is no Show YAML in the team menu or
  // the palette, and a problem with nothing on the canvas to point at no longer opens it.
  it('never shows the team file as YAML', async () => {
    Object.assign(documentState, {
      isValid: false,
      documentChipState: 'invalid',
      documentProblems: [{ message: '(document) must NOT have additional properties', yamlPath: ['unexpected'] }],
      yamlPreview: 'schemaVersion: 1\nunexpected: true\nagents: []\n',
    })
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
    expect(screen.getByRole('dialog', { name: 'Team menu' })).toHaveTextContent('Copy path')
    expect(screen.queryByRole('button', { name: 'Show YAML' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.getByRole('button', { name: /Copy file path/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show YAML/ })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })

    fireEvent.click(screen.getAllByRole('button', { name: 'Review' }).find((button) => button.hasAttribute('aria-controls'))!)
    fireEvent.click(screen.getByRole('button', { name: /Team.*must NOT have additional properties/ }))
    expect(screen.queryByRole('dialog', { name: /YAML/ })).not.toBeInTheDocument()
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

  // One gold fill per screen (DESIGN_LANGUAGE §8): once the schedule can be saved, Save schedule is
  // the fill; Run team steps back to a ring and the chosen frequency is a ring, as a selection is (§5).
  it('keeps one gold fill while the schedule is open: Save schedule, with Run team and the chosen frequency as rings', async () => {
    renderWorkspace()
    const run = screen.getByRole('button', { name: 'Run team' })
    expect(goldFilled()).toEqual(['Run team'])
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))
    // No task yet, so Save schedule can't be pressed: Run team keeps the fill.
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled()
    expect(goldFilled()).toEqual(['Run team'])
    fireEvent.change(screen.getByLabelText('Scheduled task'), { target: { value: 'Prepare the morning digest.' } })
    expect(goldFilled()).toEqual(['Save schedule'])
    expect(run).toHaveClass('btn-ring')
    expect(background(run)).toBe('transparent')
    expect(cascaded(run, 'color')).toBe('var(--color-ink)')
    expect(cascaded(run, 'border-color')).toBe('var(--color-accent)')
    // At the fill's weight, as the tray's stepped-back ring is: two rings side by side match.
    expect(cascaded(run, 'font-weight')).toBe('600')
    const chosen = screen.getByRole('tab', { selected: true })
    expect(isGoldFill(chosen)).toBe(false)
    expect(cascaded(chosen, 'color')).toBe('var(--color-ink)')
    expect(cascaded(chosen, 'box-shadow')).toBe('inset 0 0 0 1px var(--color-accent)')
    // The row clips to its rounded corner inside a 1 px border; the ring follows that corner.
    expect(cascaded(chosen.parentElement!, 'border-radius')).toBe('var(--r-sm)')
    expect(cascaded(chosen, 'border-radius')).toBe('calc(var(--r-sm) - 1px)')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(goldFilled()).toEqual(['Run team'])
  })

  // Gold means the action at hand: an unchanged schedule's Save schedule would do nothing, so on
  // reopening one Run team keeps the fill, until the schedule is changed.
  it('keeps Run team the one fill on reopening an unchanged schedule, until it is changed', async () => {
    Object.assign(documentState, { teamSchedule: { cron: '0 8 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the daily digest.' } })
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: /Schedule trigger.*Daily/ }))
    expect(screen.getByRole('form', { name: 'Edit schedule' })).toHaveTextContent('This schedule matches the team file on disk.')
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeEnabled()
    expect(goldFilled()).toEqual(['Run team'])
    fireEvent.change(screen.getByLabelText('Scheduled task'), { target: { value: 'Prepare the evening digest.' } })
    expect(goldFilled()).toEqual(['Save schedule'])
    fireEvent.click(screen.getByRole('button', { name: 'Close schedule' }))
    expect(goldFilled()).toEqual(['Run team'])
    Object.assign(documentState, { teamSchedule: null })
  })

  // The menu is the only way from a team to Team memory, About you, Connections, Usage and the guide.
  // A phone hid it, so a team opened on a phone had no way to any of them.
  it('keeps the team menu on a phone, beside Ask and the bell rather than under them', async () => {
    renderWorkspace()
    const toggle = screen.getByRole('button', { name: 'Menu' })
    const menu = toggle.parentElement!
    const anchor = document.querySelector('.workspace-chrome > .needs-you-anchor')!
    for (const viewport of [DESKTOP, PHONE]) expect(cascaded(menu, 'display', viewport)).toBe('flex')
    // On a phone both stand in the row under the header, side by side: the menu at the end, with the
    // bell's 30 px look, and Ask and the bell to its left.
    expect(cascaded(menu, 'right', PHONE)).toBe('19px')
    expect(heightOf(toggle, PHONE)).toBe(30)
    expect(cascaded(anchor, 'right', PHONE)).toBe('64px')
    fireEvent.click(toggle)
    for (const item of ['Team memory', 'About you…', 'Connections…', 'Usage…']) expect(screen.getByRole('menuitem', { name: item })).toBeInTheDocument()
  })

  // A team with unsaved changes: Run team saves before it starts, so it keeps the one gold fill and
  // the name chip's Save is a gold ring, 32 px like the chip's other buttons.
  it('keeps Run team the one fill on a team with unsaved changes, with Save as a ring', async () => {
    Object.assign(documentState, { documentChipState: 'dirty', saveState: 'dirty' })
    renderWorkspace()
    const save = screen.getAllByRole('button', { name: /^Save/ }).find((button) => button.closest('.lw-chip'))!
    expect(save).toBeEnabled()
    expect(goldFilled()).toEqual(['Run team'])
    expect(save).toHaveClass('btn-ring')
    expect(cascaded(save, 'border-color')).toBe('var(--color-accent)')
    expect(heightOf(save)).toBe(32)
    Object.assign(documentState, { documentChipState: 'clean', saveState: 'clean' })
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
    await waitFor(() => expect(screen.getByRole('button', { name: /^Model/ })).toHaveFocus())
    Object.assign(documentState, { nodes: originalNodes, isValid: true, documentChipState: 'clean', fieldProblemsByAgent: new Map() })
  })

  // The chat's piece of work is where a run is stopped.
  it('cancels a live run through the API from its piece in the chat', async () => {
    const cancelled: string[] = []
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/chat?')) return new Response(JSON.stringify({ teamKey: 'demo', teamPath: 'demo.yaml', more: false, items: [{ kind: 'work', run: runRecord, request: null, notes: [] }] }), { status: 200 })
      if (url.endsWith('/cancel')) { cancelled.push(url); return new Response(JSON.stringify({ ...runRecord, status: 'cancelled', finishedAt: at(9) }), { status: 200 }) }
      if (url.includes('/checkpoints')) return new Response(JSON.stringify([]), { status: 200 })
      if (url.includes('/api/runs/run-1')) return new Response(JSON.stringify(runRecord), { status: 200 })
      return new Response(JSON.stringify({ error: `unexpected ${url} ${init?.method ?? ''}` }), { status: 404 })
    })
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    renderWorkspace('run-1')
    const chat = screen.getByRole('region', { name: /chat$/ })
    const stop = await within(chat).findByRole('button', { name: 'Stop' })
    await act(async () => { fireEvent.click(stop) })
    await waitFor(() => expect(cancelled).toEqual(['/api/runs/run-1/cancel']))
  })
  // ---- Canvas A: one canvas (TNG89 §15, acceptance rows 40–45) --------------------------
  //
  // The rule under test throughout: the configured graph never moves.

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
      fireEvent.click(screen.getByRole('button', { name: RUN_BUTTON }))
      await runOnScreen()
      fireEvent.click(screen.getByRole('button', { name: 'Workflow' }))

      expect(positionOf('Researcher')).toBe('0x0')
      expect(positionOf('Reviewer')).toBe('300x0')
    })

    it('docks the Output last, one gutter right of the stage that answers (rows 24, 42)', () => {
      const { container } = renderWorkspace()
      expect(nodeKinds(container)[0]).toBe('agent')
      expect(nodeKinds(container).at(-1)).toBe('response')
      // Docked, not stacked: computed from the positions the operator placed, not a layout of its own.
      expect(screen.getByLabelText('Output, No run yet.').closest('[data-node]')).toHaveAttribute('data-position', '760x0')
    })

    it('opens the Run request from Build without adding a prompt node to the canvas', () => {
      const { container } = renderWorkspace()
      expect(nodeKinds(container)).not.toContain('prompt')
      fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
      typeInto(screen.getByRole('textbox', { name: 'Message the team' }), '@team Audit the harnesses')
      expect(wordsIn(screen.getByRole('textbox', { name: 'Message the team' }))).toBe('@team Audit the harnesses')
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
    it('says in the agent panel where the agent sits, instead of a fourth responder control', () => {
      const researcher = documentState.nodes[0]
      researcher.selected = true
      const view = renderWorkspace()
      try {
        expect(screen.getByRole('region', { name: 'In the workflow' })).toHaveTextContent(/Step 1 of \d · receives your request first/)
        expect(screen.queryByRole('button', { name: /Produces the team output/ })).not.toBeInTheDocument()
      } finally {
        view.unmount()
        researcher.selected = false
      }
    })

    // The user: the panel showed what the agent's workbench already sets. It now says only what this
    // team makes of the agent, and the workbench is one click away.
    it('leaves what the workbench sets to the workbench', () => {
      const researcher = documentState.nodes[0]
      researcher.selected = true
      const view = renderWorkspace()
      try {
        const panel = screen.getByRole('complementary', { name: 'Selected node settings' })
        expect(within(panel).getByRole('button', { name: 'Open its workbench' })).toBeInTheDocument()
        for (const field of ['Name', 'Instructions']) expect(within(panel).queryByRole('textbox', { name: field })).not.toBeInTheDocument()
        expect(within(panel).queryByRole('button', { name: 'Thinking effort and more settings' })).not.toBeInTheDocument()
        expect(within(panel).queryByRole('group', { name: 'Allowed without asking' })).not.toBeInTheDocument()
        // Agents are built in My agents before a team uses them, so the panel no longer offers to keep one there.
        expect(within(panel).queryByRole('button', { name: 'Add to My agents' })).not.toBeInTheDocument()
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

    it('keeps the output and capabilities reader below 768 px', async () => {
      const width = window.innerWidth
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420, writable: true })
      sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
      renderWorkspace('run-1')
      await waitFor(() => expect(screen.getByRole('main', { name: 'Run workspace' })).toBeInTheDocument())
      expect(screen.queryByRole('application')).not.toBeInTheDocument()
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
      // jsdom has no modal dialogs; the panel opens as one over Details.
      const showModal = HTMLDialogElement.prototype.showModal
      HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
      try {
        renderWorkspace('run-1')
        const routes = await screen.findAllByRole('button', { name: 'What it received' })
        fireEvent.click(routes[0])
        const panel = await screen.findByRole('region', { name: /What Researcher was given/ })
        expect(panel).toHaveTextContent('no preceding stage')
        // The stored packet is read after the panel opens ("Reading the stored packet…").
        await waitFor(() => expect(panel).toHaveTextContent('1 entry · pinned'))
      } finally {
        HTMLDialogElement.prototype.showModal = showModal
      }
    })

    // Details' "What was recorded" is Details' own to wire (DeliveryLane's onShowRecorded), so a
    // team's Details that stops passing it would lose the link without a word.
    it('opens every record behind the run from Details’ What was recorded', async () => {
      sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
      renderWorkspace('run-1')
      fireEvent.click(await screen.findByRole('button', { name: /What was recorded/ }))
      expect(await screen.findByRole('complementary', { name: 'Provenance' })).toBeInTheDocument()
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

describe('the Workflow canvas cards', () => {
  const agentCards = () => [...document.querySelectorAll('[data-node="agent"] > *')].map((card) => card.className)

  it('draws the Build cards, with no run state to claim', async () => {
    composerLayoutState.nodes = []
    composerLayoutState.edges = []
    renderWorkspace()
    await waitFor(() => expect(agentCards()).toHaveLength(2))
    for (const card of agentCards()) expect(card).toContain('build-node')
    expect(document.querySelector('.build-node.has-run')).toBeNull()
    expect(document.querySelector('.lw-shell')).toHaveClass('build-workspace', 'build-graph')
  })
})

// The owner (2026-10-26): Cole wore a lilac spool in My agents, and another figure on the screen a
// link to a run of Cole's chat opened. The chat is a team of one in `.jobs/.bench/cole.yaml` whose
// agent names no link, so the file it is says whose agent it is.
describe('an agent’s own chat, opened on the team screen', () => {
  const lilac = '/agent/figures/spool-lilac.webp'
  let nodes: typeof documentState.nodes
  beforeEach(() => {
    nodes = documentState.nodes
    const [, reviewer] = nodes
    Object.assign(documentState, { path: '/teams/.jobs/.bench/reviewer.yaml', nodes: [{ ...reviewer, data: { ...reviewer.data, isEntrypoint: true } }], edges: [], entrypoint: 'reviewer' })
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/jobs'
      ? new Response(JSON.stringify({ folder: '.jobs', jobs: [{ id: 'reviewer', file: '.jobs/reviewer.yaml', name: 'Reviewer', instructions: 'Review it.', figure: { kind: 'spool', color: 'lilac' } }], problems: [] }), { status: 200 })
      : fallback(input, init)))
  })
  afterEach(() => { Object.assign(documentState, { path: '/teams/demo.yaml', nodes, edges: [{ id: 'researcher->reviewer', source: 'researcher', target: 'reviewer', data: { kind: 'sequence', ts: '' }, selected: false }], entrypoint: 'researcher' }) })

  it('draws its agent in the figure it wears in My agents: its card, the team’s sentence, the palette and the rail', async () => {
    expect(figureStill(figureFor('reviewer'))).not.toBe(lilac)
    renderWorkspace()
    await waitFor(() => expect(document.querySelector('[data-node="agent"] .build-node-figure')).toHaveAttribute('src', lilac))
    expect(document.querySelector('.story-name .tc-mention-face img')).toHaveAttribute('src', lilac)
    expect(screen.getByRole('button', { name: /^Reviewer\s*On this canvas/ }).querySelector('.palette-figure')).toHaveAttribute('src', lilac)
    const rail = screen.getByRole('navigation', { name: 'My team' })
    await waitFor(() => expect(rail.querySelector('[aria-current="page"] .crew-team img')).toHaveAttribute('src', lilac))
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

  it('takes "Fix in Workflow" to the field that has to change, and says why', async () => {
    const restore = withRealSelection()
    sessionState.events = busFailure()
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Workflow/ }))
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
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Workflow/ }))
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
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Workflow/ }))
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
    fireEvent.click(await screen.findByRole('button', { name: /Fix in Workflow/ }))
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
    expect(screen.queryByRole('button', { name: /Fix in Workflow/ })).not.toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: /Fix in Workflow/ })).not.toBeInTheDocument()
  })

  it('keeps the record reachable: "Show evidence" opens the failing call, without the agent panel over it', async () => {
    sessionState.events = busFailure()
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Show evidence' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Researcher couldn’t ask market-researcher' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Researcher/, pressed: true })).toHaveClass('flow-who')
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
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }))
    await waitFor(() => expect(nodePanel()).not.toBeInTheDocument())
    restore()
  })

  // The delivery lane has its own route into this panel; closing on a tab switch must not take it.
  it('leaves the delivery lane’s own "Agent details" route working', async () => {
    const restore = selectionBackedByState(null)
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Agent details' }))
    await waitFor(() => expect(nodePanel()).toBeInTheDocument())
    restore()
  })

  // The lane lives in the run's Details. The panel opened in the canvas's layer, under Details, so
  // "Agent details" seemed to do nothing, and the panel showed only once Details was closed.
  it('opens the panel over the run’s Details, inside the window', async () => {
    const restore = selectionBackedByState(null)
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Agent details' }))
    await waitFor(() => expect(nodePanel()).toBeInTheDocument())
    const panel = nodePanel()!
    const details = screen.getByRole('complementary', { name: 'Details of this piece of work' })
    // The header's menus (☰, the needs-you tray) open in its layer, a Tailwind z-40 class.
    const header = Number(/\bz-(\d+)\b/.exec(document.querySelector('.workspace-chrome')!.className)![1])
    for (const viewport of [DESKTOP, PHONE]) {
      const z = Number(cascaded(panel, 'z-index', viewport))
      expect(z).toBeGreaterThan(Number(cascaded(details, 'z-index', viewport)))
      expect(z).toBeLessThan(header)
      expect(cascaded(panel, 'max-height', viewport)).not.toBeNull()
      expect(cascaded(panel, ['overflow', 'overflow-y'], viewport)).toBe('auto')
    }
    // A phone's Details takes the whole screen: the panel is a sheet across its bottom.
    expect(cascaded(panel, 'position', PHONE)).toBe('fixed')
    expect(cascaded(panel, 'top', PHONE)).toBe('auto')
    expect(cascaded(panel, 'width', PHONE)).toBe('auto')
    restore()
  })

  it('closes the panel with the Details it was opened from', async () => {
    const restore = selectionBackedByState(null)
    sessionState.events = [event(0, 'process', { phase: 'spawned', pid: 1 })]
    renderWorkspace('run-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Agent details' }))
    await waitFor(() => expect(nodePanel()).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Details of this piece of work' })).not.toBeInTheDocument())
    expect(nodePanel()).not.toBeInTheDocument()
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

// Every agent thinks on the person's OpenRouter key: a team can't run until one is added, and Build
// says so before the run rather than letting the first model call fail.
describe('a team whose way of paying isn’t connected', () => {
  function withKey(connected: boolean) {
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/ai') return new Response(JSON.stringify({ openrouter: { connected } }), { status: 200, headers: { 'content-type': 'application/json' } })
      return fallback(input, init)
    }))
  }

  it('says so in the heading, and Run is blocked with the reason', async () => {
    withKey(false)
    renderWorkspace()
    expect(await screen.findByRole('heading', { name: 'Finish setting up' })).toBeInTheDocument()
    // Which agents need which way of paying, and what to do about it (ADR 0073).
    const said = /through OpenRouter, which isn’t connected\. Add an OpenRouter key on the Connections page/
    expect(screen.getAllByText(said).length).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    expect(screen.getAllByText(said).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('textbox', { name: 'Message the team' })).toHaveAttribute('aria-disabled', 'true')
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  // The counterfactual: the same team, with a key, is ready and runs.
  it('leaves a team ready to run once a key is added', async () => {
    withKey(true)
    renderWorkspace()
    expect(await screen.findByRole('heading', { name: 'Your team is ready' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run team' }))
    // Run team means start the team: the box starts with @team, not as a note that starts nothing.
    await waitFor(() => expect(wordsIn(screen.getByRole('textbox', { name: 'Message the team' }))).toBe('@team '))
    typeInto(screen.getByRole('textbox', { name: 'Message the team' }), '@team Summarise the repo')
    expect(screen.getByText(/^Starts the team/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
  })
})

// ADR 0043: Home's way into Ask is "Describe the job", so its header has no Ask button too.
describe('Home', () => {
  // ADR 0097: on Home, Set up project makes projects, and Ask keeps the app's own button.
  it('sets projects up through Set up project, and keeps Ask’s own button in the header', async () => {
    const path = documentState.path
    documentState.path = ''
    try {
      renderWorkspace()
      expect(await screen.findByRole('heading', { name: 'What are you working on?' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Set up project' })).toBeInTheDocument()
      expect(within(screen.getByRole('banner')).getAllByRole('button', { name: /Ask LoomWatch/ })).toHaveLength(1)
    } finally {
      documentState.path = path
    }
  })
})

// The team rail: every team beside the open one, one click away, without going back to Home.
describe('the team rail', () => {
  let assign: ReturnType<typeof vi.fn>
  let real: Location
  beforeEach(() => {
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/teams')) return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml', 'trip.yaml'], teams: [{ path: 'demo.yaml', name: 'Demo', agentCount: 2 }, { path: 'trip.yaml', name: 'Trip', agentCount: 1 }] }), { status: 200 })
      if (url.startsWith('/api/team?')) {
        const path = new URLSearchParams(url.split('?')[1]).get('path')
        return new Response(JSON.stringify({ path, revision: 'r1', yaml: path === 'trip.yaml' ? 'name: Trip\nagents:\n  - {id: planner, name: Planner}\n' : 'name: Demo\nagents: []\n' }), { status: 200 })
      }
      return fallback(input, init)
    }))
    // jsdom makes location.assign non-configurable, so stand in a whole location.
    real = window.location
    assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { href: real.href, pathname: real.pathname, search: real.search, assign } })
  })
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: real })
    Object.assign(documentState, { documentChipState: 'clean', saveState: 'clean', isValid: true })
  })

  it('lists the teams, this one as it is on screen, and opens another on the same tab', async () => {
    renderWorkspace()
    const rail = screen.getByRole('navigation', { name: 'My team' })
    const trip = await within(rail).findByRole('link', { name: 'Trip' })
    // The open team's name and agents are the canvas's, saved or not.
    expect(within(rail).getByRole('link', { name: 'demo' })).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByRole('link', { name: 'demo' }).querySelector('.crew-team')).toHaveClass('n2')
    expect(trip).toHaveAttribute('href', '/?path=trip.yaml')
    fireEvent.click(trip)
    expect(assign).toHaveBeenCalledWith('/?path=trip.yaml')
  })

  // In the app the page follows the address in place (App.tsx): another team's part starts fresh
  // under a new key, beside the frame's rail.
  function TeamPageFrame() {
    const page = useTeamPage()
    return <><FrameTeamRail /><Workspace key={page.key} onDocumentOpen={vi.fn()} initialRunId={page.runId} /></>
  }

  it('opens another team in place, the rail staying with the keyboard on the team picked', async () => {
    render(<TeamPageFrame />)
    const rail = screen.getByRole('navigation', { name: 'My team' })
    const trip = await within(rail).findByRole('link', { name: 'Trip' })
    trip.focus()
    fireEvent.click(trip)
    await waitFor(() => expect(real.search).toBe('?path=trip.yaml'))
    expect(assign).not.toHaveBeenCalled()
    expect(screen.getByRole('navigation', { name: 'My team' })).toBe(rail)
    expect(document.activeElement).toBe(trip)
  })

  it('goes Home in place from the LoomWatch mark', async () => {
    render(<TeamPageFrame />)
    const mark = screen.getByRole('link', { name: 'LoomWatch, my team' })
    // A click that asks for a new tab is left to the browser.
    expect(fireEvent.click(mark, { metaKey: true })).toBe(true)
    expect(real.search).toBe('?path=demo.yaml')
    fireEvent.click(mark)
    await waitFor(() => expect(`${real.pathname}${real.search}`).toBe('/'))
    expect(assign).not.toHaveBeenCalled()
  })

  it('asks before leaving changes, and opens the other team once they are saved', async () => {
    Object.assign(documentState, { documentChipState: 'dirty', saveState: 'dirty' })
    const view = renderWorkspace()
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'My team' })).findByRole('link', { name: 'Trip' }))
    expect(assign).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save first' })) })
    expect(documentState.save).toHaveBeenCalledOnce()
    // Its box goes; the keyboard goes to the team picked, not to the page.
    expect(document.activeElement).toHaveAttribute('href', '/?path=trip.yaml')
    // The page moves only once the team says it is saved, so the browser's own "Leave site?",
    // which asks while there are changes, never asks a second time.
    expect(assign).not.toHaveBeenCalled()
    Object.assign(documentState, { documentChipState: 'saved', saveState: 'saved' })
    view.rerender(workspaceTree())
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/?path=trip.yaml'))
  })

  it('drops the changes by reading the file again, then goes', async () => {
    Object.assign(documentState, { documentChipState: 'dirty', saveState: 'dirty' })
    const view = renderWorkspace()
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'My team' })).findByRole('link', { name: 'Trip' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })) })
    expect(document.activeElement).toHaveAttribute('href', '/?path=trip.yaml')
    expect(documentState.reloadFromDisk).toHaveBeenCalledOnce()
    expect(documentState.save).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
    Object.assign(documentState, { documentChipState: 'clean', saveState: 'clean' })
    view.rerender(workspaceTree())
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/?path=trip.yaml'))
  })

  // ADR 0043: the rail is the one way to another team or a new one; the team menu is this team's file.
  it('opens New team from the rail’s +, and the team menu lists no teams', async () => {
    renderWorkspace()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'My team' })).getByRole('button', { name: 'New team' }))
    expect(await screen.findByRole('dialog', { name: 'Create a team' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Create a team' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
    const menu = screen.getByRole('dialog', { name: 'Team menu' })
    expect(within(menu).queryByRole('listbox')).not.toBeInTheDocument()
    expect(within(menu).queryByText(/New team/)).not.toBeInTheDocument()
    // However a list might come back, the other team's name is not in it.
    expect(within(menu).queryByText('Trip')).not.toBeInTheDocument()
  })
})
