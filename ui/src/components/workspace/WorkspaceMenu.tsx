import { Menu as MenuIcon } from 'lucide-react'
import { useState } from 'react'

import { openFeedback } from '../../lib/feedback/report'
import { startTour } from '../../lib/tour/store'

interface WorkspaceMenuProps {
  /** A run is on screen, so feedback says it came from the Run tab. */
  runView: boolean
  onHistory: () => void
  onMemory: () => void
}

/**
 * The workspace's overflow menu: only what has no other control on the screen (ADR 0043). All
 * teams is the brand, Organize and its undo are in the view bar, the full trace is in the run's
 * heading, Show YAML is with the team's file in the switcher, and a routine runs from its
 * schedule. Its open state lives here rather than in the workspace, so opening and closing it
 * re-renders the menu alone.
 */
export function WorkspaceMenu({ runView, onHistory, onMemory }: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false)
  // Every item closes the menu before it acts.
  const item = (action: () => void) => () => { setOpen(false); action() }
  return (
    <div className="prototype-workspace-menu">
      <button aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MenuIcon size={15} aria-hidden="true" /></button>
      {open && (
        <div role="menu">
          <button role="menuitem" onClick={item(onHistory)}>Run history</button>
          <button role="menuitem" onClick={item(onMemory)}>Team memory</button>
          <button role="menuitem" onClick={item(() => window.location.assign('/connections'))}>Connections…</button>
          <button role="menuitem" onClick={item(startTour)}>Getting started guide</button>
          <button role="menuitem" onClick={item(() => openFeedback({ screen: runView ? 'run' : 'build' }))}>Send feedback…</button>
        </div>
      )}
    </div>
  )
}
