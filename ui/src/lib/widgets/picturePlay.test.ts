import { describe, expect, it } from 'vitest'

import { MOVE_MS, restFor, stretches } from './picturePlay'
import type { WidgetPart } from './types'

const part = (text: string): WidgetPart => ({ label: 'x', text, at: [0, 0] })

describe('picturePlay', () => {
  it('rests on a step as long as its words take to read, within its bounds', () => {
    // 2 s and 45 ms a character, never under 2.3 s or over 9 s.
    expect(restFor(part('x'), 1)).toBe(2300)
    expect(restFor(part('x'.repeat(100)), 1)).toBe(6500)
    expect(restFor(part('x'.repeat(400)), 1)).toBe(9000)
    // Characters, not bytes: Vietnamese words read as long as they look.
    expect(restFor(part('ạ'.repeat(100)), 1)).toBe(6500)
    // The first step longer, so the thing is named before it moves; the step a guess comes before
    // longer, so what was guessed is read with it.
    expect(restFor(part('x'), 0)).toBe(2900)
    expect(restFor(part('x'), 1, { before: 2, question: 'q', choices: ['a', 'b'], answer: 0 })).toBe(3800)
  })

  it('plays a rest on each step and a move between each two, end to end', () => {
    const plan = stretches([part('a'), part('b'.repeat(100)), part('c')])
    expect(plan.map((one) => [one.from, one.to, one.ms, one.start])).toEqual([
      [0, 0, 2900, 0],
      [0, 1, MOVE_MS, 2900],
      [1, 1, 6500, 2900 + MOVE_MS],
      [1, 2, MOVE_MS, 9400 + MOVE_MS],
      [2, 2, 2300, 9400 + 2 * MOVE_MS],
    ])
  })
})
