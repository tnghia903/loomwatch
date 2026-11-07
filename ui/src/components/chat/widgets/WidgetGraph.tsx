import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import { barPath, niceTicks } from '../../../lib/widgets/graph'
import { display } from '../../../lib/widgets/formula'
import type { WidgetSpec } from '../../../lib/widgets/types'

type Graph = Extract<WidgetSpec, { kind: 'graph' }>

/** The plot's height, and the room under it for the labels. */
const HEIGHT = 180
const BELOW = 22
/** Width when the page can't measure it (tests). */
const FALLBACK_WIDTH = 560
/** About how wide a character of the 12px axis text is, to fit labels. */
const CHAR = 7.5
/** A line's series after the first are dashed and dotted (round caps add a little to each dash), so
    a series is never told by colour alone. */
const DASH = [undefined, '5 6', '0.1 5'] as const
/** The thinnest a bar is drawn, so a busy graph on a phone still shows each. */
const MIN_BAR = 3

/**
 * A graph: bars side by side or a line over time, up to three series (ADR 0114). To look at: tap or
 * drag across it, hover, or use the arrow keys to read a point's values in words above the plot.
 * Two or more series have a legend; bars after the first are an outline and a hatch, lines a dash
 * and a dot, so a series is never told by colour alone. The figures are also a table for a screen
 * reader. Series wear `--color-series-n` in a fixed order; every word stays ink.
 */
