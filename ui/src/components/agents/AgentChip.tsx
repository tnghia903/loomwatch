import { ChevronDown, Pin } from '../ui/icon'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { PINNED_SHORTCUT, PINNED_SHORTCUT_WORDS } from '../../island/bridge'
import { ChipDot, type ChipState } from '../ui/glyphs'

export interface AgentChipProps {
  name: string
  /** How it is kept, as the dot says it. */
  state: ChipState
  /** The line under its name: saved when, unsaved, or what stops a save. */
  detail: string
  /** Beside it while there is something to save: Save. */
  action?: ReactNode
  /** Ask to take it out of My agents (the confirmation is the caller's); absent for one not saved
      yet, which has nothing to take out. */
  onRemove?: () => void
  /** Keep it at the notch on a Mac, the one ⌃⌥Space opens the box to from any app (ADR 0083), or
      take it away; absent off a Mac, where there is no notch or box. */
  pin?: { pinned: boolean; notchShown: boolean; onToggle: () => void }
}

/**
 * An agent's name at the top of its page, the same chip as a team's at the top of a team's: the
 * name, how it is kept, Save while there is something to save, and a menu for what is done to the
 * agent itself.
 */
export function AgentChip({ name, state, detail, action, onRemove, pin }: AgentChipProps) {
  const [open, setOpen] = useState(false)
  const chip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (chip.current && !chip.current.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])
  const ledger = state === 'saving' ? 'saving' : state === 'saved' ? 'saved' : state === 'failed' ? 'failed' : ''
  const text = (
    <>
      <ChipDot state={state} />
      <span className="chip-text">
        <span className="chip-l1 t-body-m">{pin?.pinned ? <><span className="chip-name">{name}</span><Pin className="chip-pin" size={12} aria-hidden="true" /></> : name}</span>
        <span className="chip-l2 t-meta">{detail}</span>
      </span>
    </>
  )
  return (
    <div ref={chip} style={{ position: 'relative', pointerEvents: 'auto' }}>
      <div className={`e1 lw-chip agent-chip ${ledger}`} style={{ position: 'relative' }} title={`${name}${pin?.pinned ? ' · pinned to the notch' : ''} · ${detail}`}>
        {onRemove
          ? <button type="button" className="chip-open" onClick={() => setOpen((value) => !value)} aria-controls="agent-chip-pop" aria-expanded={open} aria-label={`${name}${pin?.pinned ? ', pinned to the notch' : ''}, ${detail}, open agent menu`}>{text}<span className="chev"><ChevronDown size={14} aria-hidden="true" /></span></button>
          : <span className="chip-open">{text}</span>}
        {action && <span className="chip-action">{action}</span>}
        <span className="ledger" aria-hidden="true" />
      </div>
      {open && onRemove && (
        <div id="agent-chip-pop" className="pop e2" role="dialog" aria-label="Agent menu" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: '50%', transform: 'translateX(-50%)', width: 'min(320px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
          <div className="pop-foot">
            <span className="acts">
              {pin && <button type="button" className="link" title={pin.pinned ? undefined : pin.notchShown ? `Message it with ${PINNED_SHORTCUT_WORDS} (${PINNED_SHORTCUT}) from any app, without opening LoomWatch` : `Message it with ${PINNED_SHORTCUT_WORDS} (${PINNED_SHORTCUT}) from any app, after you turn on Show at the notch`} onClick={() => { setOpen(false); pin.onToggle() }}>{pin.pinned ? 'Unpin from the notch' : 'Pin to the notch'}</button>}
              <button type="button" className="link alert" onClick={() => { setOpen(false); onRemove() }}>Remove from My agents…</button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
