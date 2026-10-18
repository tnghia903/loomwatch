import { act, cleanup, render } from '@testing-library/react'
import { Position, ReactFlow, ReactFlowProvider, useStoreApi, type Node } from '@xyflow/react'
import { useEffect } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { CARD_CATCH, CardPorts } from './CardPorts'

// The real React Flow, so the classes it gives a handle (and with them its pointer events) are the
// ones under test. jsdom has no ResizeObserver; nothing here needs a measurement.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(cleanup)

const nodes: Node[] = [
  { id: 'ada', type: 'card', position: { x: 0, y: 0 }, data: {} },
  { id: 'bea', type: 'card', position: { x: 400, y: 0 }, data: {} },
]
const nodeTypes = { card: () => <article><CardPorts connectIn connectOut /></article> }

function Store({ onStore }: { onStore: (store: ReturnType<typeof useStoreApi>) => void }) {
  const store = useStoreApi()
  useEffect(() => onStore(store), [onStore, store])
  return null
}

function renderCanvas() {
  let store: ReturnType<typeof useStoreApi> | null = null
  const view = render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}><ReactFlow nodes={nodes} nodeTypes={nodeTypes} /></div>
      <Store onStore={(api) => { store = api }} />
    </ReactFlowProvider>,
  )
  const handle = (node: string, id: string | null, type: 'source' | 'target') => view.container.querySelector(`.react-flow__handle[data-id$="-${node}-${id}-${type}"]`)!
  return { ...view, store: store!, handle }
}

// A line being dragged from Ada's right-hand dot, as React Flow's XYHandle sets it.
function dragFrom(store: ReturnType<typeof useStoreApi>, nodeId: string) {
  const fromHandle = { id: null, nodeId, type: 'source' as const, position: Position.Right, x: 0, y: 0, width: 8, height: 8 }
  act(() => store.setState({
    connection: {
      inProgress: true, isValid: null, from: { x: 0, y: 0 }, fromHandle, fromPosition: Position.Right,
      fromNode: store.getState().nodeLookup.get(nodeId)!, to: { x: 0, y: 0 }, toHandle: null, toPosition: Position.Left, toNode: null, pointer: { x: 0, y: 0 },
    },
  }))
}

describe('CardPorts: a line can be dropped anywhere on a card', () => {
  it('puts a card-sized handle of each type after the dots, so a line with no handle id meets the dot', () => {
    const { container } = renderCanvas()
    const card = container.querySelector('.react-flow__node[data-id="ada"]')!
    const targets = [...card.querySelectorAll('.react-flow__handle.target')]
    const sources = [...card.querySelectorAll('.react-flow__handle.source')]
    expect(targets[0]).not.toHaveAttribute('data-handleid')
    expect(sources[0]).not.toHaveAttribute('data-handleid')
    expect(targets.at(-1)).toHaveAttribute('data-handleid', CARD_CATCH)
    expect(sources.at(-1)).toHaveAttribute('data-handleid', CARD_CATCH)
    expect(targets.at(-1)).toHaveClass('card-catch')
  })

  it('takes no pointer at rest, so the card still selects and drags', () => {
    const { handle } = renderCanvas()
    for (const type of ['target', 'source'] as const) {
      const catcher = handle('ada', CARD_CATCH, type)
      expect(catcher).toHaveClass('connectable')
      expect(catcher).not.toHaveClass('connectablestart')
      expect(catcher).not.toHaveClass('connectionindicator')
    }
  })

  it('catches a line dragged from another card, but not one dragged from its own', () => {
    const { store, handle } = renderCanvas()
    dragFrom(store, 'ada')
    expect(handle('bea', CARD_CATCH, 'target')).toHaveClass('connectableend', 'connectionindicator')
    // A source-to-source line is refused, so Bea's other catcher stays out of the way.
    expect(handle('bea', CARD_CATCH, 'source')).not.toHaveClass('connectionindicator')
    // Dropping the line back on Ada is a change of mind, not "Ada follows Ada".
    expect(handle('ada', CARD_CATCH, 'target')).not.toHaveClass('connectableend')
    expect(handle('ada', CARD_CATCH, 'target')).not.toHaveClass('connectionindicator')
  })

  it('stays out of a click-to-connect, so a click on a card after a click on a dot selects it', () => {
    const { store, handle } = renderCanvas()
    act(() => store.setState({ connectionClickStartHandle: { nodeId: 'ada', id: null, type: 'source' } }))
    expect(handle('bea', null, 'target')).toHaveClass('connectionindicator')
    expect(handle('bea', CARD_CATCH, 'target')).not.toHaveClass('connectionindicator')
  })
})
