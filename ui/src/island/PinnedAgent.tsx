// The agent pinned to the notch, drawn (ADR 0083, decisions 9 and 10): the slot that opens when
// something is dragged near, what went in waiting for a job, its answer with Copy, its request to
// start one of your teams, and the team it started at work under the notch as its crew.
import { useEffect, useState } from 'react'
import { parse } from 'yaml'

import { FigureStill } from '../components/agents/FigureStill'
import type { WorkPhase } from '../lib/library/figure'
import { figureFor } from '../lib/library/figures'
import { dollars } from '../lib/runs/spend'
import type { TeamRequest } from '../lib/runs/teamRequests'
import { fetchTeamFile } from '../lib/team-file/client'
import { useRunSession } from '../lib/runs/useRunSession'
import { workPhase } from '../lib/watch/workPhase'
import { intakeLabel, jobsFor, kindOf } from './intake'
import { plainText, type TeamNow } from './teams'
import type { Island } from './useIsland'

/** The open slot: a gold lip along the island's edge, and the pinned agent's eyes over it. */
export function Slot({ island }: { island: Island }) {
  const pinned = island.pinned
  if (!pinned) return null
  return (
    <div className="island-slot-open" role="status" aria-label={`Drop it here for ${pinned.name}`}>
      <span className="island-slot-eyes glow" data-moment="ready" aria-hidden="true">
        <FigureStill figure={figureFor(pinned.id, pinned.job.figure)} alt="" />
      </span>
      <i className="island-slot-lip" aria-hidden="true" />
    </div>
  )
}

/** What was dropped into the slot, and the jobs that fit it; the box under them takes your own. */
export function IntakeJobs({ island }: { island: Island }) {
  const intake = island.intake
  if (!intake) return null
  const [first, ...rest] = jobsFor(kindOf(intake))
  return (
    <div className="island-intake">
      <span className="island-intake-what">
        <span>{intakeLabel(intake)}</span>
        <button type="button" className="island-intake-remove" aria-label="Take it out" onClick={island.clearIntake}>×</button>
      </span>
      <span className="island-jobs">
        {[first, ...rest].map((job, index) => (
          <button key={job} type="button" className={`island-chip${index === 0 ? ' is-likely' : ''}`} disabled={island.sending} onClick={() => island.send(job)}>{job}</button>
        ))}
      </span>
    </div>
  )
}

/**
 * The pinned agent's answer, as any answer on the island: who answered, its opening lines, Copy and
 * See answer. Copy takes the whole answer, formatted for apps that take formatting and as plain
 * text, links with their addresses, for the rest; until it is read whole, Copy is off.
 */
export function AnswerSlip({ island, team }: { island: Island; team: TeamNow }) {
  const answer = island.answerOf(team)
  const whole = plainText(answer?.text ?? team.result)
  return (
    <div className="island-answer">
      <div className="island-words">
        <small>{team.teamName} answered</small>
        {/* Its opening lines, read without the blank lines between paragraphs. */}
        <p>{whole.replace(/\n{2,}/g, '\n')}</p>
      </div>
      <div className="island-acts">
        {island.copied ? <small className="island-sent" role="status">Copied.</small> : (
          <button type="button" className="island-button" disabled={!answer} onClick={() => { if (answer) island.copy(answer) }}>Copy</button>
        )}
        <button type="button" className="island-button" onClick={() => island.open(team)}>See answer</button>
      </div>
    </div>
  )
}

/**
 * The pinned agent asks one of your teams to do part of the job: nothing runs until Start, which
 * names the team and says what one run of it may spend, from its file. What an answer did shows
 * for a moment before the card goes.
 */
export function TeamAskBody({ island, request, first }: { island: Island; request: TeamRequest; first: boolean }) {
  const pinned = island.pinned
  const busy = island.teamBusy === request.id
  const failed = island.teamFailed === request.id
  const said = island.teamSaid?.id === request.id ? island.teamSaid.text : null
  const limit = useRunLimit(request.team.path)
  return (
    <>
      <div className="island-words">
        <small>{pinned?.name ?? 'Your agent'} wants {request.team.name} to do this</small>
        <p className="island-ask" title={request.request}>{request.request}</p>
        {!said && limit !== undefined && <small className="island-detail">{limit === null ? 'No spending limit set' : `May spend up to ${dollars(limit)} on this run`}</small>}
        {failed && <small className="island-problem" role="alert">That didn’t go through. Press Start again.</small>}
        {said && <small className="island-said" role="status">{said}</small>}
      </div>
      {!said && (
        <div className="island-acts">
          <button type="button" className="island-button" disabled={busy} onClick={() => island.answerTeam(request, 'decline')}>Not now</button>
          <button type="button" className={`island-button${first ? ' is-primary' : ''}`} disabled={busy} onClick={() => island.answerTeam(request, 'start')}>Start {request.team.name}</button>
        </div>
      )}
    </>
  )
}

/** What one run of the team at `path` may spend, from its file: `null` when it sets no limit,
    `undefined` until read. */
function useRunLimit(path: string): number | null | undefined {
  const [limit, setLimit] = useState<{ path: string; perRun: number | null } | null>(null)
  useEffect(() => {
    let live = true
    fetchTeamFile(path).then((file) => {
      const perRun = (parse(file.yaml) as { spend?: { perRun?: unknown } } | null)?.spend?.perRun
      if (live) setLimit({ path, perRun: typeof perRun === 'number' && perRun > 0 ? perRun : null })
    }, () => {})
    return () => { live = false }
  }, [path])
  return limit?.path === path ? limit.perRun : undefined
}

/** What an agent at work on the stage is doing, from its newest events, in a word or two. */
const DOING: Record<WorkPhase, string> = { reading: 'reading', thinking: 'thinking', tools: 'at the computer', typing: 'writing' }

/**
 * A team the pinned agent started, at work under the notch: each of its agents on a gold line, the
 * one working glowing and saying what it is doing, a bead on it as the work passes along.
 */
export function CrewStage({ island, crew }: { island: Island; crew: TeamNow }) {
  const session = useRunSession(crew.runId, null)
  const agents = crew.agents.length ? crew.agents : crew.agent ? [crew.agent] : []
  const at = Math.max(0, agents.indexOf(crew.agent ?? ''))
  return (
    <div className="island-stage" aria-label={`${crew.teamName} is working for ${crew.crewFor}`}>
      <small>{crew.teamName}, for {crew.crewFor}</small>
      <div className="island-stage-line" style={{ ['--crew' as string]: agents.length }}>
        <i className="island-stage-bead" aria-hidden="true" style={{ ['--at' as string]: at }} />
        {agents.map((agent) => {
          const working = agent === crew.agent && crew.moment === 'work'
          const doing = working ? DOING[workPhase(session.events, agent, island.now)] : ''
          return (
            <span key={agent} className="island-stage-member">
              <span className={`island-stage-figure${working ? ' glow' : ''}`} data-moment={working ? 'work' : 'rest'} aria-hidden="true">
                <FigureStill figure={island.figure(crew.teamPath, agent)} alt="" />
              </span>
              <b>{crew.names?.[agent] ?? agent}</b>
              {doing ? <em>{doing}</em> : null}
            </span>
          )
        })}
      </div>
    </div>
  )
}
