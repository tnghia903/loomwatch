import { Menu as MenuIcon } from 'lucide-react'
import { useState } from 'react'

import { openFeedback } from '../../lib/feedback/report'
import { startTour } from '../../lib/tour/store'

interface WorkspaceMenuProps {
  canOrganize: boolean
  /** An earlier Organize can be undone. */
  canUndoOrganize: boolean
  /** A run is on screen, so its full trace can be opened. */
  runView: boolean
  onHistory: () => void
  onMemory: () => void
  /** Runs the team's `schedule:` routine now. Absent when the team has no routine. */
  onRunRoutine?: () => void
  onOrganize: () => void
  onUndoOrganize: () => void
  onFullTrace: () => void
  onShowYaml: () => void
}

/**
 * The workspace's overflow menu. Its open state lives here rather than in the workspace, so
 * opening and closing it re-renders the menu alone.
 */
export function WorkspaceMenu({ canOrganize, canUndoOrganize, runView, onHistory, onMemory, onRunRoutine, onOrganize, onUndoOrganize, onFullTrace, onShowYaml }: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false)
  // Every item closes the menu before it acts.
  const item = (action: () => void) => () => { setOpen(false); action() }
  return (
    <div className="prototype-workspace-menu">
      <button aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MenuIcon size={15} aria-hidden="true" /></button>
      {open && (
        <div role="menu">
          <button role="menuitem" onClick={item(() => window.location.assign('/'))}>All teams</button>
          <button role="menuitem" onClick={item(onHistory)}>Run history</button>
          <button role="menuitem" onClick={item(onMemory)}>Team memory</button>
          {onRunRoutine && <button role="menuitem" onClick={item(onRunRoutine)}>Run routine now</button>}
          <button role="menuitem" onClick={item(() => window.location.assign('/connections'))}>Connections…</button>
          <button role="menuitem" disabled={!canOrganize} onClick={item(onOrganize)}>Organize</button>
          {canUndoOrganize && <button role="menuitem" onClick={item(onUndoOrganize)}>Undo organize</button>}
          {runView && <button role="menuitem" onClick={item(onFullTrace)}>Full trace</button>}
          <button role="menuitem" onClick={item(onShowYaml)}>View as YAML (advanced)</button>
          <button role="menuitem" onClick={item(startTour)}>Getting started guide</button>
          <button role="menuitem" onClick={item(() => openFeedback({ screen: runView ? 'run' : 'build' }))}>Send feedback…</button>
        </div>
      )}
    </div>
  )
}
