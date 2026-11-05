import type { CSSProperties } from 'react'

import { drawChart, figureOf } from '../../../lib/widgets/chart'
import { LINE_DOT, dotEach, tensIn } from '../../../lib/widgets/dots'
import type { WidgetSpec } from '../../../lib/widgets/types'
import { useMeasuredWidth } from '../../../lib/widgets/useMeasuredWidth'
import { WidgetDots } from './WidgetDots'

type Chart = Extract<WidgetSpec, { kind: 'chart' }>

/** Width when the page can't measure it (tests): an answer's widget at the chat's usual width. */
const FALLBACK_WIDTH = 570

/**
 * A chart (ADR 0114): each thing's name and figure on a line, and under it a bar LoomWatch draws
 * to scale from the figures the agent gave, every bar from one zero; a figure below zero runs left
 * of the zero line. Figures that count whole things (`counted`) are a line of dots instead, a dot
 * for each thing or, with a key saying so, for a round number of them, in tens. It reads the same
 * without the marks.
 * Nothing is kept: it is for reading.
 */
export function WidgetChart({ spec }: { spec: Chart }) {
  const [box, width] = useMeasuredWidth<HTMLUListElement>(FALLBACK_WIDTH)
  const { bars, zero } = drawChart(spec)
  const crossesZero = bars.some((bar) => bar.below)
  const counted = spec.counted === true && !crossesZero
  const largest = Math.max(0, ...spec.bars.map((bar) => bar.value))
  const each = counted ? dotEach(largest, tensIn(width, LINE_DOT) * 10) : 1
  return (
    <section className={`wg wg-chart${counted ? ' counted' : ''}`} aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <ul ref={box} className="wg-bars">
        {bars.map((bar, at) => (
          <li key={at} className="wg-bar" style={{ '--k': at } as CSSProperties}>
            <span className="wg-bar-label">{bar.label}</span>
            {counted
              ? <WidgetDots value={spec.bars[at]?.value ?? 0} each={each} delay={at} />
              : (
                  <span className="wg-bar-track" aria-hidden="true">
                    {crossesZero && <span className="wg-bar-zero" style={{ left: `${zero * 100}%` }} />}
                    <span className={`wg-bar-fill${bar.below ? ' below' : ''}`} data-testid="wg-bar-fill" style={{ left: `${bar.start * 100}%`, width: `${bar.width * 100}%` }} />
                  </span>
                )}
            <span className="wg-bar-figure">{bar.figure}{bar.note && <span className="wg-bar-note"> {bar.note}</span>}</span>
          </li>
        ))}
      </ul>
      {counted && each > 1 && <p className="wg-key" aria-hidden="true"><i />= {figureOf(each, { unit: spec.unit, decimals: 0 })}</p>}
    </section>
  )
}
