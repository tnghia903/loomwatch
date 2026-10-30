import { useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Network, Plus, UserRoundPlus, X } from '../ui/icon'

import type { DetectedCapability } from '../../lib/library/client'
import type { AgentDraft } from '../../lib/library/draft'
import { benchChatOwner, type SavedJob } from '../../lib/library/jobs'
import { draftFromTeamAgent, readsOf, teamKnowledge, type TeamKnowledge } from '../../lib/library/teamDraft'
import type { RunRecord } from '../../lib/runs/client'
import type { ModelMove } from '../../lib/team-file/useModelFollowing'
import type { AgentConfig } from '../../lib/team-file/types'
import { agentFigure, figureFor } from '../../lib/library/figures'
import { FigureStill } from '../agents/FigureStill'
import { useAgentFigure } from '../agents/figureContext'
import { useBenchFile } from '../../lib/files/useBenchFile'
import { useBenchDetails } from '../../lib/runs/useBenchDetails'
import { AgentAnswer, AgentChat, AgentFile } from '../agents/AgentChat'
import { AgentDetails } from '../agents/AgentDetails'
import { AgentBuilder, AgentHead } from '../agents/AgentBuilder'
import type { LeaveGuard } from '../agents/leave'
import { ByHand, type ByHandProps } from '../agents/ByHand'
import type { AgentView } from '../agents/route'
import { withAllowed } from '../../lib/tools/allow'
import { InlineMarkdown } from '../ui/Markdown'

export interface TeamAgentsProps {
  /** The team's agents, in its order; the review step is not one of them. */
  agents: readonly AgentConfig[]
  /** The agent whose reply is the team's answer, so the model suggested fits each agent's place. */
  responder: string | null
  selected: string | null
  onSelect: (id: string) => void
  teamName: string
  teamPath: string | null
  /** Changes can be kept: the team is open for editing here. */
  editable: boolean
  skills: readonly DetectedCapability[]
  skillsLoading: boolean
  savedJobs: readonly SavedJob[]
  /** My agents has been read: until then, an agent's place there is unknown, not missing. */
  savedJobsLoaded?: boolean
  /** One workbench change on an agent this team hasn't saved to My agents yet, written into the team file. */
  onEdit: <K extends keyof AgentDraft>(agentId: string, key: K, value: AgentDraft[K]) => void
  /** One of My agents was saved here: the team shows it as it is now (ADR 0094). */
  onAgentSaved: (job: SavedJob) => void
  onShowWorkflow: () => void
  /** Kept up to date with what closing the workbench of one of My agents would lose. */
  leaveRef?: MutableRefObject<LeaveGuard | null>
  /** Put one of Your agents in this team. Absent when the team can't be changed here. */
  onAdd?: (job: SavedJob) => void
  /** A model picked for a team's own agent, and whether it now follows its suggestion (ADR 0072).
      Absent: the pick only sets its model. */
  onPickModel?: (agentId: string, model: string, follow: boolean) => void
  /** Agents whose model just moved with their configuration, and Undo. */
  modelMoves?: ReadonlyMap<string, ModelMove>
  onUndoModelMove?: (agentId: string) => void
}

const NO_MOVES: ReadonlyMap<string, ModelMove> = new Map()

/**
 * THE TEAM'S AGENTS, each on its workbench: a sheet over the Team tab, opened from an agent's card
 * (round 3). Every agent is one of My agents (ADR 0094), so its workbench is its own: saving it
 * changes it in every team it's in. One the team hasn't saved yet is edited with the team and joins
 * My agents when the team is saved.
 */
