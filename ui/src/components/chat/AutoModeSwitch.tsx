import { Check, ChevronDown, Hand, Sparkles } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { PermissionMode } from '../../lib/team-file/types'

export interface AutoModeControl {
  mode: PermissionMode
  /** Absent when the team file cannot be changed from here. */
  onChange?: (mode: PermissionMode) => void
}

const CHOICES: readonly { mode: PermissionMode; label: string; says: string; Icon: typeof Hand }[] = [
  { mode: 'ask', label: 'Ask me', says: 'A command an agent isn’t allowed to run on its own waits for your answer.', Icon: Hand },
  { mode: 'auto', label: 'Auto', says: 'Commands that only read files or download pages run on their own. Anything else still asks you.', Icon: Sparkles },
]

/**
 * Who decides an agent's commands (ADR 0061), beside the box that starts the work: the team's one
 * Auto mode switch. It states the mode it is in — "Commands · Ask me", "Commands · Auto". An
 * agent's own "Commands" switch still comes first.
 */
export function AutoModeSwitch({ mode, onChange }: AutoModeControl) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const current = CHOICES.find((choice) => choice.mode === mode) ?? CHOICES[0]

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const choose = (next: PermissionMode) => {
    setOpen(false)
    if (next !== mode) onChange?.(next)
  }

  return (
    <div className="tc-mode" ref={root} onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      // Closes the menu and nothing else: the workspace's Escape would also leave the chat.
      event.stopPropagation()
      setOpen(false)
    }}>
      <button
        type="button"
        className={`tc-mode-chip mode-${mode}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={!onChange}
        title={onChange ? 'Who decides the commands agents ask to run' : 'Open the team’s file in LoomWatch to change this'}
        onClick={() => setOpen((value) => !value)}
      >
        <current.Icon size={13} aria-hidden="true" />
        <span>Commands · <b>{current.label}</b></span>
        {onChange && <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open && (
        <div className="tc-mode-menu e2" id={menuId} role="menu" aria-label="When an agent wants to run a command">
          <p className="tc-mode-title">When an agent wants to run a command</p>
          {CHOICES.map(({ mode: choice, label, says, Icon }) => (
            <button key={choice} type="button" role="menuitemradio" aria-checked={choice === mode}
              className="tc-mode-item" onClick={() => choose(choice)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
                const at = items.indexOf(event.currentTarget)
                items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
              }}>
              <Icon size={15} aria-hidden="true" />
              <span className="tc-mode-name">{label}</span>
              {choice === mode && <Check className="tc-mode-tick" size={14} aria-hidden="true" />}
              <span className="tc-mode-says">{says}</span>
            </button>
          ))}
          <p className="tc-mode-foot">Decided on this computer from the command alone. Scripts, deleting, pushing, publishing and admin commands always ask you, and downloads need the agent’s Web switch.</p>
        </div>
      )}
    </div>
  )
}
