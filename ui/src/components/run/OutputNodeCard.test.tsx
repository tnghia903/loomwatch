// Regression (TNG-166 D4/D5, TNG89_INTERACTION §3.4): a terminally failed run has no
// answer coming — the node is the strip plus `[ Reuse ]`, never a "yet" placeholder, and
// its accessible name must not credit a response the run never produced. The placeholder
// keeps its legitimate use for phases that can still answer.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OutputNode } from '../../lib/runs/graph'
import { CanvasActionsContext, type CanvasActions } from '../canvas/CanvasActionsContext'
import { OutputNodeCard } from './StoryNodes'

vi.mock('@xyflow/react', () => ({
  Handle: ({ type }: { type: string }) => <span data-handle={type} />,
  Position: { Left: 'left', Top: 'top' },
}))

const failedOutput: OutputNode['data'] = {
  text: '',
  phase: 'failed',
  phaseText: 'Run failed.',
  producer: 'lead',
  producerLabel: 'Agent A · lead',
  mode: 'replay',
  streaming: false,
  pending: false,
  strip: { tone: 'alert', message: 'The run finished but no agent produced an answer.', watermark: 'missing_canonical_response' },
  compact: false,
  expanded: false,
  terminal: true,
}

function renderCard(data: OutputNode['data'], actions: Partial<CanvasActions> = {}) {
  const context: CanvasActions = {
    renameAgent: vi.fn(),
    touchField: vi.fn(),
    mode: 'pipeline',
    stepById: new Map(),
    nodeNames: new Map(),
    toggleProvenance: vi.fn(),
    reusePrompt: vi.fn(),
    ...actions,
  }
  return render(
    <CanvasActionsContext.Provider value={context}>
      <OutputNodeCard id="__output" data={data} type="response" dragging={false} zIndex={0} selectable={false} deletable={false} selected={false} draggable={false} isConnectable={false} positionAbsoluteX={0} positionAbsoluteY={0} />
    </CanvasActionsContext.Provider>,
  )
}

afterEach(cleanup)

describe('OutputNodeCard', () => {
  it('renders a terminally failed run as the strip plus [ Reuse ], never as a pending body', () => {
    const { container } = renderCard(failedOutput)
    expect(container.firstElementChild).toHaveClass('st-failed')
    expect(container.querySelector('.rr-body')).toBeNull()
    expect(screen.queryByText('No response text yet.')).not.toBeInTheDocument()
    expect(screen.getByText('The run finished but no agent produced an answer.')).toBeInTheDocument()
    expect(screen.getByText('missing_canonical_response')).toBeInTheDocument()
    expect(screen.getByLabelText('Output, Run failed.')).toBeInTheDocument()
  })

  it('offers [ Reuse ] on the failed node, which reuses the prompt instead of toggling provenance', () => {
    const toggleProvenance = vi.fn()
    const reusePrompt = vi.fn()
    renderCard(failedOutput, { toggleProvenance, reusePrompt })
    fireEvent.click(screen.getByText('[ Reuse ]'))
    expect(reusePrompt).toHaveBeenCalledTimes(1)
    expect(toggleProvenance).not.toHaveBeenCalled()
  })

  it('keeps the "yet" placeholder for a phase that can still answer, naming the producer', () => {
    const { container } = renderCard({ ...failedOutput, phase: 'running', phaseText: 'Running — 1 agent active.', terminal: false, strip: null })
    expect(container.firstElementChild).toHaveClass('st-running')
    expect(screen.getByText('No response text yet.')).toBeInTheDocument()
    expect(screen.getByLabelText('Output response from Agent A · lead, Running — 1 agent active.')).toBeInTheDocument()
    expect(screen.queryByText('[ Reuse ]')).not.toBeInTheDocument()
  })

  // TNG89 §15.2.2: the Output node is permanent, so it exists before any run. That state says
  // whose reply will fill it and claims nothing else — no phase word, no live/replay badge, no
  // producer credited — and it is drawn dashed until content arrives.
  it('names the stage that will fill it while it is still empty, and is drawn dashed', () => {
    const { container } = renderCard({
      ...failedOutput,
      text: '',
      phase: 'queued',
      phaseText: 'No run yet.',
      producerLabel: 'Writer',
      terminal: false,
      strip: null,
      awaiting: true,
      placeholder: "The team's answer appears here when Writer replies.",
    })
    expect(screen.getByLabelText('Output, No run yet.')).toHaveTextContent("The team's answer appears here when Writer replies.")
    expect(container.firstElementChild).toHaveClass('awaiting')
    expect(container.firstElementChild).toHaveClass('story-prompt')
    expect(container.querySelector('.rt-head')).toHaveTextContent('Output / response · Writer')
    expect(container.querySelector('.rr-sub')).toBeNull()
    expect(screen.queryByText('Live')).not.toBeInTheDocument()
    expect(screen.queryByText('Replay')).not.toBeInTheDocument()
    // Nothing to disclose yet, so it is not a button and offers no provenance route.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('streams into the same node rather than swapping the placeholder for another card', () => {
    const awaiting = { ...failedOutput, text: '', phase: 'running' as const, phaseText: 'Running — 1 agent active.', terminal: false, strip: null, placeholder: "The team's answer appears here when Writer replies." }
    const { container, rerender } = renderCard(awaiting)
    expect(container.firstElementChild).toHaveClass('awaiting')

    rerender(
      <CanvasActionsContext.Provider value={{ renameAgent: vi.fn(), touchField: vi.fn(), mode: 'pipeline', stepById: new Map(), nodeNames: new Map() }}>
        <OutputNodeCard id="__output" data={{ ...awaiting, text: 'Three harnesses auto-approve.' }} type="response" dragging={false} zIndex={0} selectable={false} deletable={false} selected={false} draggable={false} isConnectable={false} positionAbsoluteX={0} positionAbsoluteY={0} />
      </CanvasActionsContext.Provider>,
    )
    expect(screen.getByText('Three harnesses auto-approve.')).toBeInTheDocument()
    expect(container.firstElementChild).not.toHaveClass('awaiting')
    expect(screen.queryByText(/appears here when/)).not.toBeInTheDocument()
  })

  it('keeps the body and the provenance route for a failed run that kept partial content', () => {
    renderCard({ ...failedOutput, text: 'A partial answer survived the crash.', phase: 'partial', phaseText: 'Partial answer.' })
    expect(screen.getByText('A partial answer survived the crash.')).toBeInTheDocument()
    expect(screen.queryByText('[ Reuse ]')).not.toBeInTheDocument()
  })
})
