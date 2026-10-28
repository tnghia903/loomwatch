// The agent pinned to the notch, drawn (ADR 0083, decisions 9 and 10): the tray that opens when
// something is dragged near, what went in waiting for a job, its answer with Copy, its request to
// start one of your teams in its own words, and the team it started at work under the notch as its
// crew.
import { Check, Copy, Mail, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { FigureStill } from '../components/agents/FigureStill'
import type { WorkPhase } from '../lib/library/figure'
import { figureFor } from '../lib/library/figures'
import { dollars } from '../lib/runs/spend'
import type { TeamRequest } from '../lib/runs/teamRequests'
import { useRunSession } from '../lib/runs/useRunSession'
import { workPhase } from '../lib/watch/workPhase'
import { extensionOf } from '../lib/files/fileRefs'
import { intakeLabel, isEmail, isPicture, jobsFor, kindOf, tileName } from './intake'
import { plainText, type TeamNow } from './teams'
import type { Island } from './useIsland'
import { useRunLimit } from './useRunLimit'
import { InlineMarkdown } from '../components/ui/Markdown'
import { plainWords } from '../lib/chat/findWords'

/** The open slot: a tray drawn in a gold line, and the box's agent behind it, ready to take it. */
export function Slot({ island }: { island: Island }) {
  const agent = island.box
  if (!agent) return null
  return (
    <div className="island-slot-open" role="status" aria-label={`Drop it here for ${agent.name}`}>
      <span className="island-tray-figure glow" data-moment="ready" aria-hidden="true">
        <FigureStill figure={figureFor(agent.id, agent.job.figure)} alt="" />
      </span>
      <span className="island-tray" aria-hidden="true">
        <svg><rect width="100%" height="100%" rx="16" pathLength="728" /></svg>
      </span>
    </div>
  )
}

/** What was dropped into the slot, and the jobs that fit it; the box under them takes your own.
    Files show one by one, each to take out on its own; a link or some text, as one. */
export function IntakeJobs({ island }: { island: Island }) {
  const intake = island.intake
  if (!intake) return null
  const [first, ...rest] = jobsFor(kindOf(intake))
  return (
    <div className="island-intake">
      {intake.files.length > 0 ? (
        <ul className="island-files" aria-label="Going with your message">
          {intake.files.map((file) => <FileTile key={`${file.name}\n${file.size}`} island={island} file={file} />)}
        </ul>
      ) : (
        <span className="island-intake-what">
          <span>{intakeLabel(intake)}</span>
          <button type="button" className="island-intake-remove" aria-label="Don’t send it" onPointerDown={(event) => event.preventDefault()} onClick={island.clearIntake}>×</button>
        </span>
      )}
      <span className="island-jobs">
        {[first, ...rest].map((job, index) => (
          <button key={job} type="button" className={`island-chip${index === 0 ? ' is-likely' : ''}`} disabled={island.sending} onClick={() => island.send(job)}>{job}</button>
        ))}
      </span>
    </div>
  )
}

/** A picture drawn from the file itself, with no request; its address is let go once it is out. */
function Picture({ file, unreadable }: { file: File; unreadable: () => void }) {
  const picture = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const drawn = picture.current
    if (!drawn) return
    const address = URL.createObjectURL(file)
    drawn.src = address
    return () => {
      drawn.removeAttribute('src')
      URL.revokeObjectURL(address)
    }
  }, [file])
  return <img ref={picture} alt="" decoding="async" onError={unreadable} />
}

/** A file's name under its tile: as it wraps, or cut into its first and last words. */
function TileName({ lines }: { lines: readonly string[] }) {
  if (lines.length === 1) return <span className="island-file-name" aria-hidden="true">{lines[0]}</span>
  return (
    <span className="island-file-name is-cut" aria-hidden="true">
      {lines.map((line, index) => <span key={index}>{line}</span>)}
    </span>
  )
}

/**
 * A file waiting to go: the picture itself, or a page with its kind on it (an envelope for an
 * email), its name under it, and × to take it out, as the team chat has it. As the message goes, a
 * line runs along it until it is with the agent, then it has a tick. Pressing × keeps the keyboard
 * in the box, as pressing a figure does.
 */
