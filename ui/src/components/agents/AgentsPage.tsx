import { useMemo, useState, type ReactNode } from 'react'
import { Plus, UserRound } from '../ui/icon'

import { modelNameFromId } from '../../lib/ai/modelIds'
import type { DetectedCapability } from '../../lib/library/client'
import { draftFromJob } from '../../lib/library/draft'
import { figureFor } from '../../lib/library/figures'
import { useSavedJobs } from '../../lib/library/jobs'
import { usePinnedAgent } from '../../lib/library/pinned'
import { modelForPreset, ROLE_PRESETS } from '../../lib/library/roles'
import { useAgentUses } from '../../lib/library/uses'
import { useRunRecords } from '../../lib/story/useNeedsYou'
import { KnowYou } from '../you/KnowYou'
import { AgentTile } from './AgentTile'
import { AgentBuilder } from './AgentBuilder'
import { AgentChip } from './AgentChip'
import { AgentFrame, type AgentBarSlots } from './AgentFrame'
import { navigate, useAgentsRoute } from './route'
import { SectionHead } from '../ui/SectionHead'

export interface AgentsPageProps {
  skills: DetectedCapability[]
  skillsLoading: boolean
  /** The bell in an agent's header, as a team's has it: what waits on you. */
  tray?: ReactNode
}

/**
 * Your agents: build an agent once, work with it in its own chat, then use it in any team. Each team keeps the
 * version it was given until someone chooses Update in that team, so changing an agent here never
 * changes a team behind its back.
 */
export function AgentsPage(props: AgentsPageProps) {
  const route = useAgentsRoute()
  const { tray, ...builder } = props
  // Where the agent on screen puts its name chip and tabs in the header.
  const [slots, setSlots] = useState<AgentBarSlots>(NO_SLOTS)
  if (route.kind !== 'list') {
    // An agent's page, or a new one's: the header, then the page, beside the dock.
    const starting = route.kind === 'new' && !route.from
    return (
      <AgentFrame tray={tray} chip={starting ? <AgentChip name="New agent" state="new" detail="Start from a job" /> : undefined} onSlots={setSlots}>
        <main className="home-main agents-main">
          {starting
            ? <AgentTemplates team={route.team} />
            : <AgentBuilder key={route.kind === 'agent' ? route.id : `new-${route.from ?? ''}`} id={route.kind === 'agent' ? route.id : null} startFrom={route.kind === 'new' ? route.from : null} cameFrom={route.team} view={route.view} run={route.kind === 'agent' ? route.run : null} bar={slots} {...builder} />}
        </main>
      </AgentFrame>
    )
  }
  return (
    <div className="lw-home lw-agents" data-tour="agents">
      <div className="ground" aria-hidden="true" />
      <main className="home-main agents-main"><AgentsList /></main>
    </div>
  )
}

const NO_SLOTS: AgentBarSlots = { chip: null, tabs: null }


/**
 * Where building an agent starts: a job to start from, with working instructions on the model its
 * kind of work suits, or Blank. The jobs are templates for Your agents. A team's canvas has none of
 * its own, so an agent is built and tried here before a team depends on it.
 */
function AgentTemplates({ team }: { team: string | null }) {
  const start = (from: string) => navigate(`/agents/new?${new URLSearchParams({ from, ...(team ? { team } : {}) })}`)
  return (
    <>
      <section className="home-hero agents-hero">
        <SectionHead page as="h1" className="t-display" title="Build an agent" explain="Start from a job: it comes with working instructions, on the model its kind of work suits, and you can change all of it. Or start blank and write your own." />
        {team && <a className="link agent-back" href={`/?path=${encodeURIComponent(team)}`}>Back to the team</a>}
      </section>
      <section className="agents-start" aria-labelledby="agents-start-title" data-tour="agent-start">
        <h2 id="agents-start-title">Start from a job</h2>
        <ul className="agents-start-grid">
          {ROLE_PRESETS.map((preset) => (
            <li key={preset.id}><button type="button" className="agents-start-card" onClick={() => start(preset.id)}><b>{preset.label}</b><span>{preset.does}</span><em>on {modelNameFromId(modelForPreset(preset).model)}</em></button></li>
          ))}
          <li><button type="button" className="agents-start-card blank" onClick={() => start('blank')}><b>Blank</b><span>Write the instructions yourself</span></button></li>
        </ul>
      </section>
    </>
  )
}

function AgentsList() {
  const { jobs, problems, available, loaded, error } = useSavedJobs()
  const { uses } = useAgentUses()
  const { pinned } = usePinnedAgent()
  // The one shared poll (round 3): what each agent is doing in its own chat lights its figure.
  const { records } = useRunRecords()
  const usage = useMemo(() => {
    const byAgent = new Map<string, { teams: number; scheduled: number }>()
    for (const job of jobs) byAgent.set(job.id, { teams: 0, scheduled: 0 })
    for (const use of uses ?? []) {
      const entry = byAgent.get(use.agent)
      if (!entry) continue
      entry.teams += 1
      if (use.scheduled) entry.scheduled += 1
    }
    return byAgent
  }, [jobs, uses])
  const open = (to: string) => navigate(to)
  return (
    <>
      <section className="home-hero agents-hero">
        <SectionHead page as="h1" className="t-display" title="My agents" explain="Build an agent once and work with it in its own chat. Then add it to any team: it is the same agent in every team it’s in. Under each agent, a mark with a check is something it may do without asking; a dashed one, it asks you first." />
        <KnowYou />
        <div className="home-hero-acts">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => open('/agents/new')} data-tour="new-agent"><Plus size={16} aria-hidden="true" />New agent</button>
        </div>
      </section>


      <section className="home-teams" aria-labelledby="agents-title">
        <div className="home-teams-head"><h2 id="agents-title">My agents</h2></div>
        {!available && <p role="alert" className="home-empty alert">This LoomWatch server is older than My agents. Restart it to use them.</p>}
        {error && <p role="alert" className="home-empty alert">Couldn’t list your agents. {error}</p>}
        {available && !loaded && <p role="status" className="home-empty">Loading your agents…</p>}
        {available && loaded && jobs.length === 0 && (
          <div className="home-empty"><UserRound size={20} aria-hidden="true" /><span>No agents yet. Press <b>New agent</b> to start from a job such as Researcher or Writer, or from a blank page.</span></div>
        )}
        {jobs.length > 0 && (
          <ul className="home-grid agents-grid">
            {jobs.map((job) => (
              <li key={job.id}>
                <button type="button" className="home-card agent-card" title={job.model ? `${job.name} · on ${modelNameFromId(job.model)}` : job.name} onClick={() => open(`/agents/${encodeURIComponent(job.id)}`)}>
                  <AgentTile id={job.id} figure={figureFor(job.id, job.figure)} draft={draftFromJob(job)} teams={usage.get(job.id)?.teams ?? 0} runs={records} pinned={pinned === job.id} />
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
