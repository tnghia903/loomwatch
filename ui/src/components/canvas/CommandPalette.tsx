import { Command, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

export interface CommandAction {
  label: string
  shortcut?: string
  run: () => void
  disabled?: boolean
  icon?: LucideIcon
}

// UX_REDESIGN §11: ⌘K is the menu. 560 px, e2, centred at 22% from the top, a filter field
// and a flat ungrouped ranked list. Every primary flow is reachable without a pointer.
export function CommandPalette({ actions, onClose }: { actions: CommandAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const filtered = useMemo(() => rankActions(actions, query), [actions, query])

  function run(action: CommandAction | undefined) {
    if (!action || action.disabled) return
    onClose()
    action.run()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length === 0) return
      setActiveIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Enter') { event.preventDefault(); run(filtered[activeIndex]) }
  }

  return (
    <div className="lw-scrim" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="pop e2 lw-palette" onMouseDown={(event) => event.stopPropagation()}>
        <label className="pop-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4.3-4.3" /></svg>
          <input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }} onKeyDown={onKeyDown} placeholder="Type a command" aria-label="Command" />
        </label>
        <div className="pop-list" style={{ maxHeight: 360 }}>
          {filtered.map((action, index) => {
            const Icon = action.icon ?? Command
            return (
              <button key={action.label} type="button" disabled={action.disabled} onMouseMove={() => setActiveIndex(index)} onClick={() => run(action)} className={`pop-row ${index === activeIndex ? 'active' : ''}`}>
                <Icon size={14} aria-hidden="true" style={{ color: 'var(--color-ink-3)', flex: 'none' }} />
                <span className="name t-body">{action.label}</span>
                {action.shortcut && <kbd className="kbd t-mono-sm">{action.shortcut}</kbd>}
              </button>
            )
          })}
          {filtered.length === 0 && <p className="pop-empty t-meta">No commands match.</p>}
        </div>
      </div>
    </div>
  )
}

/** A flat list can still put the closest textual match first without inventing categories. */
function rankActions(actions: CommandAction[], query: string): CommandAction[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return actions
  return actions
    .map((action, index) => {
      const label = action.label.toLowerCase()
      const wordStart = label.split(/\W+/).some((word) => word.startsWith(needle))
      const score = label.startsWith(needle) ? 0 : wordStart ? 1 : label.includes(needle) ? 2 : 3
      return { action, index, score }
    })
    .filter(({ score }) => score < 3)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ action }) => action)
}
