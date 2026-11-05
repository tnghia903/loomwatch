import { useState } from 'react'

import type { WidgetSpec } from '../../../lib/widgets/types'

type Steps = Extract<WidgetSpec, { kind: 'steps' }>

/**
 * Steps to tap through (ADR 0114), laid out by LoomWatch in order; tap one to read it. Steps that
 * repeat end on a ghost of the first, beside the last step: not a step and not a button. Nothing is
 * kept: it is for reading.
 */
export function WidgetSteps({ spec }: { spec: Steps }) {
  const [at, setAt] = useState(0)
  const count = spec.steps.length
  const step = spec.steps[at] ?? spec.steps[0]
  return (
    <section className="wg wg-steps" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <ol className="wg-step-list">
        {spec.steps.map((one, which) => (
          <li key={which}>
            <button type="button" className={`wg-step${which === at ? ' on' : ''}`} aria-pressed={which === at} onClick={() => setAt(which)}>
              <span className="wg-step-n" aria-hidden="true">{which + 1}</span>
              <span className="wg-step-label">{one.label}</span>
            </button>
            {spec.repeats && which === count - 1 && (
              <span className="wg-step-again" role="img" aria-label="Then back to step 1" title="Then back to step 1"><span className="wg-step-ghost" aria-hidden="true">1</span></span>
            )}
          </li>
        ))}
      </ol>
      <div className="wg-step-text" aria-live="polite">
        <p className="wg-step-head">{at + 1} of {count} · {step.label}</p>
        <p className="wg-step-body">{step.text}</p>
      </div>
    </section>
  )
}
