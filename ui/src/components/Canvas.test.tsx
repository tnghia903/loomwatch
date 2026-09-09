import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  fileGone: false,
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
  createNewDocument: vi.fn(), reloadFromDisk: vi.fn(), keepMine: vi.fn(), useDisk: vi.fn(), saveCopy: vi.fn(), layoutNodes: vi.fn(),
  settleNodeCollision: vi.fn(), capturePositionHistory: vi.fn(), undo: vi.fn(), redo: vi.fn(),
  onNodesChange: vi.fn(), onEdgesChange: vi.fn(), onConnect: vi.fn(), addAgentFromDrop: vi.fn(), save: vi.fn(),
  touchField: vi.fn(), renameAgent: vi.fn(), updateAgentModel: vi.fn(), updateAgentCwd: vi.fn(), updateAgentBudget: vi.fn(),
  updateAgentAllowRecruiting: vi.fn(), promoteEntrypoint: vi.fn(), removeAgent: vi.fn(), updateTeamGuards: vi.fn(),
  updateTeamBudget: vi.fn(), dismissRefusal: vi.fn(),
}))

const flowState = vi.hoisted(() => ({
  fitView: vi.fn(), screenToFlowPosition: vi.fn(), setViewport: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(),
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
  useReactFlow: () => flowState,
}))

vi.mock('../lib/team-file/useTeamDocument', () => ({ useTeamDocument: () => documentState }))
vi.mock('./canvas/AgentNodeCard', () => ({ AgentNodeCard: () => null }))
vi.mock('./canvas/ConfiguredEdgeView', () => ({ ConfiguredEdgeView: () => null }))
vi.mock('./canvas/DocumentChip', () => ({
  DocumentChip: ({ onSelectProblem }: { onSelectProblem: (problem: { agentId: string }) => void }) =>
    <button type="button" onClick={() => onSelectProblem({ agentId: 'ada' })}>Select validation problem</button>,
}))
vi.mock('./canvas/ModePill', () => ({ ModePill: () => null }))

describe('Canvas accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(documentState, { readOnlyReason: null, saveState: 'saved', documentChipState: 'saved' })
  })

  afterEach(cleanup)

  it('labels the application, focusable graph elements, and saved-state announcement', () => {
    render(<Canvas harnessCount={1} harnessesLoading={false} libraryVisible onToggleLibrary={vi.fn()} onDocumentOpen={vi.fn()} />)

    expect(screen.getByRole('application', { name: 'Team canvas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ada, Researcher, gpt-5, idle' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'sequence from Ada to Reviewer' })).toBeInTheDocument()
    expect(screen.getByTestId('flow')).toHaveAttribute('data-nodes-focusable', 'true')
    expect(screen.getByTestId('flow')).toHaveAttribute('data-edges-focusable', 'true')
    expect(screen.getByText('Team saved.').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
  })

  it('keeps the schema-version mismatch notice persistently visible', () => {
    const reason = 'This file uses schema version 2. This build of LoomWatch understands version 1.'
    Object.assign(documentState, { readOnlyReason: reason, saveState: 'read-only', documentChipState: 'read-only' })

    render(<Canvas harnessCount={1} harnessesLoading={false} libraryVisible onToggleLibrary={vi.fn()} onDocumentOpen={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent(reason)
  })

  it('selects and centres the node identified by a validation problem', () => {
    render(<Canvas harnessCount={1} harnessesLoading={false} libraryVisible onToggleLibrary={vi.fn()} onDocumentOpen={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select validation problem' }))

    expect(documentState.onNodesChange).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'ada', selected: true }),
      expect.objectContaining({ id: 'reviewer', selected: false }),
    ]))
    expect(flowState.fitView).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ id: 'ada' })],
    }))
  })
})

function renderCanvas() {
  return render(<Canvas harnessCount={1} harnessesLoading={false} libraryVisible onToggleLibrary={vi.fn()} onDocumentOpen={vi.fn()} />)
}

function focusEditingElement(tagName: 'input' | 'textarea') {
  const element = document.createElement(tagName)
  document.body.appendChild(element)
  element.focus()
  return element
}

describe('Canvas save shortcut (§9.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(documentState, { readOnlyReason: null, saveState: 'saved', documentChipState: 'saved', externalChange: null })
  })

  afterEach(cleanup)

  it('saves with ⌘S while an input is focused', () => {
    renderCanvas()
    const input = focusEditingElement('input')

    expect(fireEvent.keyDown(input, { key: 's', metaKey: true })).toBe(false)

    expect(documentState.save).toHaveBeenCalledOnce()
    input.remove()
  })

  it('saves with Ctrl+S while a textarea is focused', () => {
    renderCanvas()
    const textarea = focusEditingElement('textarea')

    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })

    expect(documentState.save).toHaveBeenCalledOnce()
    textarea.remove()
  })

  it('does not save from an input when the document is read-only', () => {
    Object.assign(documentState, { readOnlyReason: 'This file uses schema version 2. This build of LoomWatch understands version 1.' })
    renderCanvas()
    const input = focusEditingElement('input')

    fireEvent.keyDown(input, { key: 's', metaKey: true })

    expect(documentState.save).not.toHaveBeenCalled()
    input.remove()
  })

  it('preserves normal text entry in a focused input', () => {
    renderCanvas()
    const input = focusEditingElement('input')

    expect(fireEvent.keyDown(input, { key: 's' })).toBe(true)

    expect(documentState.save).not.toHaveBeenCalled()
    input.remove()
  })
})

describe('Canvas conflict compare sheet (§9.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(documentState, {
      readOnlyReason: null,
      saveState: 'conflict',
      documentChipState: 'conflict',
      externalChange: { diskYaml: 'agents: []\n', diskRevision: 'disk-hash' },
    })
  })

  afterEach(cleanup)

  it('repeats Keep mine and Use disk at the sheet foot, with Use disk confirming inline', () => {
    renderCanvas()
    fireEvent.click(screen.getByRole('button', { name: 'Compare…' }))
    const sheet = screen.getByRole('dialog', { name: 'Disk ↔ in-memory YAML' })

    expect(sheet).toHaveTextContent('--- disk')

    fireEvent.click(within(sheet).getByRole('button', { name: 'Use disk' }))
    expect(documentState.useDisk).not.toHaveBeenCalled()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Discard my edits?' }))
    expect(documentState.useDisk).toHaveBeenCalledOnce()
  })

  it('keeps the in-memory edits from the compare sheet', () => {
    renderCanvas()
    fireEvent.click(screen.getByRole('button', { name: 'Compare…' }))
    const sheet = screen.getByRole('dialog', { name: 'Disk ↔ in-memory YAML' })

    fireEvent.click(within(sheet).getByRole('button', { name: 'Keep mine' }))

    expect(documentState.keepMine).toHaveBeenCalledOnce()
    expect(documentState.useDisk).not.toHaveBeenCalled()
  })
})
