import { createElement, type ComponentType, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { RunCapability } from '../../lib/runs/capabilityEvidence'

const handed: unknown[][] = []
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ReactFlow: ({ nodes, nodeTypes }: { nodes: Array<{ id: string; type: string; data: unknown }>; nodeTypes: Record<string, ComponentType<{ data: unknown }>> }) => {
    handed.push(nodes)
    return <>{nodes.map(node => createElement(nodeTypes[node.type], { key: node.id, data: node.data }))}</>
  },
}))
import { CapabilityGraph } from './CapabilityGraph'

const call = (label: string): RunCapability & { agentId: string; agentName: string } => ({
  id: 'editor:tool:Read file', name: 'Read file', kind: 'tool', required: false, state: 'observed', label, evidence: [], agentId: 'editor', agentName: 'Editor',
})
const graph = (items: ReturnType<typeof call>[]) => <CapabilityGraph items={items} harnesses={new Map([['editor', 'Claude Code']])} planned={false} scoped={false} onInspect={() => {}} buttonRef={() => {}} />

describe('CapabilityGraph', () => {
  // React Flow drops a node's measured size whenever it is handed a new node object; one handed
  // over between its measuring and its commit stays hidden for good, which blanked the Editor's
  // graph mid-run. A live run relabels its calls on every event, so that must not rebuild nodes.
  it('keeps its node objects while a live run relabels the same calls', () => {
    handed.length = 0
    const { rerender } = render(graph([call('1 call · in progress')]))
    rerender(graph([call('2 calls · succeeded')]))
    expect(handed.at(-1)).toBe(handed[0])
    expect(screen.getByRole('button', { name: 'Inspect Read file: 2 calls · succeeded' })).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
  })
  it('lays the nodes out again when a new call appears', () => {
    handed.length = 0
    const { rerender } = render(graph([call('1 call · in progress')]))
    rerender(graph([call('1 call · succeeded'), { ...call('1 call · in progress'), id: 'editor:tool:Run command', name: 'Run command' }]))
    expect(handed.at(-1)).not.toBe(handed[0])
    expect(screen.getByRole('button', { name: 'Inspect Run command: 1 call · in progress' })).toBeInTheDocument()
  })
})
