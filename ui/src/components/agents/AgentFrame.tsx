import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'


export interface AgentFrameProps {
  /** The bell: what waits on you, from the same poll as a team's. */
  tray?: ReactNode
  /** The name chip, when the page has one of its own (a new agent's start); otherwise the agent's
      page puts its own in the header's slot. */
  chip?: ReactNode
  /** Where the agent on screen puts its name chip and its Build · Chat tabs. */
  onSlots: (slots: AgentBarSlots) => void
  children: ReactNode
}

export interface AgentBarSlots { chip: HTMLElement | null; tabs: HTMLElement | null }

/** Where the team header hides its name chip (prototype-workspace.css, loom.css). */
const NARROW = '(max-width: 767px)'
const subscribeNarrow = (changed: () => void) => {
  const query = window.matchMedia?.(NARROW)
  query?.addEventListener('change', changed)
  return () => query?.removeEventListener('change', changed)
}
const isNarrow = () => window.matchMedia?.(NARROW).matches ?? false

/**
 * An agent's page in the same header as a team's, built from the team header's own parts so the
 * two match to the pixel: the name chip, the tabs in the middle and the bell (the agent on screen
 * puts its chip and tabs into their places), then the page. Home, Skills and Quests are the dock's.
 */
export function AgentFrame({ tray, chip, onSlots, children }: AgentFrameProps) {
  const chipSlot = useRef<HTMLDivElement>(null)
  const narrowChipSlot = useRef<HTMLDivElement>(null)
  const tabsSlot = useRef<HTMLDivElement>(null)
  // A narrow window has no room for the name chip in the header: a team's page hides its chip. An
  // agent's Save lives in its chip, so here it moves to a row under the header, with the bell.
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false)
  useLayoutEffect(() => { onSlots({ chip: narrow ? narrowChipSlot.current : chipSlot.current, tabs: tabsSlot.current }) }, [onSlots, narrow])
  return (
    <div className="lw-railed agent-frame-root" data-tour="agents">
      <div className="agent-frame">
        <div className="lw-shell agent-bar">
          <div className="workspace-chrome pointer-events-none absolute inset-x-0 z-40 flex flex-col items-center gap-2" style={{ top: 'var(--lw-panel-inset)' }}>
            {!narrow && tray && <div className="needs-you-anchor">{tray}</div>}
            <div ref={tabsSlot} className="agent-bar-tabs" />
            <div ref={chipSlot} className="agent-bar-chip">{!narrow && chip}</div>
          </div>
        </div>
        <div className="agent-frame-body">
          {narrow && <div className="agent-bar-narrow"><div ref={narrowChipSlot} className="agent-narrow-chip">{chip}</div>{tray && <div className="needs-you-anchor">{tray}</div>}</div>}
          {children}
        </div>
      </div>
    </div>
  )
}
