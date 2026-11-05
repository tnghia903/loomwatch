import { describe, expect, it } from 'vitest'

import { dotEach, dotsOf, tensIn } from './dots'

describe('dots', () => {
  it('gives a dot to each thing while they fit, then a round number of them', () => {
    expect(dotEach(435, 480)).toBe(1)
    expect(dotEach(480, 480)).toBe(1)
    expect(dotEach(481, 480)).toBe(2)
    expect(dotEach(2400, 480)).toBe(5)
    expect(dotEach(4801, 480)).toBe(20)
    expect(dotEach(331_000_000, 60)).toBe(10_000_000)
    expect(dotEach(0, 60)).toBe(1)
    expect(dotEach(Number.NaN, 60)).toBe(1)
  })

  it('draws what is left over as part of a dot, never as a whole one', () => {
    expect(dotsOf(52, 1)).toEqual({ whole: 52, part: 0 })
    expect(dotsOf(435, 10)).toEqual({ whole: 43, part: 0.5 })
    expect(dotsOf(3, 10)).toEqual({ whole: 0, part: 0.3 })
    expect(dotsOf(-4, 1)).toEqual({ whole: 0, part: 0 })
  })

  it('fits tens of dots to the room there is', () => {
    expect(tensIn(0)).toBe(1)
    expect(tensIn(68)).toBe(1)
    expect(tensIn(143)).toBe(2)
    // Two tens need 68 + 7 + 68 px: one short of that is one ten.
    expect(tensIn(142)).toBe(1)
    expect(tensIn(475)).toBe(6)
    // A chart's larger dots: a ten is 88 px.
    expect(tensIn(570, 7)).toBe(6)
    expect(tensIn(310, 7)).toBe(3)
  })
})
