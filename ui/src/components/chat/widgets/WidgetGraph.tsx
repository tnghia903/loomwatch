import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { barPath, niceTicks } from '../../../lib/widgets/graph'
import { display } from '../../../lib/widgets/formula'
import type { WidgetSpec } from '../../../lib/widgets/types'

type Graph = Extract<WidgetSpec, { kind: 'graph' }>

/** The plot's height, and the room under it for the labels. */
const HEIGHT = 180
const BELOW = 22
/** Width when the page can't measure it (tests, the first paint). */
const FALLBACK_WIDTH = 560
/** A line's series after the first are dashed and dotted, so a series is never told by colour alone. */
const DASH = [undefined, '6 4', '2 3'] as const

/**
 * Bars to compare or a line over time, up to three series (ADR 0114). To look at: tap or hover a
 * point, or use the arrow keys, to read its values in words above the plot. Two or more series have
 * a legend; the figures are also a table for a screen reader. Series wear `--color-series-n` in a
 * fixed order; every word stays ink.
 */
export function WidgetGraph({ spec }: { spec: Graph }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const [at, setAt] = useState(spec.labels.length - 1)
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
  const left = 8 + Math.max(...tickText.map((text) => text.length)) * 7
  const plot = Math.max(80, width - left - 4)
  const points = spec.labels.length
  const column = plot / points
  const y = (value: number) => HEIGHT - ((value - low) / (high - low || 1)) * HEIGHT
  const x = (index: number) => left + column * (index + 0.5)
  // Every label that fits: as much room as the longest takes, at 11px, and a gap.
  const room = Math.max(24, Math.max(...spec.labels.map((label) => label.length)) * 7 + 10)
  const every = Math.max(1, Math.ceil(points / Math.max(1, Math.floor(plot / room))))
  const selected = Math.min(Math.max(at, 0), points - 1)
  const move = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') setAt((current) => Math.min(points - 1, current + 1))
    else if (event.key === 'ArrowLeft') setAt((current) => Math.max(0, current - 1))
    else return
    event.preventDefault()
  }
  const reading = `${spec.labels[selected]}: ${spec.series.map((series) => `${spec.series.length > 1 ? `${series.label} ` : ''}${written(series.values[selected] ?? 0)}`).join(', ')}`

  return (
    <section className="wg wg-graph" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      {spec.series.length > 1 && (
        <ul className="wg-legend" aria-hidden="true">
          {spec.series.map((series, which) => (
            <li key={which}>
              <svg width="18" height="10" className={`wg-swatch s${which + 1}`}>
                {spec.style === 'line'
                  ? <line x1="1" y1="5" x2="17" y2="5" strokeDasharray={DASH[which]} />
                  : <rect x="3" y="0" width="12" height="10" rx="2" />}
              </svg>
              {series.label}
            </li>
          ))}
        </ul>
      )}
      <p className="wg-reading" aria-live="polite">{reading}</p>
      <div ref={box} className="wg-plot" tabIndex={0} role="group" aria-label={`${spec.title}: use the arrow keys to read each point`} onKeyDown={move}>
        <svg width={width} height={HEIGHT + BELOW} aria-hidden="true">
          {ticks.map((tick, which) => (
            <g key={tick}>
              <line className="wg-grid" x1={left} x2={left + plot} y1={y(tick)} y2={y(tick)} />
              <text className="wg-axis" x={left - 6} y={y(tick)} dy="0.32em" textAnchor="end">{tickText[which]}</text>
            </g>
          ))}
          {spec.labels.map((label, index) => (index % every === 0 || index === selected) && (
            <text key={index} className={`wg-axis${index === selected ? ' on' : ''}`} x={x(index)} y={HEIGHT + 16} textAnchor="middle">{label}</text>
          ))}
          <line className="wg-at" x1={x(selected)} x2={x(selected)} y1={0} y2={HEIGHT} />
          {spec.style === 'bar'
            ? spec.series.map((series, which) => {
                const gap = 2
                const group = Math.min(column * 0.7, 18 * spec.series.length + gap * (spec.series.length - 1))
                const bar = (group - gap * (spec.series.length - 1)) / spec.series.length
                return series.values.map((value, index) => {
                  const start = x(index) - group / 2 + which * (bar + gap)
                  return <path key={`${which}-${index}`} className={`wg-gbar s${which + 1}`} d={barPath(start, bar, y(0), y(value))} />
                })
              })
            : spec.series.map((series, which) => (
                <g key={which}>
                  <path className={`wg-gline s${which + 1}`} strokeDasharray={DASH[which]} d={series.values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ')} />
                  <circle className={`wg-gdot s${which + 1}`} cx={x(selected)} cy={y(series.values[selected] ?? 0)} r={4} />
                </g>
              ))}
          {spec.labels.map((_, index) => (
            <rect key={index} className="wg-hit" x={left + column * index} y={0} width={column} height={HEIGHT + BELOW} onPointerEnter={() => setAt(index)} onClick={() => setAt(index)} />
          ))}
        </svg>
      </div>
      <table className="visually-hidden">
        <caption>{spec.title}</caption>
        <thead><tr><th scope="col">Label</th>{spec.series.map((series, which) => <th key={which} scope="col">{series.label}</th>)}</tr></thead>
        <tbody>
          {spec.labels.map((label, index) => (
            <tr key={index}><th scope="row">{label}</th>{spec.series.map((series, which) => <td key={which}>{written(series.values[index] ?? 0)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
