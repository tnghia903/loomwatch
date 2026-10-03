import { ShieldQuestionMark } from 'lucide-react'
import { useState } from 'react'

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
}

const SWITCH_LABEL: Record<AllowSwitch, string> = { web: 'web', commands: 'commands', edits: 'file edits' }

/**
 * What an agent is waiting on you for, while its app waits (ADR 0040). The run used to refuse
 * these on the spot and the agent carried on without — a web search that "failed" because nobody
 * was asked. Now the app holds, this card asks, and whatever you choose is the answer it gets.
 */
export function PermissionPrompt({ run, onAlwaysAllow }: PermissionPromptProps) {
  const now = useNow(true)
  // Answered here, before the next poll of the run takes them off the record.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = (run.permissionRequests ?? []).filter((request) => !answered.has(request.id))
  if (open.length === 0) return null

  const answer = async (request: PermissionRequest, decision: PermissionDecision) => {
    setBusy(request.id)
    setError(null)
    try {
      await answerPermission(run.runId, request.id, decision)
      setAnswered((current) => new Set(current).add(request.id))
    } catch (caught) {
      // A request that timed out or was answered elsewhere is gone either way; say so and drop it.
      setError(caught instanceof Error ? caught.message : String(caught))
      setAnswered((current) => new Set(current).add(request.id))
    } finally {
      setBusy(null)
    }
  }
  const always = (request: PermissionRequest) => {
    if (!request.switch || !onAlwaysAllow) return
    onAlwaysAllow(request.agent, request.switch)
    void answer(request, 'allow_run')
  }

  return (
    <section className="permission-prompt e2" aria-label="Waiting for your permission" role="region">
      {open.map((request) => (
        <article key={request.id} className="permission-ask" aria-live="polite">
          <header>
            <ShieldQuestionMark size={18} aria-hidden="true" />
            <strong>{permissionSentence(request)}</strong>
          </header>
          <p className="permission-what" title={permissionWhat(request)}>{permissionWhat(request)}</p>
          <p className="permission-note">{request.name} is paused until you answer. {permissionDeadline(request.expiresAt, now)}</p>
          <div className="permission-acts">
            <button type="button" className="btn btn-primary" disabled={busy === request.id} onClick={() => void answer(request, 'allow_once')}>Allow</button>
            <button type="button" className="btn" disabled={busy === request.id} onClick={() => void answer(request, 'allow_run')} title={`Allow every ${request.title.toLowerCase()} request from ${request.name} until this run ends`}>Allow for this run</button>
            {request.switch && onAlwaysAllow && (
              <button type="button" className="btn" disabled={busy === request.id} onClick={() => always(request)} title={`Switch on “${SWITCH_LABEL[request.switch]}” for ${request.name} in the team file, so later runs do not ask`}>Always allow {SWITCH_LABEL[request.switch]}</button>
            )}
            <button type="button" className="btn permission-deny" disabled={busy === request.id} onClick={() => void answer(request, 'deny')}>Deny</button>
          </div>
        </article>
      ))}
      {error && <p className="permission-error" role="alert">{error}</p>}
    </section>
  )
}
