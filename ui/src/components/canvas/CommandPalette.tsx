import { Command, Search, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

export interface CommandAction {
  label: string
  shortcut?: string
  run: () => void
  disabled?: boolean
  icon?: LucideIcon
}

export function CommandPalette({ actions, onClose }: { actions: CommandAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const filtered = useMemo(
    () => rankActions(actions, query),
    [actions, query],
  )

  function run(action: CommandAction | undefined) {
    if (!action || action.disabled) return
    action.run()
    onClose()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length === 0) return
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + direction + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(filtered[activeIndex])
    }
  }

  return (
    <div className="absolute inset-0 z-40 bg-ink/10" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="mx-auto mt-[22vh] w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-xl border border-hairline/10 bg-surface-solid shadow-[0_24px_80px_rgb(0_0_0/.2)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label className="flex h-12 items-center gap-2 border-b border-hairline/10 px-4">
          <Search className="size-4 text-ink-3" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onKeyDown={onKeyDown}
            placeholder="Type a command"
            className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <div className="max-h-[360px] overflow-y-auto p-2">
          {filtered.map((action, index) => {
            const Icon = action.icon ?? Command
            return (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => run(action)}
              className={`flex h-10 w-full items-center rounded-lg px-3 text-left text-[13px] text-ink hover:bg-iris/6 disabled:opacity-40 ${index === activeIndex ? 'bg-iris/6' : ''}`}
            >
              <Icon className="mr-2 size-3.5 text-ink-3" aria-hidden="true" />
              <span className="flex-1">{action.label}</span>
              {action.shortcut && <kbd className="font-mono text-[11px] text-ink-3">{action.shortcut}</kbd>}
            </button>
            )
          })}
          {filtered.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-ink-3">No commands match.</p>}
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
