import { cleanup, render } from '@testing-library/react'
import { Position, type ConnectionLineComponentProps } from '@xyflow/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CardConnectionLine } from './CardConnectionLine'
import { CARD_CATCH } from './CardPorts'

afterEach(cleanup)

const card = { x: 400, y: 300, width: 200, height: 80 } // centre (500, 340)

const node = { id: 'folder', measured: { width: card.width, height: card.height }, internals: { positionAbsolute: { x: card.x, y: card.y } } }

function lineEnd(props: Partial<ConnectionLineComponentProps>) {
  const { container } = render(<svg><CardConnectionLine {...({ fromX: 100, fromY: 340, fromPosition: Position.Right, toX: 500, toY: 340, toPosition: Position.Left, toNode: null, toHandle: null, ...props } as ConnectionLineComponentProps)} /></svg>)
  const path = container.querySelector('path.react-flow__connection-path')!
  const numbers = path.getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number)
  return numbers.slice(-2)
}

describe('CardConnectionLine', () => {
  it("ends at the card's edge, not its centre, while the whole card catches the line", () => {
    const toHandle = { id: CARD_CATCH, nodeId: 'folder', type: 'target', position: Position.Left, x: 0, y: 0, width: card.width, height: card.height }
    expect(lineEnd({ toNode: node as unknown as ConnectionLineComponentProps['toNode'], toHandle } as Partial<ConnectionLineComponentProps>)).toEqual([400, 340])
  })

  it('ends where React Flow says everywhere else: at the pointer, or at a dot', () => {
    expect(lineEnd({ toX: 700, toY: 500 })).toEqual([700, 500])
    const dot = { id: null, nodeId: 'folder', type: 'target', position: Position.Left, x: 0, y: 0, width: 8, height: 8 }
    expect(lineEnd({ toX: 404, toY: 344, toNode: node as unknown as ConnectionLineComponentProps['toNode'], toHandle: dot } as Partial<ConnectionLineComponentProps>)).toEqual([404, 344])
  })
})
