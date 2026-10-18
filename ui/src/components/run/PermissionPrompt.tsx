import { ShieldQuestionMark } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'

import { useRevealOnArrival } from '../../lib/chat/follow'
import { answerPermission, MAX_PERMISSION_TEXT, type PermissionDecision, type PermissionRequest, type RunRecord } from '../../lib/runs/client'
import { autoNote, permissionDeadline, permissionSentence, permissionWhat } from '../../lib/runs/permissionRequests'
import type { AllowSwitch } from '../../lib/team-file/types'
import type { AlwaysAllowed } from '../../lib/tools/allow'
import { useNow } from '../../lib/useNow'

interface PermissionPromptProps {
  run: Pick<RunRecord, 'runId' | 'permissionRequests'>
  /**
   * "Always allow": switch it on for this agent in the team file (ADR 0037), or always allow that
   * one call of a connected tool (ADR 0069), as well as letting the rest of this run through.
   * Absent when the team cannot be changed from here, or for a request nothing covers.
   */
  onAlwaysAllow?: (agentId: string, what: AlwaysAllowed) => void
  /**
   * Shown as a message in the team's chat (ADR 0051) rather than floating over the screen: the
   * ask belongs to the piece of work it pauses.
   */
  inline?: boolean
  /** The run has more than one agent: offer "Allow for the whole team". */
  team?: boolean
  /** An answer was chosen here: the team's chat follows its newest work again. */
  onDecide?: () => void
}

const SWITCH_LABEL: Record<AllowSwitch, string> = { web: 'web', commands: 'commands', edits: 'file edits' }

/**
 * What an agent is waiting on you for, while its app waits (ADR 0040). The run used to refuse
 * these on the spot and the agent carried on without — a web search that "failed" because nobody
 * was asked. Now the app holds, this card asks, and whatever you choose is the answer it gets.
 *
 * Besides yes and no, you can change a command before it runs ("Edit, then allow"), or answer in
 * its place ("Answer instead"): the agent reads your words as what the tool returned.
 */
export function PermissionPrompt({ run, onAlwaysAllow, inline = false, team = false, onDecide }: PermissionPromptProps) {
  // Answered here, before the next poll of the run takes them off the record.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const open = (run.permissionRequests ?? []).filter((request) => !answered.has(request.id))
  if (open.length === 0) return null

  return (
    <section className={inline ? 'permission-prompt inline' : 'permission-prompt e2'} aria-label="Waiting for your permission" role="region">
      {open.map((request) => (
        <Ask key={request.id} request={request}>
          <PermissionActions
            runId={run.runId}
            request={request}
            team={team}
            onAlwaysAllow={onAlwaysAllow}
            onDecide={onDecide}
            // A request that timed out or was answered elsewhere is gone either way; say so and drop it.
            onAnswered={(id, failure) => { setAnswered((current) => new Set(current).add(id)); setError(failure) }}
          />
        </Ask>
      ))}
      {error && <p className="permission-error" role="alert">{error}</p>}
    </section>
  )
}

/** One request on the card. In the team's chat, a request that arrives is scrolled into view. */
function Ask({ request, children }: { request: PermissionRequest; children: ReactNode }) {
  const element = useRevealOnArrival<HTMLElement>()
  return (
    <article ref={element} className="permission-ask" aria-live="polite">
      <header>
        <ShieldQuestionMark size={18} aria-hidden="true" />
        <strong>{permissionSentence(request)}</strong>
      </header>
      <p className="permission-what" title={permissionWhat(request)}>{permissionWhat(request)}</p>
      {request.auto && <p className="permission-auto">{autoNote(request.auto)}</p>}
      {children}
    </article>
  )
}

interface PermissionActionsProps {
  runId: string
  request: PermissionRequest
  /** The run has more than one agent: offer "Allow for the whole team". */
  team?: boolean
  onAlwaysAllow?: (agentId: string, what: AlwaysAllowed) => void
  /** An answer was chosen, before it is sent. */
  onDecide?: () => void
  /** Sent, or refused because it was gone. Absent, these say so themselves. */
  onAnswered?: (requestId: string, failure: string | null) => void
}

/**
 * The answers to one request, and how long it waits for them: the card's, and the team chat's on
 * the message that asks (ADR 0051).
 */
