import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { CanvasActionsContext, type CanvasActions } from './CanvasActionsContext'
import { AgentNodeCard } from './AgentNodeCard'

const viewport = vi.hoisted(() => ({ zoom: 1 }))

vi.mock('@xyflow/react', () => ({
  Handle: ({ type }: { type: string }) => <span data-handle={type} />,
  Position: { Left: 'left', Right: 'right' },
  useStore: (selector: (store: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, viewport.zoom] }),
}))

const actions: CanvasActions = {
  renameAgent: vi.fn(),
  touchField: vi.fn(),
  mode: 'team',
  stepById: new Map(),
  nodeNames: new Map(),
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
}

function renderAtZoom(zoom: number) {
  viewport.zoom = zoom
  return render(
    <CanvasActionsContext.Provider value={actions}>
      <AgentNodeCard
        id="ada"
        data={nodeData}
        type="agent"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={false}
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </CanvasActionsContext.Provider>,
  )
}

afterEach(cleanup)

describe('AgentNodeCard level of detail', () => {
  it('renders the full 264 × 88 card at and above 0.6 zoom', () => {
    const { container } = renderAtZoom(0.6)

    expect(screen.getByText('Protocol Researcher')).toBeInTheDocument()
    expect(screen.getByText('openai/gpt-5.4')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('h-[88px]', 'w-[264px]')
  })

  it('renders the compact 264 × 44 card from 0.35 up to 0.6 zoom', () => {
    const { container } = renderAtZoom(0.35)

    expect(screen.getByText('Agent Ada')).toBeInTheDocument()
    expect(screen.queryByText('Protocol Researcher')).not.toBeInTheDocument()
    expect(screen.queryByText('openai/gpt-5.4')).not.toBeInTheDocument()
    expect(screen.getByLabelText('idle')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('h-11', 'w-[264px]')
  })

  it('renders the 44 × 44 glyph chip with an 11 px name label below 0.35 zoom', () => {
    const { container } = renderAtZoom(0.349)

    const name = screen.getByText('Agent Ada')
    expect(name).toHaveClass('text-[11px]')
    expect(container.firstElementChild).toHaveClass('size-11')
    expect(screen.queryByLabelText('idle')).not.toBeInTheDocument()
  })
})
