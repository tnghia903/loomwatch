import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import type { DetectedHarness } from '../lib/harnesses'
import { Workspace } from './Workspace'

// The whole workspace, with the real team-document hook, opening team files the daemon accepts
// because `config.rs` defaults the keys they leave out. Each used to throw during render, which
// unmounted the whole app and left a blank page.
// Workspace.test.tsx mocks `useTeamDocument`, so it cannot see a file's shape at all.

vi.mock('../lib/watch/useSessionEvents', () => ({
  readArchive: vi.fn(async () => []),
  useSessionEvents: (sessionId: string) => ({ sessionId, events: [], error: null, connected: true }),
}))
vi.mock('../lib/runs/useRunHistory', () => ({ useRunHistory: () => ({ records: [], sessions: [], error: null, unavailable: null, loaded: true, refresh: vi.fn() }) }))
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  Handle: () => null,
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  NodeToolbar: ({ children, isVisible }: { children: React.ReactNode; isVisible?: boolean }) => isVisible ? <>{children}</> : null,
  useStore: (selector: (store: { transform: number[]; minZoom: number; maxZoom: number }) => unknown) => selector({ transform: [0, 0, 1], minZoom: 0.25, maxZoom: 2 }),
  useNodesInitialized: () => true,
  useReactFlow: () => ({ fitView: vi.fn(), screenToFlowPosition: vi.fn(), setViewport: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), getNodes: () => [], getNode: () => undefined }),
  ReactFlow: ({ nodes, nodeTypes }: { nodes: Array<{ id: string; type: string; data: unknown; selected?: boolean }>; nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown; selected: boolean }>> }) => (
    <div data-testid="flow">
      {nodes.map((node) => { const Card = nodeTypes[node.type]; return <div key={node.id}><Card id={node.id} data={node.data} selected={node.selected ?? false} /></div> })}
    </div>
  ),
}))

const SCHEMA = parse(readFileSync(resolve(process.cwd(), '../schemas/team.schema.yaml'), 'utf8')) as object

const HARNESSES: DetectedHarness[] = [
  { id: 'opencode', name: 'OpenCode', command: 'opencode', executablePath: '/bin/opencode', acpAvailable: true, spawn: { cmd: 'opencode', args: ['acp'] } },
  { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/bin/claude', acpAvailable: true, spawn: { cmd: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] } },
]

const WRITER = `  - id: writer
    name: Writer
    role: Write the summary.
    model: sonnet
`

const SHAPES: Array<{ name: string; yaml: string; card: string }> = [
  {
    name: 'a spawn with cmd and cwd but no args or env',
    yaml: `schemaVersion: 1\nid: no-args\nname: No args\nentrypoint: writer\nagents:\n${WRITER}    spawn:\n      cmd: opencode\n      cwd: .\nedges: []\n`,
    card: 'Writer, OpenCode, Write the summary.',
  },
  {
    name: 'an npx spawn with no args, which detection compares against both npx harnesses',
    yaml: `schemaVersion: 1\nid: npx\nname: Npx\nentrypoint: writer\nagents:\n${WRITER}    spawn:\n      cmd: npx\n      cwd: .\nedges: []\n`,
    card: 'Writer, Custom command: npx, Write the summary.',
  },
  {
    name: 'a memory block with inherits and no brief',
    yaml: `schemaVersion: 1\nid: inherits-only\nname: Inherits only\nentrypoint: writer\nmemory:\n  inherits:\n    - team: research\nagents:\n${WRITER}    spawn:\n      cmd: opencode\n      args: [acp]\n      env: {}\n      cwd: .\nedges: []\n`,
    card: 'Writer, OpenCode, Write the summary.',
  },
  {
    name: 'a memory block with inherits, no brief, and no edges key',
    yaml: `schemaVersion: 1\nid: no-edges\nname: No edges\nentrypoint: writer\nmemory:\n  inherits:\n    - team: research\nagents:\n${WRITER}    spawn:\n      cmd: opencode\n      args: [acp]\n      env: {}\n      cwd: .\n`,
    card: 'Writer, OpenCode, Write the summary.',
  },
  {
    name: 'an agent with no name or role, in a team with no id, name or edges',
    yaml: 'schemaVersion: 1\nentrypoint: writer\nagents:\n  - id: writer\n    model: sonnet\n    spawn:\n      cmd: opencode\n      cwd: .\n',
    // The accessible name is trimmed: the card's label is `${name}, ${app}, ${role}` with both ends empty.
    card: ', OpenCode,',
  },
]

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('Workspace opens team files that omit keys the daemon defaults', () => {
  it.each(SHAPES)('opens $name', async ({ yaml, card }) => {
    window.history.replaceState({}, '', `/?path=${encodeURIComponent('/teams/shape.yaml')}`)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/config/schema') return jsonResponse(200, SCHEMA)
      if (url.startsWith('/api/team?')) return jsonResponse(200, { path: '/teams/shape.yaml', yaml })
      if (url.startsWith('/api/team/layout?')) return jsonResponse(200, { version: 1, nodes: [], edges: [], agents: {} })
      return jsonResponse(404, { error: `unexpected ${url}` })
    }))
    render(<Workspace harnesses={HARNESSES} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onDocumentOpen={vi.fn()} initialRunId={null} />)

    expect(await screen.findByRole('article', { name: card })).toBeInTheDocument()
  })
})
