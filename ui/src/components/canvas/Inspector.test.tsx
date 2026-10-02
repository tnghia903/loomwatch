import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { Inspector, type InspectorProps } from './Inspector'

const node: AgentNode = {
  id: 'editor', type: 'agent', position: { x: 0, y: 0 },
  data: {
    label: 'News Editor', isEntrypoint: false,
    agent: {
      id: 'editor', name: 'News Editor', role: 'Edit the digest.', model: 'claude-sonnet-5', status: 'idle',
      spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' },
    },
  },
}

function renderInspectorProps(overrides: Partial<InspectorProps> = {}): InspectorProps {
  return {
    node, onRename: vi.fn(), onModelChange: vi.fn(), onCwdChange: vi.fn(),
    onAllowRecruitingChange: vi.fn(), onPromoteEntrypoint: vi.fn(), onRemoveCapability: vi.fn(),
    onDelete: vi.fn(), onClose: vi.fn(), onFieldBlur: vi.fn(),
    onMemoryBriefChange: vi.fn(), onDeliverAsChange: vi.fn(),
    modelOptions: [
      { id: 'claude-sonnet-5', name: 'Sonnet 5', thinkingEfforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'More deliberate reasoning.' }] },
      { id: 'claude-opus-5', name: 'Opus 5', thinkingEfforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    ], ...overrides,
  }
}

function renderInspector(overrides: Partial<InspectorProps> = {}) {
  const props = renderInspectorProps(overrides)
  render(<Inspector {...props} />)
  return props
}

afterEach(cleanup)

