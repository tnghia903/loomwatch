import type { WidgetSpec } from '../../../lib/widgets/types'

type Flow = Extract<WidgetSpec, { kind: 'flow' }>

/**
 * Boxes joined by arrows, in order (ADR 0114): the parts a request passes through, how one thing
 * leads to the next. To look at, all at once; steps to tap through are `WidgetSteps`. A flow that
 * repeats ends on a ghost of the first box, as steps do.
 */
export function WidgetFlow({ spec }: { spec: Flow }) {
  const first = spec.boxes[0]
  return (
    <section className="wg wg-flow" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <ol className="wg-flow-boxes">
        {spec.boxes.map((box, at) => (
          <li key={at} className="wg-flow-box">
            <span className="wg-flow-label">{box.label}</span>
            {box.note && <span className="wg-flow-note">{box.note}</span>}
          </li>
        ))}
      </ol>
      {spec.repeats && first && (
        <p className="wg-flow-again" role="img" aria-label={`Then back to ${first.label}`} title={`Then back to ${first.label}`}>
          <span className="wg-flow-ghost" aria-hidden="true">{first.label}</span>
        </p>
      )}
    </section>
  )
}
