import { Check, Loader2, X } from 'lucide-react'

import type { SaveState } from '../../lib/team-file/useTeamDocument'

// docs/CANVAS_SPEC.md §9.1: the document chip is the single place file state is expressed.
// Scoped to the states useTeamDocument actually tracks — `no-file` renders nothing, since
// there is no open document to name (that is §10.1's empty-canvas screen, out of scope here).
export interface DocumentChipProps {
  path: string | null
  saveState: SaveState
  saveError: string | null
  onSave: () => void
}

export function DocumentChip({ path, saveState, saveError, onSave }: DocumentChipProps) {
  if (!path) {
    return null
  }
  const filename = path.split('/').pop() ?? path

  return (
    <div
      title={saveState === 'error' ? (saveError ?? undefined) : undefined}
      className="pointer-events-auto flex h-10 min-w-[260px] items-center gap-2 rounded-full border border-hairline/10 bg-surface/72 px-3 text-[13px] shadow-[0_1px_2px_rgb(0_0_0/.04),0_8px_24px_rgb(0_0_0/.08)] backdrop-blur-xl"
    >
      <Dot saveState={saveState} />
      <span className="min-w-0 flex-1 truncate text-ink">
        {filename}
        {saveState === 'dirty' && <span className="text-ink-2"> · Unsaved changes</span>}
        {saveState === 'saving' && <span className="text-ink-2"> · Saving…</span>}
        {saveState === 'saved' && <span className="text-green"> · Saved</span>}
        {saveState === 'error' && <span className="text-red"> · Couldn't save</span>}
      </span>
      {(saveState === 'dirty' || saveState === 'error') && (
        <button
          type="button"
          onClick={onSave}
          className="shrink-0 rounded-full bg-iris px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
        >
          {saveState === 'error' ? 'Retry' : 'Save ⌘S'}
        </button>
      )}
    </div>
  )
}

function Dot({ saveState }: { saveState: SaveState }) {
  switch (saveState) {
    case 'dirty':
      return <span className="size-2 shrink-0 rounded-full bg-iris" aria-hidden="true" />
    case 'saving':
      return <Loader2 className="size-3 shrink-0 animate-spin text-iris" aria-hidden="true" />
    case 'saved':
      return <Check className="size-3 shrink-0 text-green" aria-hidden="true" />
    case 'error':
      return <X className="size-3 shrink-0 text-red" aria-hidden="true" />
    default:
      return <span className="size-2 shrink-0 rounded-full border-[1.5px] border-ink-3" aria-hidden="true" />
  }
}
