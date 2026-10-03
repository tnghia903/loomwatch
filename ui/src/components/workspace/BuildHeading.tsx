import { Check, Play } from 'lucide-react'

import type { SaveState } from '../../lib/team-file/useTeamDocument'

interface BuildHeadingProps {
  agentCount: number
  isValid: boolean
  /** The schema is still loading, so validity is not known yet. */
  checking: boolean
  saveState: SaveState
  /** What stops an agent's app from starting on this computer, when something does. */
  appProblem?: string | null
  /**
   * Connections drawn on the canvas before their kind was delivered, which no run receives yet
   * (ADR 0029). Said here rather than over the canvas, where it would hide the cards it is about.
   */
  undelivered?: number
  onDeliver?: () => void
  onRun: () => void
  /** An Ask LoomWatch proposal is on the canvas: the heading becomes its Apply or Discard. */
  proposal?: BuildProposal | null
}

export interface BuildProposal {
  isNew: boolean
  /** Who proposed it: Ask LoomWatch, or the connected app that called LoomWatch's tools. */
  from: string
  /** What the proposal changes, in plain words. */
  lines: string[]
  applying: boolean
  error: string | null
  onApply: () => void
  onDiscard: () => void
}

/** Build's heading. It says what to do next, not what the screen is called. */
export function BuildHeading({ agentCount, isValid, checking, saveState, appProblem = null, undelivered = 0, onDeliver, onRun, proposal = null }: BuildHeadingProps) {
  if (proposal) {
    return (
      <header className="build-workspace-heading proposal" aria-label="Proposal from Ask LoomWatch">
        <div>
          <h1>{proposal.isNew ? 'Check your new team' : 'Check the proposed changes'}</h1>
          <span>From {proposal.from} · not saved yet</span>
          {proposal.lines.length > 0 && <ul className="build-proposal-lines">{proposal.lines.map((line) => <li key={line}>{line}</li>)}</ul>}
          {proposal.error && <p role="alert" className="build-proposal-error">{proposal.error}</p>}
        </div>
        <div className="build-workspace-actions">
          <button className="btn" disabled={proposal.applying} onClick={proposal.onDiscard}>Discard</button>
          <button className="btn btn-primary" disabled={proposal.applying} onClick={proposal.onApply}><Check size={15} />{proposal.applying ? 'Applying…' : 'Apply'}</button>
        </div>
      </header>
    )
  }
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
      {/* Saving is the team chip's at the top, on every screen (ADR 0043). */}
      <div className="build-workspace-actions">
        <button className="btn btn-primary" data-tour="run-team" onClick={onRun}><Play size={15} />Run team</button>
      </div>
    </header>
  )
}
