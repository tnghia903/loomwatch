import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

import type { LoomMarkState } from '../../lib/story/loomMark'
import { useTheme } from '../../lib/theme'
import { LoomMark, LoomWordmark } from '../ui/glyphs'
import { WorkspaceMenu } from '../workspace/WorkspaceMenu'

export interface AgentFrameProps {
  mark?: LoomMarkState
  /** The bell: what waits on you, from the same poll as a team's. */
  tray?: ReactNode
  /** My agents down the side. */
  rail: ReactNode
  /** The name chip, when the page has one of its own (a new agent's start); otherwise the agent's
      page puts its own in the header's slot. */
  chip?: ReactNode
  /** Where the agent on screen puts its name chip and its Build · Chat tabs. The frame stays while
      you move between agents, so the rail beside it does too. */
  onSlots: (slots: AgentBarSlots) => void
  children: ReactNode
}

export interface AgentBarSlots { chip: HTMLElement | null; tabs: HTMLElement | null }

/** Where the team header hides its name chip and moves its menu under the header (prototype-workspace.css, loom.css). */
const NARROW = '(max-width: 767px)'
const subscribeNarrow = (changed: () => void) => {
  const query = window.matchMedia?.(NARROW)
  query?.addEventListener('change', changed)
  return () => query?.removeEventListener('change', changed)
}
const isNarrow = () => window.matchMedia?.(NARROW).matches ?? false

/**
 * An agent's page in the same frame as a team's: the rail down the side with its find button in
 * the header's row, then the header itself, built from the team header's own parts so the two
 * match to the pixel (the brand, the name chip, the tabs in the middle, the bell and the menu; the
 * agent on screen puts its chip and tabs into their places),
 * then the page. Skills, Quests and the theme, which a team's screen reaches from its palette and
 * view bar, are in the menu here.
 */
export function AgentFrame({ mark, tray, rail, chip, onSlots, children }: AgentFrameProps) {
  const { resolved, toggle } = useTheme()
  const chipSlot = useRef<HTMLDivElement>(null)
  const narrowChipSlot = useRef<HTMLDivElement>(null)
  const tabsSlot = useRef<HTMLDivElement>(null)
  // A narrow window has no room for the name chip or the menu in the header: a team's page hides
  // its chip and drops its menu under the header. An agent's Save lives in its chip, so here both
  // move to a row under it.
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false)
  useLayoutEffect(() => { onSlots({ chip: narrow ? narrowChipSlot.current : chipSlot.current, tabs: tabsSlot.current }) }, [onSlots, narrow])
  const more = [
    { label: 'Skills…', run: () => window.location.assign('/skills') },
    { label: 'Quests…', run: () => window.location.assign('/quests') },
    { label: resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: toggle },
  ]
  const menu = <WorkspaceMenu more={more} screen="agent" />
  return (
    <div className="lw-railed agent-frame-root" data-tour="agents">
      {rail}
      <div className="agent-frame">
        <div className="lw-shell agent-bar">
          <div className="workspace-chrome pointer-events-none absolute inset-x-0 z-40 flex flex-col items-center gap-2" style={{ top: 'var(--lw-panel-inset)' }}>
            {/* The brand is the way home: every team is one click from the list of all teams. */}
            <a className="delivery-brand" href="/" aria-label="LoomWatch, my team" title="My team" data-tour="your-teams" style={{ pointerEvents: 'auto', color: 'inherit', textDecoration: 'none' }}><LoomMark size={26} state={mark} /><LoomWordmark height={19} /></a>
            {!narrow && menu}
            {!narrow && tray && <div className="needs-you-anchor">{tray}</div>}
            <div ref={tabsSlot} className="agent-bar-tabs" />
            <div ref={chipSlot} className="agent-bar-chip">{!narrow && chip}</div>
          </div>
        </div>
        <div className="agent-frame-body">
          {narrow && <div className="agent-bar-narrow"><div ref={narrowChipSlot} className="agent-narrow-chip">{chip}</div>{tray && <div className="needs-you-anchor">{tray}</div>}{menu}</div>}
          {children}
        </div>
      </div>
    </div>
  )
}
