import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { ChipDot, type ChipState } from '../ui/glyphs'

export interface AgentChipProps {
  name: string
  /** How it is kept, as the dot says it. */
  state: ChipState
  /** The line under its name: saved when, unsaved, or what stops a save. */
  detail: string
  /** Beside it while there is something to save: Save. */
  action?: ReactNode
  /** Take it out of My agents; absent for one not saved yet, which has nothing to take out. */
  onRemove?: () => void
}

/**
 * An agent's name at the top of its page, the same chip as a team's at the top of a team's: the
 * name, how it is kept, Save while there is something to save, and a menu for what is done to the
 * agent itself.
 */
export function AgentChip({ name, state, detail, action, onRemove }: AgentChipProps) {
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const chip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (chip.current && !chip.current.contains(event.target as Node)) { setOpen(false); setRemoving(false) } }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])
  const ledger = state === 'saving' ? 'saving' : state === 'saved' ? 'saved' : state === 'failed' ? 'failed' : ''
  const text = (
    <>
      <ChipDot state={state} />
      <span className="chip-text">
        <span className="chip-l1 t-body-m">{name}</span>
        <span className="chip-l2 t-meta">{detail}</span>
      </span>
    </>
  )
  return (
    <div ref={chip} style={{ position: 'relative', pointerEvents: 'auto' }}>
      <div className={`e1 lw-chip ${ledger}`} style={{ position: 'relative' }} title={`${name} · ${detail}`}>
        {onRemove
          ? <button type="button" className="chip-open" onClick={() => { setOpen((value) => !value); setRemoving(false) }} aria-controls="agent-chip-pop" aria-expanded={open} aria-label={`${name}, ${detail}, open agent menu`}>{text}<span className="chev"><ChevronDown size={14} aria-hidden="true" /></span></button>
          : <span className="chip-open">{text}</span>}
        {action && <span className="chip-action">{action}</span>}
        <span className="ledger" aria-hidden="true" />
      </div>
      {open && onRemove && (
        <div id="agent-chip-pop" className="pop e2" role="dialog" aria-label="Agent menu" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: '50%', transform: 'translateX(-50%)', width: 'min(320px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
          <div className="pop-foot">
            {removing
              ? <span className="pop-inline t-meta" role="alertdialog" aria-label="Remove from My agents"><span>Remove it from My agents? Teams keep their copies.</span><button type="button" className="btn" onClick={() => { setOpen(false); onRemove() }}>Remove</button><button type="button" className="btn" onClick={() => setRemoving(false)}>Keep it</button></span>
              : <span className="acts"><button type="button" className="link alert" onClick={() => setRemoving(true)}>Remove from My agents…</button></span>}
          </div>
        </div>
      )}
    </div>
  )
}
