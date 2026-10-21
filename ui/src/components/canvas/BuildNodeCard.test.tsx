import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { figureFor, figureStill } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { SavedAgentsContext } from '../agents/figureContext'
import { CanvasActionsContext, type CanvasActions } from './CanvasActionsContext'
import { BuildAgentCard, BuildCapabilityCard } from './BuildNodeCard'

// The canvas zoom the card reads its depth from (lib/story/depth.ts); 1 is the Team depth.
const view = vi.hoisted(() => ({ zoom: 1 }))
vi.mock('@xyflow/react', () => ({
  Handle: ({ type, className }: { type: string; className?: string }) => <span data-handle={type} className={className} />,
  Position: { Left: 'left', Right: 'right' },
  useConnection: (selector: (connection: { inProgress: boolean }) => unknown) => selector({ inProgress: false }),
  useNodeId: () => null,
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
    model: 'openai/gpt-6.1-sol',
    status: 'idle',
  },
  isEntrypoint: true,
}

function renderCard(data: AgentNode['data'], actionOverrides: Partial<CanvasActions> = {}, selected = false) {
  return render(
    <CanvasActionsContext.Provider value={{ ...actions, ...actionOverrides }}>
      <BuildAgentCard id="ada" data={data} type="agent" dragging={false} zIndex={0} selectable deletable selected={selected} draggable isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />
    </CanvasActionsContext.Provider>,
  )
}

afterEach(cleanup)

describe('BuildAgentCard on the Build canvas', () => {
  it('draws the agent card: its model, name, role and the entrypoint chip', () => {
    const { container } = renderCard({ ...nodeData, modelLabel: 'GPT-6.1 Sol' })
    const card = container.firstElementChild!
    expect(card).toHaveClass('build-node', 'kind-harness')
    expect(card).not.toHaveClass('has-run')
    expect(screen.getByText('GPT-6.1 Sol')).toHaveClass('node-kind')
    expect(screen.getByText('Agent Ada')).toHaveClass('node-name')
    expect(screen.getByText('Protocol Researcher')).toBeInTheDocument()
    expect(screen.getByText('Start')).toHaveClass('primary-chip')
  })

  it('names the model from its id before the model list has arrived', () => {
    renderCard(nodeData)
    expect(screen.getByText('GPT-6.1 Sol')).toHaveClass('node-kind')
    cleanup()
    renderCard({ ...nodeData, agent: { ...nodeData.agent, model: 'fake/offline' } })
    expect(screen.getByText('Offline demo (no AI)')).toHaveClass('node-kind')
  })

  // A run is read in the team's chat and its Details, never on the canvas card.
  it('carries no run rows', () => {
    const { container } = renderCard(nodeData)
    expect(container.querySelector('.build-node-task')).toBeNull()
    expect(container.querySelector('.build-node-meta')).toBeNull()
  })

  it('surfaces incomplete settings without changing the card it is drawn on', () => {
    const { container } = renderCard({ ...nodeData, fieldProblems: { model: { weight: 'incomplete', message: 'Required' } } })
    expect(screen.getByText('Check settings')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('kind-harness')
  })

  it('names the agent, its model and its job in its accessible name', () => {
    const { container } = renderCard(nodeData)
    expect(container.firstElementChild).toHaveAccessibleName('Agent Ada, GPT-6.1 Sol, Protocol Researcher')
  })
})

describe('BuildAgentCard wears the agent’s figure', () => {
  it('is the one it wears in My agents when it came from there, and the one its id picks when it is the team’s own', () => {
    const editor: SavedJob = { id: 'editor', file: '.jobs/editor.yaml', name: 'Editor', instructions: 'Edit.', figure: { kind: 'button', color: 'butter' } }
    // Placed from Your agents as "editor-2": it still wears Editor's figure, found by its link.
    const { container, unmount } = render(
      <SavedAgentsContext.Provider value={[editor]}>
        <CanvasActionsContext.Provider value={actions}>
          <BuildAgentCard id="editor-2" data={{ ...nodeData, agent: { ...nodeData.agent, id: 'editor-2', from: { agent: 'editor', version: 1 } } }} type="agent" dragging={false} zIndex={0} selectable deletable selected={false} draggable isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />
        </CanvasActionsContext.Provider>
      </SavedAgentsContext.Provider>,
    )
    expect(container.querySelector('.build-node-figure')).toHaveAttribute('src', figureStill({ kind: 'button', color: 'butter' }))
    unmount()
    const own = renderCard(nodeData)
    expect(own.container.querySelector('.build-node-figure')).toHaveAttribute('src', figureStill(figureFor('ada')))
  })
})

describe('BuildAgentCard as a review stop', () => {
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

  // ADR 0039: what the agent panel would tell, not the id and the command line.
  const facts = () => Object.fromEntries([...document.querySelectorAll('.depth-trace-facts dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]))

  it('adds what the agent may do and is given when zoomed in to Trace', () => {
    view.zoom = 1.4
    renderCard({ ...nodeData, agent: { ...nodeData.agent, model: 'sonnet', thinkingEffort: 'high', allow: { web: true, commands: true }, capabilities: [{ kind: 'knowledge', name: 'brand.pdf' }, { kind: 'skill', name: 'claude-design' }] } })
    expect(facts()).toEqual({
      Model: 'sonnet · high effort',
      Allowed: 'Search the web, run commands',
      Given: 'brand.pdf, claude-design skill',
    })
    expect(document.querySelector('.depth-story-line')).toBeNull()
  })

  it('names an effort in plain words at Trace, and leaves the model’s default out', () => {
    view.zoom = 1.4
    renderCard({ ...nodeData, agent: { ...nodeData.agent, model: 'sonnet', thinkingEffort: 'xhigh' } })
    expect(facts().Model).toBe('sonnet · extra high effort')
    cleanup()
    renderCard({ ...nodeData, agent: { ...nodeData.agent, model: 'sonnet[default]', thinkingEffort: undefined } })
    expect(facts().Model).toBe('sonnet')
  })

  it('says plainly when an agent is allowed and given nothing extra', () => {
    view.zoom = 1.4
    renderCard({ ...nodeData, agent: { ...nodeData.agent, model: undefined } })
    expect(facts()).toEqual({ Model: 'Default model', Allowed: 'Reading only', Given: 'Nothing connected' })
  })

  it('names a folder chosen for the agent, whatever is connected to it (ADR 0042)', () => {
    view.zoom = 1.4
    const chosen = { ...nodeData.agent, spawn: { cwd: '/Users/me/Projects/website' } }
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

// ADR 0043: a skill, tool, folder or file card is removed from its panel or with Delete, like an
// agent card; its own × was a second remove button for the same thing.
describe('BuildCapabilityCard', () => {
  it('has no remove button of its own, and says what it is and who uses it', () => {
    render(<BuildCapabilityCard id="knowledge@/Users/me/reports" data={{ kind: 'knowledge', name: 'reports', source: 'Linked folder', path: '/Users/me/reports', wiredTo: 2, readOnly: false }} type="capability" dragging={false} zIndex={0} selectable deletable selected={false} draggable isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />)
    expect(screen.getByRole('article', { name: 'reports, linked folder at /Users/me/reports, used by 2 agents' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove reports/ })).not.toBeInTheDocument()
  })
})

// ADR 0043: an agent a source is dragged over says it will take the drop.
it('outlines the agent a skill, tool, folder or file is dragged over', () => {
  const { container, unmount } = renderCard(nodeData, { dropTargetId: 'ada' })
  expect(container.querySelector('article')).toHaveClass('drop-target')
  unmount()
  const other = renderCard(nodeData, { dropTargetId: 'someone-else' })
  expect(other.container.querySelector('article')).not.toHaveClass('drop-target')
})
