import { describe, expect, it } from 'vitest'

import { canZoom, zoomStep, zoomWithin, zoomWords } from './zoom'

describe('zoom steps', () => {
  it('steps in and out from a fitted share to the next round one', () => {
    expect(zoomStep(0.28, 1)).toBe(0.33)
    expect(zoomStep(0.28, -1)).toBe(0.25)
    expect(zoomStep(1, 1)).toBe(1.25)
    expect(zoomStep(1, -1)).toBe(0.75)
  })

  it('takes a share a hair from a step as at it', () => {
    expect(zoomStep(0.496, 1)).toBe(0.67)
    expect(zoomStep(0.504, -1)).toBe(0.33)
  })

  it('stops at the ends, and says so', () => {
    expect(zoomStep(8, 1)).toBe(8)
    expect(zoomStep(0.1, -1)).toBe(0.1)
    expect(canZoom(8, 1)).toBe(false)
    expect(canZoom(0.1, -1)).toBe(false)
    expect(canZoom(0.05, 1)).toBe(true)
    expect(zoomWithin(20)).toBe(8)
    expect(zoomWithin(0.01)).toBe(0.1)
    expect(zoomWithin(0.4)).toBe(0.4)
  })

  it('reads as a whole percent', () => {
    expect(zoomWords(0.2766)).toBe('28%')
    expect(zoomWords(1)).toBe('100%')
  })
})
