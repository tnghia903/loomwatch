import type { ReactNode, Ref } from 'react'

import { X } from '../ui/icon'

/**
 * The head of what the agent's chat opened in the pane beside it (an answer, its Details, a file), as
 * a team's Details has it: what it is about, and its × (`closes` names it, "Close details"), which
 * shows the bench again.
 */
export function PaneHead({ title, closes, onClose, back }: { title?: ReactNode; closes: string; onClose: () => void; back?: Ref<HTMLButtonElement> }) {
  return (
    <header className="tc-details-head agent-pane-head">
      <h2>{title}</h2>
      <button ref={back} type="button" className="btn btn-icon" onClick={onClose} aria-label={closes} title={closes}><X size={15} aria-hidden="true" /></button>
    </header>
  )
}
