import { useEffect, useRef } from 'react'

/** The action on a lesson about you rather than one job (ADR 0078). */
export const TELL_ALL = 'Tell all my agents'

/**
 * The question before Tell all my agents: the lesson goes into About you (ADR 0074), which every
 * agent reads, only once you press Add here. Cancel, or Esc, leaves everything as it was. Add has
 * the focus when it opens, so the keyboard is where the question is.
 */
export function TellAllAsk({ id, busy, onAdd, onCancel }: { id?: string; busy: boolean; onAdd: () => void; onCancel: () => void }) {
  const add = useRef<HTMLButtonElement>(null)
  useEffect(() => { add.current?.focus() }, [])
  return (
    <span id={id} className="tell-all-ask" role="group" aria-label={TELL_ALL} onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}>
      <span className="tell-all-says">Add to About you, so every agent does this?</span>
      <span className="tell-all-choices">
        <button ref={add} type="button" className="link" disabled={busy} onClick={onAdd}>Add</button>
        <button type="button" className="link" disabled={busy} onClick={onCancel}>Cancel</button>
      </span>
    </span>
  )
}
