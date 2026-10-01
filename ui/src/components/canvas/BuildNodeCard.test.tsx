import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { CanvasActionsContext, type CanvasActions } from './CanvasActionsContext'
import { BuildAgentCard } from './BuildNodeCard'

vi.mock('@xyflow/react', () => ({
  Handle: ({ type, className }: { type: string; className?: string }) => <span data-handle={type} className={className} />,
  Position: { Left: 'left', Right: 'right' },
}))

const actions: CanvasActions = {
  renameAgent: vi.fn(),
  touchField: vi.fn(),
  mode: 'pipeline',
  stepById: new Map([['ada', { id: 'ada', step: 2, joinFrom: [] }]]),
  nodeNames: new Map([['ada', 'Agent Ada']]),
}

const nodeData: AgentNode['data'] = {
  label: 'Agent Ada',
  agent: {
    id: 'ada',
    name: 'Agent Ada',
    role: 'Protocol Researcher',
    spawn: { cmd: 'opencode', args: [], env: {}, cwd: '.' },
    model: 'openai/gpt-5.4',
    budget: { limitUsd: 5 },
    status: 'idle',
  },
  isEntrypoint: true,
}

const runtime = { status: 'running' as const, taskState: 'STREAMING' as const, task: 'Writing the reply', ownerLabel: 'Agent A · lead', costUsd: 1.25, spentPct: 25, live: true }

function renderCard(data: AgentNode['data'], actionOverrides: Partial<CanvasActions> = {}, selected = false) {
  return render(
    <CanvasActionsContext.Provider value={{ ...actions, ...actionOverrides }}>
      <BuildAgentCard id="ada" data={data} type="agent" dragging={false} zIndex={0} selectable deletable selected={selected} draggable isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />
    </CanvasActionsContext.Provider>,
  )
}

afterEach(cleanup)

