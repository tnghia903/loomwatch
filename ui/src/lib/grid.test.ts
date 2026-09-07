import { describe, expect, it } from 'vitest'

import { snapToGrid } from './grid'

describe('snapToGrid', () => {
  it('rounds to the nearest 8px', () => {
    expect(snapToGrid(0)).toBe(0)
    expect(snapToGrid(3)).toBe(0)
    expect(snapToGrid(5)).toBe(8)
    expect(snapToGrid(12)).toBe(16)
    expect(snapToGrid(-5)).toBe(-8)
  })
})
