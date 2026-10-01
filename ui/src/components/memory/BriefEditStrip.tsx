import { X } from 'lucide-react'

/**
 * The mid-run Brief-edit strip (docs/TEAM_MEMORY.md → "The Memory panel", During a run).
 *
 * The whole Brief is read **once**, at run acceptance, before anything spawns — §5's third loader
 * rule — so an edit during a run cannot reach an agent that is already running, and it does not
 * interrupt anything either. That is the only thing this strip says, and it says it with the two
 * times that make it checkable: when the edit landed, and which revision the run still holds.
 *
 * It never claims a live turn was interrupted, and it never says an agent "has" or "knows" the old
 * text: the sanctioned word is **supplied**, and what it was supplied is the revision named here.
 */
export interface BriefEditStripProps {
  /** The entry's title, as the Brief file's first heading spells it. */
  title: string
  /** When the operator's edit was written. */
  editedAt: Date
  /** An agent in the run that was supplied the earlier revision, by name. */
  holderName: string
  /** When this run read the Brief — its acceptance time. */
  suppliedAt: Date | null
  onDismiss: () => void
}

export function BriefEditStrip({ title, editedAt, holderName, suppliedAt, onDismiss }: BriefEditStripProps) {
  return (
    <div className="lw-notice lw-brief-strip t-meta" role="status">
      <span className="msg">
        Edited <b>{title}</b> at {clock(editedAt)} · available at the next session start.
        {suppliedAt ? ` ${holderName} still has the ${clock(suppliedAt)} version.` : ` ${holderName} still has the revision this run started with.`}
      </span>
      <button type="button" className="iconbtn" style={{ width: 22, height: 22 }} onClick={onDismiss} aria-label="Dismiss this notice"><X size={13} aria-hidden="true" /></button>
    </div>
  )
}

function clock(at: Date): string {
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}
