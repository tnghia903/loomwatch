import { ChevronDown } from '../ui/icon'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { baseName } from '../../lib/files/paths'
import { listNames } from '../../lib/format'
import type { RunRecord } from '../../lib/runs/client'
import type { LeaveTeam } from '../../lib/team-file/leaveTeam'
import { reviewProblems, type ReviewProblem } from '../../lib/team-file/problems'
import type { EntrypointProblem, SaveState } from '../../lib/team-file/useTeamDocument'
import type { TeamView } from '../../lib/team-file/useTeamList'
import type { AgentFieldProblems, DocumentProblem } from '../../lib/team-file/validation'
import { ChipDot, type ChipState } from '../ui/glyphs'
import { keys } from '../../lib/platform'
import { TeamSwitch } from './TeamSwitch'

export interface DocumentSwitcherProps {
  path: string | null
  /** The team's display name; the chip leads with it and keeps the file name as detail. */
  teamName?: string | null
  /** For a team in several projects (ADR 0103): the project this page is its place in. */
  here?: string | null
  /** The other projects an unsaved change to the team's setup reaches when saved (ADR 0103). */
  alsoIn?: readonly string[]
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
  /**
   * The other teams, listed in the menu and opened on the tab on screen; absent, none are listed.
   * `before` lets the page ask first about anything else a move would lose (an agent's workbench),
   * then carry on.
   */
  teams?: { view: TeamView; runs: readonly RunRecord[]; leave: LeaveTeam; before?: (then: () => void) => void }
}