function FileTile({ island, file }: { island: Island; file: File }) {
  const [unreadable, setUnreadable] = useState(false)
  const arrived = island.uploaded.has(file)
  const going = island.sending && !arrived
  const extension = extensionOf(file.name).toUpperCase()
  const drawn = isPicture(file) && !unreadable
  return (
    <li className={`island-file${going ? ' is-going' : ''}`} aria-label={arrived ? `${file.name}, with ${island.box?.name ?? 'the agent'}` : file.name} title={file.name} aria-busy={going}>
      <span className={`island-file-face${drawn ? '' : ' is-page'}`} aria-hidden="true">
        {drawn ? <Picture file={file} unreadable={() => setUnreadable(true)} /> : isEmail(file) ? <Mail size={20} /> : extension && <b>{extension}</b>}
        {going && <i className="island-file-line" />}
      </span>
      <TileName lines={tileName(file)} />
      {arrived ? (
        <span className="island-file-in" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
      ) : !island.sending && (
        <button type="button" className="island-file-remove" aria-label={`Don’t send ${file.name}`} onPointerDown={(event) => event.preventDefault()} onClick={() => island.takeOut(file)}>
          <X size={12} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

/**
 * The pinned agent's answer, as any answer on the island: who answered with Copy beside it, as a
 * mark, then its opening lines and Open in LoomWatch. Copy takes the whole answer, formatted for apps
 * that take formatting and as plain text, links with their addresses, for the rest; until it is read
 * whole, Copy is off. In the list, its foot's Open in LoomWatch opens the answer instead (`foot`).
 */
export function AnswerSlip({ island, team, foot = false }: { island: Island; team: TeamNow; foot?: boolean }) {
  const answer = island.answerOf(team)
  const whole = plainText(answer?.text ?? team.result)
  return (
    <div className="island-answer">
      <div className="island-words">
        <span className="island-answer-head">
          <small>{team.teamName} answered</small>
          {/* One button throughout, so the keyboard stays on it once it has copied. */}
          <button type="button" className={`island-copy${island.copied ? ' is-copied' : ''}`} aria-label={island.copied ? 'Copied' : 'Copy'} disabled={!answer} onClick={() => { if (answer && !island.copied) island.copy(answer) }}>
            {island.copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          </button>
          <span className="island-unseen" role="status">{island.copied ? 'Copied.' : ''}</span>
        </span>
        {/* Its opening lines, read without the blank lines between paragraphs. */}
        <p>{whole.replace(/\n{2,}/g, '\n')}</p>
      </div>
      {!foot && (
        <div className="island-acts">
          <button type="button" className="island-button" onClick={() => island.open(team)}>Open in LoomWatch</button>
        </div>
      )}
    </div>
  )
}

/**
 * The pinned agent asks one of your teams to do part of the job, in its own words, to the team named
 * under them, which says too when a run of it has no spending limit. Nothing runs until Start: under
 * the words on the card that drops from the notch (`start`), and in the message box's place in the
 * agent's row, where writing something turns it back into Send. In the row, × in the corner says
 * don't (`decline`); the card has none, so putting it away never answers it. The island gets no
 * pointer to show a tooltip with, so nothing a person needs is only in one. What an answer did
 * shows for a moment before it goes.
 */
export function TeamAskBody({ island, request, first, start, decline }: { island: Island; request: TeamRequest; first: boolean; start: boolean; decline: boolean }) {
  const failed = island.teamFailed === request.id
  const said = island.teamSaid?.id === request.id ? island.teamSaid.text : null
  const crew = island.crewFigures(request.team.path).slice(0, 3)
  const limit = useRunLimit(request.team.path)
  return (
    <>
      <div className="island-words island-request">
        <div className="island-said-by">
          <p className="island-ask" title={plainWords(request.request)}><InlineMarkdown clickable={false}>{request.request}</InlineMarkdown></p>
          {decline && !said && <button type="button" className="island-not-now" aria-label={`Don’t start ${request.team.name}`} title={`Don’t start ${request.team.name}`} disabled={island.teamBusy === request.id} onClick={() => island.answerTeam(request, 'decline')}>×</button>}
        </div>
        <small className="island-for">
          to{' '}
          {crew.length > 0 && (
            <span className="island-crew" aria-hidden="true">
              {crew.map((figure, index) => <span key={index} className="island-crew-figure"><FigureStill figure={figure} alt="" /></span>)}
            </span>
          )}
          {' '}<span className="island-team">{request.team.name}</span>
          {limit === null && ' · no spending limit'}
        </small>
        {failed && <small className="island-problem" role="alert">That didn’t go through. Press Start again.</small>}
        {said && <small className="island-said" role="status">{said}</small>}
      </div>
      {start && !said && (
        <div className="island-acts">
          <StartTeam island={island} request={request} first={first} limit={limit} />
        </div>
      )}
    </>
  )
}

/** Start on what the pinned agent asked a team, naming the team and what one run of it may spend
    for the screen reader and the tooltip, where there is one. */
export function StartTeam({ island, request, first, limit }: { island: Island; request: TeamRequest; first: boolean; limit: number | null | undefined }) {
  const said = `Start ${request.team.name}.${typeof limit === 'number' ? ` It may spend up to ${dollars(limit)}.` : ''}`
  return (
    <button type="button" className={`island-button${first ? ' is-primary' : ''}`} aria-label={`Start ${request.team.name}`} title={said} disabled={island.teamBusy === request.id} onClick={() => island.answerTeam(request, 'start')}>Start</button>
  )
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
