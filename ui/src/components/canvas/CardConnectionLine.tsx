import { getSmoothStepPath, useStoreApi, type ConnectionLineComponentProps, type InternalNode } from '@xyflow/react'

import { choosePorts, portAt, type Box } from '../../lib/canvas/ports'
import { routeEdge } from './route'

function boxOf(node: InternalNode): Box | null {
  const { width, height } = node.measured
  if (!width || !height) return null
  return { ...node.internals.positionAbsolute, width, height }
}

/**
 * The line drawn while connecting. Over a card that would take it, it is the line the connection
 * will draw: between the two points `lib/canvas/ports.ts` chooses, in the same shape, so letting go
 * changes nothing on screen. React Flow on its own would end it at the centre of the handle under
 * the pointer, which for the handle that catches a line anywhere on a card is the card's middle.
 * Anywhere else it runs from the dot it was dragged from to the pointer.
 */
export function CardConnectionLine({ fromNode, fromHandle, fromX, fromY, fromPosition, toX, toY, toPosition, toNode, connectionStatus, connectionLineStyle }: ConnectionLineComponentProps) {
  const store = useStoreApi()
  const from = boxOf(fromNode)
  const to = connectionStatus === 'valid' && toNode && toNode.id !== fromNode.id ? boxOf(toNode) : null
  let path: string
  if (from && to && toNode) {
    // A line dragged backwards, out of a receiving dot, still runs from the sender to the receiver.
    const [source, target] = fromHandle.type === 'source' ? [from, to] : [to, from]
    const others = [...store.getState().nodeLookup.values()]
      .filter((node) => !node.hidden && node.id !== fromNode.id && node.id !== toNode.id)
      .flatMap((node) => boxOf(node) ?? [])
    const ports = choosePorts(source, target, others, false)
    const start = portAt(source, ports.sourceHandle, 'source')
    const end = portAt(target, ports.targetHandle, 'target')
    path = routeEdge({ sourceX: start.point[0], sourceY: start.point[1], sourcePosition: start.side, targetX: end.point[0], targetY: end.point[1], targetPosition: end.side }).path
  } else {
    ;[path] = getSmoothStepPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: toX, targetY: toY, targetPosition: toPosition, borderRadius: 14 })
  }
  return <path d={path} fill="none" className="react-flow__connection-path" style={connectionLineStyle} />
}
