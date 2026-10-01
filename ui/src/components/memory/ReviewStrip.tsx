import { useState } from 'react'

import type { Note } from '../../lib/memory/client'

/**
 * The after-run review strip (docs/TEAM_MEMORY.md → decision 3: review, never auto).
 *
 * "Run 04 finished · 3 new notes the next run could use. [Review 3] [Keep all] [Not now]".
 *
 * Two rules, and both are refusals:
 *
 * * **Nothing is kept automatically.** `memory.notebook.keep` has `review` and `never` and no
 *   `auto`, because a run's observations becoming the team's standing memory with nobody reading
 *   them is how a team accumulates confident nonsense. "Keep all" exists because reviewing three
 *   notes one at a time is friction, not safety — but it is a click, every time.
 * * **A failed run's notes are never promoted.** They stay as evidence of that run. A run that
 *   failed is precisely the run whose observations are least likely to be right, so the strip
 *   does not appear at all: `Workspace` renders it only for a `succeeded` record.
 */
export interface ReviewStripProps {
  /** The attempt number, as the lifecycle strip counts it. */
  attempt: number
  /** Notes this run wrote that are still `active` — eligible to be kept, and not yet kept. */
  notes: Note[]
  /** Opens the Memory panel on the Notebook tab. */
  onReview: () => void
  /** Keeps every note in `notes`. Resolves once the last one has landed. */
  onKeepAll: () => Promise<void>
  onDismiss: () => void
}

export function ReviewStrip({ attempt, notes, onReview, onKeepAll, onDismiss }: ReviewStripProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const count = notes.length
  if (count === 0) return null
  return (
    <div className="rt-strip t-meta" role="status" data-testid="review-strip">
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>Run {String(attempt).padStart(2, '0')} finished</b> · {count} new note{count === 1 ? '' : 's'} the next run could use.
      </span>
      <button type="button" className="btn" onClick={onReview} disabled={busy}>Review {count}</button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setFailed(null)
          onKeepAll()
            .catch((caught: unknown) => setFailed(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Keeping…' : 'Keep all'}
      </button>
      <button type="button" className="btn" onClick={onDismiss} disabled={busy}>Not now</button>
      {failed && <span role="alert" style={{ color: 'var(--color-alert)' }}>{failed}</span>}
    </div>
  )
}
