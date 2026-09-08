import { describe, expect, it } from 'vitest'

import { pipelineOrder } from './pipelineOrder'

describe('pipelineOrder', () => {
  it('is empty in team mode (no edges)', () => {
    expect(pipelineOrder(['a', 'b'], [], 'a')).toEqual([])
  })

  it('numbers a linear chain from the entrypoint', () => {
    const steps = pipelineOrder(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
      'a',
    )
    expect(steps).toEqual([
      { id: 'a', step: 1, joinFrom: [] },
      { id: 'b', step: 2, joinFrom: [] },
      { id: 'c', step: 3, joinFrom: [] },
    ])
  })

  it('flags a join node with its predecessors in edge-declaration order', () => {
    const steps = pipelineOrder(
      ['a', 'b', 'c', 'd'],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
      'a',
    )
    const d = steps.find((s) => s.id === 'd')
    expect(d?.joinFrom).toEqual(['b', 'c'])
    expect(steps[0]).toEqual({ id: 'a', step: 1, joinFrom: [] })
    expect(d?.step).toBe(4)
  })

  it('appends a node unreachable from the entrypoint deterministically', () => {
    const steps = pipelineOrder(
      ['a', 'b', 'orphan'],
      [{ from: 'a', to: 'b' }],
      'a',
    )
    expect(steps.map((s) => s.id)).toEqual(['a', 'b', 'orphan'])
    expect(steps.find((s) => s.id === 'orphan')?.joinFrom).toEqual([])
  })

  it('still produces an order when entrypoint is null', () => {
    const steps = pipelineOrder(['a', 'b'], [{ from: 'a', to: 'b' }], null)
    expect(steps.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
