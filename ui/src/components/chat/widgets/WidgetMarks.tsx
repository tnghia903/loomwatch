import type { WidgetSpec } from '../../../lib/widgets/types'
import { Check, Minus, X } from '../../ui/icon'

type Marks = Extract<WidgetSpec, { kind: 'marks' }>

const WORD = { yes: 'Yes', no: 'No', neither: 'Neither yes nor no' } as const

/**
 * A row of things, each marked yes, no or neither, with a few facts under it (ADR 0114): which
 * results were relevant, which days are free. To look at. A mark is its glyph and its words, never
 * its colour alone; a "no" is quiet, not red, since it marks a fact rather than something wrong.
 */
export function WidgetMarks({ spec }: { spec: Marks }) {
  return (
    <section className="wg wg-marks" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <ul className="wg-cells">
        {spec.cells.map((cell, at) => (
          <li key={at} className={`wg-cell ${cell.mark}`} aria-label={`${cell.label}: ${WORD[cell.mark]}${cell.note ? `, ${cell.note}` : ''}`}>
            <span className="wg-cell-label" aria-hidden="true">{cell.label}</span>
            <span className="wg-cell-mark" aria-hidden="true">
              {cell.mark === 'yes' ? <Check size={16} /> : cell.mark === 'no' ? <X size={16} /> : <Minus size={16} />}
            </span>
            {cell.note && <span className="wg-cell-note" aria-hidden="true">{cell.note}</span>}
          </li>
        ))}
      </ul>
      {spec.facts && spec.facts.length > 0 && (
        <ul className="wg-facts">
          {spec.facts.map((fact, at) => <li key={at}>{fact}</li>)}
        </ul>
      )}
    </section>
  )
}