describe('BuildAgentCard on the Build canvas', () => {
  it('draws the harness card: kind, name, role and the entrypoint chip', () => {
    const { container } = renderCard({ ...nodeData, harnessLabel: 'Claude Code' })
    const card = container.firstElementChild!
    expect(card).toHaveClass('build-node', 'kind-harness')
    expect(card).not.toHaveClass('has-run')
    expect(screen.getByText('Claude Code')).toHaveClass('node-kind')
    expect(screen.getByText('Agent Ada')).toHaveClass('node-name')
    expect(screen.getByText('Protocol Researcher')).toBeInTheDocument()
    expect(screen.getByText('Start')).toHaveClass('primary-chip')
  })

  it('names the harness from the spawn command when the daemon reported no label', () => {
    renderCard(nodeData)
    expect(screen.getByText('OpenCode')).toHaveClass('node-kind')
  })

  // Nothing a run projects belongs on a card with no run behind it: the spend, the task row and
  // the evidence routes would all be claims about an attempt that does not exist.
  it('carries no run rows without a runtime', () => {
    const { container } = renderCard({ ...nodeData, harnessLabel: 'Claude Code' })
    expect(container.querySelector('.build-node-task')).toBeNull()
    expect(container.querySelector('.build-node-meta')).toBeNull()
    expect(container.querySelector('.budget-lane')).toBeNull()
  })

  it('surfaces incomplete settings without changing the card it is drawn on', () => {
    const { container } = renderCard({ ...nodeData, fieldProblems: { model: { weight: 'incomplete', message: 'Required' } } })
    expect(screen.getByText('Check settings')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('kind-harness')
  })
})

// The Run canvas ("Full trace") draws the same card, so these assert that what a run adds lands
// on it — and that the card is still recognisably the one the operator composed.
describe('BuildAgentCard while a run is shown', () => {
  it('keeps the Build identity row and adds the task row, spend and pipeline ordinal', () => {
    const { container } = renderCard({ ...nodeData, harnessLabel: 'Claude Code', runtime })
    const card = container.firstElementChild!
    expect(card).toHaveClass('build-node', 'kind-harness', 'has-run', 'st-running')
    expect(screen.getByText('Claude Code')).toHaveClass('node-kind')
    expect(screen.getByText('Agent A · lead · STREAMING')).toBeInTheDocument()
    expect(screen.getByText('Writing the reply')).toHaveClass('task-text')
    expect(screen.getByText('$1.25 / $5.00')).toHaveClass('cost')
    expect(screen.getByText('openai/gpt-5.4')).toHaveClass('model')
    expect((card.querySelector('.budget-lane > i') as HTMLElement).style.width).toBe('25%')
    expect(card.querySelector('.step')).toHaveTextContent('2')
  })

  // The React Flow node wrapper already carries the run's accessible name; a second one on the
  // card would announce the same agent twice.
  it('leaves the accessible name to the node wrapper while a run is shown', () => {
    const { container } = renderCard({ ...nodeData, runtime })
    expect(container.firstElementChild).not.toHaveAttribute('aria-label')
    cleanup()
    const planned = renderCard({ ...nodeData, harnessLabel: 'Claude Code' })
    expect(planned.container.firstElementChild).toHaveAttribute('aria-label', 'Agent Ada, Claude Code, Protocol Researcher')
  })

  it('shows the budget limit alone when the run recorded no spend for this agent', () => {
    renderCard({ ...nodeData, runtime: { ...runtime, costUsd: null, spentPct: null } })
    expect(screen.getByText('$5.00')).toHaveClass('cost')
    expect(screen.queryByText(/\$5\.00 \/ /)).not.toBeInTheDocument()
  })

  it('marks the perimeter with the run status, and lets selection take it back', () => {
    expect(renderCard({ ...nodeData, runtime: { ...runtime, status: 'failed' } }).container.firstElementChild).toHaveClass('st-failed')
    cleanup()
    expect(renderCard({ ...nodeData, runtime }, {}, true).container.firstElementChild).toHaveClass('selected', 'st-running')
  })

  it('folds evidence into a count that fans one agent, mirroring the fold in aria-expanded', () => {
    const toggleEvidenceFan = vi.fn()
    renderCard({ ...nodeData, runtime: { ...runtime, eventCount: 12 } }, { toggleEvidenceFan })
    const chip = screen.getByRole('button', { name: '12 events from Agent A · lead; fan its evidence' })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chip)
    expect(toggleEvidenceFan).toHaveBeenCalledWith('ada')
  })

  it('says when a call is still open, rather than implying every event is settled', () => {
    renderCard({ ...nodeData, runtime: { ...runtime, eventCount: 7, openCalls: 1, fanned: true } }, { toggleEvidenceFan: vi.fn() })
    const chip = screen.getByRole('button', { name: /7 events from Agent A · lead; fold its evidence/ })
    expect(chip).toHaveTextContent('7 events · open')
    expect(chip).toHaveAttribute('aria-expanded', 'true')
  })

  it('offers the packet route for an agent that was handed nothing but has a packet', () => {
    const inspectHandover = vi.fn()
    renderCard({ ...nodeData, runtime: { ...runtime, hasPacket: true } }, { inspectHandover })
    fireEvent.click(screen.getByRole('button', { name: 'What it was given' }))
    expect(inspectHandover).toHaveBeenCalledWith('ada')
  })

  it('offers no packet route for an agent the run stored nothing for', () => {
    const { container } = renderCard({ ...nodeData, runtime }, { inspectHandover: vi.fn() })
    expect(screen.queryByRole('button', { name: 'What it was given' })).not.toBeInTheDocument()
    expect(container.querySelector('.build-node-chips')).toBeNull()
  })

  it('counts only the notes this agent was supplied', () => {
    renderCard({ ...nodeData, runtime: { ...runtime, givenNotes: 1 } })
    expect(screen.getByText('given 1 note')).toHaveClass('mem-chip')
    cleanup()
    renderCard({ ...nodeData, runtime: { ...runtime, givenNotes: 3 } })
    expect(screen.getByText('given 3 notes')).toBeInTheDocument()
  })
})

describe('BuildAgentCard as a review stop', () => {
  it('renders the question and its answer route, with no harness, model or spend', () => {
    const onAnswer = vi.fn()
    const { container } = renderCard({
      label: 'You',
      agent: { id: 'review', kind: 'operator', name: 'You', role: 'Review findings' },
      waiting: { node: 'review', name: 'You', kind: 'review_stop', question: 'Approve the findings?', since: '2026-09-13T01:00:00Z', park: 'reloadable', parkNote: 'Parked with no process running', sendBackAvailable: true },
      onAnswer,
    })
    expect(container.firstElementChild).toHaveClass('build-node', 'kind-operator', 'st-waiting')
    expect(screen.getByText('Approve the findings?')).toBeInTheDocument()
    expect(screen.getByText(/Parked with no process running/)).toBeInTheDocument()
    expect(container.querySelector('.budget-lane')).toBeNull()
    expect(container.querySelector('.build-node-meta')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onAnswer).toHaveBeenCalledOnce()
  })

  it('says what an operator node does before it is asked anything', () => {
    renderCard({ label: 'You', agent: { id: 'review', kind: 'operator', name: 'Budget sign-off', role: 'Approve the spend' } })
    expect(screen.getByText('You · Budget sign-off')).toBeInTheDocument()
    expect(screen.getByText('Pauses for your decision')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument()
  })
})
