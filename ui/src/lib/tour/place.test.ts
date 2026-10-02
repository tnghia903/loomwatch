import { describe, expect, it } from 'vitest'

import { placeCard } from './place'

const viewport = { width: 1000, height: 800 }
const card = { width: 320, height: 200 }

describe('placeCard', () => {
  it('centres a card that has no target', () => {
    expect(placeCard(null, card, viewport)).toEqual({ side: 'center', left: 340, top: 300 })
  })

  it('puts the card on the first side with room, centred on the target', () => {
    const target = { top: 100, left: 400, width: 200, height: 40 }
    expect(placeCard(target, card, viewport, ['bottom', 'top'])).toEqual({ side: 'bottom', top: 154, left: 340 })
  })

  it('skips a side without room for the card', () => {
    // 200 px of card does not fit below a target that ends 60 px above the bottom edge.
    const target = { top: 700, left: 400, width: 200, height: 40 }
    expect(placeCard(target, card, viewport, ['bottom', 'top'])).toEqual({ side: 'top', top: 486, left: 340 })
  })

  it('keeps a card beside its target inside the viewport', () => {
    const target = { top: 10, left: 900, width: 80, height: 30 }
    const placed = placeCard(target, card, viewport, ['bottom'])
    expect(placed).toMatchObject({ side: 'bottom', left: 1000 - 12 - 320 })
  })

  it('falls back to the first side, clamped, when nothing fits', () => {
    const target = { top: 0, left: 0, width: 1000, height: 800 }
    const placed = placeCard(target, card, viewport, ['right'])
    expect(placed).toEqual({ side: 'right', top: 300, left: 1000 - 12 - 320 })
  })

  it('places nothing rather than cover a target that must stay clear', () => {
    const dialog = { top: 16, left: 200, width: 600, height: 768 }
    expect(placeCard(dialog, card, viewport, ['right', 'left'], true)).toBeNull()
    expect(placeCard({ ...dialog, left: 340, width: 300 }, card, viewport, ['right', 'left'], true)).toMatchObject({ side: 'right', left: 654 })
  })
})
