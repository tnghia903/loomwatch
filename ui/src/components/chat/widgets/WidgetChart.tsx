import { drawChart } from '../../../lib/widgets/chart'
import type { WidgetSpec } from '../../../lib/widgets/types'

type Chart = Extract<WidgetSpec, { kind: 'chart' }>

/**
 * A chart (ADR 0114): bars LoomWatch draws to scale from the figures the agent gave, each with its
 * figure written beside it, so it reads the same without the bars. Nothing is kept: it is for
 * reading.
 */
export function WidgetChart({ spec }: { spec: Chart }) {
  const { bars, zero } = drawChart(spec)
  const crossesZero = bars.some((bar) => bar.below)
  return (
    <section className="wg wg-chart" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <ul className="wg-bars">
        {bars.map((bar, at) => (
          <li key={at} className="wg-bar">
            <span className="wg-bar-label">{bar.label}</span>
            <span className="wg-bar-track" aria-hidden="true">
              {crossesZero && <span className="wg-bar-zero" style={{ left: `${zero * 100}%` }} />}
              <span className={`wg-bar-fill${bar.below ? ' below' : ''}`} data-testid="wg-bar-fill" style={{ left: `${bar.start * 100}%`, width: `${bar.width * 100}%` }} />
            </span>
            <span className="wg-bar-figure">{bar.figure}{bar.note && <span className="wg-bar-note"> {bar.note}</span>}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