export function TeamAgents({ agents, responder, selected, onSelect, teamName, teamPath, editable, skills, skillsLoading, savedJobs, savedJobsLoaded = true, onEdit, onAgentSaved, onShowWorkflow, leaveRef, onAdd, onPickModel, modelMoves = NO_MOVES, onUndoModelMove }: TeamAgentsProps) {
  const agent = agents.find((candidate) => candidate.id === selected) ?? agents[0] ?? null
  const mine = agent?.from ? savedJobs.find((job) => job.id === agent.from?.agent) ?? null : null
  // What the team gives it to read, kept the same list while the team file doesn't change it.
  const reads = useMemo(() => (agent ? readsOf(agent) : []), [agent])
  // The same, as its chat here is given it: it reads in its chat what it reads in the team.
  const knowledge = useMemo(() => teamKnowledge(agent ?? {}, teamPath), [agent, teamPath])
  const [adding, setAdding] = useState(false)
  // An empty team has nothing else to show: choosing its first agents is the whole page.
  const choosing = Boolean(onAdd) && (adding || !agent)
  return (
    <div className="team-agents">
      <nav className="team-agents-strip" aria-label={`${teamName}’s agents`}>
        {agents.map((candidate) => {
          const job = candidate.from ? savedJobs.find((each) => each.id === candidate.from?.agent) : undefined
          return (
            <button key={candidate.id} type="button" className="team-agents-chip" aria-pressed={candidate.id === agent?.id} onClick={() => onSelect(candidate.id)}>
              <FigureStill className="team-agents-figure" figure={agentFigure(candidate, savedJobs, benchChatOwner(teamPath))} alt="" width={40} height={40} />
              <span><b>{candidate.name}</b><em>{!candidate.from ? 'Joins My agents when you save' : job ? (job.does?.trim() || 'One of My agents') : savedJobsLoaded ? 'Not in My agents' : ''}</em></span>
            </button>
          )
        })}
        {onAdd && agent && <button type="button" className="team-agents-chip add" aria-expanded={adding} onClick={() => setAdding((value) => !value)}><Plus size={16} aria-hidden="true" /><span><b>Add an agent</b><em>From My agents, or a new one</em></span></button>}
      </nav>

      {choosing && onAdd && <AddAgents jobs={savedJobs} inTeam={agents} teamPath={teamPath} first={!agent} onAdd={(job) => { onAdd(job); setAdding(false) }} onClose={agent ? () => setAdding(false) : undefined} onShowWorkflow={onShowWorkflow} />}

      {!agent && !onAdd && (
        <div className="team-agents-empty">
          <p>This team has no agents yet.</p>
          <button type="button" className="btn btn-primary" onClick={onShowWorkflow}><Network size={14} aria-hidden="true" />Back to the team</button>
        </div>
      )}

      {agent && agent.from && (
        <div className="team-agents-linked" key={agent.id}>
          {mine
            ? <AgentBuilder id={mine.id} skills={[...skills]} skillsLoading={skillsLoading} inTeam={{ name: teamName, onSaved: onAgentSaved, reads, knowledge, onShowWorkflow }} leaveRef={leaveRef} />
            : savedJobsLoaded && (
              <div className="team-agents-empty">
                <p>This agent isn’t in My agents any more, so this team can’t run. On the Team tab, select it, press Delete and save.</p>
                <button type="button" className="btn" onClick={onShowWorkflow}><Network size={14} aria-hidden="true" />Back to the team</button>
              </div>
            )}
        </div>
      )}

      {agent && !agent.from && <OwnAgent key={agent.id} agent={agent} team={{ agents, responder }} teamPath={teamPath} editable={editable} skills={skills} skillsLoading={skillsLoading} onEdit={onEdit} knowledge={knowledge} onShowWorkflow={onShowWorkflow}
        following={{
          follows: agent.followsSuggestion === true,
          moved: modelMoves.get(agent.id) && { from: (modelMoves.get(agent.id) as ModelMove).from, onUndo: () => onUndoModelMove?.(agent.id) },
          onPick: (model, follow) => { if (!editable) return; if (onPickModel) onPickModel(agent.id, model, follow); else onEdit(agent.id, 'model', model) },
        }} />}
    </div>
  )
}

/**
 * Choosing agents for the team: the ones you built in Your agents, each added in one click and
 * linked to its current version, or a new one built there first. The first step of a team.
 */
