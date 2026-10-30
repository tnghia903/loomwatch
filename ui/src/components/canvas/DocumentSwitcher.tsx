import { ChevronDown } from '../ui/icon'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { baseName } from '../../lib/files/paths'
import { reviewProblems, type ReviewProblem } from '../../lib/team-file/problems'
import type { EntrypointProblem, SaveState } from '../../lib/team-file/useTeamDocument'
import type { AgentFieldProblems, DocumentProblem } from '../../lib/team-file/validation'
import { ChipDot, type ChipState } from '../ui/glyphs'
import { keys } from '../../lib/platform'

export interface DocumentSwitcherProps {
  path: string | null
  /** The team's display name; the chip leads with it and keeps the file name as detail. */
  teamName?: string | null
  saveState: SaveState
  saveError: string | null
  entrypointProblem: EntrypointProblem | null
  documentProblems: DocumentProblem[]
  fieldProblemsByAgent: ReadonlyMap<string, AgentFieldProblems>
  agentNames: ReadonlyMap<string, string>
  /** Agents whose app is not on this computer (`lib/team-file/appChecks`). The file is still valid. */
  isValid: boolean
  readOnlyReason: string | null
  fileGone?: boolean
  editingDisabled?: boolean
  onSave: () => void
  onSaveCopy: () => void
  onReload: () => void
  onDiscard: () => void
  /**
   * Rename the open team, and its file with it (ADR 0099); absent while it cannot be edited.
   * Resolves to why it was not renamed, or null.
   */
  onRename?: (name: string) => Promise<string | null> | void
  /** Ask to delete the open team (the confirmation is the caller's); absent while it has no file. */
  onDelete?: () => void
  onSelectProblem: (problem: ReviewProblem) => void
  problemsOpen: boolean
  onProblemsOpenChange: (open: boolean) => void
}


