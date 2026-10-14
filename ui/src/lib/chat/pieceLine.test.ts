import { describe, expect, it } from 'vitest'

import { GHOST_PAD, lineBox, pillBox, withinView } from './pieceLine'

describe('where the flying pill starts and lands', () => {
  it('sits pill-high on the line, its words where the line’s words are', () => {
    expect(lineBox({ left: 100, top: 400, width: 220, height: 18 })).toEqual({ left: 100 - GHOST_PAD, top: 399, width: 220 + GHOST_PAD + 12, height: 20 })
  })

  it('lands on the part of a header pill clear of its face', () => {
    expect(pillBox({ left: 60, top: 12, width: 150, height: 20 })).toEqual({ left: 70, top: 12, width: 140, height: 20 })
  })

  it('leaves from the edge the line went out of', () => {
    const view = { left: 0, top: 100, width: 400, height: 500 }
    // Scrolled off the top: it sets off from just inside the top edge.
    expect(withinView({ left: 20, top: 40, width: 200, height: 20 }, view).top).toBe(100)
    // Off the bottom: from just inside the bottom edge.
    expect(withinView({ left: 20, top: 900, width: 200, height: 20 }, view).top).toBe(580)
    // Still in view: from where it is.
    expect(withinView({ left: 20, top: 300, width: 200, height: 20 }, view).top).toBe(300)
  })
})
