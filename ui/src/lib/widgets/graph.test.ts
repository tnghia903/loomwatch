import { describe, expect, it } from 'vitest'

import { barPath, niceTicks } from './graph'

describe('graph', () => {
  it('picks round ticks that hold every value, zero included', () => {
    expect(niceTicks(0, 1300)).toEqual([0, 500, 1000, 1500])
    expect(niceTicks(-3, 7)).toEqual([-5, -2.5, 0, 2.5, 5, 7.5])
    expect(niceTicks(0, 0.9)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(niceTicks(5, 5)).toEqual([5, 6])
  })

  it('puts the top line at or above the largest value, so no bar or point rises out of the plot', () => {
    // Vietnam's GDP growth topped at 8.02 % and Ho Chi Minh City's rain at about 430 mm: the top
    // line stopped at 7.5 and 400, and the tallest bars ran into the words above the plot.
    expect(niceTicks(0, 8.02)).toEqual([0, 2.5, 5, 7.5, 10])
    expect(niceTicks(0, 430)).toEqual([0, 200, 400, 600])
    for (const [low, high] of [[0, 8.02], [0, 430], [0, 3.3], [0, 99], [0, 1001], [0, 0.26], [-12, 61], [-0.4, 0]]) {
      const ticks = niceTicks(low, high)
      expect(ticks[0]).toBeLessThanOrEqual(low)
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(high)
      expect(ticks.length).toBeGreaterThanOrEqual(3)
      expect(ticks.length).toBeLessThanOrEqual(7)
    }
  })

  it('gives figures too far apart to measure a plain scale, and never runs on', () => {
    // -1e308 to 1e308 is further than a number holds: the step was not a number, and the chat
    // that drew the graph froze each time it was opened.
    expect(niceTicks(-1e308, 1e308)).toEqual([0, 1])
    expect(niceTicks(0, Number.MAX_VALUE).length).toBeLessThanOrEqual(12)
  })

  it('rounds a bar’s far end and keeps its base square, up or down', () => {
    expect(barPath(10, 20, 100, 40)).toBe('M10,100 L10,44 Q10,40 14,40 L26,40 Q30,40 30,44 L30,100 Z')
    expect(barPath(10, 20, 100, 160)).toBe('M10,100 L10,156 Q10,160 14,160 L26,160 Q30,160 30,156 L30,100 Z')
  })
})
