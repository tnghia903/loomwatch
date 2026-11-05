import { useState } from 'react'

import type { WidgetSpec } from '../../../lib/widgets/types'

type Choices = Extract<WidgetSpec, { kind: 'choices' }>

/** A widget's controls while the answer is still being written. */
export const LIVE = 'Works once the answer is done'

/**
 * Choices to tap (ADR 0114): a tap sends that choice as your message, replying to the answer, so
 * it is the same as writing it in the box. Only the newest answer's can be tapped, and only while
 * nothing is at work; once one is sent, it stays marked. One that couldn't be sent comes unmarked.
 */
export function WidgetChoices({ spec, onChoose, chosen, live = false }: { spec: Choices; onChoose?: (label: string) => Promise<boolean> | void; chosen: string | null; live?: boolean }) {
  const [picked, setPicked] = useState<string | null>(null)
  const on = picked ?? (spec.options.some((option) => option.label === chosen) ? chosen : null)
  const open = onChoose !== undefined && on === null
  return (
    <section className="wg wg-choices" aria-label={spec.title} title={live ? LIVE : !open && on === null ? 'You can tap these on the newest answer, once nothing is at work' : undefined}>
      <p className="wg-title">{spec.title}</p>
      <div className="wg-options">
        {spec.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={`wg-option${on === option.label ? ' on' : ''}`}
            aria-pressed={on === option.label}
            disabled={!open}
            title={open ? `Sends “${option.label}” as your reply` : undefined}
            onClick={() => {
              if (!open) return
              setPicked(option.label)
              void Promise.resolve(onChoose(option.label)).then((sent) => {
                if (sent === false) setPicked(null)
              })
            }}
          >
            <span className="wg-option-label">{option.label}</span>
            {option.detail && <span className="wg-option-detail">{option.detail}</span>}
          </button>
        ))}
      </div>
    </section>
  )
}
