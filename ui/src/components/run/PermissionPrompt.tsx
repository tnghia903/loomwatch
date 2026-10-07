import { ShieldQuestionMark } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { useRevealOnArrival } from '../../lib/chat/follow'
import { answerPermission, type PermissionDecision, type PermissionRequest, type RunRecord } from '../../lib/runs/client'
import { permissionDeadline, permissionSentence, permissionWhat } from '../../lib/runs/permissionRequests'
import type { AllowSwitch } from '../../lib/team-file/types'
import { useNow } from '../../lib/useNow'

interface PermissionPromptProps {
  run: Pick<RunRecord, 'runId' | 'permissionRequests'>
  /**
   * "Always allow": switch it on for this agent in the team file (ADR 0037) as well as letting the
   * rest of this run through. Absent when the team cannot be changed from here, or for a request
   * no switch covers.
   */
  onAlwaysAllow?: (agentId: string, key: AllowSwitch) => void
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
      {children}
    </article>
  )
}

interface PermissionActionsProps {
  runId: string
  request: PermissionRequest
  /** The run has more than one agent: offer "Allow for the whole team". */
  team?: boolean
  onAlwaysAllow?: (agentId: string, key: AllowSwitch) => void
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

  const answer = async (decision: PermissionDecision) => {
    onDecide?.()
    setBusy(true)
    let failure: string | null = null
    try {
      await answerPermission(runId, request.id, decision)
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught)
    }
    setBusy(false)
    setSent({ failure })
    onAnswered?.(request.id, failure)
  }
  const always = () => {
    if (!request.switch || !onAlwaysAllow) return
    onAlwaysAllow(request.agent, request.switch)
    void answer('allow_run')
  }

  if (sent) return sent.failure && !onAnswered ? <p className="permission-error" role="alert">{sent.failure}</p> : null
  return (
    <>
      <p className="permission-note">{request.name} is paused until you answer. {permissionDeadline(request.expiresAt, now)}</p>
      <div className="permission-acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer('allow_once')}>Allow</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer('allow_run')} title={`Allow every ${request.title.toLowerCase()} request from ${request.name} until this run ends`}>Allow for this run</button>
        {team && (
          <button type="button" className="btn" disabled={busy} onClick={() => void answer('allow_team')} title={`Allow ${request.title} for every agent in this run, without asking, until the run ends. Other tools still ask.`}>Allow for the whole team</button>
        )}
        {request.switch && onAlwaysAllow && (
          <button type="button" className="btn" disabled={busy} onClick={always} title={`Switch on “${SWITCH_LABEL[request.switch]}” for ${request.name} in the team file, so later runs do not ask`}>Always allow {SWITCH_LABEL[request.switch]}</button>
        )}
        <button type="button" className="btn permission-deny" disabled={busy} onClick={() => void answer('deny')}>Deny</button>
      </div>
    </>
  )
}
