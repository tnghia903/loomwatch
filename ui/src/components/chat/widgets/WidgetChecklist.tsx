import type { WidgetSpec, WidgetState } from '../../../lib/widgets/types'
import { Check } from '../../ui/icon'

type Checklist = Extract<WidgetSpec, { kind: 'checklist' }>

/** A checklist to tick (ADR 0114). Each tick is kept, and the next work reads what is ticked.
    `disabled` while the answer is still being written. */
export function WidgetChecklist({ spec, state, onToggle, error, disabled = false }: { spec: Checklist; state?: WidgetState; onToggle: (checked: boolean[]) => void; error: string | null; disabled?: boolean }) {
  const checked = spec.items.map((_, at) => (state && 'checked' in state ? state.checked[at] === true : false))
  const done = checked.filter(Boolean).length
  return (
    <section className="wg wg-checklist" aria-label={spec.title}>
      <p className="wg-title">{spec.title}<span className="wg-count">{done} of {spec.items.length} done</span></p>
      <ul className="wg-items">
        {spec.items.map((item, at) => (
          <li key={at}>
            <button
              type="button"
              role="checkbox"
              aria-checked={checked[at]}
              disabled={disabled}
              className={`check wg-tick${checked[at] ? ' on' : ''}`}
              onClick={() => onToggle(checked.map((on, which) => (which === at ? !on : on)))}
            >
              <span className="box">{checked[at] && <Check size={11} strokeWidth={3.5} aria-hidden="true" />}</span>
              <span className="txt"><b className="t-body">{item.text}</b>{item.note && <span className="t-meta">{item.note}</span>}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </section>
  )
}
