import { Handle, Position } from '@xyflow/react'

import { BRIDGE_IN_AT, BRIDGE_OUT_AT, PORT } from '../../lib/canvas/ports'

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
 */
export function CardPorts({ input = true, output = true, connectIn = false, connectOut = false, connectDown = false }: CardPortsProps) {
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
    </>
  )
}
