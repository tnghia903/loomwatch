import type { CSSProperties } from 'react'

import { dotEach, tensIn } from '../../../lib/widgets/dots'
import { display } from '../../../lib/widgets/formula'
import { figureOf } from '../../../lib/widgets/chart'
import type { WidgetSpec } from '../../../lib/widgets/types'
import { useMeasuredWidth } from '../../../lib/widgets/useMeasuredWidth'
import { WidgetDots } from './WidgetDots'

type Compare = Extract<WidgetSpec, { kind: 'compare' }>

/** Width when the page can't measure it (tests). */
const FALLBACK_WIDTH = 480
/** A side's padding either side, in px (widgets.css `.wg-side`). */
const SIDE_PAD = 10
/** The most rows of dots a side draws, so a block stays a picture rather than a wall. */
const MOST_ROWS = 16
/** Each side's series colour, in order: blue, violet, then clay, which beside blue alone reads
    close to the red that means something is wrong. */
const SERIES = [1, 3, 2] as const

/**
 * Two or three things side by side, or the parts of one thing (ADR 0114): the whole above, joined
 * to each part; each side's name, its figure drawn to scale (a rule from one zero, or a dot for
 * each thing it counts, with a key when a dot stands for more than one), and a few words; then
 * facts read across, each labelled once with a value under each side. To look at. A screen reader reads it as a table.
 */
export function WidgetCompare({ spec }: { spec: Compare }) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH)
  const count = spec.sides.length
  const rows = spec.rows ?? []
  const values = spec.sides.map((side) => side.value)
  const figures = values.every((value) => value !== undefined && Number.isFinite(value))
  const largest = Math.max(0, ...values.map((value) => value ?? 0))
  const toScale = figures && largest > 0 && values.every((value) => (value ?? 0) >= 0)
  const perRow = (Math.min(3, tensIn(width / count - SIDE_PAD * 2)) * 10) as 10 | 20 | 30
  const each = spec.counted && toScale ? dotEach(largest, perRow * MOST_ROWS) : 1
  const number = (value: number) => `${spec.prefix ?? ''}${display(value, spec.decimals ?? null) ?? 'too large'}`

  return (
    <section className="wg wg-compare" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <div ref={box} className={`wg-cmp n${count}`} style={{ '--n': count } as CSSProperties} aria-hidden="true" data-testid="wg-compare">
        {spec.whole && (
          <>
            <div className="wg-whole">
              <b>{spec.whole.label}</b>
              {spec.whole.note && <span>{spec.whole.note}</span>}
            </div>
            <div className="wg-tree" />
          </>
        )}
        {spec.sides.map((side, at) => (
          <div key={at} className={`wg-side s${SERIES[at] ?? 1}${toScale ? ' drawn' : ''}${figures ? '' : ' named'}`}>
            <span className="wg-side-name">{side.label}</span>
            {figures && side.value !== undefined && (
              <span className="wg-side-figure">{number(side.value)}{spec.unit && <small> {spec.unit}</small>}</span>
            )}
            {side.note && <span className="wg-side-note">{side.note}</span>}
            {toScale && side.value !== undefined && (spec.counted
              ? <WidgetDots value={side.value} each={each} perRow={perRow} />
              : <span className="wg-side-scale"><i data-testid="wg-side-scale" style={{ width: `${(side.value / largest) * 100}%`, '--k': at } as CSSProperties} /></span>)}
          </div>
        ))}
        {spec.counted && toScale && each > 1 && (
          <p className="wg-key">
            <i />
            = {figureOf(each, { unit: spec.unit, decimals: 0 })}
          </p>
        )}
        {rows.map((row, at) => (
          <div key={at} className="wg-row">
            <span className="wg-row-label">{row.label}</span>
            {row.values.map((value, side) => <span key={side} className="wg-row-value">{value}</span>)}
          </div>
        ))}
      </div>
      <table className="visually-hidden">
        <caption>{spec.whole ? `${spec.title}: ${spec.whole.label}${spec.whole.note ? `, ${spec.whole.note}` : ''}` : spec.title}</caption>
        <thead>
          <tr>
            <td />
            {spec.sides.map((side, at) => <th key={at} scope="col">{side.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {figures && (
            <tr>
              <th scope="row">{spec.unit ?? 'Number'}</th>
              {spec.sides.map((side, at) => <td key={at}>{side.value === undefined ? '' : figureOf(side.value, spec)}</td>)}
            </tr>
          )}
          {spec.sides.some((side) => side.note) && (
            <tr>
              <th scope="row">Note</th>
              {spec.sides.map((side, at) => <td key={at}>{side.note ?? ''}</td>)}
            </tr>
          )}
          {rows.map((row, at) => (
            <tr key={at}>
              <th scope="row">{row.label}</th>
              {row.values.map((value, side) => <td key={side}>{value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
