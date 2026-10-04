import { useId, useState } from 'react'

import type { TeamReview } from '../../lib/runs/client'

export interface TeamReviewDialogProps {
  review: TeamReview
  /** Approve the revision shown and start the run the operator asked for. */
  onTrust: () => Promise<void>
  onClose: () => void
}

/** The daemon quotes commands in backticks; they read as code. */
function withCode(text: string) {
  return text.split('`').map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))
}

/**
 * Before a team file from outside LoomWatch runs for the first time (ADR 0048): what it will start,
 * allow and read, in the daemon's plain words, so the operator decides before anything starts.
 * Lines worth a second look — a program LoomWatch doesn't know, commands without asking, reading
 * outside the team's own folder — are marked.
 */
export function TeamReviewDialog({ review, onTrust, onClose }: TeamReviewDialogProps) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const marked = review.review.some((line) => line.warn)

  async function trust() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onTrust()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-deleteteam lw-teamreview" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <h2 id={titleId}>Check “{review.teamName}” before it runs</h2>
        <p>This team was added or changed outside LoomWatch, so LoomWatch hasn’t run this version of it. Here is what it will do on this computer:</p>
        <ul className="tr-lines">
          {review.review.map((line, index) => (
            <li key={index} className={line.warn ? 'tr-warn' : undefined}>
              {line.warn && <span className="tr-flag" aria-hidden="true">!</span>}
              <span className="tr-text">
                {line.warn && <span className="visually-hidden">Look twice: </span>}
                {withCode(line.text)}
              </span>
            </li>
          ))}
        </ul>
        <p>{marked ? 'Run it only if you trust where it came from and understand the lines marked !.' : 'Run it only if you trust where it came from.'}</p>
        {error && <p role="alert" className="dt-alert">{error}</p>}
        <div className="dt-acts">
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void trust()} disabled={busy}>{busy ? 'Starting…' : 'Trust and run'}</button>
        </div>
      </div>
    </div>
  )
}
