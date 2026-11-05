import { useState, type CSSProperties } from 'react'

import { fitsAcross } from '../../../lib/widgets/route'
import type { WidgetSpec } from '../../../lib/widgets/types'
import { useMeasuredWidth } from '../../../lib/widgets/useMeasuredWidth'

type Steps = Extract<WidgetSpec, { kind: 'steps' }>

/** Width when the page can't measure it (tests). */
const FALLBACK_WIDTH = 480
/** The least room a step takes across; with less, the steps run down. */
const STEP_WIDTH = 84

/**
 * Steps to tap through (ADR 0114): numbered stops along one line, as a flow's, across while each
 * has room and down when it hasn't; tap one to read it. Each stop has a button's edge, which a
 * flow's stops don't, so it reads as something to tap. Steps that repeat end on a ghost of the
 * first: not a step and not a button. Nothing is kept: it is for reading.
 */
export function WidgetSteps({ spec }: { spec: Steps }) {
  const [at, setAt] = useState(0)
  const [box, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH)
  const count = spec.steps.length
  const step = spec.steps[at] ?? spec.steps[0]
  const stops = count + (spec.repeats ? 1 : 0)
  const across = fitsAcross(width, spec.steps.map((one) => one.label), stops, STEP_WIDTH, 20)
  return (
    <section className="wg wg-steps" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <div ref={box} className={`wg-route ${across ? 'across' : 'down'}${spec.repeats ? ' again' : ''}`} style={{ '--n': stops, '--stops': count } as CSSProperties}>
        <span className="wg-rail" aria-hidden="true" />
        <ol className="wg-stops">
          {spec.steps.map((one, which) => (
            <li key={which} className={`wg-stop${which === at ? ' on' : ''}`}>
              <button type="button" className="wg-step" aria-pressed={which === at} onClick={() => setAt(which)}>
                <span className="wg-step-n" aria-hidden="true">{which + 1}</span>
                <span className="wg-step-label">{one.label}</span>
              </button>
            </li>
          ))}
        </ol>
        {spec.repeats && (
          <span className="wg-again" role="img" aria-label="Then back to step 1" title="Then back to step 1">
            <span className="wg-again-n" aria-hidden="true">1</span>
            <span className="wg-again-label" aria-hidden="true">{spec.steps[0]?.label}</span>
          </span>
        )}
      </div>
      <div className="wg-step-text" aria-live="polite">
        <p className="wg-step-head">{at + 1} of {count} · {step.label}</p>
        <p className="wg-step-body">{step.text}</p>
      </div>
    </section>
  )
}
