import { MoreHorizontal } from '../ui/icon'
import { useEffect, useRef, useState } from 'react'

import { openFeedback } from '../../lib/feedback/report'
import { startTour } from '../../lib/tour/store'

interface WorkspaceMenuProps {
  /** A run is on screen, so feedback says it came from the Run tab. */
  runView?: boolean
  /** The team's memory. */
  onMemory?: () => void
}

/**
 * A team's ⋯: what is the team's own and has no other control on its page (ADR 0043). The places
 * (Home, Agents, Skills, Quests) are the dock's, and About you, Connections, Usage and the look are
 * in You; Organize and its undo are in the view bar, and a routine runs from its schedule. Its open
 * state lives here rather than in the workspace, so opening and closing it re-renders the menu alone.
 */
export function WorkspaceMenu({ runView = false, onMemory }: WorkspaceMenuProps) {
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
      <button ref={toggle} aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={20} strokeWidth={2.25} aria-hidden="true" /></button>
      {open && (
        <div role="menu">
          {onMemory && <button role="menuitem" onClick={item(onMemory)}>Team memory</button>}
          <button role="menuitem" onClick={item(startTour)}>Getting started guide</button>
          <button role="menuitem" onClick={item(() => openFeedback({ screen: runView ? 'run' : 'build' }))}>Send feedback…</button>
        </div>
      )}
    </div>
  )
}
