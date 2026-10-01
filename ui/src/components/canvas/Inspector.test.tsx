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
      spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' }, budget: { limitUsd: 2 },
    },
  },
}

function renderInspectorProps(overrides: Partial<InspectorProps> = {}): InspectorProps {
  return {
    node, isEntrypoint: false, isResponder: false, onRename: vi.fn(), onModelChange: vi.fn(), onCwdChange: vi.fn(),
    onBudgetChange: vi.fn(), onAllowRecruitingChange: vi.fn(), onPromoteEntrypoint: vi.fn(), onPromoteResponder: vi.fn(),
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
    expect(screen.getByText('Loading models from this harness…')).toBeInTheDocument()

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
    expect(screen.getByText(/Could not load this harness's models: failed to load models from Claude/)).toBeInTheDocument()
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

describe('Inspector responder control', () => {
  it('lets a pipeline agent become the canonical responder', () => {
    const props = renderInspector({ pipeline: true })
    fireEvent.click(screen.getByRole('button', { name: /Produces the team output/ }))
    expect(props.onPromoteResponder).toHaveBeenCalledOnce()
  })

  it('keeps a different responder unavailable in self-organizing team mode', () => {
    renderInspector({ pipeline: false, isEntrypoint: false, isResponder: false })
    const control = screen.getByRole('button', { name: /Produces the team output/ })
    expect(control).toBeDisabled()
    expect(control).toHaveAttribute('title', expect.stringContaining('Create a pipeline'))
  })
})

// docs/TEAM_MEMORY.md §5: the two per-agent memory keys. Until this zone existed only the YAML
// could set them, and the composer chip could promise a Brief the Inspector could not scope.
describe('Inspector memory toggles', () => {
  const withMemory = (memory: AgentNode['data']['agent']['memory']): AgentNode => ({
    ...node, data: { ...node.data, agent: { ...node.data.agent, memory } },
  })

  it('clears the key rather than writing the default when an agent is put back on the brief', () => {
    const props = renderInspector({ node: withMemory({ brief: false }), briefCount: 2 })
    const toggle = screen.getByRole('button', { name: /Reads the team Brief/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)

    // `undefined` removes the override, so the agent inherits the team's block instead of
    // carrying a key that says what the default already says.
    expect(props.onMemoryBriefChange).toHaveBeenCalledWith(true)
  })

  it('opts one agent out, and says how many entries it will stop being supplied', () => {
    const props = renderInspector({ briefCount: 2 })
    const toggle = screen.getByRole('button', { name: /Reads the team Brief/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveTextContent('Supplied 2 entries at the start of every session')

    fireEvent.click(toggle)
    expect(props.onMemoryBriefChange).toHaveBeenCalledWith(false)
  })

  it('says what packet-only costs instead of leaving deliverAs unexplained', () => {
    const props = renderInspector({ node: withMemory({ deliverAs: 'packet-only' }), briefCount: 1 })
    const toggle = screen.getByRole('button', { name: /Brief in its own memory file/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveTextContent('keeps its declared folder')
    expect(toggle).toHaveTextContent('compaction can summarise the Brief away')

    fireEvent.click(toggle)
    expect(props.onDeliverAsChange).toHaveBeenCalledWith('native-file')
  })

  it('inherits the team default, and narrows from it', () => {
    const props = renderInspector({ briefCount: 1, teamDeliverAs: 'packet-only' })
    expect(screen.getByRole('button', { name: /Brief in its own memory file/ })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: /Brief in its own memory file/ }))
    expect(props.onDeliverAsChange).toHaveBeenCalledWith('native-file')
  })

  it('offers no switch over a Brief that does not exist, and says so', () => {
    renderInspector({ briefCount: 0 })
    const toggle = screen.getByRole('button', { name: /Reads the team Brief/ })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveTextContent('This team has no Brief yet')
    // Neither switch may read as on: there is nothing to be supplied, so "on" would be a
    // promise about nothing — and a checked-but-disabled control says the opposite.
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    const deliver = screen.getByRole('button', { name: /Brief in its own memory file/ })
    expect(deliver).toBeDisabled()
    expect(deliver).toHaveAttribute('aria-pressed', 'false')
  })

  it('never claims the agent knows, remembers or has read anything', () => {
    const { container } = render(<Inspector {...renderInspectorProps({ briefCount: 2 })} />)
    const behaviour = [...container.querySelectorAll('.zone')].find((zone) => zone.textContent?.includes('Reads the team Brief'))!
    expect(behaviour.textContent).not.toMatch(/knows|remembers|has read/i)
    expect(behaviour.textContent).toMatch(/Supplied/)
  })
})

it('edits a review question without offering a model, budget or entrypoint', () => {
  const props = renderInspector({ node: { ...node, data: { label: 'You', agent: { kind: 'operator', id: 'review', name: 'You', role: 'Approve?' } } } })
  fireEvent.change(screen.getByLabelText('Review question'), { target: { value: 'What should change?' } })
  expect(props.onRename).toHaveBeenCalledWith('role', 'What should change?')
  expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Budget limit in USD')).not.toBeInTheDocument()
  expect(screen.queryByText(/Make entrypoint/)).not.toBeInTheDocument()
})
