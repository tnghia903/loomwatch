import { useEffect, useMemo, useRef, useState } from 'react'
import { Network, Plus, UserRoundPlus, X } from 'lucide-react'

import { fetchHarnessModels, type DetectedHarness, type HarnessModels } from '../../lib/harnesses'
import type { DetectedCapability } from '../../lib/library/client'
import type { ReadSource } from '../../lib/library/figure'
import type { AgentDraft } from '../../lib/library/draft'
import { savedJobPreset, type SavedJob } from '../../lib/library/jobs'
import { roleSource } from '../../lib/library/roles'
import { linkState } from '../../lib/library/link'
import { draftFromTeamAgent, readsOf, toolsOf } from '../../lib/library/teamDraft'
import type { RunRecord } from '../../lib/runs/client'
import type { AgentConfig } from '../../lib/team-file/types'
import { agentFigure, figureFor, figureStill } from '../../lib/library/figures'
import { AgentBuilder } from '../agents/AgentBuilder'
import { ByHand } from '../agents/ByHand'
import { TestBench } from '../agents/TestBench'
import { LinkedAgent } from '../canvas/LinkedAgent'

export interface TeamAgentsProps {
  /** The team's agents, in its order; the review step is not one of them. */
  agents: readonly AgentConfig[]
  selected: string | null
  onSelect: (id: string) => void
  teamName: string
  teamPath: string | null
  /** Changes can be kept: the team is open for editing here. */
  editable: boolean
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  skills: readonly DetectedCapability[]
  skillsLoading: boolean
  savedJobs: readonly SavedJob[]
  /** One workbench change on a team's own agent, written into the team file. */
  onEdit: <K extends keyof AgentDraft>(agentId: string, key: K, value: AgentDraft[K]) => void
  /** Bring a linked agent in this team to a version of its agent in Your agents. */
  onApplyVersion: (agentId: string, job: SavedJob) => void
  onUnlink: (agentId: string) => void
  onShowWorkflow: () => void
  /** Put one of Your agents in this team. Absent when the team can't be changed here. */
  onAdd?: (job: SavedJob) => void
}

/**
 * THE TEAM'S AGENTS, the first of a team's three views (Agents, Workflow, Chat): every agent of the
 * team on its workbench. A team starts here, with the agents you built in Your agents or a new one;
 * Workflow is where they are connected. A team's own agent is edited right here and saved with the
 * team, like a canvas edit. One placed from Your agents opens its saved version: saving it makes the
 * next version and moves this team to it.
 */
export function TeamAgents({ agents, selected, onSelect, teamName, teamPath, editable, harnesses, harnessesLoading, skills, skillsLoading, savedJobs, onEdit, onApplyVersion, onUnlink, onShowWorkflow, onAdd }: TeamAgentsProps) {
  const agent = agents.find((candidate) => candidate.id === selected) ?? agents[0] ?? null
  const link = agent ? linkState(agent, savedJobs) : null
  // What the team gives it to read, kept the same list while the team file doesn't change it.
  const reads = useMemo(() => (agent ? readsOf(agent) : []), [agent])
  const tools = useMemo(() => (agent ? toolsOf(agent) : []), [agent])
  const [adding, setAdding] = useState(false)
  // An empty team has nothing else to show: choosing its first agents is the whole page.
  const choosing = Boolean(onAdd) && (adding || !agent)
  return (
    <div className="team-agents">
      <nav className="team-agents-strip" aria-label={`${teamName}’s agents`}>
        {agents.map((candidate) => {
          const linked = linkState(candidate, savedJobs)
          return (
            <button key={candidate.id} type="button" className="team-agents-chip" aria-pressed={candidate.id === agent?.id} onClick={() => onSelect(candidate.id)}>
              <img className="team-agents-figure" src={figureStill(agentFigure(candidate, savedJobs))} alt="" width={40} height={40} />
              <span><b>{candidate.name}</b><em>{linked ? `From Your agents · v${linked.version}${linked.behind ? ` · v${linked.latest} ready` : ''}` : 'This team’s own'}</em></span>
            </button>
          )
        })}
        {onAdd && agent && <button type="button" className="team-agents-chip add" aria-expanded={adding} onClick={() => setAdding((value) => !value)}><Plus size={16} aria-hidden="true" /><span><b>Add an agent</b><em>From Your agents, or a new one</em></span></button>}
      </nav>

      {choosing && onAdd && <AddAgents jobs={savedJobs} inTeam={agents} harnesses={harnesses} teamPath={teamPath} first={!agent} onAdd={(job) => { onAdd(job); setAdding(false) }} onClose={agent ? () => setAdding(false) : undefined} onShowWorkflow={onShowWorkflow} />}

      {!agent && !onAdd && (
        <div className="team-agents-empty">
          <p>This team has no agents yet.</p>
          <button type="button" className="btn btn-primary" onClick={onShowWorkflow}><Network size={14} aria-hidden="true" />Add one in Workflow</button>
        </div>
      )}

      {agent && link && (
        <div className="team-agents-linked" key={agent.id}>
          <LinkedAgent agent={agent} link={link} readOnly={!editable} onApply={(job) => onApplyVersion(agent.id, job)} onUnlink={() => onUnlink(agent.id)} teamPath={teamPath} headClassName="agent-section-head" showEdit={false} />
          {link.job
            ? <AgentBuilder id={link.job.id} harnesses={harnesses} harnessesLoading={harnessesLoading} skills={[...skills]} skillsLoading={skillsLoading} inTeam={{ name: teamName, onSaved: (job) => { if (editable) onApplyVersion(agent.id, job) }, reads, tools, onShowWorkflow }} />
            : <p className="t-meta">Its agent is gone from Your agents. Make it this team’s own to change it here.</p>}
        </div>
      )}

      {agent && !link && <OwnAgent key={agent.id} agent={agent} teamPath={teamPath} editable={editable} harnesses={harnesses} harnessesLoading={harnessesLoading} skills={skills} skillsLoading={skillsLoading} onEdit={onEdit} reads={reads} tools={tools} onShowWorkflow={onShowWorkflow} />}
    </div>
  )
}

