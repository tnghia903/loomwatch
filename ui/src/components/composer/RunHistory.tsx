import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { relativeTime, type HistoryEntry } from '../../lib/runs/history'
import { StatusGlyph } from '../ui/glyphs'

export interface RunHistoryProps {
  entries: HistoryEntry[]
  currentId: string | null
  loading: boolean
  error: string | null
  onOpen: (entry: HistoryEntry) => void
  onClose: () => void
}

// Selecting a run loads it in REPLAY: same picture, no motion. Reopening never re-executes.
export function RunHistory({ entries, currentId, loading, error, onOpen, onClose }: RunHistoryProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // A popover, not a modal: a click anywhere else closes it, as Escape and the close button do.
  // Escape from outside it is the workspace's (useWorkspaceShortcuts); inside, `onKeyDown` below.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose() }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [onClose])
  // Filtering flattens the thread on purpose: a search for "pricing" that hid a matching
  // follow-up because its parent did not match would be a filter that lies.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? entries.filter((entry) => `${entry.prompt} ${entry.sub} ${entry.statusWord}`.toLowerCase().includes(needle))
        .map((entry) => ({ ...entry, depth: 0 }))
      : entries
  }, [entries, query])

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length === 0) return
      setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
    }
    if (event.key === 'Enter' && filtered[active]) { event.preventDefault(); onOpen(filtered[active]) }
  }

  return (
    <div ref={root} className="pop e2 lw-history" role="dialog" aria-label="Run history" onKeyDown={onKeyDown}>
      <div className="pop-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4.3-4.3" /></svg>
        <input autoFocus placeholder="Filter runs" aria-label="Filter runs" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }} />
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close run history" title="Close (Esc)"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="pop-list" role="listbox" aria-label="Previous runs">
        {loading && entries.length === 0 && <p className="pop-empty t-meta">Finding runs…</p>}
        {error && <p className="pop-empty t-meta" role="alert" style={{ color: 'var(--color-alert)' }}>{error}</p>}
        {!loading && !error && filtered.length === 0 && <p className="pop-empty t-meta">{entries.length === 0 ? 'No runs yet. Type a goal below and press Run.' : 'No runs match this filter.'}</p>}
        {filtered.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="option"
            aria-selected={entry.id === currentId}
            className={`pop-row ${entry.id === currentId ? 'current' : ''} ${index === active ? 'active' : ''}`}
            onMouseMove={() => setActive(index)}
            onClick={() => onOpen(entry)}
            title={entry.prompt}
            style={entry.depth ? { paddingLeft: `calc(var(--space-3) + ${entry.depth * 16}px)` } : undefined}
            data-depth={entry.depth || undefined}
          >
            <StatusGlyph status={entry.status} />
            <span className="hrow-text">
              <span className="goal t-body">
                {/* A follow-up reads as part of its parent's thread; a retry is labelled where it
                    sits, because it is a sibling attempt and not a continuation. */}
                {entry.depth ? <span className="t-meta" aria-hidden="true">↳ </span> : null}
                {entry.prompt}
              </span>
              <span className="sub t-meta">{entry.statusWord}{entry.lineage ? ` · ${entry.lineage}` : ''} · {entry.sub}</span>
            </span>
            <span className="when t-meta">{entry.live ? <span className="badge t-micro badge-live"><span className="pip" />Live</span> : relativeTime(entry.when)}</span>
          </button>
        ))}
      </div>
      <div className="pop-sep" />
      <div className="pop-foot">
        <span className="pop-note t-meta">Reopening a run shows exactly what was recorded. It never runs the agents again.</span>
      </div>
    </div>
  )
}
