import { ArrowRight, MessageSquare, Asterisk, Square, Workflow } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Markdown } from '../ui/Markdown'

import type { WaitingOn } from '../../lib/runs/client'
import type { ExecutionMode } from '../../lib/team-file/useTeamDocument'
import type { RunPhase } from '../../lib/watch/events'

export type ComposerState =
  | { kind: 'answering'; waiting: WaitingOn; sending: boolean }
  | { kind: 'ready' }
  | { kind: 'dirty'; filename: string }
  | { kind: 'saving'; filename: string }
  | { kind: 'starting' }
  | { kind: 'blocked'; reason: string; action?: { label: string; run: () => void } }
  | { kind: 'busy'; phase: RunPhase }
  | { kind: 'terminal'; phase: RunPhase }
  | { kind: 'unavailable'; reason: string }

/**
 * Where a follow-up starts. `null` is the whole pipeline; a stage id starts there and replays the
 * earlier stages' stored handovers (Canvas B, decision 8).
 *
 * Team mode only ever offers `null`: `edges: []` means there is no configured order, so "from the
 * third agent" is not something the file expresses — and the daemon refuses it.
 */
export type FollowUpTarget = string | null

export interface ComposerProps {
  compact?: boolean
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
  switchBanner?: boolean
  /**
   * The pipeline's stages **in order**, for the Follow up chooser. Empty in team mode, which then
   * offers only "whole pipeline".
   */
  followUpStages?: readonly { id: string; name: string }[]
  followUpTarget?: FollowUpTarget
  onFollowUpTargetChange?: (target: FollowUpTarget) => void
  /** Starts a follow-up of the run on screen, at [`followUpTarget`]. */
  onFollowUp?: () => void
  dirty?: boolean
  onAnswer?: (sendBack?: string) => void
  replyAgents?: readonly { id: string; name: string }[]
  onReply?: (agentId: string) => void
  replySending?: boolean
  reviewContext?: { label: string; text: string }
  /** Display names by agent id, so buttons say "Send back to Researcher", not an id. */
  agentNames?: ReadonlyMap<string, string>
  note?: ReactNode
  children?: ReactNode
}

