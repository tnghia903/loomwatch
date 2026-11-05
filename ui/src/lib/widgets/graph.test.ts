import { describe, expect, it } from 'vitest'

import { barPath, niceTicks } from './graph'

describe('graph', () => {
  it('picks round ticks that hold every value, zero included', () => {
    expect(niceTicks(0, 1300)).toEqual([0, 500, 1000, 1500])
    expect(niceTicks(-3, 7)).toEqual([-5, -2.5, 0, 2.5, 5, 7.5])
    expect(niceTicks(0, 0.9)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(niceTicks(5, 5)).toEqual([5, 6])
  })

  it('rounds a bar’s far end and keeps its base square, up or down', () => {
    expect(barPath(10, 20, 100, 40)).toBe('M10,100 L10,44 Q10,40 14,40 L26,40 Q30,40 30,44 L30,100 Z')
    expect(barPath(10, 20, 100, 160)).toBe('M10,100 L10,156 Q10,160 14,160 L26,160 Q30,160 30,156 L30,100 Z')
  })
})
