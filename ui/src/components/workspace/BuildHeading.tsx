import { Play } from 'lucide-react'

import type { SaveState } from '../../lib/team-file/useTeamDocument'

interface BuildHeadingProps {
  agentCount: number
  isValid: boolean
  /** The schema is still loading, so validity is not known yet. */
  checking: boolean
  saveState: SaveState
  documentChipState: SaveState
  onSave: () => void
  onRun: () => void
}

/** Build's heading. It says what to do next, not what the screen is called. */
export function BuildHeading({ agentCount, isValid, checking, saveState, documentChipState, onSave, onRun }: BuildHeadingProps) {
  const heading = agentCount === 0
    ? { title: 'Add your first agent', detail: 'Click + next to an AI app on the left. You can add more agents and connect them later.' }
    : !isValid && !checking
      ? { title: 'Finish setting up', detail: 'Open the list at the top to see what still needs your attention.' }
      : { title: 'Your team is ready', detail: 'Press Run team and describe what you want done. Add agents and connect them to hand work along.' }
  return (
    <header className="build-workspace-heading">
      <div>
        <h1>{heading.title}</h1>
        <span>{saveState === 'new' ? 'Not saved yet' : ['dirty', 'conflict', 'error'].includes(saveState) ? 'Unsaved changes' : 'Saved'}</span>
        <p>{heading.detail}</p>
      </div>
      <div className="build-workspace-actions">
        <button className="btn" disabled={!['dirty', 'new'].includes(documentChipState) || !isValid} onClick={onSave}>Save</button>
        <button className="btn btn-primary" onClick={onRun}><Play size={15} />Run team</button>
      </div>
    </header>
  )
}
