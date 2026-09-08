import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Canvas } from './Canvas'

const documentState = vi.hoisted(() => ({
  path: '/teams/research.yaml',
  nodes: [{
    id: 'ada',
    type: 'agent',
    position: { x: 0, y: 0 },
    selected: false,
    data: {
      label: 'Ada',
      agent: {
        id: 'ada', name: 'Ada', role: 'Researcher', model: 'gpt-5', status: 'idle',
        spawn: { cmd: 'codex', args: [], env: {}, cwd: '.' }, budget: { limitUsd: 5 },
      },
    },
  }, {
    id: 'reviewer',
    type: 'agent',
    position: { x: 300, y: 0 },
    selected: false,
    data: {
      label: 'Reviewer',
      agent: {
        id: 'reviewer', name: 'Reviewer', role: 'Reviewer', model: 'gpt-5', status: 'idle',
        spawn: { cmd: 'codex', args: [], env: {}, cwd: '.' }, budget: { limitUsd: 5 },
      },
    },
  }],
  edges: [{ id: 'ada-reviewer', source: 'ada', target: 'reviewer', ariaLabel: 'sequence from Ada to Reviewer', selected: false }],
  entrypoint: 'ada',
  entrypointProblem: null,
  teamGuards: null,
  teamBudget: null,
  saveState: 'saved',
  documentChipState: 'saved',
  saveError: null,
  documentProblems: [],
  fieldProblemsByAgent: new Map(),
  isValid: true,
  readOnlyReason: null,
  loadFailure: null,
  externalChange: null,
  diskNotice: null,
  yamlPreview: '',
  canUndo: false,
  canRedo: false,
  refusal: null,
  mode: 'team',
  pipelineSteps: [],
  modeSwitchBanner: false,
  pendingEdgeRemoval: null,
  createNewDocument: vi.fn(), reloadFromDisk: vi.fn(), keepMine: vi.fn(), useDisk: vi.fn(), layoutNodes: vi.fn(),
  settleNodeCollision: vi.fn(), capturePositionHistory: vi.fn(), undo: vi.fn(), redo: vi.fn(),
  onNodesChange: vi.fn(), onEdgesChange: vi.fn(), onConnect: vi.fn(), addAgentFromDrop: vi.fn(), save: vi.fn(),
  touchField: vi.fn(), renameAgent: vi.fn(), updateAgentModel: vi.fn(), updateAgentCwd: vi.fn(), updateAgentBudget: vi.fn(),
  updateAgentAllowRecruiting: vi.fn(), promoteEntrypoint: vi.fn(), removeAgent: vi.fn(), updateTeamGuards: vi.fn(),
  updateTeamBudget: vi.fn(), dismissRefusal: vi.fn(),
}))

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: ({ ariaLabel }: { ariaLabel: string }) => <div aria-label={ariaLabel} />,
  MiniMap: () => null,
  ReactFlow: ({ nodes, edges, nodesFocusable, edgesFocusable, children }: {
    nodes: Array<{ id: string; ariaLabel?: string }>
    edges: Array<{ id: string; ariaLabel?: string }>
    nodesFocusable: boolean
    edgesFocusable: boolean
    children: React.ReactNode
  }) => <div data-testid="flow" data-nodes-focusable={String(nodesFocusable)} data-edges-focusable={String(edgesFocusable)}>
    {nodes.map((node) => <button key={node.id} aria-label={node.ariaLabel} />)}
    {edges.map((edge) => <button key={edge.id} aria-label={edge.ariaLabel} />)}
    {children}
  </div>,
  useReactFlow: () => ({ fitView: vi.fn(), screenToFlowPosition: vi.fn(), setViewport: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn() }),
}))

vi.mock('../lib/team-file/useTeamDocument', () => ({ useTeamDocument: () => documentState }))
vi.mock('./canvas/AgentNodeCard', () => ({ AgentNodeCard: () => null }))
vi.mock('./canvas/ConfiguredEdgeView', () => ({ ConfiguredEdgeView: () => null }))
vi.mock('./canvas/DocumentChip', () => ({ DocumentChip: () => null }))
vi.mock('./canvas/ModePill', () => ({ ModePill: () => null }))

describe('Canvas accessibility', () => {
  it('labels the application, focusable graph elements, and saved-state announcement', () => {
    render(<Canvas harnessCount={1} harnessesLoading={false} libraryVisible onToggleLibrary={vi.fn()} onDocumentOpen={vi.fn()} />)

    expect(screen.getByRole('application', { name: 'Team canvas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ada, Researcher, gpt-5, idle' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'sequence from Ada to Reviewer' })).toBeInTheDocument()
    expect(screen.getByTestId('flow')).toHaveAttribute('data-nodes-focusable', 'true')
    expect(screen.getByTestId('flow')).toHaveAttribute('data-edges-focusable', 'true')
    expect(screen.getByText('Team saved.').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
  })
})
