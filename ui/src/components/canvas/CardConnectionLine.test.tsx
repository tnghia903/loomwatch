import { cleanup, render } from '@testing-library/react'
import { Position, ReactFlowProvider, type ConnectionLineComponentProps } from '@xyflow/react'
import { afterEach, describe, expect, it } from 'vitest'

import { choosePorts, portAt, type Box } from '../../lib/canvas/ports'
import { CardConnectionLine } from './CardConnectionLine'
import { routeEdge } from './route'

afterEach(cleanup)

const researcher: Box = { x: 0, y: 0, width: 240, height: 100 }
const checker: Box = { x: 400, y: 0, width: 240, height: 100 }
const folder: Box = { x: 0, y: 300, width: 220, height: 80 }

const internal = (id: string, box: Box) => ({ id, measured: { width: box.width, height: box.height }, internals: { positionAbsolute: { x: box.x, y: box.y } } })

function drawn(props: Partial<ConnectionLineComponentProps>) {
  const { container } = render(
    <ReactFlowProvider>
      <svg>
        <CardConnectionLine {...({
          fromNode: internal('researcher', researcher), fromHandle: { id: null, nodeId: 'researcher', type: 'source', position: Position.Right, x: 0, y: 0, width: 8, height: 8 },
          fromX: 240, fromY: 44, fromPosition: Position.Right, toX: 700, toY: 500, toPosition: Position.Left, toNode: null, toHandle: null, connectionStatus: null, ...props,
        } as ConnectionLineComponentProps)} />
      </svg>
    </ReactFlowProvider>,
  )
  return container.querySelector('path.react-flow__connection-path')!.getAttribute('d')!
}

/** The line the edge between these cards draws once connected. */
function finished(source: Box, target: Box) {
  const ports = choosePorts(source, target, [], false)
  const start = portAt(source, ports.sourceHandle, 'source')
  const end = portAt(target, ports.targetHandle, 'target')
  return routeEdge({ sourceX: start.point[0], sourceY: start.point[1], sourcePosition: start.side, targetX: end.point[0], targetY: end.point[1], targetPosition: end.side }).path
}

describe('CardConnectionLine', () => {
  it('shows, over a card that takes the line, the line the connection will draw', () => {
    // Over the card on the right: right side to left side, not into the card's middle.
    expect(drawn({ toNode: internal('checker', checker), connectionStatus: 'valid' } as Partial<ConnectionLineComponentProps>)).toBe(finished(researcher, checker))
    // Over the folder below, even though the line was dragged out of the right-hand dot: it will
    // leave by the bottom and land on the folder's top.
    const toFolder = drawn({ toNode: internal('folder', folder), connectionStatus: 'valid' } as Partial<ConnectionLineComponentProps>)
    expect(toFolder).toBe(finished(researcher, folder))
    expect(toFolder.startsWith('M 120 100')).toBe(true)
    expect(toFolder.endsWith('L 110 300')).toBe(true)
  })

  it('runs from the sender to the receiver when the line was dragged out of a receiving dot', () => {
    const fromHandle = { id: null, nodeId: 'checker', type: 'target', position: Position.Left, x: 0, y: 0, width: 8, height: 8 }
    expect(drawn({ fromNode: internal('checker', checker), fromHandle, toNode: internal('researcher', researcher), connectionStatus: 'valid' } as Partial<ConnectionLineComponentProps>)).toBe(finished(researcher, checker))
  })

  it('follows the pointer anywhere else, or over a card that would refuse the line', () => {
    expect(drawn({}).endsWith('700 500')).toBe(true)
    expect(drawn({ toNode: internal('checker', checker), connectionStatus: 'invalid' } as Partial<ConnectionLineComponentProps>).endsWith('700 500')).toBe(true)
  })
})
