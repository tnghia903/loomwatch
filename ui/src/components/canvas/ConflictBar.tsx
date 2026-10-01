import { useState } from 'react'

import { ChipDot } from '../ui/glyphs'

// §16: the daemon is a local process; a disk conflict offers Compare / Keep mine / Use disk
// and nothing cleverer. LoomWatch never merges.
export function ConflictBar({ filename, onKeepMine, onUseDisk, onCompare }: { filename: string; onKeepMine: () => void; onUseDisk: () => void; onCompare: () => void }) {
  const [confirmDisk, setConfirmDisk] = useState(false)
  return (
    <div role="alert" className="bar alert">
      <ChipDot state="invalid" />
      <span className="msg t-body-m"><strong>{filename}</strong> changed on disk while you were editing.</span>
      <span className="acts">
        <button type="button" className="btn" onClick={onCompare}>Compare…</button>
        <button type="button" className="btn" onClick={onKeepMine}>Keep mine</button>
        <button type="button" className={`btn ${confirmDisk ? 'btn-danger' : ''}`} onClick={() => confirmDisk ? onUseDisk() : setConfirmDisk(true)} style={confirmDisk ? { color: 'var(--color-alert)' } : undefined}>
          {confirmDisk ? 'Discard my edits?' : 'Use disk'}
        </button>
      </span>
    </div>
  )
}
