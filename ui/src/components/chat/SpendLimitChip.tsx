import { ChevronDown, Coins } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { CHATGPT_USAGE_PAGE } from '../../lib/ai/sources'
import { dollarField, dollars, NEW_TEAM_PER_RUN_USD, typedDollars } from '../../lib/runs/spend'

export interface SpendLimitControl {
  /** What one run may spend, in dollars; `null` is no limit. */
  perRun: number | null
  /** Absent when the team file cannot be changed from here. */
  onChange?: (perRun: number | null) => void
  /** Whether some of the team's agents run on a plan (ADR 0073), whose calls count differently. */
  plans?: { chatgpt: boolean; anthropic: boolean }
}

/**
 * What one run of the team may spend (ADR 0068), beside the box that starts the work and the Auto
 * mode switch: "Each run · $1.00". Past it, the run waits for you to add more or to finish with
 * what it has. The monthly cap is a limit on the OpenRouter key itself. Only dollars count: calls on
 * the ChatGPT plan cost none and stop at the plan's own limit, and the menu says so when the team
 * has agents on it.
 */
export function SpendLimitChip({ perRun, onChange, plans }: SpendLimitControl) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const fieldId = useId()

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const show = () => {
    setText(dollarField(perRun ?? NEW_TEAM_PER_RUN_USD))
    setOpen(true)
  }
  const typed = typedDollars(text)
  const save = (next: number | null) => {
    setOpen(false)
    if (next !== perRun) onChange?.(next)
  }

  return (
    <div className="tc-mode" ref={root} onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      // Closes the panel and nothing else: the workspace's Escape would also leave the chat.
      event.stopPropagation()
      setOpen(false)
    }}>
      <button
        type="button"
        className={`tc-mode-chip${perRun === null ? '' : ' mode-spend'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={!onChange}
        title={onChange ? 'What one run of this team may spend' : 'Open the team’s file in LoomWatch to change this'}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <Coins size={13} aria-hidden="true" />
        <span>Each run · <b>{perRun === null ? 'no limit' : dollars(perRun)}</b></span>
        {onChange && <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open && (
        <form className="tc-mode-menu tc-spend-menu e2" id={panelId} role="dialog" aria-label="What one run may spend"
          onSubmit={(event) => { event.preventDefault(); if (typed !== null) save(typed) }}>
          <label className="tc-mode-title" htmlFor={fieldId}>One run of this team may spend up to</label>
          <span className="tc-spend-field">
            <span aria-hidden="true">$</span>
            <input id={fieldId} className="input" type="number" inputMode="decimal" min="0.01" step="any" value={text} autoFocus
              onChange={(event) => setText(event.target.value)} />
          </span>
          <p className="tc-mode-foot">Past it, the agents wait for you to add more or to finish with what they have.</p>
          {plans?.anthropic && <p className="tc-mode-foot">Calls on your Claude credit count at Claude’s list prices.</p>}
          {plans?.chatgpt && <p className="tc-mode-foot">Calls on your ChatGPT plan cost no dollars, so they don’t count toward this. They stop at your plan’s own limit: see <a className="link" href={CHATGPT_USAGE_PAGE} target="_blank" rel="noreferrer">Manage usage</a>.</p>}
          <span className="tc-spend-acts">
            <button type="submit" className="btn btn-primary" disabled={typed === null}>Save</button>
            {perRun !== null && <button type="button" className="btn" onClick={() => save(null)}>No limit</button>}
          </span>
        </form>
      )}
    </div>
  )
}