// UX_REDESIGN §9.1: the canvas is a view over a file and the file is the truth. This chip is
// the only place file state is expressed; its menu is what is done to the file, and the other teams
// to go to, on the same tab (ADR 0043: one control per action; the dock's Projects lists them too,
// a place away). A new team is made in Projects.
export function DocumentSwitcher(props: DocumentSwitcherProps) {
  const { path, teamName = null, here = null, alsoIn = [], saveState, saveError, entrypointProblem, documentProblems, fieldProblemsByAgent, agentNames, isValid, readOnlyReason, fileGone = false, editingDisabled = false, onSave, onSaveCopy, onReload, onDiscard, onRename, onDelete, onSelectProblem, problemsOpen, onProblemsOpenChange, teams } = props
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // While the file moves, and why it didn't when it couldn't.
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameRefused, setRenameRefused] = useState<string | null>(null)
  const refusedId = useId()
  const chipRef = useRef<HTMLDivElement>(null)
  // Another team picked while this one has changes not saved: where to, and how keeping them went.
  const [leavingTo, setLeavingTo] = useState<string | null>(null)
  const [keeping, setKeeping] = useState<'saving' | 'failed' | null>(null)

  const problems = useMemo(() => reviewProblems(entrypointProblem, fieldProblemsByAgent, documentProblems, agentNames), [entrypointProblem, fieldProblemsByAgent, documentProblems, agentNames])
  const errors = problems.filter((problem) => problem.weight === 'error')
  const incomplete = problems.filter((problem) => problem.weight === 'incomplete')
  const scheduleErrors = errors.filter((problem) => problem.yamlPath?.[0] === 'schedule')

  useEffect(() => {
    if (!switcherOpen && !problemsOpen) return
    function onPointerDown(event: PointerEvent) {
      if (chipRef.current && !chipRef.current.contains(event.target as Node)) { setSwitcherOpen(false); onProblemsOpenChange(false); setDiscardConfirm(false); setRenaming(null); setRenameRefused(null); setLeavingTo(null); setKeeping(null) }
    }
    // Caught on the way down: the Team tab's canvas stops a press on itself before it bubbles up.
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
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

  const closeMenu = () => { setSwitcherOpen(false); setLeavingTo(null); setKeeping(null) }
  // Another team: at once, or once this one's changes are saved or dropped.
  const pickTeam = (href: string | null) => {
    if (!teams || href === null) { closeMenu(); return }
    const go = () => {
      if (teams.leave.asks()) { setSwitcherOpen(true); setLeavingTo(href); setKeeping(null); return }
      closeMenu()
      teams.leave.go(href)
    }
    if (!teams.before) { go(); return }
    // The page's own question comes first, with the menu out of its way; this team's, after it.
    closeMenu()
    teams.before(go)
  }
  const keepThenGo = async () => {
    if (!teams || !leavingTo) return
    setKeeping('saving')
    const saved = await teams.leave.saveThenGo(leavingTo)
    if (saved) closeMenu()
    else setKeeping('failed')
  }
  const dropThenGo = () => {
    if (!teams || !leavingTo) return
    const href = leavingTo
    closeMenu()
    void teams.leave.dropThenGo(href)
  }

  let state: ChipState = 'clean'
  let l1 = teamName ?? filename
  // Saved, as an agent's chip says it; the file's name and folder are in the menu.
  // Which project's place this is, when the team works in more than one: each has its own chat.
  let l2 = here ? `Saved · in ${here}` : 'Saved'
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
  else if (saveState === 'saved') { state = 'saved'; l2 = here ? `Saved · in ${here}` : 'Saved' }
  else if (saveState === 'error') { state = 'failed'; l2 = `Couldn't save: ${saveError ?? 'unknown error'}`; action = <button type="button" className="btn" onClick={onSave}>Retry</button> }
  else if (saveState === 'conflict') { state = 'failed'; l2 = 'Changed outside LoomWatch'; action = null }
  else if (!isValid && errors.length > 0) { state = 'invalid'; l2 = scheduleErrors.length === errors.length ? 'Schedule needs attention' : `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix`; action = review }
  else if (!isValid && incomplete.length > 0) { state = 'incomplete'; l2 = `${incomplete.length} thing${incomplete.length === 1 ? '' : 's'} to finish`; action = review }
  else if (saveState === 'new') { state = 'new'; l2 = 'Not saved yet'; action = save }
  // A team in several projects: what a save reaches, before it is pressed (ADR 0103).
  else if (saveState === 'dirty') { state = 'dirty'; l2 = alsoIn.length > 0 ? `Unsaved · ${listNames(alsoIn)} ${alsoIn.length === 1 ? 'gets' : 'get'} this too when you save` : 'Unsaved changes'; action = save }
  else if (editingDisabled) { l2 = 'Editing needs a wider window' }

  const ledger = saveState === 'saving' ? 'saving' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'failed' : ''

  // Leaving with changes not saved: the question an agent's workbench asks (LeaveConfirm), in this
  // team's words. Where saving can't work, it says why and offers what can.
  const cantSave = saveState === 'conflict' ? `${l1} was changed outside LoomWatch.` : !isValid ? `${l1} can’t be saved yet.${problems.length > 0 ? ` ${l2}.` : ''}` : null
  const leaveQuestion = keeping === 'failed' ? (saveError ? `Couldn’t save: ${saveError}` : 'Couldn’t save.') : cantSave ?? `Save changes to ${l1}?`

  // Its menus hang from the chip's left edge: the chip starts the header, beside the dock, and a menu
  // centred on it slid under the dock.
  return (
    <div ref={chipRef} style={{ position: 'relative', pointerEvents: 'auto' }}>
      <div className={`e1 lw-chip ${ledger}`} style={{ position: 'relative' }} title={readOnlyReason ?? saveError ?? undefined}>
        <button type="button" className="chip-open" onClick={() => { if (switcherOpen) closeMenu(); else setSwitcherOpen(true); onProblemsOpenChange(false) }} aria-controls="switcher-pop" aria-expanded={switcherOpen} aria-label={`${l1}, ${l2}, open team menu`} title={`${l1} · ${l2}`}>
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
        <div id="switcher-pop" className="pop e2" role="dialog" aria-label="Team menu" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: 0, width: 'min(392px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') closeMenu() }}>
          {teams && path && <TeamSwitch open={path} view={teams.view} runs={teams.runs} onPick={pickTeam} />}
          {leavingTo && (
            <div className="pop-inline team-switch-leave t-meta" role="alertdialog" aria-label={leaveQuestion} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setLeavingTo(null); setKeeping(null) } }}>
              <span>{leaveQuestion}</span>
              {/* A gold line: the screen's one gold fill stays its own action's (Run team, Send). The
                  keyboard waits on Save, or on Cancel where there is no Save, never on Don't save. */}
              {!cantSave && <button type="button" className="btn btn-ring" autoFocus onClick={() => void keepThenGo()} disabled={keeping === 'saving'}>{keeping === 'saving' ? 'Saving…' : 'Save'}</button>}
              <button type="button" className="btn" onClick={dropThenGo} disabled={keeping === 'saving'}>Don’t save</button>
              <button type="button" className="btn" autoFocus={Boolean(cantSave)} onClick={() => { setLeavingTo(null); setKeeping(null) }} disabled={keeping === 'saving'}>Cancel</button>
            </div>
          )}
          {/* While it asks about leaving, the question is the menu's: the file's own Discard steps aside. */}
          {!leavingTo && (<>
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
          </>)}
        </div>
      )}

      {problemsOpen && (
        <div id="problems-pop" className="pop e2" role="dialog" aria-label="Document problems" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: 0, width: 'min(392px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') onProblemsOpenChange(false) }}>
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