describe('Inspector model picker', () => {
  it('selects a known model instead of accepting a typed model id', () => {
    const props = renderInspector()
    const picker = screen.getByRole('combobox', { name: 'Model' })
    expect(picker).toHaveValue('claude-sonnet-5')
    expect(screen.getByRole('option', { name: 'Opus 5' })).toBeInTheDocument()

    fireEvent.change(picker, { target: { value: 'claude-opus-5' } })
    fireEvent.blur(picker)

    expect(props.onModelChange).toHaveBeenCalledWith('claude-opus-5')
    expect(props.onFieldBlur).toHaveBeenCalledWith('model')
  })

  it('stores thinking effort separately using the harness choices', () => {
    const onThinkingEffortChange = vi.fn()
    renderInspector({ onThinkingEffortChange, defaultThinkingEffort: 'low' })

    const slider = screen.getByRole('slider', { name: 'Thinking effort' })
    expect(slider).toHaveAttribute('aria-valuetext', 'Low')
    fireEvent.change(slider, { target: { value: '1' } })

    expect(onThinkingEffortChange).toHaveBeenCalledWith('high')
  })

  it('keeps a custom value visible and disables the picker in read-only mode', () => {
    renderInspector({
      node: { ...node, data: { ...node.data, agent: { ...node.data.agent, model: 'company/custom-claude' } } },
      readOnly: true,
    })
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('company/custom-claude')
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
  })

  it('shows discovery progress and offers a retry when the harness cannot be queried', () => {
    const retry = vi.fn()
    const { rerender } = render(<Inspector {...renderInspectorProps({ modelOptionsLoading: true })} />)
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
    expect(screen.getByText('Loading models from this app…')).toBeInTheDocument()

    rerender(<Inspector {...renderInspectorProps({ modelOptionsError: 'adapter unavailable', onRetryModelOptions: retry })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  // Switching harness clears the model, so `model` is "Required" in exactly the state where the
  // catalog could not be read. Reporting the field problem there left an empty picker, no reason
  // for it, and no way back — the user saw only "Required" and no models to choose.
  it('still names the discovery failure, and still offers Retry, while the model is unset', () => {
    const retry = vi.fn()
    const unset = { ...node, data: { ...node.data, agent: { ...node.data.agent, model: '' } } }
    render(<Inspector {...renderInspectorProps({
      node: unset,
      modelOptions: [],
      modelOptionsError: 'failed to load models from Claude: timed out after 20s',
      fieldProblems: { model: { weight: 'error', message: 'Required' } },
      onRetryModelOptions: retry,
    })} />)
    expect(screen.getByText(/Could not load this app's models: failed to load models from Claude/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  // The field problem is still the hint whenever the catalog itself is fine.
  it('reports the field problem when the models loaded', () => {
    const unset = { ...node, data: { ...node.data, agent: { ...node.data.agent, model: '' } } }
    render(<Inspector {...renderInspectorProps({ node: unset, fieldProblems: { model: { weight: 'error', message: 'Required' } } })} />)
    expect(screen.getByText('Required')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})

// ADR 0034: CONTEXT replaced BEHAVIOUR. It says what the agent is given — its place in the team,
// the Brief, and what is connected — rather than offering switches that repeated the canvas or did
// nothing in team mode.
describe('Inspector context', () => {
  const withAgent = (agent: Partial<AgentNode['data']['agent']>): AgentNode => ({
    ...node, data: { ...node.data, agent: { ...node.data.agent, ...agent } },
  })
  const zone = (container: HTMLElement) => [...container.querySelectorAll('.zone')].find((candidate) => candidate.querySelector('.zone-head')?.textContent === 'Context')!

  it('replaces the old behaviour switches', () => {
    const { container } = render(<Inspector {...renderInspectorProps({ pipeline: true })} />)
    expect(zone(container)).toBeTruthy()
    expect(screen.queryByText('Behaviour')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Produces the team output/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Starts the team/ })).not.toBeInTheDocument()
  })

  it('states the place the agent is told about, and offers to make it the start only where it can be', () => {
    const place = { summary: 'Step 2 of 3 · after Researcher · hands its work to Writer.', final: false, canStart: false }
    const { rerender } = render(<Inspector {...renderInspectorProps({ place })} />)
    expect(screen.getByText(place.summary)).toBeInTheDocument()
    expect(screen.getByText('The agent is told this at the start of every run.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Make this the starting agent' })).not.toBeInTheDocument()

    const props = renderInspectorProps({ place: { ...place, canStart: true } })
    rerender(<Inspector {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Make this the starting agent' }))
    expect(props.onPromoteEntrypoint).toHaveBeenCalledOnce()
  })

  // `allowRecruiting` is read only in pipeline mode (team_bus::refuse_by_mode); in team mode the
  // switch changed nothing, so it is not offered there.
  it('offers the helpers switch only where it does something', () => {
    renderInspector({ pipeline: false })
    expect(screen.queryByRole('button', { name: /Can bring in helpers/ })).not.toBeInTheDocument()
    cleanup()
    const props = renderInspector({ pipeline: true })
    const toggle = screen.getByRole('button', { name: /Can bring in helpers/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    expect(props.onAllowRecruitingChange).toHaveBeenCalledWith(false)
  })

  it('lists what is connected and disconnects one by kind and name', () => {
    const props = renderInspector({
      node: withAgent({ capabilities: [{ kind: 'skill', name: 'claude-design' }, { kind: 'knowledge', name: 'loomwatch project' }] }),
      inheritedMemory: ['research · memory'],
    })
    const list = screen.getByRole('list', { name: 'Connected to this agent' })
    expect(list).toHaveTextContent('claude-design')
    expect(list).toHaveTextContent('Knowledge · supplied as source material')
    expect(list).toHaveTextContent('research · memory')
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect loomwatch project' }))
    expect(props.onRemoveCapability).toHaveBeenCalledWith({ kind: 'knowledge', name: 'loomwatch project' })
  })

  it('says how to connect something when nothing is', () => {
    renderInspector()
    expect(screen.getByText(/Nothing connected\. Drag a skill, knowledge source or tool/)).toBeInTheDocument()
  })

  it('never offers a disconnect in read-only mode', () => {
    renderInspector({ readOnly: true, node: withAgent({ capabilities: [{ kind: 'tool', name: 'Agent Memory' }] }) })
    expect(screen.queryByRole('button', { name: 'Disconnect Agent Memory' })).not.toBeInTheDocument()
  })
})

// docs/TEAM_MEMORY.md §5: the two per-agent memory keys.
describe('Inspector memory toggles', () => {
  const withMemory = (memory: AgentNode['data']['agent']['memory']): AgentNode => ({
    ...node, data: { ...node.data, agent: { ...node.data.agent, memory } },
  })
  const openProcess = () => fireEvent.click(screen.getByRole('button', { name: /Process/ }))

  it('clears the key rather than writing the default when an agent is put back on the brief', () => {
    const props = renderInspector({ node: withMemory({ brief: false }), briefCount: 2 })
    const toggle = screen.getByRole('button', { name: /Team Brief/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveTextContent('Not supplied — 2 entries left out')

    fireEvent.click(toggle)

    // `undefined` removes the override, so the agent inherits the team's block instead of
    // carrying a key that says what the default already says.
    expect(props.onMemoryBriefChange).toHaveBeenCalledWith(true)
  })

  it('opts one agent out, and says how many entries it will stop being supplied', () => {
    const props = renderInspector({ briefCount: 2 })
    const toggle = screen.getByRole('button', { name: /Team Brief/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveTextContent('2 entries supplied at the start of every session')

    fireEvent.click(toggle)
    expect(props.onMemoryBriefChange).toHaveBeenCalledWith(false)
  })

  it('offers no switch over a Brief that does not exist, and says so', () => {
    renderInspector({ briefCount: 0 })
    expect(screen.queryByRole('button', { name: /Team Brief/ })).not.toBeInTheDocument()
    expect(screen.getByText(/No team Brief yet/)).toBeInTheDocument()
    openProcess()
    expect(screen.queryByRole('button', { name: /Work in this folder/ })).not.toBeInTheDocument()
  })

  // `deliverAs` moved into PROCESS beside the folder it decides, in plain words.
  it('says what working in the folder costs, and narrows from the team default', () => {
    const props = renderInspector({ node: withMemory({ deliverAs: 'packet-only' }), briefCount: 1 })
    openProcess()
    const toggle = screen.getByRole('button', { name: /Work in this folder/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveTextContent('may summarise the Brief away')
    fireEvent.click(toggle)
    expect(props.onDeliverAsChange).toHaveBeenCalledWith('native-file')
  })

  it('inherits the team default', () => {
    const props = renderInspector({ briefCount: 1, teamDeliverAs: 'packet-only' })
    openProcess()
    expect(screen.getByRole('button', { name: /Work in this folder/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Work in this folder/ }))
    expect(props.onDeliverAsChange).toHaveBeenCalledWith('native-file')
  })

  // With anything connected the agent works in its own folder whatever `deliverAs` says, so the
  // switch would decide nothing — and the folder field says it is not used.
  it('drops the folder switch, and says the folder is unused, once something is connected', () => {
    renderInspector({ briefCount: 1, node: { ...node, data: { ...node.data, agent: { ...node.data.agent, capabilities: [{ kind: 'skill', name: 'claude-design' }] } } } })
    openProcess()
    expect(screen.queryByRole('button', { name: /Work in this folder/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Not used while something is connected/)).toBeInTheDocument()
  })

  it('never claims the agent knows, remembers or has read anything', () => {
    const { container } = render(<Inspector {...renderInspectorProps({ briefCount: 2, inheritedMemory: ['research · memory'] })} />)
    const context = [...container.querySelectorAll('.zone')].find((candidate) => candidate.textContent?.includes('Team Brief'))!
    expect(context.textContent).not.toMatch(/knows|remembers|has read/i)
    expect(context.textContent).toMatch(/supplied/)
  })
})

// Budgets are retired: a harness agent's settings have no spend limit or warn-at field to edit.
it('offers no budget field for a harness agent', () => {
  renderInspector()
  expect(screen.queryByLabelText('Budget limit in USD')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Warn at percent')).not.toBeInTheDocument()
  expect(screen.queryByText('Budget')).not.toBeInTheDocument()
})

it('edits a review question without offering a model or entrypoint', () => {
  const props = renderInspector({ node: { ...node, data: { label: 'You', agent: { kind: 'operator', id: 'review', name: 'You', role: 'Approve?' } } } })
  fireEvent.change(screen.getByLabelText('Review question'), { target: { value: 'What should change?' } })
  expect(props.onRename).toHaveBeenCalledWith('role', 'What should change?')
  expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Make entrypoint/)).not.toBeInTheDocument()
})
