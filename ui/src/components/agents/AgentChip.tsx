import { ChevronDown, Pin } from '../ui/icon'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { PINNED_SHORTCUT, PINNED_SHORTCUT_WORDS } from '../../island/bridge'
import { ChipDot, type ChipState } from '../ui/glyphs'
import { AgentSwitch } from './AgentSwitch'
import type { LeaveGuard } from './leave'
import type { AgentView } from './route'

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
  /**
   * My agents, listed in the menu as a team's menu lists the other teams, each opened on the tab on
   * screen (`go`); absent while there is no other to go to. With changes not saved (`leave`), the
   * menu asks first whether to keep them, and says why a save didn't work (`saveError`).
   */
  switcher?: { open: string | null; view: AgentView; leave: LeaveGuard | null; saveError?: string | null; go: (href: string) => void }
}

/**
 * An agent's name at the top of its page, the same chip as a team's at the top of a team's: the
 * name, how it is kept, Save while there is something to save, and a menu: the others of My agents
 * to go to, then what is done to the agent itself.
 */
export function AgentChip({ name, state, detail, action, onRemove, pin, switcher }: AgentChipProps) {
  const [open, setOpen] = useState(false)
  // Another agent picked while this one has changes not saved: where to, and how keeping them went.
  const [leavingTo, setLeavingTo] = useState<string | null>(null)
  const [keeping, setKeeping] = useState<'saving' | 'failed' | null>(null)
  const chip = useRef<HTMLDivElement>(null)
  const close = () => { setOpen(false); setLeavingTo(null); setKeeping(null) }
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (chip.current && !chip.current.contains(event.target as Node)) { setOpen(false); setLeavingTo(null); setKeeping(null) } }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])
  // Another agent: at once, or once this one's changes are saved or dropped.
  const pick = (href: string | null) => {
    if (!switcher || href === null) { close(); return }
    if (switcher.leave) { setLeavingTo(href); setKeeping(null); return }
    close()
    switcher.go(href)
  }
  const keepThenGo = async () => {
    if (!switcher?.leave || !leavingTo) return
    const href = leavingTo
    setKeeping('saving')
    if (await switcher.leave.save()) { close(); switcher.go(href) } else setKeeping('failed')
  }
  const dropThenGo = () => {
    if (!switcher || !leavingTo) return
    const href = leavingTo
    close()
    switcher.go(href)
  }
  // Leaving with changes not saved: the question a team's menu asks, in this agent's words. Where
  // saving can't work, it says why and offers what can.
  const cantSave = switcher?.leave?.problem ? `${name} can’t be saved yet. ${switcher.leave.problem}` : null
  const leaveQuestion = keeping === 'failed' ? (switcher?.saveError ? `Couldn’t save: ${switcher.saveError}` : 'Couldn’t save.') : cantSave ?? `Save changes to ${name}?`
  const menu = Boolean(onRemove || switcher)
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
        {menu
          ? <button type="button" className="chip-open" onClick={() => { if (open) close(); else setOpen(true) }} aria-controls="agent-chip-pop" aria-expanded={open} aria-label={`${name}${pin?.pinned ? ', pinned to the notch' : ''}, ${detail}, open agent menu`}>{text}<span className="chev"><ChevronDown size={14} aria-hidden="true" /></span></button>
          : <span className="chip-open">{text}</span>}
        {action && <span className="chip-action">{action}</span>}
        <span className="ledger" aria-hidden="true" />
      </div>
      {/* Hung from the chip's left edge, as a team's menu is. */}
      {open && menu && (
        <div id="agent-chip-pop" className="pop e2" role="dialog" aria-label="Agent menu" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: 0, width: 'min(392px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') close() }}>
          {switcher && <AgentSwitch open={switcher.open} view={switcher.view} onPick={pick} />}
          {leavingTo && (
            <div className="pop-inline team-switch-leave t-meta" role="alertdialog" aria-label={leaveQuestion} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setLeavingTo(null); setKeeping(null) } }}>
              <span>{leaveQuestion}</span>
              {/* A gold line: the screen's one gold fill stays its own action's. The keyboard waits on
                  Save, or on Cancel where there is no Save, never on Don't save. */}
              {!cantSave && <button type="button" className="btn btn-ring" autoFocus onClick={() => void keepThenGo()} disabled={keeping === 'saving'}>{keeping === 'saving' ? 'Saving…' : 'Save'}</button>}
              <button type="button" className="btn" onClick={dropThenGo} disabled={keeping === 'saving'}>Don’t save</button>
              <button type="button" className="btn" autoFocus={Boolean(cantSave)} onClick={() => { setLeavingTo(null); setKeeping(null) }} disabled={keeping === 'saving'}>Cancel</button>
            </div>
          )}
          {/* While it asks about leaving, the question is the menu's. */}
          {!leavingTo && (pin || onRemove) && <div className="pop-foot">
            <span className="acts">
              {pin && <button type="button" className="link" title={pin.pinned ? undefined : pin.notchShown ? `Message it with ${PINNED_SHORTCUT_WORDS} (${PINNED_SHORTCUT}) from any app, without opening LoomWatch` : `Message it with ${PINNED_SHORTCUT_WORDS} (${PINNED_SHORTCUT}) from any app, after you turn on Show at the notch`} onClick={() => { setOpen(false); pin.onToggle() }}>{pin.pinned ? 'Unpin from the notch' : 'Pin to the notch'}</button>}
              {onRemove && <button type="button" className="link alert" onClick={() => { setOpen(false); onRemove() }}>Remove from My agents…</button>}
            </span>
          </div>}
        </div>
      )}
    </div>
  )
}
