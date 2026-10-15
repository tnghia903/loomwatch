import { ArrowRight, Plus, UserRound } from 'lucide-react'

import { useSavedJobs, versionOf } from '../../lib/library/jobs'
import { AgentMark } from '../ui/AgentMark'

/**
 * Home's row of Your agents: the way in to building one agent at a time. It stays one row, after
 * the teams, so the first run is still "New team"; it is there for the people who come back.
 */
export function YourAgentsShelf() {
  const { jobs, available, loaded } = useSavedJobs()
  if (!available) return null
  return (
    <section className="home-teams home-agents" aria-labelledby="home-agents-title">
      <div className="home-teams-head">
        <h2 id="home-agents-title">Your agents</h2>
        <a className="link home-agents-all" href="/agents">{jobs.length > 0 ? 'All agents' : 'Open Your agents'}<ArrowRight size={14} aria-hidden="true" /></a>
      </div>
      {loaded && jobs.length === 0 && (
        <div className="home-empty"><UserRound size={20} aria-hidden="true" /><span>Build an agent once, try it on its own, and use it in any team. <a href="/agents/new">Build your first agent</a></span></div>
      )}
      {jobs.length > 0 && (
        <ul className="home-agents-row">
          {jobs.slice(0, 6).map((job) => (
            <li key={job.id}><a className="home-agent-chip" href={`/agents/${encodeURIComponent(job.id)}`}><AgentMark id={job.id} name={job.name} size={20} animate={false} /><b>{job.name}</b><span>v{versionOf(job)}</span></a></li>
          ))}
          <li><a className="home-agent-chip new" href="/agents/new"><Plus size={14} aria-hidden="true" />New agent</a></li>
        </ul>
      )}
    </section>
  )
}
