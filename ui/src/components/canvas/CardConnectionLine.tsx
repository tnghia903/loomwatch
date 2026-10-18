import { getBezierPath, type ConnectionLineComponentProps } from '@xyflow/react'

import { cardEdgePoint } from '../../lib/canvas/ports'
import { CARD_CATCH } from './CardPorts'

/**
 * The line drawn while connecting. React Flow ends it at the centre of the handle under the pointer,
 * and the handle that catches a line anywhere on a card (CardPorts) is the whole card, so over a
 * card this ends it at the card's edge, on the side facing where the line starts. Everywhere else it
 * is React Flow's own bezier.
 */
export function CardConnectionLine({ fromX, fromY, fromPosition, toX, toY, toPosition, toNode, toHandle, connectionLineStyle }: ConnectionLineComponentProps) {
  let end = { x: toX, y: toY, position: toPosition }
  if (toHandle?.id === CARD_CATCH && toNode?.measured.width && toNode.measured.height) {
    const { x, y } = toNode.internals.positionAbsolute
    end = cardEdgePoint({ x: fromX, y: fromY }, { x, y, width: toNode.measured.width, height: toNode.measured.height })
  }
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: end.x, targetY: end.y, targetPosition: end.position })
  return <path d={path} fill="none" className="react-flow__connection-path" style={connectionLineStyle} />
}