// TNG89 §1: 720 × 56, bottom-centre. It absorbs the mode pill: the pill says how the document
// will execute, and that fact is worth most at the moment you execute it. The pill is a label,
// not a button — the popover it once opened explained tool names and guard limits an operator
// never needs, and the canvas already numbers the steps (CANVAS_SPEC §8.1).
// ↵ sends and ⇧↵ inserts a newline, the convention of every chat app an operator already uses;
// ⌘↵ also sends. There is no "run without saving".
export function Composer({ compact = false, mode, stepCount, anomalyCount = 0, state, value, onChange, onSubmit, onStop, onRetry, onNewRun, switchBanner, followUpStages = [], followUpTarget = null, onFollowUpTargetChange, onFollowUp, dirty = false, onAnswer, replyAgents = [], onReply, replySending = false, reviewContext, agentNames, note, children }: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const element = panel.current
    const shell = element?.closest<HTMLElement>('.lw-shell')
    if (!element || !shell || typeof ResizeObserver === 'undefined') return
    const measure = () => shell.style.setProperty('--lw-composer-height', `${Math.max(56, element.getBoundingClientRect().height)}px`)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => { observer.disconnect(); shell.style.removeProperty('--lw-composer-height') }
  }, [])
  const answering = state.kind === 'answering' ? state : null
  // At a review stop the box is where the operator writes a note, so it looks and reads like a field.
  const reviewing = answering?.waiting.kind === 'review_stop'
  const busy = state.kind === 'busy'
  const [replyTarget, setReplyTarget] = useState('')
  const replyTo = busy ? replyAgents.find((agent) => agent.id === replyTarget) : null
  const terminal = state.kind === 'terminal'
  const disabled = answering?.sending || replySending || (busy && !replyTo) || state.kind === 'saving' || state.kind === 'starting' || state.kind === 'unavailable'

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
  const modeLabel = mode === 'pipeline' ? `${stepCount} step${stepCount === 1 ? '' : 's'} in order` : 'Lead agent delegates'
  const modeHint = mode === 'pipeline'
    ? 'Your agents work one after another, in the order you connected them. Each one picks up where the last one left off.'
    : 'Your lead agent gets the request and decides who else to bring in.'
  // "When the Output arrives the composer does not go dark. It offers Follow up." Available only
  // on a terminal run, because a follow-up is a child of a run that is over.
  const canFollowUp = terminal && onFollowUp !== undefined
  const submit = onSubmit
  const newRun = onNewRun
  const followUp = () => onFollowUp?.()
  const targetName = followUpTarget
    ? followUpStages.find((stage) => stage.id === followUpTarget)?.name ?? followUpTarget
    : null
  // The one-line composer is for asking. Once a run is over the operator has real choices —
  // follow up, redo from a step, retry, reopen another run — so the full composer comes back
  // with every one of them on screen, as the README promises, instead of a lone arrow.
  const slim = compact && !answering && !replyTo && !canFollowUp

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const modified = event.metaKey || event.ctrlKey
    // A plain ↵ sends unless an IME is composing (Japanese, Vietnamese Telex…), where ↵ commits
    // the candidate text instead; ⇧↵ and ⌥↵ fall through and insert a newline.
    const plainEnter = event.key === 'Enter' && !modified && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
    if ((modified && event.key === 'Enter') || plainEnter) {
      event.preventDefault()
      // ↵ sends the follow-up when there is one to send: it is the primary action once the
      // composer is in follow-up mode, and Retry stays reachable by its own button.
      if (replyTo && !replySending && value.trim()) onReply?.(replyTo.id)
      else if (answering && !answering.sending && value.trim()) onAnswer?.()
      else if (canFollowUp && value.trim()) followUp()
      // Re-running with nothing typed is only ever deliberate: ⌘↵, never a stray ↵.
      else if (terminal && !value.trim() && modified) onRetry()
      else if (terminal && value.trim()) newRun()
      else if (canSubmit) submit()
    }
    // §1.2: Esc blurs, which collapses the grown input above. It is handled here rather than in
    // the workspace's Escape chain so that dismissing the composer never also clears a selection.
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.currentTarget.blur()
    }
  }

  let action: ReactNode
  if (replyTo) {
    action = <>
      <button type="button" className="btn" onClick={() => setReplyTarget('')} disabled={replySending}>Cancel reply</button>
      <button type="button" className="btn btn-primary" disabled={replySending || !value.trim()} onClick={() => onReply?.(replyTo.id)}>{replySending ? 'Sending…' : 'Reply'} <kbd>↵</kbd></button>
    </>
  } else if (answering) {
    // A review stop can be approved as it stands: requiring a typed comment before "Continue" made
    // the most common answer — "looks good" — the hardest one to give. A question still needs one.
    const from = answering.waiting.handoverFrom
    action = <>
      {answering.waiting.sendBackAvailable && from && <button type="button" className="btn" disabled={answering.sending || !value.trim()} title={value.trim() ? undefined : 'Type what should change first.'} onClick={() => onAnswer?.(from)}>Send back to {agentNames?.get(from) ?? from}</button>}
      <button type="button" className="btn btn-primary" disabled={answering.sending || (!reviewing && !value.trim())} onClick={() => onAnswer?.()}>{answering.sending ? 'Sending…' : reviewing ? (value.trim() ? 'Continue' : 'Approve') : 'Reply'}{(!reviewing || value.trim()) && <kbd>↵</kbd>}</button>
      <button type="button" className="btn btn-danger" onClick={onStop}>Stop</button>
    </>
  } else if (busy) {
    const label = state.phase === 'queued' ? 'Queued…' : state.phase === 'starting' ? 'Starting…' : 'Running…'
    action = <>
      <button type="button" className="btn" disabled>{label}</button>
      <button type="button" className="btn btn-danger" onClick={onStop} title="Stop this run. The prompt and every accepted event are kept."><Square size={12} aria-hidden="true" /> Stop</button>
    </>
  } else if (terminal) {
    action = <>
      <button type="button" className="btn" onClick={onRetry} title="Run the original request again from scratch">Retry</button>
      {canFollowUp
        ? <button type="button" className="btn btn-primary" onClick={followUp} disabled={!value.trim()} title={value.trim() ? undefined : 'Type what to change first.'}>{dirty ? 'Save & follow up' : 'Follow up'} <kbd>↵</kbd></button>
        : <button type="button" className="btn btn-primary" onClick={newRun} disabled={!value.trim()} title={value.trim() ? undefined : 'Type a new goal first.'}>New run</button>}
    </>
  } else if (state.kind === 'saving') {
    action = <button type="button" className="btn" disabled>Saving…</button>
  } else if (state.kind === 'starting') {
    // §1.6: "The button shows `Starting…`, disabled." The save step and the start step are two
    // steps, and §1.4 requires they stay legible as two.
    action = <button type="button" className="btn" disabled>Starting…</button>
  } else if (state.kind === 'dirty') {
    action = <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>Save &amp; run <kbd>↵</kbd></button>
  } else if (state.kind === 'blocked' || state.kind === 'unavailable') {
    action = <>
      {state.kind === 'blocked' && state.action && <button type="button" className="btn" onClick={state.action.run}>{state.action.label}</button>}
      <button type="button" className="btn btn-primary" disabled title={state.reason}>Run <kbd>↵</kbd></button>
    </>
  } else {
    action = <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit} title={canSubmit ? undefined : 'Type what the team should do.'}>Run <kbd>↵</kbd></button>
  }

  let noteNode: ReactNode = note
  let noteClass = ''
  if (!noteNode) {
    if (replyTo) noteNode = `Reply to ${replyTo.name}. This is another turn in its current session.`
    else if (answering) noteNode = answering.waiting.kind === 'review_stop' ? 'Your turn: approve to let the team continue, or type what should change. Anything you type is passed on as your direction.' : answering.waiting.park === 'released' ? `Reply to ${answering.waiting.name}. Its session was released; your answer starts a new run from its checkpoint.` : `Reply to ${answering.waiting.name}. Your answer arrives as its next turn.`
    else if (busy) noteNode = 'Connection loss never starts, restarts or cancels a run.'
    // One line explaining the chosen target, because "from Writer" and "whole pipeline" cost
    // different amounts and the operator is choosing between them.
    else if (canFollowUp && targetName) noteNode = `Starts again at ${targetName}, reusing what the earlier steps handed over. Retry runs the original request from scratch.`
    else if (canFollowUp) noteNode = 'Runs every step again, building on this answer. Retry runs the original request from scratch.'
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
      <div ref={panel} className={`panel bottom cx e1 lw-composer ${slim ? 'prototype-composer' : ''} ${focused ? 'focused' : ''} ${switchBanner ? 'mode-switch' : ''} ${answering || replyTo || canFollowUp ? 'expanded-actions' : ''}`} role="group" aria-label="Prompt composer" data-tour="composer">
        {slim && <MessageSquare className="composer-message-icon" size={17} />}
        {/* One agent has nothing to order and no one to delegate to, so the chip would say nothing true. */}
        {stepCount > 1 && <span className={`mode-chip mode-summary t-body-m ${mode}`} title={modeHint}>
          <span className="glyph" aria-hidden="true">{mode === 'pipeline' ? <Workflow size={15} /> : <Asterisk size={15} />}</span>
          <span className="label">{modeLabel}</span>
          {anomalyCount > 0 && <span className="anomaly t-micro" title={`In the last run, an agent passed work to someone it isn’t connected to (${anomalyCount} time${anomalyCount === 1 ? '' : 's'}). The Run view marks where.`}>⚠ {anomalyCount}</span>}
        </span>}
        {/* The follow-up target chooser, beside the chips that explain what the run is made of.
            Stages are listed in pipeline order; team mode has no order, so it gets one option. */}
        {canFollowUp && (
          <label className="mode-chip t-body-m" title="Which step the follow-up starts from">
            <span className="label">Redo from:</span>
            <select
              aria-label="Follow up target"
              value={followUpTarget ?? ''}
              onChange={(event) => onFollowUpTargetChange?.(event.target.value || null)}
            >
              <option value="">the beginning</option>
              {followUpStages.map((stage) => (
                <option key={stage.id} value={stage.id}>{stage.name}</option>
              ))}
            </select>
          </label>
        )}
        {busy && replyAgents.length > 0 && <label className="mode-chip t-body-m">
          <select aria-label="Reply to agent" value={replyTo?.id ?? ''} disabled={replySending} onChange={(event) => setReplyTarget(event.target.value)}>
            <option value="">Reply to…</option>
            {replyAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>}
        <div className="comp-mid">
          {/* A handover is the stage's own Markdown, read here before deciding, as answers are. */}
          {reviewContext && <details className="operator-context">
            <summary>{reviewContext.label}</summary><div className="operator-context-text"><Markdown>{reviewContext.text}</Markdown></div>
          </details>}
          <textarea
            ref={textarea}
            rows={1}
            className={reviewing ? 'comp-field' : undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={disabled}
            aria-label={replyTo ? `Reply to ${replyTo.name}` : reviewing ? 'Your note to the team' : answering ? `Answer to ${answering.waiting.name}` : 'What should the team do?'}
            placeholder={replyTo ? 'What would you like to ask?' : reviewing ? 'Type what should change, or leave empty to approve as is' : answering ? answering.waiting.question : busy ? 'A run is in flight…' : canFollowUp ? 'What should change?' : terminal ? 'Type a new goal, or Retry the last one' : 'What should the team do?'}
          />
          {noteNode && <span className={`comp-note t-meta ${noteClass}`} role={noteClass === 'err' ? 'alert' : undefined}>{noteNode}</span>}
        </div>
        <div className="comp-act">
          {slim && !busy && (state.kind === 'ready' || state.kind === 'dirty') ? <button type="button" className="iconbtn prototype-send" aria-label="Run team" disabled={!canSubmit} onClick={submit}><ArrowRight size={17} /></button> : action}
        </div>
      </div>
    </>
  )
}
