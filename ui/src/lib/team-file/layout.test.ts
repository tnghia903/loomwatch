import { describe, expect, it } from 'vitest'

import { autoLayout, offsetCollision, seededLayout } from './layout'

describe('canvas layout', () => {
  it('lays a pipeline out left-to-right with stable coordinates', () => {
    const nodes = [{ id: 'reviewer' }, { id: 'researcher' }, { id: 'editor' }]
    const edges = [{ from: 'researcher', to: 'reviewer' }, { from: 'reviewer', to: 'editor' }]
    const first = autoLayout(nodes, edges)
    const second = autoLayout([...nodes].reverse(), [...edges].reverse())

    expect(first.researcher.x).toBeLessThan(first.reviewer.x)
    expect(first.reviewer.x).toBeLessThan(first.editor.x)
    expect(second).toEqual(first)
  })

  it('uses a centred deterministic constellation when there are no edges', () => {
    expect(seededLayout(['c', 'a', 'b'])).toEqual(seededLayout(['b', 'c', 'a']))
    expect(Object.keys(seededLayout(['a', 'b', 'c']))).toHaveLength(3)
  })

  it('offsets a fully overlapping drop by 24 pixels until clear', () => {
    expect(offsetCollision({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 24, y: 24 }])).toEqual({ x: 48, y: 48 })
  })
})
