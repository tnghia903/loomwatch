import { ArrowUp, FileText, Folder } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { listFolder, type FolderEntry, type FolderListing } from '../../lib/knowledge/client'

export interface FolderPickerProps {
  onChoose: (folder: FolderEntry) => void
  onClose: () => void
}

/**
 * Choose a folder on this computer to link as knowledge (ADR 0035).
 *
 * A browser cannot hand a page a real folder path, so the daemon — which runs on this computer —
 * lists folders and this dialog walks them. Portalled to the body: the inspector it opens from
 * clips its own overflow.
 */
export function FolderPicker({ onChoose, onClose }: FolderPickerProps) {
  const titleId = useId()
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const latest = useRef(0)

  // State is set only when the listing answers, so the first load can run from an effect; a
  // newer request makes an older answer stale.
  const load = useCallback((path?: string) => {
    const request = ++latest.current
    listFolder(path)
      .then((next) => { if (request === latest.current) { setListing(next); setError(null) } })
      .catch((caught: unknown) => { if (request === latest.current) setError(caught instanceof Error ? caught.message : String(caught)) })
      .finally(() => { if (request === latest.current) setLoading(false) })
  }, [])
  const open = (path: string) => {
    setLoading(true)
    load(path)
  }

  useEffect(() => { load() }, [load])

  return createPortal(
    <div className="folder-picker-scrim" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 folder-picker" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
        <h2 id={titleId} className="t-title">Add a folder</h2>
        <p className="t-meta">The agent is given the folder’s list of files and its README, and may open the files in it. The folder is linked, not copied, so every run sees what is in it then.</p>
        {listing && listing.places.length > 0 && (
          <nav className="folder-picker-places" aria-label="Places">
            {listing.places.map((place) => (
              <button key={place.path} type="button" className={place.path === listing.path ? 'on' : undefined} aria-current={place.path === listing.path ? 'location' : undefined} onClick={() => open(place.path)}>{place.name}</button>
            ))}
          </nav>
        )}
        <div className="folder-picker-path">
          <button type="button" className="iconbtn" aria-label="Up one folder" disabled={!listing?.parent || loading} onClick={() => listing?.parent && open(listing.parent)}><ArrowUp size={14} aria-hidden="true" /></button>
          <span className="t-mono-sm" title={listing?.path}>{listing?.path ?? '…'}</span>
        </div>
        <ul className="folder-picker-list" aria-label={listing ? `In ${listing.name}` : 'Folder contents'} aria-busy={loading}>
          {listing?.folders.map((folder) => (
            <li key={folder.path}>
              <button type="button" onClick={() => open(folder.path)}><Folder size={14} aria-hidden="true" />{folder.name}</button>
            </li>
          ))}
          {listing?.files.map((file) => (
            <li key={file} className="folder-picker-file"><FileText size={14} aria-hidden="true" />{file}</li>
          ))}
          {listing && listing.moreFiles > 0 && <li className="folder-picker-file t-meta">… and {listing.moreFiles} more files</li>}
          {listing && listing.folders.length === 0 && listing.files.length === 0 && <li className="folder-picker-file t-meta">This folder is empty.</li>}
        </ul>
        {error && <p className="folder-picker-error t-meta" role="alert">{error}</p>}
        <footer className="folder-picker-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!listing || loading} onClick={() => listing && onChoose({ name: listing.name, path: listing.path })}>
            {listing ? `Add “${listing.name}”` : 'Add'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
