import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { CanvasActionsContext, type CanvasActions } from './CanvasActionsContext'
import { BuildAgentCard } from './BuildNodeCard'

// The canvas zoom the card reads its depth from (lib/story/depth.ts); 1 is the Team depth.
const view = vi.hoisted(() => ({ zoom: 1 }))
vi.mock('@xyflow/react', () => ({
  Handle: ({ type, className }: { type: string; className?: string }) => <span data-handle={type} className={className} />,
  Position: { Left: 'left', Right: 'right' },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) => selector({ transform: [0, 0, view.zoom] }),
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
    status: 'idle',
  },
  isEntrypoint: true,
}

const runtime = { status: 'running' as const, taskState: 'STREAMING' as const, task: 'Writing the reply', ownerLabel: 'Agent A · lead', live: true }

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

  // Nothing a run projects belongs on a card with no run behind it: the task row and the
  // evidence routes would both be claims about an attempt that does not exist.
  it('carries no run rows without a runtime', () => {
    const { container } = renderCard({ ...nodeData, harnessLabel: 'Claude Code' })
    expect(container.querySelector('.build-node-task')).toBeNull()
    expect(container.querySelector('.build-node-meta')).toBeNull()
  })

  it('surfaces incomplete settings without changing the card it is drawn on', () => {
    const { container } = renderCard({ ...nodeData, fieldProblems: { model: { weight: 'incomplete', message: 'Required' } } })
    expect(screen.getByText('Check settings')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('kind-harness')
  })

  // A team shared from another computer: the file is fine, the app is not here.
  it('says on the card when its app is not on this computer, and in its accessible name', () => {
    const sentence = 'Agent Ada’s app “acme-agent-cli” isn’t installed on this computer.'
    const { container } = renderCard({ ...nodeData, appProblem: sentence })
    expect(screen.getByText(sentence)).toHaveClass('build-node-app-problem')
    expect(container.firstElementChild).toHaveAccessibleName(`Agent Ada, OpenCode, Protocol Researcher, ${sentence}`)
  })

  it('draws no app problem on a card that has none', () => {
    const { container } = renderCard(nodeData)
    expect(container.querySelector('.build-node-app-problem')).toBeNull()
    expect(container.firstElementChild).toHaveAccessibleName('Agent Ada, OpenCode, Protocol Researcher')
  })
})

// The Run canvas ("Full trace") draws the same card, so these assert that what a run adds lands
// on it — and that the card is still recognisably the one the operator composed.
describe('BuildAgentCard while a run is shown', () => {
  it('keeps the Build identity row and adds the task row, model and pipeline ordinal', () => {
    const { container } = renderCard({ ...nodeData, harnessLabel: 'Claude Code', runtime })
    const card = container.firstElementChild!
    expect(card).toHaveClass('build-node', 'kind-harness', 'has-run', 'st-running')
    expect(screen.getByText('Claude Code')).toHaveClass('node-kind')
    expect(screen.getByText('Agent A · lead · STREAMING')).toBeInTheDocument()
    expect(screen.getByText('Writing the reply')).toHaveClass('task-text')
    expect(screen.getByText('openai/gpt-5.4')).toHaveClass('model')
    // Spend is not tracked: the meta row is the model alone, with no dollar figure or meter.
    expect(card.querySelector('.build-node-meta')?.children).toHaveLength(1)
    expect(card).not.toHaveTextContent('$')
    expect(card.querySelector('.step')).toHaveTextContent('2')
  })

  // The React Flow node wrapper already carries the run's accessible name; a second one on the
  // card would announce the same agent twice.
  // A run that could not start says so in its own error; the card does not repeat a pre-run check.
  it('draws no app problem while a run is shown', () => {
    const { container } = renderCard({ ...nodeData, runtime, appProblem: 'Agent Ada’s app “acme-agent-cli” isn’t installed on this computer.' })
    expect(container.querySelector('.build-node-app-problem')).toBeNull()
  })

  it('leaves the accessible name to the node wrapper while a run is shown', () => {
    const { container } = renderCard({ ...nodeData, runtime })
    expect(container.firstElementChild).not.toHaveAttribute('aria-label')
    cleanup()
    const planned = renderCard({ ...nodeData, harnessLabel: 'Claude Code' })
    expect(planned.container.firstElementChild).toHaveAttribute('aria-label', 'Agent Ada, Claude Code, Protocol Researcher')
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
  it('renders the question and its answer route, with no harness or model', () => {
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

describe('BuildAgentCard at each depth', () => {
  afterEach(() => { view.zoom = 1 })

  it('says one plain sentence when zoomed out to Story', () => {
    view.zoom = 0.5
    renderCard(nodeData)
    expect(screen.getByText('Researches')).toHaveClass('depth-story-line')
    expect(document.querySelector('.depth-trace-facts')).toBeNull()
  })

  it('tells the run state as a sentence at Story depth', () => {
    view.zoom = 0.5
    renderCard({ ...nodeData, runtime })
    expect(document.querySelector('.depth-story-line')).toHaveTextContent('Writing the reply')
  })

  // ADR 0039: what the agent panel would tell, not the id and the command line.
  const facts = () => Object.fromEntries([...document.querySelectorAll('.depth-trace-facts dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]))

  it('adds what the agent may do and is given when zoomed in to Trace', () => {
    view.zoom = 1.4
    renderCard({ ...nodeData, agent: { ...nodeData.agent, spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' }, model: 'sonnet', thinkingEffort: 'high', allow: { web: true, commands: true }, capabilities: [{ kind: 'knowledge', name: 'brand.pdf' }, { kind: 'skill', name: 'claude-design' }] } })
    expect(facts()).toEqual({
      Model: 'sonnet · high effort',
      Allowed: 'Search the web, run commands',
      Given: 'brand.pdf, claude-design skill',
    })
    expect(document.querySelector('.depth-trace-facts')).not.toHaveTextContent('claude-agent-acp')
    expect(document.querySelector('.depth-story-line')).toBeNull()
  })

  it('says plainly when an agent is allowed and given nothing extra', () => {
    view.zoom = 1.4
    renderCard({ ...nodeData, agent: { ...nodeData.agent, spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' }, model: undefined } })
    expect(facts()).toEqual({ Model: 'App default', Allowed: 'Reading only', Given: 'Nothing connected' })
  })

  it('says an app that never asks is not held back by the switches', () => {
    view.zoom = 1.4
    renderCard(nodeData)
    expect(facts().Allowed).toBe('Anything: OpenCode doesn’t ask')
  })

  it('names a folder chosen for the agent, whatever is connected to it (ADR 0042)', () => {
    view.zoom = 1.4
    const chosen = { ...nodeData.agent, spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '/Users/me/Projects/website' } }
    renderCard({ ...nodeData, agent: chosen })
    expect(facts()['Works in']).toBe('website')
    cleanup()
    renderCard({ ...nodeData, agent: { ...chosen, capabilities: [{ kind: 'tool', name: 'search' }] } })
    expect(facts()['Works in']).toBe('website')
  })

  it('adds nothing at Team depth', () => {
    renderCard(nodeData)
    expect(document.querySelector('.depth-story-line')).toBeNull()
    expect(document.querySelector('.depth-trace-facts')).toBeNull()
  })
})
