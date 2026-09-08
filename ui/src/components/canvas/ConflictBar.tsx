import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'

export function ConflictBar({ filename, onKeepMine, onUseDisk, onCompare }: { filename: string; onKeepMine: () => void; onUseDisk: () => void; onCompare: () => void }) {
  const [confirmDisk, setConfirmDisk] = useState(false)
  return (
    <div role="alert" className="pointer-events-auto mx-4 mt-4 flex min-h-12 items-center gap-3 rounded-lg border border-copper bg-surface-solid px-4 text-[13px] text-ink shadow-lg">
      <TriangleAlert className="size-4 shrink-0 text-copper" aria-hidden="true" />
      <span className="flex-1"><strong>{filename}</strong> changed on disk while you had unsaved edits.</span>
      <button type="button" onClick={onCompare} className="rounded-md px-2 py-1 hover:bg-hairline/10">Compare…</button>
      <button type="button" onClick={onKeepMine} className="rounded-md px-2 py-1 hover:bg-hairline/10">Keep mine</button>
      <button type="button" onClick={() => confirmDisk ? onUseDisk() : setConfirmDisk(true)} className="rounded-md px-2 py-1 text-red hover:bg-red/10">
        {confirmDisk ? 'Discard my edits?' : 'Use disk'}
      </button>
    </div>
  )
}
