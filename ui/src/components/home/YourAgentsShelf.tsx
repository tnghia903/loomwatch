import { ArrowRight, Plus, UserRound } from 'lucide-react'

import { figureFor } from '../../lib/library/figures'
import { FigureStill } from '../agents/FigureStill'
import { useSavedJobs, versionOf } from '../../lib/library/jobs'

/**
 * Home's row of Your agents: the first step of the work, so it comes before the teams. Each agent
 * is built and tried on its own here, then put in a team's workflow.
 */
export function YourAgentsShelf() {
  const { jobs, available, loaded } = useSavedJobs()
  if (!available) return null
  return (
    <section className="home-teams home-agents" aria-labelledby="home-agents-title">
      <div className="home-teams-head">
        <h2 id="home-agents-title">Your agents<span className="home-section-says">Build and try each one</span></h2>
        <a className="link home-agents-all" href="/agents">{jobs.length > 0 ? 'All agents' : 'Open Your agents'}<ArrowRight size={14} aria-hidden="true" /></a>
      </div>
      {loaded && jobs.length === 0 && (
        <div className="home-empty"><UserRound size={20} aria-hidden="true" /><span>Start here: build an agent once, chat with it on its own, then use it in any team. <a href="/agents/new">Build your first agent</a></span></div>
      )}
      {jobs.length > 0 && (
        <ul className="home-agents-row">
          {jobs.slice(0, 6).map((job) => (
            // Coming back from Home is coming back to use the agent, so it opens on its chat (a newcomer
            // test went to Build and had to look for Chat); Build is the tab beside it.
            <li key={job.id}><a className="home-agent-chip" href={`/agents/${encodeURIComponent(job.id)}?view=chat`}><FigureStill className="home-agent-figure" figure={figureFor(job.id, job.figure)} headOnly alt="" width={30} height={30} loading="lazy" decoding="async" /><b>{job.name}</b><span>v{versionOf(job)}</span></a></li>
          ))}
          <li><a className="home-agent-chip new" href="/agents/new"><Plus size={14} aria-hidden="true" />New agent</a></li>
        </ul>
      )}
    </section>
  )
}
