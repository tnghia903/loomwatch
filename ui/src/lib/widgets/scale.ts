import { figureOf } from './chart'
import type { WidgetRange, WidgetSpec } from './types'

type Scale = Extract<WidgetSpec, { kind: 'scale' }>

/** One range as drawn: where it starts across the bar and how wide it is (each 0–1), and whether a
    pin falls in it. */
export interface DrawnRange { label: string; start: number; width: number; from: string; to: string; held: boolean }

/** One pin as drawn: its figure as you read it, where it stands across the bar (0–1), and the
    range it falls in. */
export interface DrawnPin { label: string; figure: string; at: number; range: string | null }

/** A figure under the bar where one range ends and the next starts, the scale's ends too. */
export interface Tick { at: number; figure: string }

/**
 * The range `value` falls in, by its place in `ranges`: the one it is at or above the start of and
 * below the end of, or the last for its very top; -1 off the scale. The twin of the daemon's
 * `scale::range_of`.
 */
export function rangeOf(ranges: readonly WidgetRange[], value: number): number {
  const inside = ranges.findIndex((range) => value >= range.from && value < range.to)
  if (inside >= 0) return inside
  const last = ranges.length - 1
  return last >= 0 && value >= ranges[last].from && value <= ranges[last].to ? last : -1
}

/**
 * A scale to scale (ADR 0114, amended 8 November): each range as wide as the stretch it covers,
 * each pin where its figure falls, and a figure under each meeting of two ranges and at each end,
 * the unit after the last.
 */
export function drawScale(spec: Scale): { ranges: DrawnRange[]; pins: DrawnPin[]; ticks: Tick[] } {
  const low = spec.ranges[0]?.from ?? 0
  const high = spec.ranges[spec.ranges.length - 1]?.to ?? 1
  const span = high - low
  const across = (value: number) => (span > 0 ? Math.min(1, Math.max(0, (value - low) / span)) : 0)
  const bare = { prefix: spec.prefix, decimals: spec.decimals }
  const held = new Set(spec.pins.map((pin) => rangeOf(spec.ranges, pin.value)))
  const ranges = spec.ranges.map((range, at) => ({
    label: range.label,
    start: across(range.from),
    width: across(range.to) - across(range.from),
    from: figureOf(range.from, bare),
    to: figureOf(range.to, spec),
    held: held.has(at),
  }))
  const pins = spec.pins.map((pin) => {
    const range = rangeOf(spec.ranges, pin.value)
    return { label: pin.label, figure: figureOf(pin.value, spec), at: across(pin.value), range: range >= 0 ? spec.ranges[range].label : null }
  })
  const ticks = [low, ...spec.ranges.map((range) => range.to)].map((value, at, all) => ({
    at: across(value),
    figure: figureOf(value, at === all.length - 1 ? spec : bare),
  }))
  return { ranges, pins, ticks }
}

/** About how wide a figure or a label is at the scale's small size, in pixels: a little over
    the widest figures' 7 pixels, so a guess errs on the side of room. */
export function wordsWidth(words: string): number {
  return words.length * 7.5 + 4
}

/**
 * The ticks that have room under a bar `width` pixels wide: the scale's ends always, the first set
 * from the left edge and the last to the right edge, and a figure between them, centred on its
 * place, only when it stands clear of the one kept before it and of the last.
 */
export function ticksThatFit(ticks: readonly Tick[], width: number): Tick[] {
  if (ticks.length <= 2) return [...ticks]
  const last = ticks.length - 1
  const extent = (tick: Tick, at: number): [number, number] => {
    const wide = wordsWidth(tick.figure)
    const x = tick.at * width
    return at === 0 ? [x, x + wide] : at === last ? [x - wide, x] : [x - wide / 2, x + wide / 2]
  }
  const clear = (a: [number, number], b: [number, number]) => b[0] - a[1] >= 6
  const end = extent(ticks[last], last)
  const kept: Tick[] = [ticks[0]]
  let before = extent(ticks[0], 0)
  ticks.slice(1, -1).forEach((tick, index) => {
    const here = extent(tick, index + 1)
    if (clear(before, here) && clear(here, end)) {
      kept.push(tick)
      before = here
    }
  })
  kept.push(ticks[last])
  return kept
}

/** Whether every range's name fits inside it on a bar `width` pixels wide. */
export function namesFit(ranges: readonly DrawnRange[], width: number): boolean {
  return ranges.every((range) => range.width * width >= wordsWidth(range.label) + 12)
}

/** How a pin's name stands over the bar: centred on the pin, or from the pin's side of the bar
    (`first`, `last`) when centred it would cross the card's edge. */
export function pinAnchor(pin: DrawnPin, width: number): '' | 'first' | 'last' {
  const half = wordsWidth(pin.label) / 2
  if (pin.at * width < half) return 'first'
  if ((1 - pin.at) * width < half) return 'last'
  return ''
}

/** Where a pin's name runs across the bar, in pixels, as `pinAnchor` stands it. */
function nameExtent(pin: DrawnPin, width: number): [number, number] {
  const wide = wordsWidth(pin.label)
  const x = pin.at * width
  const anchor = pinAnchor(pin, width)
  return anchor === 'first' ? [x - 6, x - 6 + wide] : anchor === 'last' ? [x + 6 - wide, x + 6] : [x - wide / 2, x + wide / 2]
}

/**
 * Each pin's row above the bar, so pins that stand close keep their names apart: the first row
 * that has room, from the lowest figure up.
 */
export function pinRows(pins: readonly DrawnPin[], width: number): number[] {
  const order = pins.map((_, at) => at).sort((a, b) => pins[a].at - pins[b].at)
  const ends: number[] = []
  const rows = pins.map(() => 0)
  for (const at of order) {
    const [left, right] = nameExtent(pins[at], width)
    let row = ends.findIndex((end) => end + 6 <= left)
    if (row < 0) {
      row = ends.length
      ends.push(0)
    }
    ends[row] = right
    rows[at] = row
  }
  return rows
}