// UX_REDESIGN §9.1: the canvas is a view over a file and the file is the truth. This chip is
// the only place file state is expressed; its menu is what is done to the file. Other teams, and a
// new one, are reached from the team rail beside the page (ADR 0043: one control per action).
export function DocumentSwitcher(props: DocumentSwitcherProps) {
  const { path, teamName = null, saveState, saveError, entrypointProblem, documentProblems, fieldProblemsByAgent, agentNames, isValid, readOnlyReason, fileGone = false, editingDisabled = false, onSave, onSaveCopy, onReload, onDiscard, onRename, onDelete, onSelectProblem, problemsOpen, onProblemsOpenChange } = props
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // While the file moves, and why it didn't when it couldn't.
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameRefused, setRenameRefused] = useState<string | null>(null)
  const refusedId = useId()
  const chipRef = useRef<HTMLDivElement>(null)

  const problems = useMemo(() => reviewProblems(entrypointProblem, fieldProblemsByAgent, documentProblems, agentNames), [entrypointProblem, fieldProblemsByAgent, documentProblems, agentNames])
  const errors = problems.filter((problem) => problem.weight === 'error')
  const incomplete = problems.filter((problem) => problem.weight === 'incomplete')
  const scheduleErrors = errors.filter((problem) => problem.yamlPath?.[0] === 'schedule')

  useEffect(() => {
    if (!switcherOpen && !problemsOpen) return
    function onPointerDown(event: MouseEvent) {
      if (chipRef.current && !chipRef.current.contains(event.target as Node)) { setSwitcherOpen(false); onProblemsOpenChange(false); setDiscardConfirm(false); setRenaming(null); setRenameRefused(null) }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [switcherOpen, problemsOpen, onProblemsOpenChange])

  if (!path) return null
  const filename = baseName(path)
  const dirty = ['dirty', 'invalid', 'conflict', 'new'].includes(saveState)
  // Leaving the page after a delete would stop on the browser's "unsaved changes" prompt.
  const unsaved = dirty || saveState === 'saving' || saveState === 'error'
  // A saved team's file moves at once, so its changes come first; a team not saved yet only
  // changes the name it will be saved under.
  const renameWaits = unsaved && saveState !== 'new'
  const rename = async (name: string) => {
    if (!onRename) return
    setRenameBusy(true)
    const refused = await onRename(name) ?? null
    setRenameBusy(false)
    setRenameRefused(refused)
    if (!refused) setRenaming(null)
  }

  let state: ChipState = 'clean'
  let l1 = teamName ?? filename
  // Saved, as an agent's chip says it; the file's name and folder are in the menu.
  let l2 = 'Saved'
  let action: React.ReactNode = null
  // A gold ring, not the fill: the view's own action keeps the screen's one fill (Run team, which
  // saves first, Approve or Save schedule), and unsaved work is gold's "unfinished" edge (§5).
  const save = <button type="button" className="btn btn-ring" onClick={onSave} disabled={!isValid || editingDisabled} title={!isValid ? (errors[0]?.message ?? incomplete[0]?.message) : editingDisabled ? 'Editing needs a wider window' : undefined}>Save <kbd className="t-mono-sm" style={{ opacity: .8 }}>{keys('⌘S')}</kbd></button>
  const review = <button type="button" className="btn" onClick={() => { onProblemsOpenChange(!problemsOpen); setSwitcherOpen(false) }} aria-expanded={problemsOpen} aria-controls="problems-pop">Review</button>

  // The first line is always the team, so the operator never loses track of what is open; the
  // second line carries whatever is true about it right now.
  if (fileGone) { state = 'failed'; l2 = 'The file was moved or deleted'; action = <button type="button" className="btn btn-primary" onClick={onSaveCopy}>Save a copy…</button> }
  else if (saveState === 'read-only') { state = 'readonly'; l2 = readOnlyReason ?? 'Read-only' }
  else if (saveState === 'saving') { state = 'saving'; l2 = 'Saving…' }
  else if (saveState === 'saved') { state = 'saved'; l2 = 'Saved' }
  else if (saveState === 'error') { state = 'failed'; l2 = `Couldn't save: ${saveError ?? 'unknown error'}`; action = <button type="button" className="btn" onClick={onSave}>Retry</button> }
  else if (saveState === 'conflict') { state = 'failed'; l2 = 'Changed outside LoomWatch'; action = null }
  else if (!isValid && errors.length > 0) { state = 'invalid'; l2 = scheduleErrors.length === errors.length ? 'Schedule needs attention' : `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix`; action = review }
  else if (!isValid && incomplete.length > 0) { state = 'incomplete'; l2 = `${incomplete.length} thing${incomplete.length === 1 ? '' : 's'} to finish`; action = review }
  else if (saveState === 'new') { state = 'new'; l2 = 'Not saved yet'; action = save }
  else if (saveState === 'dirty') { state = 'dirty'; l2 = 'Unsaved changes'; action = save }
  else if (editingDisabled) { l2 = 'Editing needs a wider window' }

  const ledger = saveState === 'saving' ? 'saving' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'failed' : ''

  return (
    <div ref={chipRef} style={{ position: 'relative', pointerEvents: 'auto' }}>
      <div className={`e1 lw-chip ${ledger}`} style={{ position: 'relative' }} title={readOnlyReason ?? saveError ?? undefined}>
        <button type="button" className="chip-open" onClick={() => { setSwitcherOpen((open) => !open); onProblemsOpenChange(false) }} aria-controls="switcher-pop" aria-expanded={switcherOpen} aria-label={`${l1}, ${l2}, open team menu`} title={`${l1} · ${l2}`}>
          <ChipDot state={state} />
          <span className="chip-text">
            <span className="chip-l1 t-body-m">{l1}</span>
            <span className="chip-l2 t-meta">{l2}</span>
          </span>
          <span className="chev"><ChevronDown size={14} aria-hidden="true" /></span>
        </button>
        {action && <span className="chip-action">{action}</span>}
        <span className="ledger" aria-hidden="true" />
      </div>

      {switcherOpen && (
        <div id="switcher-pop" className="pop e2" role="dialog" aria-label="Team menu" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: '50%', transform: 'translateX(-50%)', width: 'min(392px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') setSwitcherOpen(false) }}>
          {renaming !== null && onRename && (
            <form className="pop-inline t-meta" aria-label="Rename team" aria-busy={renameBusy} onSubmit={(event) => { event.preventDefault(); void rename(renaming) }}>
              <input className="input" autoFocus aria-label="Team name" aria-invalid={renameRefused ? true : undefined} aria-describedby={renameRefused ? refusedId : undefined} value={renaming} onChange={(event) => { setRenaming(event.target.value); setRenameRefused(null) }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); setRenameRefused(null) } }} style={{ flex: 1, minWidth: 0 }} />
              <button type="submit" className="btn btn-primary" disabled={!renaming.trim() || renameBusy}>Rename</button>
              <button type="button" className="btn" onClick={() => { setRenaming(null); setRenameRefused(null) }}>Cancel</button>
            </form>
          )}
          <div className="pop-foot">
            {renaming !== null && renameRefused && <p id={refusedId} className="pop-refused t-meta" role="alert">{renameRefused}</p>}
            <span className="path t-mono-sm selectable">{path}</span>
            <span className="acts">
              {onRename && <button type="button" className="link" onClick={() => setRenaming(teamName ?? filename.replace(/\.ya?ml$/i, ''))} disabled={renameWaits} title={renameWaits ? 'Save or discard your changes first' : undefined}>Rename</button>}
              {onDelete && <button type="button" className="link alert" onClick={() => { setSwitcherOpen(false); onDelete() }} disabled={unsaved} title={unsaved ? 'Save or discard your changes first' : undefined}>Delete team…</button>}
              <button type="button" className="link" onClick={() => void navigator.clipboard?.writeText(path)}>Copy path</button>
              {/* Both read the file again (ADR 0043): with changes it is Discard, which asks first;
                  without, it is Reload, which picks up an edit made outside LoomWatch. */}
              {dirty && saveState !== 'new'
                ? <button type="button" className="link alert" onClick={() => discardConfirm ? (onDiscard(), setDiscardConfirm(false), setSwitcherOpen(false)) : setDiscardConfirm(true)}>{discardConfirm ? 'Discard changes?' : 'Discard'}</button>
                : <button type="button" className="link" onClick={onReload} disabled={saveState === 'new'}>Reload from disk</button>}
            </span>
            <span className="pop-note t-meta">Saves keep your comments and key order.</span>
          </div>
        </div>
      )}

      {problemsOpen && (
        <div id="problems-pop" className="pop e2" role="dialog" aria-label="Document problems" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: '50%', transform: 'translateX(-50%)', width: 'min(392px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') onProblemsOpenChange(false) }}>
          {incomplete.length > 0 && (
            <div className="prob-group">
              <div className="prob-head needs t-micro"><ChipDot state="incomplete" /> {incomplete.length} thing{incomplete.length === 1 ? '' : 's'} to finish</div>
              {incomplete.map((problem, index) => (
                <button key={`${problem.title}-${index}`} type="button" className="prob-row" onClick={() => { onSelectProblem(problem); onProblemsOpenChange(false) }}>
                  <b className="t-body">{problem.title}</b>
                  <span className="t-meta">{problem.message}</span>
                </button>
              ))}
            </div>
          )}
          {incomplete.length > 0 && errors.length > 0 && <div className="pop-sep" />}
          {errors.length > 0 && (
            <div className="prob-group">
              <div className="prob-head errs t-micro"><ChipDot state="invalid" /> {errors.length} problem{errors.length === 1 ? '' : 's'}</div>
              {errors.map((problem, index) => (
                <button key={`${problem.title}-${index}`} type="button" className="prob-row" onClick={() => { onSelectProblem(problem); onProblemsOpenChange(false) }}>
                  <b className="t-body">{problem.title}</b>
                  <span className="t-meta">{problem.message}</span>
                </button>
              ))}
            </div>
          )}
          {problems.length === 0 && <p className="pop-empty t-meta">Nothing to fix.</p>}
          <div className="pop-sep" />
          <div className="pop-foot">
            <span className="acts"><span className="pop-note t-meta">Next problem · F8 · Previous · {keys('⇧F8')}</span></span>
          </div>
        </div>
      )}
    </div>
  )
}