export function PermissionActions({ runId, request, team = false, onAlwaysAllow, onDecide, onAnswered }: PermissionActionsProps) {
  const now = useNow(true)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ failure: string | null } | null>(null)
  // Writing a changed command, or an answer in its place, before sending it.
  const [writing, setWriting] = useState<'edit' | 'answer' | null>(null)
  const [text, setText] = useState('')
  const fieldId = useId()

  const answer = async (decision: PermissionDecision, words?: string) => {
    onDecide?.()
    setBusy(true)
    let failure: string | null = null
    try {
      await answerPermission(runId, request.id, decision, words)
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught)
    }
    setBusy(false)
    setSent({ failure })
    onAnswered?.(request.id, failure)
  }
  const always = () => {
    if (!onAlwaysAllow) return
    if (request.tool) onAlwaysAllow(request.agent, { tool: request.tool.server, call: request.tool.call, label: request.title })
    else if (request.switch) onAlwaysAllow(request.agent, request.switch)
    else return
    void answer('allow_run')
  }

  const write = (kind: 'edit' | 'answer') => {
    setText(kind === 'edit' ? request.edit?.value ?? '' : '')
    setWriting(kind)
  }

  if (sent) return sent.failure && !onAnswered ? <p className="permission-error" role="alert">{sent.failure}</p> : null
  if (writing) {
    const changing = writing === 'edit'
    const what = request.edit?.field === 'url' ? 'address' : 'command'
    return (
      <form className="permission-write" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void answer(writing, text.trim()) }}>
        <div className="field">
          <label className="t-meta" htmlFor={fieldId}>{changing ? `The ${what} to allow instead` : `Your answer to ${request.name}, in place of what it asked to do`}</label>
          {changing
            ? <input id={fieldId} className="input mono" value={text} maxLength={MAX_PERMISSION_TEXT} spellCheck={false} autoFocus onChange={(event) => setText(event.target.value)} />
            : <textarea id={fieldId} className="input" rows={3} value={text} maxLength={MAX_PERMISSION_TEXT} autoFocus placeholder="For example: use the copy in notes.md instead" onChange={(event) => setText(event.target.value)} />}
          <span className="hint t-meta">{changing
            ? `${request.name} runs it as you wrote it, this once.`
            : `Nothing runs. ${request.name} reads your answer and carries on.`}</span>
        </div>
        <div className="permission-acts">
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>{changing ? 'Allow it changed' : 'Send answer'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setWriting(null)}>Back</button>
        </div>
      </form>
    )
  }
  return (
    <>
      <p className="permission-note">{request.name} is paused until you answer. {permissionDeadline(request.expiresAt, now)}</p>
      <div className="permission-acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer('allow_once')}>Allow</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer('allow_run')} title={`Allow every ${request.title.toLowerCase()} request from ${request.name} until this run ends`}>Allow for this run</button>
        {team && (
          <button type="button" className="btn" disabled={busy} onClick={() => void answer('allow_team')} title={`Allow ${request.title} for every agent in this run, without asking, until the run ends. Other tools still ask.`}>Allow for the whole team</button>
        )}
        {request.tool && onAlwaysAllow && (
          <button type="button" className="btn" disabled={busy} onClick={always} title={`${request.name} may do “${request.title}” without asking from now on. Its other calls still ask. Take it back in its Tools block.`}>Always allow this</button>
        )}
        {!request.tool && request.switch && onAlwaysAllow && (
          <button type="button" className="btn" disabled={busy} onClick={always} title={`Switch on “${SWITCH_LABEL[request.switch]}” for ${request.name} in the team file, so later runs do not ask`}>Always allow {SWITCH_LABEL[request.switch]}</button>
        )}
        <button type="button" className="btn permission-deny" disabled={busy} onClick={() => void answer('deny')}>Deny</button>
      </div>
      <p className="permission-more">
        {request.edit && <><button type="button" className="link" disabled={busy} onClick={() => write('edit')}>Edit, then allow</button><span aria-hidden="true"> · </span></>}
        <button type="button" className="link" disabled={busy} onClick={() => write('answer')}>Answer instead</button>
      </p>
    </>
  )
}
