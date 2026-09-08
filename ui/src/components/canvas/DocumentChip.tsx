import { Check, Clipboard, Loader2, Lock, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'

import type { DocumentProblem } from '../../lib/team-file/validation'
import type { EntrypointProblem, SaveState } from '../../lib/team-file/useTeamDocument'

export interface DocumentChipProps {
  path: string | null
  saveState: SaveState
  saveError: string | null
  entrypointProblem: EntrypointProblem | null
  documentProblems: DocumentProblem[]
  fieldProblemCount?: number
  isValid: boolean
  readOnlyReason: string | null
  editingDisabled?: boolean
  onSave: () => void
  onReload: () => void
  onShowYaml: () => void
}

// docs/CANVAS_SPEC.md §9.1/§9.5: all file state lives in this one top-centre control.
export function DocumentChip({
  path,
  saveState,
  saveError,
  entrypointProblem,
  documentProblems,
  fieldProblemCount = 0,
  isValid,
  readOnlyReason,
  editingDisabled = false,
  onSave,
  onReload,
  onShowYaml,
}: DocumentChipProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  if (!path) return null
  const filename = path.split('/').pop() ?? path
  const problemCount = documentProblems.length + fieldProblemCount + (entrypointProblem ? 1 : 0)
  const saveDisabled = !isValid || editingDisabled || saveState === 'read-only'

  return (
    <div className="pointer-events-auto relative flex flex-col items-center gap-2">
      <div
        title={readOnlyReason ?? saveError ?? (!isValid ? entrypointProblem?.message : undefined)}
        className="group flex h-10 min-w-[260px] items-center gap-2 rounded-full border border-hairline/10 bg-surface/72 px-3 text-[13px] shadow-[0_1px_2px_rgb(0_0_0/.04),0_8px_24px_rgb(0_0_0/.08)] backdrop-blur-xl"
      >
        <Dot saveState={saveState} />
        <button
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          className="min-w-0 flex-1 truncate text-left text-ink"
        >
          {saveState === 'invalid' ? `${problemCount} problem${problemCount === 1 ? '' : 's'}` : filename}
          {saveState === 'dirty' && <span className="text-ink-2"> · Unsaved changes</span>}
          {saveState === 'new' && <span className="text-ink-2"> · Not saved yet</span>}
          {saveState === 'saving' && <span className="text-ink-2"> · Saving…</span>}
          {saveState === 'saved' && <span className="text-green"> · Saved</span>}
          {saveState === 'conflict' && <span className="text-copper"> · Changed on disk</span>}
          {saveState === 'read-only' && <span className="text-slate"> · Read-only</span>}
          {saveState === 'error' && <span className="text-red"> · Couldn't save</span>}
          {editingDisabled && <span className="text-ink-3"> · Editing needs a wider window</span>}
        </button>

        {saveState === 'invalid' ? (
          <button type="button" onClick={() => setProblemsOpen((open) => !open)} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-red hover:bg-red/10">
            Review
          </button>
        ) : (saveState === 'dirty' || saveState === 'new' || saveState === 'error') ? (
          <button
            type="button"
            onClick={onSave}
            disabled={saveDisabled}
            title={saveDisabled ? entrypointProblem?.message ?? 'Resolve validation problems before saving.' : undefined}
            className="shrink-0 rounded-full bg-iris px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saveState === 'error' ? 'Retry' : saveState === 'new' ? 'Save' : 'Save ⌘S'}
          </button>
        ) : saveState === 'clean' ? (
          <span className="invisible font-mono text-[11px] text-ink-3 group-hover:visible">⌘S</span>
        ) : null}
      </div>

      {detailsOpen && (
        <div className="w-96 rounded-lg border border-hairline/10 bg-surface-solid p-3 text-[12px] text-ink shadow-[0_2px_4px_rgb(0_0_0/.06),0_16px_40px_rgb(0_0_0/.14)]">
          <p className="break-all font-mono text-ink-2">{path}</p>
          <p className="mt-2 text-ink-3">Saves keep your comments and key order.</p>
          {readOnlyReason && <p className="mt-2 text-slate">{readOnlyReason}</p>}
          {saveError && !readOnlyReason && <p className="mt-2 text-red">{saveError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(path)} className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hairline/10">
              <Clipboard className="size-3" /> Copy path
            </button>
            <button type="button" onClick={onReload} disabled={saveState === 'new'} className="rounded-md px-2 py-1 hover:bg-hairline/10 disabled:opacity-40">Reload from disk</button>
            <button type="button" onClick={onShowYaml} className="rounded-md px-2 py-1 hover:bg-hairline/10">Show YAML</button>
            <button type="button" onClick={() => { window.history.replaceState({}, '', '/'); window.location.reload() }} className="rounded-md px-2 py-1 hover:bg-hairline/10">Open another team…</button>
            {(saveState === 'dirty' || saveState === 'invalid' || saveState === 'conflict') && (
              <button type="button" onClick={() => discardConfirm ? onReload() : setDiscardConfirm(true)} className="rounded-md px-2 py-1 text-red hover:bg-red/10">
                {discardConfirm ? 'Discard changes?' : 'Discard changes'}
              </button>
            )}
          </div>
        </div>
      )}

      {problemsOpen && (
        <div role="dialog" aria-label="Document problems" className="w-96 rounded-lg border border-red/30 bg-surface-solid p-3 text-[12px] shadow-[0_16px_40px_rgb(0_0_0/.14)]">
          <p className="mb-2 font-semibold text-ink">Resolve before saving</p>
          <ul className="space-y-1 text-red">
            {entrypointProblem && <li>{entrypointProblem.message}</li>}
            {documentProblems.map((problem, index) => <li key={`${problem.message}-${index}`}>{problem.message}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

function Dot({ saveState }: { saveState: SaveState }) {
  switch (saveState) {
    case 'new':
      return <span className="size-2 shrink-0 rounded-full border-[1.5px] border-iris" aria-hidden="true" />
    case 'dirty':
      return <span className="size-2 shrink-0 rounded-full bg-iris" aria-hidden="true" />
    case 'saving':
      return <Loader2 className="size-3 shrink-0 animate-spin text-iris" aria-hidden="true" />
    case 'saved':
      return <Check className="size-3 shrink-0 text-green" aria-hidden="true" />
    case 'invalid':
      return <span className="size-2 shrink-0 rounded-full bg-red" aria-hidden="true" />
    case 'conflict':
      return <TriangleAlert className="size-3 shrink-0 text-copper" aria-hidden="true" />
    case 'read-only':
      return <Lock className="size-3 shrink-0 text-slate" aria-hidden="true" />
    case 'error':
      return <X className="size-3 shrink-0 text-red" aria-hidden="true" />
    default:
      return <span className="size-2 shrink-0 rounded-full border-[1.5px] border-ink-3" aria-hidden="true" />
  }
}