export function WidgetGraph({ spec }: { spec: Graph }) {
  const box = useRef<HTMLDivElement>(null)
  const hatch = `${useId()}-hatch`
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const [at, setAt] = useState(spec.labels.length - 1)
  // Measured before the first paint, so the plot never draws wider than its card; then kept up.
  useLayoutEffect(() => {
    const measured = box.current?.getBoundingClientRect().width
    if (measured) setWidth(Math.max(200, Math.round(measured)))
  }, [])
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(200, Math.round(entry.contentRect.width))) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const written = (value: number) => `${spec.prefix ?? ''}${display(value, spec.decimals ?? null) ?? 'too large'}${spec.unit ? ` ${spec.unit}` : ''}`
  const all = spec.series.flatMap((series) => series.values)
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all))
  const low = ticks[0] ?? 0
  const high = ticks[ticks.length - 1] ?? 1
  const tickText = ticks.map((tick) => `${spec.prefix ?? ''}${display(tick, null) ?? ''}`)
  const left = 8 + Math.max(...tickText.map((text) => text.length)) * CHAR
  const plot = Math.max(80, width - left - 4)
  const points = spec.labels.length
  const column = plot / points
  const y = (value: number) => HEIGHT - ((value - low) / (high - low || 1)) * HEIGHT
  const x = (index: number) => left + column * (index + 0.5)
  // Every label that fits: as much room as the longest takes, and a gap. One at either end stays
  // inside the plot.
  const room = Math.max(24, Math.max(...spec.labels.map((label) => label.length)) * CHAR + 10)
  const every = Math.max(1, Math.ceil(points / Math.max(1, Math.floor(plot / room))))
  const half = (index: number) => ((spec.labels[index]?.length ?? 0) * CHAR) / 2
  const labelX = (index: number) => Math.min(Math.max(x(index), left + half(index)), left + plot - half(index))
  const selected = Math.min(Math.max(at, 0), points - 1)
  // The picked point's label is always drawn; one of the others that would sit on it gives way.
  const clear = (index: number) => Math.abs(labelX(index) - labelX(selected)) >= half(index) + half(selected) + 4
  const move = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') setAt((current) => Math.min(points - 1, current + 1))
    else if (event.key === 'ArrowLeft') setAt((current) => Math.max(0, current - 1))
    else return
    event.preventDefault()
  }
  // A finger pressing or dragging across the plot reads the point under it; up and down scrolls.
  const read = (event: PointerEvent<SVGSVGElement>) => {
    const from = event.currentTarget.getBoundingClientRect().left
    setAt(Math.min(points - 1, Math.max(0, Math.floor((event.clientX - from - left) / column))))
  }
  const reading = `${spec.labels[selected]}: ${spec.series.map((series) => `${spec.series.length > 1 ? `${series.label} ` : ''}${written(series.values[selected] ?? 0)}`).join(', ')}`
  const barFill = (which: number) => (which === 2 ? `url(#${hatch})` : undefined)

  return (
    <section className={`wg wg-graph${spec.series.length > 1 ? ' many' : ''}`} aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      {spec.series.length > 1 && (
        <ul className="wg-legend" aria-hidden="true">
          {spec.series.map((series, which) => (
            <li key={which}>
              <svg width="18" height="10" className={`wg-swatch s${which + 1}`}>
                {spec.style === 'line'
                  ? <line x1="2" y1="5" x2="16" y2="5" strokeDasharray={DASH[which]} />
                  : <rect x="3.75" y="0.75" width="10.5" height="8.5" rx="2" fill={barFill(which)} />}
              </svg>
              {series.label}
            </li>
          ))}
        </ul>
      )}
      <p className="wg-reading" aria-live="polite">{reading}</p>
      <div ref={box} className="wg-plot" tabIndex={0} role="group" aria-label={`${spec.title}: use the arrow keys to read each point`} onKeyDown={move}>
        <svg width={width} height={HEIGHT + BELOW} aria-hidden="true" onPointerDown={read} onPointerMove={read}>
          <defs>
            <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className="wg-hatch s3" x1="0" y1="0" x2="0" y2="5" />
            </pattern>
          </defs>
          {ticks.map((tick, which) => (
            <g key={tick}>
              <line className="wg-grid" x1={left} x2={left + plot} y1={y(tick)} y2={y(tick)} />
              <text className="wg-axis" x={left - 6} y={y(tick)} dy="0.32em" textAnchor="end">{tickText[which]}</text>
            </g>
          ))}
          {spec.labels.map((label, index) => (index === selected || (index % every === 0 && clear(index))) && (
            <text key={index} className={`wg-axis wg-axis-label${index === selected ? ' on' : ''}`} x={labelX(index)} y={HEIGHT + 17} textAnchor="middle">{label}</text>
          ))}
          <line className="wg-at" x1={x(selected)} x2={x(selected)} y1={0} y2={HEIGHT} />
          {spec.style === 'bar'
            ? spec.series.map((series, which) => {
                const gap = 2
                const count = spec.series.length
                const group = Math.max(MIN_BAR * count + gap * (count - 1), Math.min(column * 0.7, 18 * count + gap * (count - 1)))
                const bar = (group - gap * (count - 1)) / count
                return series.values.map((value, index) => {
                  const start = x(index) - group / 2 + which * (bar + gap)
                  return <path key={`${which}-${index}`} className={`wg-gbar s${which + 1}`} fill={barFill(which)} d={barPath(start, bar, y(0), y(value))} />
                })
              })
            : spec.series.map((series, which) => (
                <g key={which}>
                  {spec.series.length === 1 && (
                    <path className="wg-garea s1" d={`${series.values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ')} L${x(series.values.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} />
                  )}
                  <path className={`wg-gline s${which + 1}`} strokeDasharray={DASH[which]} d={series.values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ')} />
                  <circle className={`wg-gdot s${which + 1}`} cx={x(selected)} cy={y(series.values[selected] ?? 0)} r={4} />
                </g>
              ))}
        </svg>
      </div>
      {/* Hidden in a box: a table takes no notice of a 1px width, so on its own it would stay as
          wide as its words and widen the page. */}
      <div className="visually-hidden">
        <table>
          <caption>{spec.title}</caption>
          <thead><tr><td />{spec.series.map((series, which) => <th key={which} scope="col">{series.label}</th>)}</tr></thead>
          <tbody>
            {spec.labels.map((label, index) => (
              <tr key={index}><th scope="row">{label}</th>{spec.series.map((series, which) => <td key={which}>{written(series.values[index] ?? 0)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
