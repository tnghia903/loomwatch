import { useMemo, useState, type MouseEvent } from 'react'

import { jobFigure, stateOf } from '../../lib/library/figures'
import { useSavedJobs, type SavedJob } from '../../lib/library/jobs'
import { agentPresence } from '../../lib/rail/presence'
import { useRunRecords } from '../../lib/story/useNeedsYou'
import { stateLabel } from '../../lib/state/words'
import { Search } from '../ui/icon'
import { FIND_FROM } from '../canvas/TeamSwitch'
import { FigureStill } from './FigureStill'
import { agentHref, type AgentView } from './route'

export interface AgentSwitchProps {
  /** The agent on screen, by its id; null for a new one not saved yet. */
  open: string | null
  /** The tab on screen, which the next agent opens on too. */
  view: AgentView
  /** Go to the agent at `href`; null is the agent on screen, which only closes the menu. */
  onPick: (href: string | null) => void
}

/**
 * Every one of My agents, in an agent's name menu, as a team's name menu lists the other teams
 * (TeamSwitch): each on its line with its figure, lit as it is (ready, at work, waiting for you), its
 * name, and what it is doing or what it does. A pick opens that agent on the tab on screen, so the
 * chat stays the chat. From FIND_FROM agents on, a box finds one by its name or what it does.
 */
export function AgentSwitch({ open, view, onPick }: AgentSwitchProps) {
  const { jobs, loaded } = useSavedJobs()
  const { records } = useRunRecords()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? jobs.filter((job) => `${job.name} ${job.does ?? ''}`.toLowerCase().includes(needle)) : jobs
  }, [jobs, query])

  // Nothing else to go to: the chip already names the agent on screen.
  if (loaded && jobs.filter((job) => job.id !== open).length === 0) return null
  const pick = (job: SavedJob) => onPick(job.id === open ? null : agentHref(job.id, view))
  // A plain click moves here; a click that asks for a new tab or window gets one.
  const follow = (event: MouseEvent<HTMLAnchorElement>, job: SavedJob) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    pick(job)
  }
  return (
    <nav className="team-switch agent-switch" aria-label="My agents">
      {jobs.length >= FIND_FROM && (
        <div className="pop-search">
          <Search size={15} aria-hidden="true" />
          <input
            autoFocus placeholder="Find an agent" aria-label="Find an agent" value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const first = shown[0]
              if (event.key === 'Enter' && first) { event.preventDefault(); pick(first) }
            }}
          />
        </div>
      )}
      <div className="pop-list team-switch-list">
        {!loaded && <p className="pop-empty t-meta">Finding your agents…</p>}
        {loaded && shown.length === 0 && <p className="pop-empty t-meta">No agent matches.</p>}
        {shown.length > 0 && (
          <ul aria-label="My agents">
            {shown.map((job) => {
              const presence = agentPresence(records, job.id)
              const line = presence === 'ready' ? job.does?.trim() || null : stateLabel(presence)
              return (
                <li key={job.id}>
                  <a className="room-card-team" href={agentHref(job.id, view)} aria-current={job.id === open ? 'page' : undefined} onClick={(event) => follow(event, job)}>
                    {/* Its name is beside it, so the figure says nothing more; its glow is how it is. */}
                    <span className="desk-figure agent-switch-figure" data-glow={presence} aria-hidden="true">
                      <FigureStill figure={jobFigure(job)} state={stateOf(presence)} alt="" width={28} height={28} loading="lazy" decoding="async" />
                    </span>
                    <span className="room-card-team-words">
                      <b>{job.name}</b>
                      {line && <small className={`room-state ${presence}`}>{line}</small>}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </nav>
  )
}
