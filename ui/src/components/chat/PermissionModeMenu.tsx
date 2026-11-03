import { Check, ChevronDown } from '../ui/icon'
import { useEffect, useId, useRef, useState } from 'react'

import { modeSays } from '../../lib/team-file/permissionMode'
import type { PermissionMode } from '../../lib/team-file/types'

export interface PermissionModeControl {
  mode: PermissionMode
  /** Absent when the team file cannot be changed from here. */
  onChange?: (mode: PermissionMode) => void
}

const TITLE = 'When an agent needs your OK'
const MODES: readonly { mode: PermissionMode; label: string }[] = [
  { mode: 'ask', label: 'Ask me' },
  { mode: 'auto', label: 'Auto' },
]

/**
 * The team's mode (ADR 0061, ADR 0109), beside the button that sends work: Ask me, or Auto, which
 * goes ahead on its own inside limits it can't cross, as Claude's Auto does. It states the mode it
 * is in, and a switch reaches the team's work at once. An agent's own switches still come first.
 */
export function PermissionModeMenu({ mode, onChange }: PermissionModeControl) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const current = MODES.find((choice) => choice.mode === mode) ?? MODES[0]

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  // Closing from the keyboard puts focus back on the chip, where it was, rather than on the page.
  const close = () => {
    setOpen(false)
    chip.current?.focus()
  }
  const choose = (next: PermissionMode) => {
    close()
    if (next !== mode) onChange?.(next)
  }

  return (
    <div className="tc-mode" ref={root}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        // Closes the menu and nothing else: the workspace's Escape would also leave the chat.
        event.stopPropagation()
        close()
      }}
      onBlur={(event) => {
        // Tabbing out of the menu closes it, as a click outside does. A blur that names no new
        // target is Safari pressing a button, which it never focuses: closing then would drop the
        // click on a choice, and a click outside is closed by the pointerdown listener anyway.
        const next = event.relatedTarget as Node | null
        if (open && next && !root.current?.contains(next)) setOpen(false)
      }}>
      <button
        ref={chip}
        type="button"
        className={`tc-mode-chip mode-${mode}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${TITLE}: ${current.label}`}
        disabled={!onChange}
        title={onChange ? TITLE : 'This team is read-only here, so its mode can’t change.'}
        onClick={() => setOpen((value) => !value)}
      >
        {current.label}
        {onChange && <ChevronDown size={13} aria-hidden="true" />}
      </button>
      {open && (
        <div className="tc-mode-menu e2" id={menuId} role="menu" aria-label={TITLE}>
          <p className="tc-mode-title" aria-hidden="true">{TITLE}</p>
          {MODES.map(({ mode: choice, label }) => (
            <button key={choice} type="button" role="menuitemradio" aria-checked={choice === mode}
              className="tc-mode-item" onClick={() => choose(choice)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
                const at = items.indexOf(event.currentTarget)
                items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
              }}>
              <span className="tc-mode-name">{label}</span>
              {choice === mode && <Check className="tc-mode-tick" size={14} aria-hidden="true" />}
              <span className="tc-mode-says">{modeSays(choice)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
