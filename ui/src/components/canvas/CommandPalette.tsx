import { Command, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

export interface CommandAction {
  label: string
  shortcut?: string
  run: () => void
  disabled?: boolean
  icon?: LucideIcon
}

/** What the palette understood from plain words or a /command (lib/story/intent.ts). */
export interface InterpretedAction extends CommandAction {
  dialect: 'plain' | 'exact'
  detail?: string
}

// UX_REDESIGN §11: ⌘K is the menu. 560 px, e2, centred at 22% from the top, a filter field
// and a flat ungrouped ranked list. Every primary flow is reachable without a pointer.
export function CommandPalette({ actions, onClose, interpret }: { actions: CommandAction[]; onClose: () => void; interpret?: (query: string) => InterpretedAction | null }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // Plain words and /commands resolve to one proposed action, shown first so Enter does exactly
  // what the row says; the ordinary list still filters below it.
  const understood = useMemo(() => interpret?.(query) ?? null, [interpret, query])
  const filtered = useMemo(() => {
    const listed = rankActions(actions, query.startsWith('/') ? query.slice(1) : query)
    return understood ? [understood, ...listed] : listed
  }, [actions, query, understood])

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
            const proposal = action === understood ? understood : null
            return (
              <button key={`${proposal ? 'understood:' : ''}${action.label}`} type="button" disabled={action.disabled} onMouseMove={() => setActiveIndex(index)} onClick={() => run(action)} className={`pop-row ${index === activeIndex ? 'active' : ''} ${proposal ? 'understood' : ''}`}>
                <Icon size={14} aria-hidden="true" style={{ color: proposal ? 'var(--color-accent)' : 'var(--color-ink-3)', flex: 'none' }} />
                <span className="name t-body">{action.label}{proposal?.detail && <small className="understood-detail">{proposal.detail}</small>}</span>
                {proposal && <span className="understood-dialect">{proposal.dialect === 'exact' ? 'Command' : 'From your words'}</span>}
                {action.shortcut && <kbd className="kbd t-mono-sm">{action.shortcut}</kbd>}
              </button>
            )
          })}
          {filtered.length === 0 && <p className="pop-empty t-meta">{interpret ? 'Nothing matches. Try plain words like “add a reviewer” or “zoom out”, or a /command.' : 'No commands match.'}</p>}
          {interpret && !query && <p className="pop-hint t-meta">Type plainly — “add a reviewer”, “zoom out”, “looks good”, “open daily news” — or exactly: <code>/add writer</code>, <code>/depth trace</code>, <code>/approve</code>, <code>/run …</code></p>}
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
