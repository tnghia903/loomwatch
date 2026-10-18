import { Handle, Position, useConnection, useNodeId } from '@xyflow/react'

import { BRIDGE_IN_AT, BRIDGE_OUT_AT, PORT } from '../../lib/canvas/ports'

/** The id of the card-sized handles that catch a line dropped anywhere on a card. No drawn line
 *  attaches to them (`lib/canvas/ports.ts` picks those), so a connection's handle ids never matter. */
export const CARD_CATCH = 'card'

interface CardPortsProps {
  /** The card can receive a line (left side). */
  input?: boolean
  /** The card can send a line (right side). */
  output?: boolean
  /** The operator may drag a new line into / out of / down from this card. */
  connectIn?: boolean
  connectOut?: boolean
  connectDown?: boolean
}

/**
 * The one set of connection points every canvas card carries (`lib/canvas/ports.ts` decides which
 * a line uses). Only the left and right points, and an agent's bottom point in Build, can start a
 * connection; the rest exist so a line can meet a card from the side that faces the other card,
 * and are invisible until a line uses them.
 *
 * A line being drawn can be dropped anywhere on a card, not only on its dot: the last two handles
 * cover the whole card. They cannot start a line, so React Flow leaves them without pointer events
 * until a line is being drawn, and the card still selects and drags. They come last so a line with
 * no handle id still meets the dot, the card's first handle of each type.
 */
export function CardPorts({ input = true, output = true, connectIn = false, connectOut = false, connectDown = false }: CardPortsProps) {
  const nodeId = useNodeId()
  // The card a line is being dragged from, so the cards re-render only when a line starts and ends.
  const drawingFrom = useConnection((connection) => (connection.inProgress ? connection.fromNode.id : null))
  // Only while a line is dragged from another card. A click on a dot and then on a card stays a click
  // that selects the card, and a line dropped back on its own card is a change of mind, not a loop.
  const catches = drawingFrom !== null && drawingFrom !== nodeId
  return (
    <>
      {input && <Handle type="target" position={Position.Left} isConnectable={connectIn} />}
      {output && <Handle type="source" position={Position.Right} isConnectable={connectOut} />}
      {output && <Handle id={PORT.down} type="source" position={Position.Bottom} isConnectable={connectDown} />}
      {output && <Handle id={PORT.trunk} type="source" position={Position.Left} isConnectable={false} style={{ top: 'auto', bottom: 6 }} />}
      {output && <Handle id={PORT.bridgeOut} type="source" position={Position.Top} isConnectable={false} style={{ left: `${BRIDGE_OUT_AT * 100}%` }} />}
      {output && <Handle id={PORT.underOut} type="source" position={Position.Bottom} isConnectable={false} style={{ left: `${BRIDGE_OUT_AT * 100}%` }} />}
      {input && <Handle id={PORT.top} type="target" position={Position.Top} isConnectable={false} />}
      {input && <Handle id={PORT.bridgeIn} type="target" position={Position.Top} isConnectable={false} style={{ left: `${BRIDGE_IN_AT * 100}%` }} />}
      {input && <Handle id={PORT.underIn} type="target" position={Position.Bottom} isConnectable={false} style={{ left: `${BRIDGE_IN_AT * 100}%` }} />}
      {input && <Handle id={CARD_CATCH} className="card-catch" type="target" position={Position.Left} isConnectable={connectIn} isConnectableStart={false} isConnectableEnd={catches} />}
      {output && <Handle id={CARD_CATCH} className="card-catch" type="source" position={Position.Right} isConnectable={connectOut} isConnectableStart={false} isConnectableEnd={catches} />}
    </>
  )
}
