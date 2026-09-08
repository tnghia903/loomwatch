import { Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

export interface CommandAction {
  label: string
  shortcut?: string
  run: () => void
  disabled?: boolean
}

export function CommandPalette({ actions, onClose }: { actions: CommandAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(
    () => actions.filter((action) => action.label.toLowerCase().includes(query.trim().toLowerCase())),
    [actions, query],
  )

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [onClose])

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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command"
            className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <div className="max-h-[360px] overflow-y-auto p-2">
          {filtered.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onClick={() => {
                action.run()
                onClose()
              }}
              className="flex h-10 w-full items-center rounded-lg px-3 text-left text-[13px] text-ink hover:bg-iris/6 disabled:opacity-40"
            >
              <span className="flex-1">{action.label}</span>
              {action.shortcut && <kbd className="font-mono text-[11px] text-ink-3">{action.shortcut}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-ink-3">No commands match.</p>}
        </div>
      </div>
    </div>
  )
}
