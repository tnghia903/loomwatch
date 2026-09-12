import { Asterisk, History, Square, Workflow } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { ExecutionMode } from '../../lib/team-file/useTeamDocument'
import type { RunPhase } from '../../lib/watch/events'

export type ComposerState =
  | { kind: 'ready' }
  | { kind: 'dirty'; filename: string }
  | { kind: 'saving'; filename: string }
  | { kind: 'starting' }
  | { kind: 'blocked'; reason: string; action?: { label: string; run: () => void } }
  | { kind: 'busy'; phase: RunPhase }
  | { kind: 'terminal'; phase: RunPhase }
  | { kind: 'unavailable'; reason: string }

export interface ComposerProps {
  mode: ExecutionMode
  stepCount: number
  anomalyCount?: number
  state: ComposerState
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  onRetry: () => void
  onNewRun: () => void
  onOpenMode: () => void
  onOpenHistory: () => void
  modeOpen: boolean
  historyOpen: boolean
  switchBanner?: boolean
  note?: ReactNode
  children?: ReactNode
}

// TNG89 §1: 720 × 56, bottom-centre. It absorbs the mode pill: the pill explains how the
// document will execute, and that fact is worth most at the moment you execute it.
// ⌘↵ submits; ↵ inserts a newline — goals are prose. There is no "run without saving".
export function Composer({ mode, stepCount, anomalyCount = 0, state, value, onChange, onSubmit, onStop, onRetry, onNewRun, onOpenMode, onOpenHistory, modeOpen, historyOpen, switchBanner, note, children }: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const busy = state.kind === 'busy'
  const terminal = state.kind === 'terminal'
  const disabled = busy || state.kind === 'saving' || state.kind === 'starting' || state.kind === 'unavailable'

  useEffect(() => {
    const element = textarea.current
    if (!element) return
    // §1.1: focused, the input grows to five 20px lines and then scrolls internally. §1.2: Esc
    // blurs and collapses it back to one line — the text is preserved, only the height is not,
    // so a dismissed composer stops occluding the canvas the operator dismissed it to see.
    if (!focused) { element.style.height = ''; return }
    element.style.height = 'auto'
    element.style.height = `${Math.min(100, element.scrollHeight)}px`
  }, [value, focused])

  const canSubmit = value.trim().length > 0 && (state.kind === 'ready' || state.kind === 'dirty')
  const modeLabel = mode === 'pipeline' ? `Pipeline · ${stepCount} step${stepCount === 1 ? '' : 's'}` : 'Team · self-organizing'

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (terminal && !value.trim()) onRetry()
      else if (terminal && value.trim()) onNewRun()
      else if (canSubmit) onSubmit()
    }
    // §1.2: Esc blurs, which collapses the grown input above. It is handled here rather than in
    // the workspace's Escape chain so that dismissing the composer never also clears a selection.
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.currentTarget.blur()
    }
  }

  let action: ReactNode
  if (busy) {
    const label = state.phase === 'queued' ? 'Queued…' : state.phase === 'starting' ? 'Starting…' : 'Running…'
    action = <>
      <button type="button" className="btn" disabled>{label}</button>
      <button type="button" className="btn btn-danger" onClick={onStop} title="Stop this run. The prompt and every accepted event are kept."><Square size={12} aria-hidden="true" /> Stop</button>
    </>
  } else if (terminal) {
    action = <>
      <button type="button" className="btn" onClick={onRetry} title="Start a new run from the same prompt">Retry <kbd>⌘↵</kbd></button>
      <button type="button" className="btn btn-primary" onClick={onNewRun} disabled={!value.trim()} title={value.trim() ? undefined : 'Type a new goal first.'}>New run</button>
    </>
  } else if (state.kind === 'saving') {
    action = <button type="button" className="btn" disabled>Saving…</button>
  } else if (state.kind === 'starting') {
    // §1.6: "The button shows `Starting…`, disabled." The save step and the start step are two
    // steps, and §1.4 requires they stay legible as two.
    action = <button type="button" className="btn" disabled>Starting…</button>
  } else if (state.kind === 'dirty') {
    action = <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={!canSubmit}>Save &amp; run <kbd>⌘↵</kbd></button>
  } else if (state.kind === 'blocked' || state.kind === 'unavailable') {
    action = <>
      {state.kind === 'blocked' && state.action && <button type="button" className="btn" onClick={state.action.run}>{state.action.label}</button>}
      <button type="button" className="btn btn-primary" disabled title={state.reason}>Run <kbd>⌘↵</kbd></button>
    </>
  } else {
    action = <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={!canSubmit} title={canSubmit ? undefined : 'Type what the team should do.'}>Run <kbd>⌘↵</kbd></button>
  }

  let noteNode: ReactNode = note
  let noteClass = ''
  if (!noteNode) {
    if (busy) noteNode = 'Connection loss never starts, restarts or cancels a run.'
    else if (terminal) noteNode = 'Retry starts a new run from the same prompt. The prompt and any partial answer are kept.'
    else if (state.kind === 'saving') noteNode = `Saving ${state.filename} — the run is created against the revision this write returns.`
    else if (state.kind === 'starting') noteNode = 'Starting the run on that revision — the prompt is kept until the run id comes back.'
    else if (state.kind === 'dirty') noteNode = `Saves ${state.filename} first, then runs that exact revision.`
    else if (state.kind === 'blocked') { noteNode = state.reason; noteClass = 'block' }
    else if (state.kind === 'unavailable') { noteNode = state.reason; noteClass = 'err' }
  }

  return (
    <>
      {children}
      <div className={`panel bottom cx e1 lw-composer ${focused ? 'focused' : ''} ${switchBanner ? 'mode-switch' : ''}`} role="group" aria-label="Prompt composer">
        <button type="button" className={`mode-chip t-body-m ${mode}`} onClick={onOpenMode} aria-haspopup="dialog" aria-expanded={modeOpen} title="How this team will execute">
          <span className="glyph" aria-hidden="true">{mode === 'pipeline' ? <Workflow size={15} /> : <Asterisk size={15} />}</span>
          <span className="label">{modeLabel}</span>
          {anomalyCount > 0 && <span className="anomaly t-micro" title={`${anomalyCount} observed delegation${anomalyCount === 1 ? '' : 's'} with no configured counterpart`}>⚠ {anomalyCount}</span>}
        </button>
        <div className="comp-mid">
          <textarea
            ref={textarea}
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={disabled}
            aria-label="What should the team do?"
            placeholder={busy ? 'A run is in flight…' : terminal ? 'Type a new goal, or Retry the last one' : 'What should the team do?'}
          />
          {noteNode && <span className={`comp-note t-meta ${noteClass}`} role={noteClass === 'err' ? 'alert' : undefined}>{noteNode}</span>}
        </div>
        <div className="comp-act">
          {action}
          <button type="button" className="iconbtn" onClick={onOpenHistory} aria-haspopup="dialog" aria-expanded={historyOpen} title="Run history — reopen a previous run (replay)" aria-label="Run history"><History size={16} aria-hidden="true" /></button>
        </div>
      </div>
    </>
  )
}
