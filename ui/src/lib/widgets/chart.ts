import { display } from './formula'
import type { WidgetSpec } from './types'

type Chart = Extract<WidgetSpec, { kind: 'chart' }>

/** One bar as drawn: where it starts and how wide it is, each a share of the track (0–1). */
export interface DrawnBar {
  label: string
  /** The figure as the person reads it: "51 seats", "$2.27", "-0.4 %". */
  figure: string
  note?: string
  start: number
  width: number
  below: boolean
}

/**
 * A chart's bars to scale: every bar measured against the same zero, so the longest is the
 * largest figure and a figure below zero runs left of the line. When every figure is at or above
 * zero, zero is the left edge. Nothing is drawn wider than the track.
 */
export function drawChart(spec: Chart): { bars: DrawnBar[]; zero: number } {
  const values = spec.bars.map((bar) => (Number.isFinite(bar.value) ? bar.value : 0))
  const above = Math.max(0, ...values)
  const below = Math.max(0, ...values.map((value) => -value))
  const span = above + below
  const zero = span > 0 ? below / span : 0
  const bars = spec.bars.map((bar, at) => {
    const value = values[at]
    const width = span > 0 ? Math.abs(value) / span : 0
    return {
      label: bar.label,
      figure: figureOf(value, spec),
      ...(bar.note ? { note: bar.note } : {}),
      start: value < 0 ? zero - width : zero,
      width,
      below: value < 0,
    }
  })
  return { bars, zero }
}

/** A figure written as the daemon writes it for the agent: prefix, grouped number, unit. */
export function figureOf(value: number, spec: Pick<Chart, 'prefix' | 'unit' | 'decimals'>): string {
  const number = display(value, spec.decimals ?? null) ?? 'too large'
  return `${spec.prefix ?? ''}${number}${spec.unit ? ` ${spec.unit}` : ''}`
}
