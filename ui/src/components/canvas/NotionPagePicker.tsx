import { NotebookText, Search } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { notionPageKey } from '../../lib/composer-layout/types'
import { searchNotionPages, type NotionPageHit } from '../../lib/notion/connection'

export interface NotionPagePickerProps {
  /** Who gets the page, for the heading; absent when the card is placed without an agent. */
  agentName?: string
  /** Pages that agent already reads, by `notionPageKey`: listed, but not chosen twice. */
  given?: ReadonlySet<string>
  onChoose: (page: NotionPageHit) => void
  onClose: () => void
}

/** How long typing must pause before Notion is searched: each search is a call to Notion. */
const SEARCH_PAUSE_MS = 350

/**
 * Choose a Notion page for an agent to read (ADR 0050), through the same search Connections uses
 * to choose the destination. Opens on recent pages, so the common case is one click. Shares the
 * folder picker's dialog, since both choose something an agent is given.
 */
export function NotionPagePicker({ agentName, given, onChoose, onClose }: NotionPagePickerProps) {
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ query: string; pages: NotionPageHit[]; nextCursor: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const latest = useRef(0)

  const search = useCallback((text: string, cursor?: string | null) => {
    const request = ++latest.current
    setLoading(true)
    searchNotionPages(text.trim(), cursor)
      .then((found) => {
        if (request !== latest.current) return
        setResults((current) => cursor && current
          ? { ...found, query: text, pages: [...current.pages, ...found.pages.filter((page) => !current.pages.some((had) => had.id === page.id))] }
          : { ...found, query: text })
        setError(null)
      })
      .catch((caught: unknown) => { if (request === latest.current) setError(caught instanceof Error ? caught.message : String(caught)) })
      .finally(() => { if (request === latest.current) setLoading(false) })
  }, [])

  // A blank search lists recent pages, so opening the picker is already a list to choose from.
  useEffect(() => {
    const timer = window.setTimeout(() => search(query), query ? SEARCH_PAUSE_MS : 0)
    return () => window.clearTimeout(timer)
  }, [query, search])

  return createPortal(
    <div className="folder-picker-scrim" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 folder-picker notion-picker" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
        <h2 id={titleId} className="t-title">{agentName ? `Give ${agentName} a Notion page` : 'Add a Notion page'}</h2>
        <p className="t-meta">When each run starts, LoomWatch reads the page through your Notion connection and gives the agent its text. The agent never gets the connection, and nothing is written to the page.</p>
        <label className="notion-picker-search">
          <Search size={13} aria-hidden="true" />
          <input autoFocus aria-label="Search your Notion pages" placeholder="Search your Notion by title" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <ul className="folder-picker-list" aria-label={results?.query ? `Pages matching ${results.query}` : 'Recent pages'} aria-busy={loading}>
          {results?.pages.map((page) => {
            const already = given?.has(notionPageKey(page.id)) ?? false
            return (
              <li key={page.id}>
                <button type="button" disabled={already} onClick={() => onChoose(page)}>
                  <NotebookText size={14} aria-hidden="true" />
                  <span className="notion-picker-title">{page.title}</span>
                  {already && <span className="t-meta notion-picker-aside">Already reads it</span>}
                </button>
              </li>
            )
          })}
          {results && results.pages.length === 0 && !loading && (
            <li className="folder-picker-file t-meta">{results.query.trim() ? 'No pages match. Try another word.' : 'No recent pages. Search by title instead.'}</li>
          )}
          {!results && loading && <li className="folder-picker-file t-meta">Looking in Notion…</li>}
        </ul>
        {error && <p className="folder-picker-error t-meta" role="alert">{error}</p>}
        <footer className="folder-picker-foot">
          {results?.nextCursor && <button type="button" className="btn" disabled={loading} onClick={() => search(results.query, results.nextCursor)}>Load more pages</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
