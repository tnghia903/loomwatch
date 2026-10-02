import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BuildResourceInspector } from './BuildResourceInspector'

afterEach(cleanup)

const props = { placed: true, connectedAgents: [], onAdd: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() }

describe('BuildResourceInspector', () => {
  /** ADR 0036: a knowledge card that is not memory is never delivered, and the short panel says so. */
  it('says a knowledge card that is not memory delivers nothing, and keeps the wiring hint for memory', () => {
    const card = { id: 'knowledge:loomwatch-project', name: 'loomwatch project', source: 'LoomWatch + OpenCode', detail: '', status: 'Compatible' as const }
    const view = render(<BuildResourceInspector {...props} item={card} kind="knowledge" />)
    expect(screen.getByText(/^Not delivered\. Knowledge is now a folder or file you choose/)).toBeInTheDocument()
    expect(screen.queryByText(/Wire this node from a harness/)).not.toBeInTheDocument()

    const memory = { id: 'memory-team', name: 'Research team · memory', source: 'LoomWatch', detail: '', status: 'Ready' as const, memory: { team: 'research-team', brief: 1 } }
    view.rerender(<BuildResourceInspector {...props} item={memory} kind="knowledge" />)
    expect(screen.getByText(/Wire this node from a harness/)).toBeInTheDocument()
    expect(screen.queryByText(/Not delivered/)).not.toBeInTheDocument()
  })
})
