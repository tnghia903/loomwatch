import { Menu as MenuIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { openFeedback, type FeedbackScreen } from '../../lib/feedback/report'
import { startTour } from '../../lib/tour/store'

interface WorkspaceMenuProps {
  /** A run is on screen, so feedback says it came from the Run tab. */
  runView?: boolean
  /** A team's memory. Absent where there is no team: an agent's page. */
  onMemory?: () => void
  /** What else this menu reaches on its screen, before the guide: the theme on Home; Skills, Quests
      and the theme on an agent's page. A team's screen has them in its palette and view bar. */
  more?: readonly { label: string; run: () => void }[]
  /** Where feedback says it came from; a team's Build or Run when absent. */
  screen?: FeedbackScreen
}

/**
 * The ☰ menu, in the same corner of Home, a team's page and an agent's page. On a team's page it
 * holds only what has no other control there (ADR 0043): All teams is the brand, Organize and its
 * undo are in the view bar, and a routine runs from its schedule. Home also links some of the same places in context (All agents, the guide). Past work is in each team's chat (ADR 0051), which retired the run history list. Its open state lives here rather than in the workspace, so opening and closing it
 * re-renders the menu alone.
 */
export function WorkspaceMenu({ runView = false, onMemory, more = [], screen }: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  // Open, it closes on a click anywhere else, as the bell's tray and a team card's menu do.
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', outside)
    return () => window.removeEventListener('mousedown', outside)
  }, [open])
  // Every item closes the menu before it acts.
  const item = (action: () => void) => () => { setOpen(false); action() }
  return (
    <div ref={root} className="prototype-workspace-menu" onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); toggle.current?.focus() } }}>
      <button ref={toggle} aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MenuIcon size={15} aria-hidden="true" /></button>
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
