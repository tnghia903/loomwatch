import { Plus, X } from 'lucide-react'
import { useState } from 'react'

/** The schema's limits (`Agent.doneWhen`): a few short lines, never a requirements document. */
export const DONE_WHEN_ITEMS = 5
export const DONE_WHEN_CHARS = 160

export interface DoneWhenProps {
  items: readonly string[]
  readOnly?: boolean
  /** Every item that is written; blank ones never reach it. */
  onChange: (items: string[]) => void
  /** The list's name, when it is not the agent's own: "Done when here" for its part in a team. */
  label?: string
}

/**
 * DONE WHEN, under the instructions (ADR 0062): what the finished result must have, as state. The
 * agent checks its result against these before it replies, fixes what it can, and lists any it
 * could not meet under "Not met": a check step reads it with the work, and on the answer it shows
 * beside it, on the verdict, rather than in it. An item is written when the field is left, so a
 * half-typed or emptied line never lands in the team file; emptying one removes it.
 */
export function DoneWhen({ items, readOnly = false, onChange, label = 'Done when' }: DoneWhenProps) {
  const [adding, setAdding] = useState('')
  const full = items.length >= DONE_WHEN_ITEMS
  const write = (index: number, text: string) => {
    const value = text.trim()
    if (value === items[index]) return
    onChange(value ? items.map((item, at) => (at === index ? value : item)) : items.filter((_, at) => at !== index))
  }
  const add = () => {
    const value = adding.trim()
    if (!value || full) return
    onChange([...items, value])
    setAdding('')
  }
  return (
    <div className="done-when" role="group" aria-label={label}>
      <div className="done-when-head">
        <span className="t-micro">{label}</span>
        <span className="t-meta">{items.length ? 'It checks these before it replies, and says which it could not meet.' : 'Nothing set. Say what the finished result must have, and it checks before it replies.'}</span>
      </div>
      {items.length > 0 && (
        <ul>
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>
              {/* Wraps instead of cutting a long line off; one item is one line, so Enter leaves it. */}
              <textarea
                className="input"
                defaultValue={item}
                rows={Math.max(1, Math.ceil(item.length / 44))}
                maxLength={DONE_WHEN_CHARS}
                readOnly={readOnly}
                aria-label={`${label}, item ${index + 1}`}
                onBlur={(event) => write(index, event.target.value.replace(/\s*\n\s*/g, ' '))}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
              />
              {!readOnly && <button type="button" className="iconbtn" aria-label={`Remove “${item}”`} onClick={() => onChange(items.filter((_, at) => at !== index))}><X size={13} aria-hidden="true" /></button>}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && !full && (
        <form className="done-when-add" onSubmit={(event) => { event.preventDefault(); add() }}>
          <input
            className="input"
            value={adding}
            maxLength={DONE_WHEN_CHARS}
            placeholder={items.length ? 'Add another' : 'e.g. Every claim links to its source'}
            aria-label={`Add to ${label.toLowerCase()}`}
            onChange={(event) => setAdding(event.target.value)}
            onBlur={add}
          />
          <button type="submit" className="shape-part add" disabled={!adding.trim()}><Plus size={11} strokeWidth={3} aria-hidden="true" />Add</button>
        </form>
      )}
      {full && !readOnly && <span className="t-meta">Five is the most: keep the ones the result can’t do without.</span>}
    </div>
  )
}
