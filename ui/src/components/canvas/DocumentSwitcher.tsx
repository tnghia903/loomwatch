import { ChevronDown, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { AppProblem } from '../../lib/team-file/appChecks'
import { fetchTeamsDiscovery, teamDisplayName, teamSummaries, type TeamSummary } from '../../lib/team-file/client'
import { reviewProblems, shortenDirectory, type ReviewProblem } from '../../lib/team-file/problems'
import type { EntrypointProblem, SaveState } from '../../lib/team-file/useTeamDocument'
import type { AgentFieldProblems, DocumentProblem } from '../../lib/team-file/validation'
import { ChipDot, type ChipState } from '../ui/glyphs'

export interface DocumentSwitcherProps {
  path: string | null
  /** The team's display name; the chip leads with it and keeps the file name as detail. */
  teamName?: string | null
  saveState: SaveState
  saveError: string | null
  linesDiffer: number
  entrypointProblem: EntrypointProblem | null
  documentProblems: DocumentProblem[]
  fieldProblemsByAgent: ReadonlyMap<string, AgentFieldProblems>
  agentNames: ReadonlyMap<string, string>
  /** Agents whose app is not on this computer (`lib/team-file/appChecks`). The file is still valid. */
  appProblems?: readonly AppProblem[]
  isValid: boolean
  readOnlyReason: string | null
  fileGone?: boolean
  editingDisabled?: boolean
  onSave: () => void
  onSaveCopy: () => void
  onReload: () => void
  onDiscard: () => void
  onShowYaml: () => void
  onNewTeam: () => void
  /** Rename the open team; absent while it cannot be edited. */
  onRename?: (name: string) => void
  /** Ask to delete the open team (the confirmation is the caller's); absent while it has no file. */
  onDelete?: () => void
  onSelectProblem: (problem: ReviewProblem) => void
  problemsOpen: boolean
  onProblemsOpenChange: (open: boolean) => void
}

const NO_APP_PROBLEMS: readonly AppProblem[] = []

// UX_REDESIGN §9.1: the canvas is a view over a file and the file is the truth. This chip is
// the only place file state is expressed, and the only way to reach another file.
export function DocumentSwitcher(props: DocumentSwitcherProps) {
  const { path, teamName = null, saveState, saveError, linesDiffer, entrypointProblem, documentProblems, fieldProblemsByAgent, agentNames, appProblems = NO_APP_PROBLEMS, isValid, readOnlyReason, fileGone = false, editingDisabled = false, onSave, onSaveCopy, onReload, onDiscard, onShowYaml, onNewTeam, onRename, onDelete, onSelectProblem, problemsOpen, onProblemsOpenChange } = props
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [files, setFiles] = useState<TeamSummary[] | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const chipRef = useRef<HTMLDivElement>(null)

  const problems = useMemo(() => reviewProblems(entrypointProblem, fieldProblemsByAgent, documentProblems, agentNames, appProblems), [entrypointProblem, fieldProblemsByAgent, documentProblems, agentNames, appProblems])
  const errors = problems.filter((problem) => problem.weight === 'error')
  const incomplete = problems.filter((problem) => problem.weight === 'incomplete')
  const scheduleErrors = errors.filter((problem) => problem.yamlPath?.[0] === 'schedule')

  useEffect(() => {
    if (!switcherOpen) return
    let cancelled = false
    fetchTeamsDiscovery().then((discovery) => { if (!cancelled) { setFiles(teamSummaries(discovery)); setRoot(discovery.root); setFilesError(null) } })
      .catch((error: unknown) => { if (!cancelled) setFilesError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [switcherOpen])

  useEffect(() => {
    if (!switcherOpen && !problemsOpen) return
    function onPointerDown(event: MouseEvent) {
      if (chipRef.current && !chipRef.current.contains(event.target as Node)) { setSwitcherOpen(false); onProblemsOpenChange(false); setPendingSwitch(null); setDiscardConfirm(false); setRenaming(null) }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [switcherOpen, problemsOpen, onProblemsOpenChange])

  if (!path) return null
  const filename = path.split('/').pop() ?? path
  const directory = path.includes('/') ? shortenDirectory(path.slice(0, path.lastIndexOf('/'))) : ''
  const dirty = ['dirty', 'invalid', 'conflict', 'new'].includes(saveState)
  // Leaving the page after a delete would stop on the browser's "unsaved changes" prompt.
  const unsaved = dirty || saveState === 'saving' || saveState === 'error'

  let state: ChipState = 'clean'
  let l1 = teamName ?? filename
  let l2 = teamName ? filename : directory || 'teams'
  let action: React.ReactNode = null
  const primarySave = <button type="button" className="btn btn-primary" onClick={onSave} disabled={!isValid || editingDisabled} title={!isValid ? (errors[0]?.message ?? incomplete[0]?.message) : editingDisabled ? 'Editing needs a wider window' : undefined}>Save <kbd className="t-mono-sm" style={{ opacity: .8 }}>⌘S</kbd></button>
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
  else if (saveState === 'new') { state = 'new'; l2 = 'Not saved yet'; action = primarySave }
  else if (saveState === 'dirty') { state = 'dirty'; l2 = 'Unsaved changes'; action = primarySave }
  // A missing app does not make the file wrong, so Save keeps its place above; once saved, the
  // chip stops saying all is well.
  else if (appProblems.length > 0) { state = 'incomplete'; l2 = `${incomplete.length} thing${incomplete.length === 1 ? '' : 's'} to finish`; action = review }
  else if (editingDisabled) { l2 = 'Editing needs a wider window' }

  const ledger = saveState === 'saving' ? 'saving' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'failed' : ''
  const needle = query.toLowerCase()
  const matches = (files ?? []).filter((team) => teamDisplayName(team).toLowerCase().includes(needle) || team.path.toLowerCase().includes(needle))
  // Two teams may share a name; their files never do, so a shared name shows its file beside it.
  const nameCounts = new Map<string, number>()
  for (const team of files ?? []) nameCounts.set(teamDisplayName(team), (nameCounts.get(teamDisplayName(team)) ?? 0) + 1)
  const isCurrent = (file: string) => (root ? `${root.replace(/\/+$/, '')}/${file}` : file) === path || file === path

  function switchTo(file: string) {
    if (dirty && saveState !== 'new') { setPendingSwitch(file); return }
    window.location.assign(`/?path=${encodeURIComponent(file)}`)
  }

  return (
    <div ref={chipRef} style={{ position: 'relative', pointerEvents: 'auto' }}>
      <div className={`e1 lw-chip ${ledger}`} style={{ position: 'relative' }} title={readOnlyReason ?? saveError ?? undefined}>
        <button type="button" className="chip-open" onClick={() => { setSwitcherOpen((open) => !open); onProblemsOpenChange(false) }} aria-controls="switcher-pop" aria-expanded={switcherOpen} aria-label={`${l1}, ${l2}, open team switcher`} title={`${l1} · ${l2}`}>
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
        <div id="switcher-pop" className="pop e2" role="dialog" aria-label="Team switcher" style={{ top: 'calc(var(--lw-chip-h) + 8px)', left: '50%', transform: 'translateX(-50%)', width: 'min(392px, calc(100vw - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') setSwitcherOpen(false) }}>
          <div className="pop-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4.3-4.3" /></svg>
            <input autoFocus placeholder="Filter teams" aria-label="Filter teams" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="pop-list" role="listbox" aria-label="Your teams">
            {files === null && !filesError && <p className="pop-empty t-meta">Finding teams…</p>}
            {filesError && <p className="pop-empty t-meta" role="alert" style={{ color: 'var(--color-alert)' }}>{filesError}</p>}
            {files !== null && matches.length === 0 && <p className="pop-empty t-meta">No team matches.</p>}
            {matches.map((team) => {
              const file = team.path
              const current = isCurrent(file)
              return (
                <div key={file}>
                  <button type="button" role="option" aria-selected={current} className={`pop-row ${current ? 'current' : ''}`} onClick={() => !current && switchTo(file)}>
                    {current ? <ChipDot state={state} /> : <span style={{ width: 12 }} />}
                    <span className={`name ${current ? 't-body-m' : 't-body'}`} title={file}>{current && teamName ? teamName : teamDisplayName(team)}</span>
                    {current && dirty
                      ? <span className="aside t-mono-sm">{linesDiffer > 0 ? `${linesDiffer} differ` : 'unsaved'}</span>
                      : (nameCounts.get(teamDisplayName(team)) ?? 0) > 1 && <span className="aside t-mono-sm">{file}</span>}
                  </button>
                  {pendingSwitch === file && (
                    <div className="pop-inline t-meta" role="alertdialog" aria-label="Unsaved changes">
                      <span>Unsaved changes.</span>
                      <button type="button" className="btn btn-primary" onClick={() => { onSave(); setPendingSwitch(null) }} disabled={!isValid}>Save first</button>
                      <button type="button" className="btn btn-danger" onClick={() => window.location.assign(`/?path=${encodeURIComponent(file)}`)}>Discard</button>
                      <button type="button" className="btn" onClick={() => setPendingSwitch(null)}>Cancel</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="pop-sep" />
          <div className="pop-list">
            <button type="button" className="pop-row" onClick={() => { setSwitcherOpen(false); onNewTeam() }}>
              <Plus size={15} aria-hidden="true" />
              <span className="name t-body">New team…</span><span className="kbd t-mono-sm">⌘N</span>
            </button>
          </div>
          <div className="pop-sep" />
          {renaming !== null && onRename && (
            <form className="pop-inline t-meta" aria-label="Rename team" onSubmit={(event) => { event.preventDefault(); onRename(renaming); setRenaming(null) }}>
              <input className="input" autoFocus aria-label="Team name" value={renaming} onChange={(event) => setRenaming(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null) } }} style={{ flex: 1, minWidth: 0 }} />
              <button type="submit" className="btn btn-primary" disabled={!renaming.trim()}>Rename</button>
              <button type="button" className="btn" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          )}
          <div className="pop-foot">
            <span className="path t-mono-sm selectable">{path}</span>
            <span className="acts">
              {onRename && <button type="button" className="link" onClick={() => setRenaming(teamName ?? filename.replace(/\.ya?ml$/i, ''))}>Rename</button>}
              {onDelete && <button type="button" className="link alert" onClick={() => { setSwitcherOpen(false); onDelete() }} disabled={unsaved} title={unsaved ? 'Save or discard your changes first' : undefined}>Delete team…</button>}
              <button type="button" className="link" onClick={() => void navigator.clipboard?.writeText(path)}>Copy path</button>
              <button type="button" className="link" onClick={onShowYaml}>Show YAML</button>
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
            <span className="acts"><span className="pop-note t-meta">Next problem · F8 · Previous · ⇧F8</span></span>
          </div>
        </div>
      )}
    </div>
  )
}
