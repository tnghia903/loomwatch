import type { RunSpend } from '../../lib/runs/client'
import { spoolLabel, spoolOf, spoolWords } from '../../lib/runs/spend'

interface SpoolProps {
  spend: RunSpend | null | undefined
  name: (id: string) => string
  hue: (id: string) => number
}

/**
 * What the run has spent, as a spool of thread (ADR 0068). The bobbin holds what is left of the
 * run's limit and unwinds as the agents spend; the thread run off it is in each agent's colour, as
 * long as its share. "$0.12 of $1.00" beside it. A run with no limit shows its threads and what
 * it spent, with no bobbin.
 */
export function Spool({ spend, name, hue }: SpoolProps) {
  const view = spoolOf(spend)
  if (!view) return null
  const full = view.used !== null && view.used >= 1
  // Each thread's length on the track: its share of the limit, or of what was spent with none.
  const whole = view.limit ?? view.spent
  const left = view.used === null ? null : Math.max(0, 1 - view.used)
  return (
    <span className={`tc-spool${full ? ' full' : ''}`} role="img" aria-label={spoolLabel(view, name)} title={spoolLabel(view, name)}>
      {left !== null && (
        <svg className="tc-spool-bobbin" viewBox="0 0 14 16" width="14" height="16" aria-hidden="true">
          <rect className="tc-spool-wound" x="3" y="2" width="8" height="12" rx="1" style={{ transform: `scaleY(${left})` }} />
          <rect className="tc-spool-flange" x="1" y="0.5" width="12" height="2" rx="1" />
          <rect className="tc-spool-flange" x="1" y="13.5" width="12" height="2" rx="1" />
        </svg>
      )}
      <span className="tc-spool-track" aria-hidden="true">
        {view.threads.map((thread) => (
          <i key={thread.agent} className={`hue-${hue(thread.agent)}`} style={{ width: `${Math.min(100, (thread.usd / whole) * 100)}%` }} />
        ))}
      </span>
      <span className="tc-spool-words">{spoolWords(view)}</span>
    </span>
  )
}