function AddAgents({ jobs, inTeam, teamPath, first, onAdd, onClose, onShowWorkflow }: { jobs: readonly SavedJob[]; inTeam: readonly AgentConfig[]; teamPath: string | null; first: boolean; onAdd: (job: SavedJob) => void; onClose?: () => void; onShowWorkflow: () => void }) {
  const here = new Set(inTeam.map((agent) => agent.from?.agent).filter(Boolean))
  return (
    <section className="team-agents-add" aria-label="Add an agent to this team" data-tour="agent-picker">
      <div className="team-agents-add-head">
        <p>{first ? <><b>Start with its agents.</b> Add the agents you built, or build a new one. Then connect them on the Team tab, and give the team work in Chat.</> : <><b>Add an agent.</b> It joins at the end of the workflow; connect it there.</>}</p>
        {onClose && <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><X size={14} aria-hidden="true" /></button>}
      </div>
      {jobs.length > 0 && (
        <ul className="team-agents-add-list">
          {jobs.map((job) => {
            const added = here.has(job.id)
            return (
              <li key={job.id}>
                <FigureStill figure={figureFor(job.id, job.figure)} alt="" width={52} height={52} loading="lazy" decoding="async" />
                <span><b>{job.name}</b><em>{added ? 'Already in this team' : job.does ? <InlineMarkdown clickable={false}>{job.does}</InlineMarkdown> : 'One of My agents'}</em></span>
                <button type="button" className="btn" onClick={() => onAdd(job)}><Plus size={13} aria-hidden="true" />{added ? 'Add again' : 'Add'}</button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="team-agents-add-acts">
        <a className={`btn${jobs.length === 0 ? ' btn-primary' : ''}`} href={`/agents/new${teamPath ? `?team=${encodeURIComponent(teamPath)}` : ''}`}><UserRoundPlus size={14} aria-hidden="true" />Build a new agent</a>
        {first && <button type="button" className="link" onClick={onShowWorkflow}>Or go back to the team</button>}
      </div>
    </section>
  )
}

/**
 * A team's own agent on the workbench, written straight into the team file, with the same two tabs
 * as one of Your agents: Build, and Chat, where you talk to it on its own.
 */
function OwnAgent({ agent, team, teamPath, editable, skills, skillsLoading, onEdit, knowledge, onShowWorkflow, following }: { agent: AgentConfig; team: { agents: readonly AgentConfig[]; responder: string | null }; teamPath: string | null; editable: boolean; skills: readonly DetectedCapability[]; skillsLoading: boolean; onEdit: TeamAgentsProps['onEdit']; knowledge: TeamKnowledge; onShowWorkflow: () => void; following: NonNullable<ByHandProps['following']> }) {
  const draft = useMemo(() => draftFromTeamAgent(agent), [agent])
  // Its chat reads what it reads as `knowledge`, named again from the chat's folder; its draft's
  // reads name a file added beside the team from the team file's folder, so they stay out of it.
  const chatDraft = useMemo(() => ({ ...draft, reads: [] }), [draft])
  const roleField = useRef<HTMLTextAreaElement>(null)
  const [record, setRecord] = useState<RunRecord | null>(null)
  // Its chat is named for this team and agent, so talking to one never touches another's. It is the
  // name its test bench had, so what was tried there before is in its chat.
  const chatId = `team-${(teamPath ?? 'new').replace(/^.*\//, '').replace(/\.ya?ml$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${agent.id}`.slice(0, 80)
  const [view, setView] = useState<AgentView>('build')
  // A long answer from the chat, read in full over the bench.
  const [answerRun, setAnswerRun] = useState<string | null>(null)
  // A file its answers name, read over the bench too (ADR 0077).
  const benchFile = useBenchFile()
  // A piece's Details, read over the bench (AgentDetails).
  const details = useBenchDetails(chatId)
  const figure = useAgentFigure(agent)
  const name = draft.name.trim() || agent.name || 'New agent'
  return (
    <div className="team-agents-own">
      {/* The same head as one of My agents (AgentHead): its name, how it is kept, its tabs. */}
      <AgentHead
        name={name}
        status={<span className="agent-builder-note">{editable ? 'Saving the team adds it to My agents.' : 'This team can’t be changed here, so the bench shows it as it is.'}</span>}
        view={view} onView={setView}
      />
      <ByHand
        draft={draft} set={(key, value) => onEdit(agent.id, key, value)} skills={skills} skillsLoading={skillsLoading} roleField={roleField} figure={figure} record={record} hideDoes readOnly={!editable} teamOwn={{ teamPath }} onShowWorkflow={onShowWorkflow} suggestFor={{ agent, team }} following={following}
        learned={teamPath ? { teamPath, agent: agent.id } : null}
        chat={view === 'chat' ? <AgentChat draft={chatDraft} model={draft.model} chatId={chatId} figure={figure} onAllow={(what) => (typeof what === 'string' ? onEdit(agent.id, 'allow', { ...draft.allow, [what]: true }) : onEdit(agent.id, 'toolAllow', withAllowed(draft.toolAllow, what.tool, what.call)))} onRecord={setRecord} answerRunId={answerRun} onOpenAnswer={(runId) => { setAnswerRun(runId); if (runId) details.close() }} knowledge={knowledge} file={benchFile.chat}
          detailsRunId={details.asked?.runId ?? null} onDetails={(asked) => { details.open(asked); setAnswerRun(null); benchFile.close() }} reveal={details.reveal} /> : undefined}
        onBuild={() => setView('build')}
        cover={view === 'chat' && benchFile.reading ? <AgentFile bench={benchFile} chatId={chatId} name={name} figure={figure} />
          : view === 'chat' && details.asked ? <AgentDetails key={details.asked.at} asked={details.asked} draft={chatDraft} model={draft.model} chatId={chatId} figure={figure} onClose={details.close} onAllow={(key) => onEdit(agent.id, 'allow', { ...draft.allow, [key]: true })} onRevealMessage={details.revealMessage} />
          : view === 'chat' && answerRun ? <AgentAnswer runId={answerRun} name={name} onClose={() => setAnswerRun(null)} /> : undefined}
      />
    </div>
  )
}
