import { describe, expect, it } from 'vitest'

import { MOVE_MS, dialReading, dialScale, restFor, stretches } from './picturePlay'
import type { WidgetPart } from './types'

const part = (text: string): WidgetPart => ({ label: 'x', text, at: [0, 0] })

describe('picturePlay', () => {
  it('rests on a step as long as its words take to read, within its bounds', () => {
    // Half a second and 45 ms a character, never under 1.5 s or over 8 s.
    expect(restFor(part('x'), 1)).toBe(1500)
    expect(restFor(part('x'.repeat(100)), 1)).toBe(5000)
    expect(restFor(part('x'.repeat(400)), 1)).toBe(8000)
    // Characters, not bytes: Vietnamese words read as long as they look.
    expect(restFor(part('ạ'.repeat(100)), 1)).toBe(5000)
    // The first step longer, so the thing is named before it moves; the step a guess comes before
    // longer, so what was guessed is read with it.
    expect(restFor(part('x'), 0)).toBe(2000)
    expect(restFor(part('x'), 1, { before: 2, question: 'q', choices: ['a', 'b'], answer: 0 })).toBe(3000)
  })

  it('plays a picture of short steps at reading pace, not keeping people waiting', () => {
    // Three steps of a short sentence each, as agents write them: read at about 238 words a
    // minute, plus a moment to look. It took 18.6 s when every step had 2 s of its own.
    const sentence = 'The pilot pulls back and the nose lifts off the runway.'
    const plan = stretches([part(sentence), part(sentence), part(sentence)])
    const whole = plan.at(-1)!.start + plan.at(-1)!.ms
    const reading = 3 * sentence.length * 45
    expect(whole).toBeGreaterThanOrEqual(reading)
    expect(whole).toBeLessThan(reading + 5000)
    expect(whole).toBeLessThan(13000)
  })

  it('plays a rest on each step and a move between each two, end to end', () => {
    const plan = stretches([part('a'), part('b'.repeat(100)), part('c')])
    expect(plan.map((one) => [one.from, one.to, one.ms, one.start])).toEqual([
      [0, 0, 2000, 0],
      [0, 1, MOVE_MS, 2000],
      [1, 1, 5000, 2000 + MOVE_MS],
      [1, 2, MOVE_MS, 7000 + MOVE_MS],
      [2, 2, 1500, 7000 + 2 * MOVE_MS],
    ])
  })

  it('reads a dial between its values, as the drawing moves between them', () => {
    const speeds = [part('x'), part('x'), part('x')].map((one, at) => ({ ...one, label: `${[0, 150, 250][at]} km/h` }))
    expect(dialScale(speeds)).toEqual({ values: [0, 150, 250], before: '', after: ' km/h', decimals: 0 })
    expect(dialReading(speeds, 0)).toBe('0 km/h')
    expect(dialReading(speeds, 2)).toBe('250 km/h')
    // Halfway between two values, eased as the drawing is: halfway.
    expect(dialReading(speeds, 1.5)).toBe('200 km/h')
    // A quarter of the way, eased: slower at first, as the drawing moves.
    expect(dialReading(speeds, 0.25)).toBe('9 km/h')
    // Words before the number, and decimals kept as written.
    const rounds = ['Round 1', 'Round 2', 'Round 3'].map((label) => ({ ...part('x'), label }))
    expect(dialReading(rounds, 1)).toBe('Round 2')
    const levels = ['0.5 m', '1.5 m'].map((label) => ({ ...part('x'), label }))
    expect(dialReading(levels, 0.5)).toBe('1.0 m')
    // Values that aren't one number in the same words read as the nearest step's label.
    const mixed = ['Slow', 'Fast'].map((label) => ({ ...part('x'), label }))
    expect(dialScale(mixed)).toBeNull()
    expect(dialReading(mixed, 0.4)).toBe('Slow')
    expect(dialReading(mixed, 0.6)).toBe('Fast')
  })
})
