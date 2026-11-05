/**
 * Figures that count whole things, drawn as dots (ADR 0114, `counted`): a dot for each thing, or
 * for a round number of them when there are too many to fit, so a difference is seen before it is
 * read. Dots go in tens, with a little more room after each ten, so they can be counted too.
 */

/** A dot's size and the gap between two, in px (widgets.css `.wg-dots`): a comparison's block of
    dots uses `DOT`, a chart's line the larger `LINE_DOT`. */
export const DOT = 5
export const LINE_DOT = 7
export const DOT_GAP = 2
/** The extra room after each ten. */
export const TEN_GAP = 3

/** How many tens of dots of `size` px fit side by side in `width` px; at least one. */
export function tensIn(width: number, size = DOT): number {
  const ten = 10 * size + 9 * DOT_GAP
  // k tens take k × ten, and between two of them a gap, the extra room and a gap again.
  const between = DOT_GAP * 2 + TEN_GAP
  return Math.max(1, Math.floor((width + between) / (ten + between)))
}

/**
 * How many things one dot stands for, so `largest` takes at most `room` dots: 1, 2, 5, 10, 20, 50,
 * 100 and on, a round number a person can multiply by.
 */
export function dotEach(largest: number, room: number): number {
  const most = Math.max(1, Math.floor(room))
  if (!(largest > most)) return 1
  for (let magnitude = 1; magnitude < 1e18; magnitude *= 10) {
    for (const step of [1, 2, 5]) {
      const each = step * magnitude
      if (Math.ceil(largest / each) <= most) return each
    }
  }
  return 1e18
}

/** `value` in dots of `each`: its whole dots, and the share of one more it fills, from 0 to 1. */
export function dotsOf(value: number, each: number): { whole: number; part: number } {
  const count = Math.max(0, Number.isFinite(value) ? value : 0) / each
  const whole = Math.floor(count)
  return { whole, part: Math.round((count - whole) * 1000) / 1000 }
}
