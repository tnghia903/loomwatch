import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { CanvasActionsContext, type CanvasActions } from './CanvasActionsContext'
import { AgentNodeCard } from './AgentNodeCard'

const viewport = vi.hoisted(() => ({ zoom: 1 }))

vi.mock('@xyflow/react', () => ({
  Handle: ({ type, className }: { type: string; className?: string }) => <span data-handle={type} className={className} />,
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

function renderAtZoom(zoom: number, selected = true) {
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
        selected={selected}
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
    expect(container.firstElementChild).toHaveClass('h-[88px]', 'w-[264px]', 'shadow-[0_0_0_2px_var(--color-iris)]')
    expect(container.querySelector('[data-handle="target"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handle="source"]')).toBeInTheDocument()
  })

  it('renders the selected compact 264 × 44 card below 0.6 zoom', () => {
    const { container } = renderAtZoom(0.599)

    expect(screen.getByText('Agent Ada')).toBeInTheDocument()
    expect(screen.queryByText('Protocol Researcher')).not.toBeInTheDocument()
    expect(screen.queryByText('openai/gpt-5.4')).not.toBeInTheDocument()
    expect(screen.getByLabelText('idle')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('h-11', 'w-[264px]', 'shadow-[0_0_0_2px_var(--color-iris)]')
    expect(container.querySelector('[data-handle="target"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handle="source"]')).toBeInTheDocument()
  })

  it('keeps selected compact styling and handles at the 0.35 boundary', () => {
    const { container } = renderAtZoom(0.35)

    expect(container.firstElementChild).toHaveClass('h-11', 'w-[264px]', 'shadow-[0_0_0_2px_var(--color-iris)]')
    expect(container.querySelector('[data-handle="target"]')).toBeInTheDocument()
    expect(container.querySelector('[data-handle="source"]')).toBeInTheDocument()
  })

  it('renders the selected 44 × 44 glyph chip with hidden handles below 0.35 zoom', () => {
    const { container } = renderAtZoom(0.349)

    const name = screen.getByText('Agent Ada')
    expect(name).toHaveClass('text-[11px]')
    expect(container.firstElementChild).toHaveClass('size-11', 'shadow-[0_0_0_2px_var(--color-iris)]')
    expect(container.firstElementChild).not.toHaveClass('shadow-sm')
    expect(screen.queryByLabelText('idle')).not.toBeInTheDocument()
    expect(container.querySelector('[data-handle="target"]')).toHaveClass('!opacity-0')
    expect(container.querySelector('[data-handle="source"]')).toHaveClass('!opacity-0')
  })

  it('keeps the normal shadow on an unselected glyph chip', () => {
    const { container } = renderAtZoom(0.349, false)

    expect(container.firstElementChild).toHaveClass('size-11', 'shadow-sm')
    expect(container.firstElementChild).not.toHaveClass('shadow-[0_0_0_2px_var(--color-iris)]')
  })
})
