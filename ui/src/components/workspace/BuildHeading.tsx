import { Play } from 'lucide-react'

import type { SaveState } from '../../lib/team-file/useTeamDocument'

interface BuildHeadingProps {
  agentCount: number
  isValid: boolean
  /** The schema is still loading, so validity is not known yet. */
  checking: boolean
  saveState: SaveState
  documentChipState: SaveState
  /** What stops an agent's app from starting on this computer, when something does. */
  appProblem?: string | null
  /**
   * Connections drawn on the canvas before their kind was delivered, which no run receives yet
   * (ADR 0029). Said here rather than over the canvas, where it would hide the cards it is about.
   */
  undelivered?: number
  onDeliver?: () => void
  onSave: () => void
  onRun: () => void
}

/** Build's heading. It says what to do next, not what the screen is called. */
export function BuildHeading({ agentCount, isValid, checking, saveState, documentChipState, appProblem = null, undelivered = 0, onDeliver, onSave, onRun }: BuildHeadingProps) {
  const heading = agentCount === 0
    ? { title: 'Add your first agent', detail: 'Pick a job on the left, like Researcher or Writer. You can add more helpers and connect them later.' }
    : !isValid && !checking
      ? { title: 'Finish setting up', detail: 'Open the list at the top to see what still needs your attention.' }
      : appProblem
        ? { title: 'Finish setting up', detail: appProblem }
        : { title: 'Your team is ready', detail: 'Press Run team and describe what you want done. Add agents and connect them to hand work along.' }
  return (
    <header className="build-workspace-heading">
      <div>
        <h1>{heading.title}</h1>
        <span>{saveState === 'new' ? 'Not saved yet' : ['dirty', 'conflict', 'error'].includes(saveState) ? 'Unsaved changes' : 'Saved'}</span>
        {/* Only once the team is otherwise ready: a missing app or an invalid file comes first. */}
        {heading.title === 'Your team is ready' && undelivered > 0 && onDeliver ? (
          <p className="build-undelivered" role="status">
            {undelivered === 1 ? 'One connection on the canvas is' : `${undelivered} connections on the canvas are`} drawn but not delivered to agents yet.{' '}
            <button type="button" className="btn" onClick={onDeliver}>Deliver on the next run</button>
          </p>
        ) : <p>{heading.detail}</p>}
      </div>
      <div className="build-workspace-actions">
        <button className="btn" disabled={!['dirty', 'new'].includes(documentChipState) || !isValid} onClick={onSave}>Save</button>
        <button className="btn btn-primary" onClick={onRun}><Play size={15} />Run team</button>
      </div>
    </header>
  )
}