/**
 * Choosing agents for the team: the ones you built in Your agents, each added in one click and
 * linked to its current version, or a new one built there first. The first step of a team.
 */
function AddAgents({ jobs, inTeam, harnesses, teamPath, first, onAdd, onClose, onShowWorkflow }: { jobs: readonly SavedJob[]; inTeam: readonly AgentConfig[]; harnesses: readonly DetectedHarness[]; teamPath: string | null; first: boolean; onAdd: (job: SavedJob) => void; onClose?: () => void; onShowWorkflow: () => void }) {
  const here = new Set(inTeam.map((agent) => agent.from?.agent).filter(Boolean))
  return (
    <section className="team-agents-add" aria-label="Add an agent to this team" data-tour="agent-picker">
      <div className="team-agents-add-head">
        <p>{first ? <><b>Start with its agents.</b> Add the agents you built, or build a new one. Then connect them in Workflow, and give the team work in Chat.</> : <><b>Add an agent.</b> It joins at the end of the workflow; connect it there.</>}</p>
        {onClose && <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><X size={14} aria-hidden="true" /></button>}
      </div>
      {jobs.length > 0 && (
        <ul className="team-agents-add-list">
          {jobs.map((job) => {
            const runnable = Boolean(roleSource(savedJobPreset(job), harnesses))
            const added = here.has(job.id)
            return (
              <li key={job.id}>
                <img src={figureStill(figureFor(job.id, job.figure))} alt="" width={52} height={52} loading="lazy" decoding="async" />
                <span><b>{job.name}</b><em>{!runnable ? 'No AI app on this computer can run it' : added ? 'Already in this team' : job.does || 'One of your agents'}</em></span>
                <button type="button" className="btn" disabled={!runnable} onClick={() => onAdd(job)}><Plus size={13} aria-hidden="true" />{added ? 'Add again' : 'Add'}</button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="team-agents-add-acts">
        <a className={`btn${jobs.length === 0 ? ' btn-primary' : ''}`} href={`/agents/new${teamPath ? `?team=${encodeURIComponent(teamPath)}` : ''}`}><UserRoundPlus size={14} aria-hidden="true" />Build a new agent</a>
        {first && <button type="button" className="link" onClick={onShowWorkflow}>Or start in Workflow</button>}
      </div>
    </section>
  )
}

/** A team's own agent on the workbench, written straight into the team file. */
function OwnAgent({ agent, teamPath, editable, harnesses, harnessesLoading, skills, skillsLoading, onEdit, reads, tools, onShowWorkflow }: { agent: AgentConfig; teamPath: string | null; editable: boolean; harnesses: DetectedHarness[]; harnessesLoading: boolean; skills: readonly DetectedCapability[]; skillsLoading: boolean; onEdit: TeamAgentsProps['onEdit']; reads: readonly ReadSource[]; tools: readonly string[]; onShowWorkflow: () => void }) {
  const draft = useMemo(() => draftFromTeamAgent(agent, harnesses), [agent, harnesses])
  const harness = harnesses.find((candidate) => candidate.id === draft.appId) ?? null
  const roleField = useRef<HTMLTextAreaElement>(null)
  const [record, setRecord] = useState<RunRecord | null>(null)
  const [models, setModels] = useState<{ app: string; list: HarnessModels | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!draft.appId) return
    let cancelled = false
    const app = draft.appId
    fetchHarnessModels(app).then((list) => { if (!cancelled) setModels({ app, list, error: null }) }, (failed: unknown) => { if (!cancelled) setModels({ app, list: null, error: failed instanceof Error ? failed.message : String(failed) }) })
    return () => { cancelled = true }
  }, [draft.appId])
  const appModels = models?.app === draft.appId ? models : null
  const resolvedModel = draft.model || appModels?.list?.currentModelId || ''
  const modelName = appModels?.list?.models.find((model) => model.id === resolvedModel)?.name
  // The bench team is named for this team and agent, so trying one never touches another's.
  const benchId = `team-${(teamPath ?? 'new').replace(/^.*\//, '').replace(/\.ya?ml$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${agent.id}`.slice(0, 80)
  return (
    <div className="team-agents-own">
      <p className="t-meta team-agents-note">{editable ? 'This team’s own agent: what you change here is saved with the team, like a change on the canvas.' : 'This team can’t be changed here, so the bench shows it as it is.'}</p>
      <ByHand draft={draft} set={(key, value) => onEdit(agent.id, key, value)} harness={harness} harnesses={harnesses} harnessesLoading={harnessesLoading} models={appModels?.list ?? null} modelsError={appModels?.error ?? null} modelName={modelName} skills={skills} skillsLoading={skillsLoading} roleField={roleField} markId={agent.id} figure={figureFor(agent.id)} record={record} hideDoes readOnly={!editable} reads={reads} tools={tools} onShowWorkflow={onShowWorkflow} />
      <div className="team-agents-bench">
        <TestBench draft={draft} harness={harness} model={resolvedModel} benchId={benchId} onAllow={(key) => onEdit(agent.id, 'allow', { ...draft.allow, [key]: true })} onRecord={setRecord} />
      </div>
    </div>
  )
}
