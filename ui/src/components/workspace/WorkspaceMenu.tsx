import { Menu as MenuIcon } from 'lucide-react'
import { useState } from 'react'

import { openFeedback, type FeedbackScreen } from '../../lib/feedback/report'
import { startTour } from '../../lib/tour/store'

interface WorkspaceMenuProps {
  /** A run is on screen, so feedback says it came from the Run tab. */
  runView?: boolean
  /** A team's memory. Absent where there is no team: an agent's page. */
  onMemory?: () => void
  /** What else only this menu reaches on its screen, before the guide: on an agent's page, Skills,
      Quests and the theme, which a team's screen has in its palette and view bar. */
  more?: readonly { label: string; run: () => void }[]
  /** Where feedback says it came from; a team's Build or Run when absent. */
  screen?: FeedbackScreen
}

/**
 * The workspace's overflow menu: only what has no other control on the screen (ADR 0043). All
 * teams is the brand, Organize and its undo are in the view bar, the full trace is in the run's
 * heading, and a routine runs from its schedule. Past work is in each team's chat (ADR 0051), which retired the run history list. Its open state lives here rather than in the workspace, so opening and closing it
 * re-renders the menu alone.
 */
export function WorkspaceMenu({ runView = false, onMemory, more = [], screen }: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false)
  // Every item closes the menu before it acts.
  const item = (action: () => void) => () => { setOpen(false); action() }
  return (
    <div className="prototype-workspace-menu">
      <button aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MenuIcon size={15} aria-hidden="true" /></button>
      {open && (
        <div role="menu">
          {onMemory && <button role="menuitem" onClick={item(onMemory)}>Team memory</button>}
          <button role="menuitem" onClick={item(() => window.location.assign('/agents'))}>My agents…</button>
          <button role="menuitem" onClick={item(() => window.location.assign('/you'))}>About you…</button>
          <button role="menuitem" onClick={item(() => window.location.assign('/connections'))}>Connections…</button>
          <button role="menuitem" onClick={item(() => window.location.assign('/usage'))}>Usage…</button>
          {more.map((entry) => <button key={entry.label} role="menuitem" onClick={item(entry.run)}>{entry.label}</button>)}
          <button role="menuitem" onClick={item(startTour)}>Getting started guide</button>
          <button role="menuitem" onClick={item(() => openFeedback({ screen: screen ?? (runView ? 'run' : 'build') }))}>Send feedback…</button>
        </div>
      )}
    </div>
  )
}
