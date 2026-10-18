import { Position } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { roundedPath, routeEdge } from './route'

/** Every drawing command in a path, by letter. */
const commands = (path: string) => path.match(/[A-Za-z]/g) ?? []

describe('canvas lines', () => {
  // The user asked for straight lines with rounded corners, never curves: only M, L and the
  // small Q of a corner may appear, and never a long bezier (C).
  it.each([
    ['relay', Position.Right, Position.Left, 400, 0],
    ['relay to another row', Position.Right, Position.Left, 400, 160],
    ['back to an earlier card', Position.Right, Position.Left, -300, 0],
    ['drop', Position.Bottom, Position.Top, 0, 200],
    ['bridge over the row', Position.Top, Position.Top, 900, 0],
    ['bridge under the row', Position.Bottom, Position.Bottom, 900, 0],
    ['tree branch', Position.Bottom, Position.Left, 0, 160],
    ['relay run backwards', Position.Left, Position.Right, -300, 0],
    ['rise to a card above', Position.Top, Position.Bottom, 40, -200],
  ])('draws a %s with straight runs and rounded corners', (_name, sourcePosition, targetPosition, dx, dy) => {
    const { path } = routeEdge({ sourceX: 100, sourceY: 100, targetX: 100 + dx, targetY: 100 + dy, sourcePosition, targetPosition })
    expect(new Set(commands(path))).not.toContain('C')
    for (const letter of commands(path)) expect(['M', 'L', 'Q']).toContain(letter)
  })

  it('takes a bridge up to the height the port chooser kept clear, and labels it there', () => {
    const route = routeEdge({ sourceX: 100, sourceY: 100, targetX: 600, targetY: 100, sourcePosition: Position.Top, targetPosition: Position.Top })
    expect(route.kind).toBe('bridge')
    // bridgeLift(500) = 128: the line runs flat at y = -28, where the label sits.
    expect(route.path).toContain(' -28')
    expect(route.labelY).toBe(-28)
    expect(route.labelX).toBe(350)
  })

  it('rounds each corner, and never by more than half a short run', () => {
    expect(roundedPath([[0, 0], [100, 0], [100, 100]], 14)).toBe('M 0 0 L 86 0 Q 100 0 100 14 L 100 100')
    expect(roundedPath([[0, 0], [10, 0], [10, 100]], 14)).toBe('M 0 0 L 5 0 Q 10 0 10 5 L 10 100')
    // A point in the middle of a straight run, or a repeated one, is no corner.
    expect(roundedPath([[0, 0], [50, 0], [50, 0], [100, 0]])).toBe('M 0 0 L 100 0')
  })
})

describe('a stack', () => {
  it('draws each branch off the trunk its column shares, and labels it left of the trunk', () => {
    const route = routeEdge({ sourceX: 120, sourceY: 100, targetX: 0, targetY: 244, sourcePosition: Position.Bottom, targetPosition: Position.Left, trunk: { x: -20, y: 116 } })
    expect(route.kind).toBe('tree')
    expect(route.path.startsWith('M 120 100 L 120 ')).toBe(true)
    expect(route.path).toContain(' -20 ')
    expect(route.path.endsWith('L 0 244')).toBe(true)
    expect(route.labelX).toBe(-26)
    expect(route.labelY).toBe(244)
  })
})
