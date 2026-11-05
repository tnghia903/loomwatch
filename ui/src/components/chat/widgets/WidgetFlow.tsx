import type { CSSProperties } from 'react'

import { fitsAcross } from '../../../lib/widgets/route'
import type { WidgetSpec } from '../../../lib/widgets/types'
import { useMeasuredWidth } from '../../../lib/widgets/useMeasuredWidth'

type Flow = Extract<WidgetSpec, { kind: 'flow' }>

/** Width when the page can't measure it (tests). */
const FALLBACK_WIDTH = 480
/** The least room a stop takes across; with less, the route runs down. */
const STOP_WIDTH = 92

/**
 * A flow (ADR 0114): one thing leading to the next, as numbered stops along one line, across while
 * each stop has room and down when it hasn't. The last stop is filled: where it arrives. A flow
 * that repeats ends on a ghost of the first stop instead, which isn't a stop of the list. To look
 * at, all at once; steps to tap through are `WidgetSteps`.
 */
export function WidgetFlow({ spec }: { spec: Flow }) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH)
  const first = spec.boxes[0]
  const stops = spec.boxes.length + (spec.repeats ? 1 : 0)
  const across = fitsAcross(width, spec.boxes.map((box) => box.label), stops, STOP_WIDTH, 12)
  return (
    <section className={`wg wg-flow${spec.repeats ? ' repeats' : ''}`} aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <div ref={box} className={`wg-route ${across ? 'across' : 'down'}${spec.repeats ? ' again' : ''}`} style={{ '--n': stops, '--stops': spec.boxes.length } as CSSProperties}>
        <span className="wg-rail" aria-hidden="true" />
        <ol className="wg-stops">
          {spec.boxes.map((box, at) => (
            <li key={at} className="wg-stop">
              <span className="wg-flow-label">{box.label}</span>
              {box.note && <span className="wg-flow-note">{box.note}</span>}
            </li>
          ))}
        </ol>
        {spec.repeats && first && (
          <span className="wg-again" role="img" aria-label={`Then back to ${first.label}`} title={`Then back to ${first.label}`}>
            <span className="wg-again-n" aria-hidden="true">1</span>
            <span className="wg-again-label" aria-hidden="true">{first.label}</span>
          </span>
        )}
      </div>
    </section>
  )
}
