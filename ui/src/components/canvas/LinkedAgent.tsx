import { useEffect, useState } from 'react'
import { ArrowUpCircle, ExternalLink, Unlink } from 'lucide-react'

import { fetchJobVersions, type JobSpec, type JobVersion, type SavedJob } from '../../lib/library/jobs'
import { changedHere, type AgentLinkState } from '../../lib/library/link'
import type { AgentConfig } from '../../lib/team-file/types'

export interface LinkedAgentProps {
  agent: AgentConfig
  link: AgentLinkState
  readOnly?: boolean
  /** Write that version of the agent into this team: Update, or putting back the version it has.
      `previous` is the version it has, when known, so what only that version read is taken away. */
  onApply: (job: SavedJob, previous: JobSpec | null) => void
  /** Drop the link: the agent becomes this team's own, exactly as it is now. */
  onUnlink: () => void
  /** The open team, so Your agents can offer the way back to it. */
  teamPath?: string | null
  headClassName?: string
  /** Offer "Edit in Your agents"; off where that agent is already open below. */
  showEdit?: boolean
}

const list = (items: readonly string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * FROM YOUR AGENTS: the agent panel's side of the versioned link. Which agent this team copies,
 * an update when the agent changed in My agents, and what this team changed in its copy. Versions
 * stay behind the scenes: nobody reads a number.
 * The panel keeps the copied fields read-only while the link stands; editing happens in Your
 * agents, or here after "Make it this team's own".
 */
export function LinkedAgent({ agent, link, readOnly = false, onApply, onUnlink, teamPath, headClassName, showEdit = true }: LinkedAgentProps) {
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
  const putBack = pinned && link.job ? () => onApply({ ...pinned.spec, id, file: link.job!.file }, pinned.spec) : null

  return (
    <section className="build-context linked-agent" aria-label="From My agents">
      <div className={headClassName}>From My agents</div>
      <p className="linked-agent-line"><b>{name}</b>{link.job && !link.behind && changed.length === 0 && <span className="t-meta"> · up to date</span>}</p>
      {!link.job && <p className="t-meta">It is no longer in My agents. This team keeps its copy.</p>}
      {link.behind && link.latest !== null && (
        <div className="linked-agent-update">
          <p><b>Changed in My agents.</b>{notes.length > 0 ? ` ${notes.join(' · ')}` : ''}</p>
          <button type="button" className="btn btn-primary" disabled={readOnly} onClick={() => link.job && onApply(link.job, pinned?.spec ?? null)}><ArrowUpCircle size={13} aria-hidden="true" />Update</button>
        </div>
      )}
      {changed.length > 0 && (
        <div className="linked-agent-changed" role="status">
          <p>This team changed its {list(changed)} from the copy it was given.</p>
          {putBack && <button type="button" className="btn" disabled={readOnly} onClick={putBack}>Put it back</button>}
        </div>
      )}
      <div className="linked-agent-acts">
        {link.job && showEdit && <a className="btn" href={`/agents/${encodeURIComponent(id)}${teamPath ? `?team=${encodeURIComponent(teamPath)}` : ''}`}><ExternalLink size={13} aria-hidden="true" />Edit in My agents</a>}
        <button type="button" className="btn" disabled={readOnly} onClick={onUnlink} title="Keep it exactly as it is now, with no link to My agents"><Unlink size={13} aria-hidden="true" />Make it this team’s own</button>
      </div>
      <p className="t-meta linked-agent-note">Its name, instructions, app and model, skills and what it may do without asking come from My agents. Where it works, its knowledge and its place in this team stay this team’s own.</p>
    </section>
  )
}
