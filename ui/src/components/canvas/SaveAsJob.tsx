import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus } from 'lucide-react'

import { JobApiError, jobFromAgent, jobIdFor, saveJob } from '../../lib/library/jobs'
import type { AgentConfig } from '../../lib/team-file/types'

type Step =
  | { kind: 'closed' }
  | { kind: 'naming' }
  | { kind: 'replace'; id: string }
  | { kind: 'saving' }
  | { kind: 'saved'; name: string }

/**
 * "Save as job": keep an agent that worked — its instructions, app, model and skills — under
 * "Your jobs" in the palette, to place in any team later (ADR 0030).
 *
 * Saving reads the agent and writes only the job, so it works while the team itself is read-only.
 * It never overwrites silently. A name already in use asks before replacing, because the job
 * it would replace may be one the operator relies on.
 */
export function SaveAsJob({ agent, appId }: { agent: AgentConfig; appId?: string }) {
  const [step, setStep] = useState<Step>({ kind: 'closed' })
  const [name, setName] = useState(agent.name)
  const [does, setDoes] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The form opens at the foot of a scrolling panel; bring all of it, buttons included, into view.
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (step.kind === 'naming' || step.kind === 'replace') form.current?.scrollIntoView?.({ block: 'nearest' })
  }, [step.kind])

  if (step.kind === 'closed' || step.kind === 'saved') {
    return <div className="save-job">
      <button className="btn" disabled={!agent.role.trim()} title={agent.role.trim() ? 'Keep these instructions, app, model and skills under Your jobs' : 'Write its instructions first'} onClick={() => { setName(agent.name); setDoes(''); setError(null); setStep({ kind: 'naming' }) }}><BookmarkPlus size={13} />Save as job</button>
      {step.kind === 'saved' && <p className="save-job-note" role="status">Saved “{step.name}” to Your jobs.</p>}
    </div>
  }

  const spec = () => jobFromAgent(agent, { name, does, appId })
  const save = async (replace: boolean) => {
    const id = jobIdFor(name)
    setError(null)
    setStep({ kind: 'saving' })
    try {
      const saved = await saveJob(id, spec(), { replace })
      setStep({ kind: 'saved', name: saved.name })
    } catch (failed) {
      if (failed instanceof JobApiError && failed.status === 412) {
        setStep({ kind: 'replace', id })
        return
      }
      // A server started before saved jobs existed has no such route until it is restarted.
      setError(failed instanceof JobApiError && failed.status === 404 ? 'This LoomWatch server is older than saved jobs. Restart it, then save again.' : failed instanceof Error ? failed.message : String(failed))
      setStep({ kind: 'naming' })
    }
  }
  const skills = spec().skills ?? []

  return <form ref={form} className="save-job-form" aria-label="Save as job" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void save(false) }}>
    <label>Job name<input value={name} autoFocus onChange={(event) => { setName(event.target.value); if (step.kind === 'replace') setStep({ kind: 'naming' }) }} maxLength={80} /></label>
    <label><span>What it does <span className="optional">optional</span></span><input value={does} onChange={(event) => setDoes(event.target.value)} placeholder="e.g. Drafts release notes" maxLength={120} /></label>
    <p className="save-job-note">Keeps its instructions{appId ? ', app and model' : ''}{skills.length ? ` and ${skills.length === 1 ? 'its skill' : `${skills.length} skills`}` : ''}. Teams already using it are not changed.</p>
    {error && <p role="alert">{error}</p>}
    {step.kind === 'replace'
      ? <div className="save-job-actions"><p role="alert">You already have a job called “{name.trim()}”. Replace it?</p><button type="button" className="btn btn-primary" onClick={() => void save(true)}>Replace</button><button type="button" className="btn" onClick={() => setStep({ kind: 'naming' })}>Keep both — rename</button></div>
      : <div className="save-job-actions"><button type="submit" className="btn btn-primary" disabled={!name.trim() || step.kind === 'saving'}>{step.kind === 'saving' ? 'Saving…' : 'Save job'}</button><button type="button" className="btn" onClick={() => setStep({ kind: 'closed' })}>Cancel</button></div>}
  </form>
}
