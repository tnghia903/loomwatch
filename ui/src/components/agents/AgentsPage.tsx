import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Moon, Plus, Sun, UserRound } from 'lucide-react'

import { modelNameFromId } from '../../lib/ai/modelIds'
import type { DetectedCapability } from '../../lib/library/client'
import { draftFromJob } from '../../lib/library/draft'
import { figureFor } from '../../lib/library/figures'
import { useSavedJobs, versionOf } from '../../lib/library/jobs'
import { usePinnedAgent } from '../../lib/library/pinned'
import { modelForPreset, ROLE_PRESETS } from '../../lib/library/roles'
import { teamAgentHref, useAgentUses } from '../../lib/library/uses'
import { agentPresence } from '../../lib/rail/presence'
import type { RunRecord } from '../../lib/runs/client'
import type { LoomMarkState } from '../../lib/story/loomMark'
import { useTheme } from '../../lib/theme'
import { CrewRail, type LeaveGuard } from '../rail/CrewRail'
import { LoomMark, LoomWordmark } from '../ui/glyphs'
import { KnowYou } from '../you/KnowYou'
import { AgentBadge } from './AgentBadge'
import { AgentBuilder } from './AgentBuilder'
import { AgentChip } from './AgentChip'
import { AgentFrame, type AgentBarSlots } from './AgentFrame'
import { FigureStill } from './FigureStill'
import { navigate, useAgentsRoute, type AgentsRoute } from './route'

export interface AgentsPageProps {
  skills: DetectedCapability[]
  skillsLoading: boolean
  /** What the header's mark says, from the needs-you poll. */
  mark?: LoomMarkState
  /** Every run the daemon knows, from the same poll: what each agent in the rail is doing. */
  records?: readonly RunRecord[]
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
  const { resolved, toggle } = useTheme()
  const { records = NO_RUNS, tray, mark, ...builder } = props
  // What leaving the agent on screen would lose, kept by its builder and read by the rail.
  const leave = useRef<LeaveGuard | null>(null)
  // Where the agent on screen puts its name chip and tabs in the header.
  const [slots, setSlots] = useState<AgentBarSlots>(NO_SLOTS)
  if (route.kind !== 'list') {
    // An agent's page, or a new one's, in a team page's frame: the rail, the header, then the page.
    // The frame stays as you move between agents; only the agent in it changes.
    const starting = route.kind === 'new' && !route.from
    return (
      <AgentFrame mark={mark} tray={tray} rail={<AgentRail route={route} records={records} leave={() => leave.current} />} chip={starting ? <AgentChip name="New agent" state="new" detail="Start from a job" /> : undefined} onSlots={setSlots}>
        <main className="home-main agents-main">
          {starting
            ? <AgentTemplates team={route.team} />
            : <AgentBuilder key={route.kind === 'agent' ? route.id : `new-${route.from ?? ''}`} id={route.kind === 'agent' ? route.id : null} startFrom={route.kind === 'new' ? route.from : null} cameFrom={route.team} view={route.view} leaveRef={leave} bar={slots} {...builder} />}
        </main>
      </AgentFrame>
    )
  }
  return (
    <div className="lw-home lw-agents" data-tour="agents">
      <div className="ground" aria-hidden="true" />
      <header className="home-top">
        <a className="home-brand" href="/" aria-label="LoomWatch home"><LoomMark size={28} state={mark} /><LoomWordmark height={19} /></a>
        <span className="home-top-acts">
          <a className="btn" href="/" data-tour="your-teams">Your teams</a>
          <button type="button" className="iconbtn" onClick={toggle} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}</button>
        </span>
      </header>
      <main className="home-main agents-main"><AgentsList /></main>
    </div>
  )
}

const NO_RUNS: readonly RunRecord[] = []
const NO_SLOTS: AgentBarSlots = { chip: null, tabs: null }

/**
 * My agents down the side of an agent's page: one click is another agent, on the same tab, so
 * moving between agents never goes back through the list. Each glows what it is doing in its own
 * chat, so one finishing, or waiting for you, is seen while you work with another.
 */
function AgentRail({ route, records, leave }: { route: Exclude<AgentsRoute, { kind: 'list' }>; records: readonly RunRecord[]; leave: () => LeaveGuard | null }) {
  const { jobs } = useSavedJobs()
  const tab = route.view === 'chat' ? '?view=chat' : ''
  const items = jobs.map((job) => ({
    key: job.id,
    href: `/agents/${encodeURIComponent(job.id)}${tab}`,
    name: job.name,
    detail: job.does || undefined,
    presence: agentPresence(records, job.id),
    current: route.kind === 'agent' && route.id === job.id,
    art: <FigureStill className="crew-rail-figure" figure={figureFor(job.id, job.figure)} alt="" width={46} height={46} decoding="async" />,
  }))
  return <CrewRail label="My agents" items={items} find="Find an agent" none="No agents yet." add={{ label: 'New agent', href: '/agents/new', current: route.kind === 'new' }} go={(href) => navigate(href)} leave={leave} />
}

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
        <h1 className="t-display">Build an agent</h1>
        <p>Start from a job: it comes with working instructions, on the model its kind of work suits, and you can change all of it. Or start blank and write your own.</p>
        {team && <a className="link agent-back" href={`/?path=${encodeURIComponent(team)}&view=agents`}>Back to the team</a>}
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
  const { uses, own } = useAgentUses()
  const { pinned } = usePinnedAgent()
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
        <h1 className="t-display">My agents</h1>
        <p>Build an agent once and work with it in its own chat. Then add it to any team: each team keeps the copy it was given until you update it there.</p>
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
        {available && loaded && jobs.length === 0 && own !== null && (
          own.length > 0
            ? <div className="home-empty"><UserRound size={20} aria-hidden="true" /><span>None kept here yet. Press <b>New agent</b> to start from a job, or keep one of the agents in your teams below.</span></div>
            : <div className="home-empty"><UserRound size={20} aria-hidden="true" /><span>No agents yet. Press <b>New agent</b> to start from a job such as Researcher or Writer, or from a blank page.</span></div>
        )}
        {jobs.length > 0 && (
          <ul className="home-grid agents-grid">
            {jobs.map((job) => (
              <li key={job.id}>
                <button type="button" className="home-card agent-card" onClick={() => open(`/agents/${encodeURIComponent(job.id)}`)}>
                  <AgentBadge compact markId={job.id} figure={figureFor(job.id, job.figure)} draft={draftFromJob(job)} usedIn={usage.get(job.id)} pinned={pinned === job.id} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {problems.map((problem) => <p key={problem.file} className="home-empty alert" title={problem.message}>Can’t read {problem.file}: {problem.message}</p>)}
      </section>

      {own && own.length > 0 && (
        <section className="home-teams" aria-labelledby="agents-in-teams-title">
          <div className="home-teams-head"><h2 id="agents-in-teams-title">In your teams<span className="home-section-says">Each works in its own team</span></h2></div>
          <p className="agents-in-teams-note">These agents were made inside a team, so each one is changed there.</p>
          <ul className="home-agents-row">
            {own.map((agent) => (
              <li key={`${agent.teamPath}#${agent.agentId}`}><a className="home-agent-chip" href={teamAgentHref(agent)} title={`Open ${agent.agentName} in ${agent.teamName}`}><FigureStill className="home-agent-figure" figure={figureFor(agent.agentId)} headOnly alt="" width={30} height={30} loading="lazy" decoding="async" /><b>{agent.agentName}</b><span className="home-agent-team">in {agent.teamName}</span></a></li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
