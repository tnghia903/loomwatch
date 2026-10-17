import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus } from 'lucide-react'

import { JobApiError, jobFromAgent, jobIdFor, saveJob, versionOf } from '../../lib/library/jobs'
import type { AgentConfig, AgentLink } from '../../lib/team-file/types'

type Step =
  | { kind: 'closed' }
  | { kind: 'naming' }
  | { kind: 'replace'; id: string }
  | { kind: 'saving' }
  | { kind: 'saved'; name: string; version: number; linked: boolean }

/**
 * "Add to Your agents": keep an agent that worked — its instructions, app, model, skills and what
 * it may do without asking — as one of Your agents, to build on and place in any team.
 *
 * Saving writes only Your agents. When the team can be edited, this agent then links to the
 * version it made (`onLinked`), which the team keeps once it is saved. A name already in use asks
 * first: saving under it makes that agent's next version, and teams using it change only when
 * someone chooses Update there.
 */
export function SaveAsJob({ agent, onLinked }: { agent: AgentConfig; onLinked?: (link: AgentLink) => void }) {
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
      <button className="btn" disabled={!agent.role.trim()} title={agent.role.trim() ? 'Keep this agent under Your agents, to build on and use in any team' : 'Write its instructions first'} onClick={() => { setName(agent.name); setDoes(''); setError(null); setStep({ kind: 'naming' }) }}><BookmarkPlus size={13} />Add to Your agents</button>
      {step.kind === 'saved' && <p className="save-job-note" role="status">Added “{step.name}” to Your agents as v{step.version}.{step.linked ? ' This agent now follows it. Save the team to keep the link.' : ''}</p>}
    </div>
  }

  const spec = () => jobFromAgent(agent, { name, does })
  const save = async (replace: boolean) => {
    const id = jobIdFor(name)
    setError(null)
    setStep({ kind: 'saving' })
    try {
      const saved = await saveJob(id, spec(), { replace })
      const version = versionOf(saved)
      onLinked?.({ agent: saved.id, version })
      setStep({ kind: 'saved', name: saved.name, version, linked: Boolean(onLinked) })
    } catch (failed) {
      if (failed instanceof JobApiError && failed.status === 412) {
        setStep({ kind: 'replace', id })
        return
      }
      // A server started before saved jobs existed has no such route until it is restarted.
      setError(failed instanceof JobApiError && failed.status === 404 ? 'This LoomWatch server is older than Your agents. Restart it, then save again.' : failed instanceof Error ? failed.message : String(failed))
      setStep({ kind: 'naming' })
    }
  }
  const skills = spec().skills ?? []

  const allowed = Object.values(agent.allow ?? {}).some(Boolean)
  return <form ref={form} className="save-job-form" aria-label="Add to Your agents" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void save(false) }}>
    <label>Name in Your agents<input value={name} autoFocus onChange={(event) => { setName(event.target.value); if (step.kind === 'replace') setStep({ kind: 'naming' }) }} maxLength={80} /></label>
    <label><span>What it does <span className="optional">optional</span></span><input value={does} onChange={(event) => setDoes(event.target.value)} placeholder="e.g. Drafts release notes" maxLength={120} /></label>
    <p className="save-job-note">Keeps its instructions{agent.model ? ', model' : ''}{skills.length ? `, ${skills.length === 1 ? 'its skill' : `${skills.length} skills`}` : ''}{allowed ? ' and what it may do without asking' : ''}. You can build on it in Your agents and add it to any team.</p>
    {error && <p role="alert">{error}</p>}
    {step.kind === 'replace'
      ? <div className="save-job-actions"><p role="alert">You already have an agent called “{name.trim()}”. Save this as its next version? Teams using it change only when you choose Update in them.</p><button type="button" className="btn btn-primary" onClick={() => void save(true)}>Save as next version</button><button type="button" className="btn" onClick={() => setStep({ kind: 'naming' })}>Keep both — rename</button></div>
      : <div className="save-job-actions"><button type="submit" className="btn btn-primary" disabled={!name.trim() || step.kind === 'saving'}>{step.kind === 'saving' ? 'Saving…' : 'Add'}</button><button type="button" className="btn" onClick={() => setStep({ kind: 'closed' })}>Cancel</button></div>}
  </form>
}
