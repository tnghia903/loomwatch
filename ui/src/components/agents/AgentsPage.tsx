import { useMemo, useState } from 'react'
import { Moon, Plus, Sun, UserRound } from 'lucide-react'

import type { DetectedHarness } from '../../lib/harnesses'
import type { DetectedCapability } from '../../lib/library/client'
import { draftFromJob } from '../../lib/library/draft'
import { figureFor } from '../../lib/library/figures'
import { useSavedJobs, versionOf } from '../../lib/library/jobs'
import { ROLE_PRESETS } from '../../lib/library/roles'
import { useAgentUses } from '../../lib/library/uses'
import { useTheme } from '../../lib/theme'
import { QuestsLink } from '../quests/QuestsLink'
import { LoomMark } from '../ui/glyphs'
import { AgentBadge } from './AgentBadge'
import { AgentBuilder } from './AgentBuilder'
import { navigate, useAgentsRoute } from './route'

export interface AgentsPageProps {
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  skills: DetectedCapability[]
  tools: DetectedCapability[]
  skillsLoading: boolean
}

/**
 * Your agents: build an agent once, work with it in its own chat, then use it in any team. Each team keeps the
 * version it was given until someone chooses Update in that team, so changing an agent here never
 * changes a team behind its back.
 */
export function AgentsPage(props: AgentsPageProps) {
  const route = useAgentsRoute()
  const { resolved, toggle } = useTheme()
  return (
    <div className="lw-home lw-agents" data-tour="agents">
      <div className="ground" aria-hidden="true" />
      <header className="home-top">
        <a className="home-brand" href="/" aria-label="LoomWatch home"><LoomMark width={46} height={20} /><span>LoomWatch</span></a>
        <span className="home-top-acts">
          <QuestsLink />
          <a className="btn" href="/" data-tour="your-teams">Your teams</a>
          <button type="button" className="iconbtn" onClick={toggle} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}</button>
        </span>
      </header>
      <main className="home-main agents-main">
        {route.kind === 'list'
          ? <AgentsList harnesses={props.harnesses} />
          : <AgentBuilder key={route.kind === 'agent' ? route.id : `new-${route.from ?? ''}`} id={route.kind === 'agent' ? route.id : null} startFrom={route.kind === 'new' ? route.from : null} cameFrom={route.team} view={route.view} {...props} />}
      </main>
    </div>
  )
}

function AgentsList({ harnesses }: { harnesses: DetectedHarness[] }) {
  const { jobs, problems, available, loaded, error } = useSavedJobs()
  const { uses } = useAgentUses()
  const [choosing, setChoosing] = useState(false)
  const usage = useMemo(() => {
    const byAgent = new Map<string, { teams: number; scheduled: number; behind: number }>()
    for (const job of jobs) byAgent.set(job.id, { teams: 0, scheduled: 0, behind: 0 })
    for (const use of uses ?? []) {
      const entry = byAgent.get(use.agent)
      const job = jobs.find((candidate) => candidate.id === use.agent)
      if (!entry || !job) continue
      entry.teams += 1
      if (use.scheduled) entry.scheduled += 1
      if (use.version < versionOf(job)) entry.behind += 1
    }
    return byAgent
  }, [jobs, uses])
  const open = (to: string) => navigate(to)
  return (
    <>
      <section className="home-hero agents-hero">
        <h1 className="t-display">Your agents</h1>
        <p>Build an agent once and work with it in its own chat. Then add it to any team: each team keeps the version it was given until you update it there.</p>
        <div className="home-hero-acts">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => setChoosing((value) => !value)} aria-expanded={choosing} data-tour="new-agent"><Plus size={16} aria-hidden="true" />New agent</button>
        </div>
      </section>

      {choosing && (
        <section className="agents-start" aria-label="Start a new agent" data-tour="agent-start">
          <h2>Start from a job</h2>
          <p className="t-meta">Each job comes with working instructions you can change. Or start blank and write your own.</p>
          <ul className="agents-start-grid">
            {ROLE_PRESETS.map((preset) => (
              <li key={preset.id}><button type="button" className="agents-start-card" onClick={() => open(`/agents/new?from=${encodeURIComponent(preset.id)}`)}><b>{preset.label}</b><span>{preset.does}</span></button></li>
            ))}
            <li><button type="button" className="agents-start-card blank" onClick={() => open('/agents/new')}><b>Blank</b><span>Write the instructions yourself</span></button></li>
          </ul>
        </section>
      )}

      <section className="home-teams" aria-labelledby="agents-title">
        <div className="home-teams-head"><h2 id="agents-title">Your agents</h2></div>
        {!available && <p role="alert" className="home-empty alert">This LoomWatch server is older than Your agents. Restart it to use them.</p>}
        {error && <p role="alert" className="home-empty alert">Couldn’t list your agents. {error}</p>}
        {available && !loaded && <p role="status" className="home-empty">Loading your agents…</p>}
        {available && loaded && jobs.length === 0 && (
          <div className="home-empty"><UserRound size={20} aria-hidden="true" /><span>No agents yet. Start from a job above, or keep an agent that worked: select it in a team and choose <b>Add to Your agents</b>.</span></div>
        )}
        {jobs.length > 0 && (
          <ul className="home-grid agents-grid">
            {jobs.map((job) => (
              <li key={job.id}>
                <button type="button" className="home-card agent-card" onClick={() => open(`/agents/${encodeURIComponent(job.id)}`)}>
                  <AgentBadge compact markId={job.id} figure={figureFor(job.id, job.figure)} draft={draftFromJob(job)} harness={harnesses.find((harness) => harness.id === job.apps?.[0]) ?? null} version={versionOf(job)} usedIn={usage.get(job.id)} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {problems.map((problem) => <p key={problem.file} className="home-empty alert" title={problem.message}>Can’t read {problem.file}: {problem.message}</p>)}
      </section>
    </>
  )
}
