import { useEffect, useState } from 'react'
import { ArrowUpCircle, ExternalLink, Unlink } from 'lucide-react'

import { fetchJobVersions, type JobVersion, type SavedJob } from '../../lib/library/jobs'
import { changedHere, type AgentLinkState } from '../../lib/library/link'
import type { AgentConfig } from '../../lib/team-file/types'

export interface LinkedAgentProps {
  agent: AgentConfig
  link: AgentLinkState
  readOnly?: boolean
  /** Write that version of the agent into this team: Update, or putting back the version it has. */
  onApply: (job: SavedJob) => void
  /** Drop the link: the agent becomes this team's own, exactly as it is now. */
  onUnlink: () => void
  headClassName?: string
}

const list = (items: readonly string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * FROM YOUR AGENTS: the agent panel's side of the versioned link. Which agent and version this
 * team copies, a newer version when one is ready, and what this team changed since its version.
 * The panel keeps the copied fields read-only while the link stands; editing happens in Your
 * agents, or here after "Make it this team's own".
 */
export function LinkedAgent({ agent, link, readOnly = false, onApply, onUnlink, headClassName }: LinkedAgentProps) {
  const id = agent.from?.agent ?? ''
  const [versions, setVersions] = useState<JobVersion[] | null>(null)
  useEffect(() => {
    if (!link.job) return
    let cancelled = false
    fetchJobVersions(id).then((found) => { if (!cancelled) setVersions(found) }, () => { if (!cancelled) setVersions([]) })
    return () => { cancelled = true }
  }, [id, link.job, link.latest])
  const pinned = versions?.find((version) => version.version === link.version) ?? null
  const changed = pinned ? changedHere(agent, pinned.spec) : []
  const newer = (versions ?? []).filter((version) => version.version > link.version)
  const notes = newer.map((version) => version.note?.trim()).filter((note): note is string => Boolean(note))
  const name = link.job?.name ?? id
  const putBack = pinned && link.job ? () => onApply({ ...pinned.spec, id, file: link.job!.file }) : null

  return (
    <section className="build-context linked-agent" aria-label="From Your agents">
      <div className={headClassName}>From Your agents</div>
      <p className="linked-agent-line"><b>{name}</b> <span className="linked-agent-version">v{link.version}</span>{link.job && !link.behind && changed.length === 0 && <span className="t-meta"> · up to date</span>}</p>
      {!link.job && <p className="t-meta">It is no longer in Your agents. This team keeps its copy of v{link.version}.</p>}
      {link.behind && link.latest !== null && (
        <div className="linked-agent-update">
          <p><b>v{link.latest} is ready.</b>{notes.length > 0 ? ` ${notes.join(' · ')}` : ''}</p>
          <button type="button" className="btn btn-primary" disabled={readOnly} onClick={() => link.job && onApply(link.job)}><ArrowUpCircle size={13} aria-hidden="true" />Update to v{link.latest}</button>
        </div>
      )}
      {changed.length > 0 && (
        <div className="linked-agent-changed" role="status">
          <p>This team changed its {list(changed)} since v{link.version}.</p>
          {putBack && <button type="button" className="btn" disabled={readOnly} onClick={putBack}>Put back v{link.version}</button>}
        </div>
      )}
      <div className="linked-agent-acts">
        {link.job && <a className="btn" href={`/agents/${encodeURIComponent(id)}`}><ExternalLink size={13} aria-hidden="true" />Edit in Your agents</a>}
        <button type="button" className="btn" disabled={readOnly} onClick={onUnlink} title="Keep it exactly as it is now, with no link to Your agents"><Unlink size={13} aria-hidden="true" />Make it this team’s own</button>
      </div>
      <p className="t-meta linked-agent-note">Its name, instructions, app and model, skills and what it may do without asking come from Your agents. Where it works, its knowledge and its place in this team stay this team’s own.</p>
    </section>
  )
}
