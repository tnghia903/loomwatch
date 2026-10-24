// The island at the notch, drawn (ADR 0083): Peek. The agent at work peeks out below the notch; a
// question drops down on a gold line; a result slides out as a slip; then it all tucks into the
// menu bar beside the camera, one figure per busy team. Pointing at the notch opens the list.
// Without a notch only the box is drawn, while it is called, hanging from the menu bar, then its
// agent at work in a pill, and its answer (decision 11).
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'

import { AgentFigure } from '../components/agents/benchFigure'
import { FigureStill } from '../components/agents/FigureStill'
import { ArrowUp, CornerDownLeft } from 'lucide-react'

import { LoomMark, StatusGlyph } from '../components/ui/glyphs'
import { dropped } from '../lib/chat/attachments'
import type { WorkPhase } from '../lib/library/figure'
import { figureFor } from '../lib/library/figures'
import type { Ticket } from '../lib/story/needsYou'
import { useSessionEvents } from '../lib/watch/useSessionEvents'
import { workPhase } from '../lib/watch/workPhase'
import { inApp, tellApp, type Area } from './bridge'
import { intakeFrom } from './intake'
import { AnswerSlip, CrewStage, IntakeJobs, Slot, StartTeam, TeamAskBody } from './PinnedAgent'
import { teamAskKey, workedFor, type TeamNow } from './teams'
import { useIsland, type Island as IslandState } from './useIsland'
import { useRunLimit } from './useRunLimit'

/** Rows in the list before "N more teams in LoomWatch", as in the menu. */
const LIST_ROWS = 5
/** Other agents shown beside the box before "+N"; Tab reaches every one. */
const OTHER_AGENTS = 5

/** The agent's workbench, with three.js: fetched as the box opens, not with the page, so the page
    loads at once and the bench is ready by the time a message goes. */
const loadBench = () => import('./BenchCard')
const BenchCard = lazy(loadBench)

/** What a question's button says when it opens LoomWatch at its run rather than answering here. */
const OPEN_WORDS: Record<Ticket['kind'], string> = { question: 'Answer', review: 'Review', permission: 'Open', spend: 'Open', failed: 'Open' }

export function Island() {
  const island = useIsland()
  const { view, notch, bar, tucked } = island
  const root = useRef<HTMLDivElement>(null)
  useReportAreas(root, view)
  // The bench comes as the box opens, so it is drawn by the time a message goes.
  const composing = island.composing
  useEffect(() => {
    if (!composing) return
    loadBench().catch(() => {})
    AgentFigure.preload().catch(() => {})
  }, [composing])

  // First beside the notch: the agent pinned to it, in its work's glow or ready, then one head per
  // other team. LoomWatch's own mark stands there only while there is no figure at all, never beside
  // one. At rest the ear is no wider than what is in it, so it covers as little menu bar as it can.
  const first = island.pinned ? 'pinned' : tucked.heads.length ? 'none' : 'mark'
  const figures = tucked.heads.length + (first === 'none' ? 0 : 1)
  const heads = headsLayout(first, tucked.heads.length, bar)
  const ear = view === 'rest' ? heads.span + 10 : Math.max(Math.round(bar * 1.5), heads.span + 14 + (tucked.more ? 16 : 0))
  const style = {
    '--notch-w': `${notch.width}px`,
    '--bar': `${bar}px`,
    '--ear': `${ear}px`,
  } as CSSProperties

  const onIsland = (over: boolean) => (event: ReactPointerEvent) => {
    if (event.pointerType === 'mouse') island.pointerOnIsland(over)
  }
  const onDrop = (over: boolean) => (event: ReactPointerEvent) => {
    if (event.pointerType === 'mouse') island.pointerOnDrop(over)
  }

  return (
    <div ref={root} className={`island${island.nudge ? ' is-nudging' : ''}`} data-view={view} data-notch={island.atNotch ? undefined : 'none'} style={style}>
      <div className="island-drop">
        <Hang island={island} onPointerEnter={onDrop(true)} onPointerLeave={onDrop(false)} />
        <Slip island={island} onPointerEnter={onDrop(true)} onPointerLeave={onDrop(false)} />
      </div>
      <div
        className="island-shape"
        role="button"
        tabIndex={view === 'hidden' ? -1 : 0}
        aria-label={shapeLabel(island)}
        aria-expanded={view === 'list'}
        onPointerEnter={onIsland(true)}
        onPointerLeave={onIsland(false)}
        onClick={(event) => {
          // The agent's workbench on its own opens the box, with it, to stay.
          if (view === 'bench') {
            island.openBench()
            return
          }
          // A press inside the open list (Copy, Start, Send, by mouse or keyboard) is not pointing
          // at the island: the list stays only while the pointer is on it or a message is written.
          if (event.target instanceof Element && event.target.closest('.island-list')) return
          // Without a notch there is no list: the agent in its pill opens the box, with its bench.
          if (!island.atNotch) island.openBench()
          else island.pointerOnIsland(true)
        }}
        onKeyDown={(event) => {
          // Keys typed inside the list (the message to the box's agent) are its own.
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (!island.atNotch || view === 'bench') island.openBench()
            else island.pointerOnIsland(view !== 'list')
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          tellApp({ kind: 'menu', x: event.clientX, y: event.clientY })
        }}
        // Anything dropped onto the island goes to the box's agent: the slot opens as it comes.
        onDragEnter={(event) => {
          if (!island.box) return
          event.preventDefault()
          island.dragOver(true)
        }}
        onDragOver={(event) => {
          if (!island.box) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          island.dragOver(false)
        }}
        onDrop={(event) => {
          if (!island.box) return
          event.preventDefault()
          // The slot stays open until what was dropped is sorted, a moment later.
          const { files, folders } = dropped(event.dataTransfer)
          const intake = intakeFrom({ files, getData: (type) => event.dataTransfer.getData(type) })
          if (intake || folders.length) island.drop(intake ?? { files: [], link: null, text: null }, folders)
          else island.dragOver(false)
        }}
      >
        <div className="island-body">
        {view === 'slot' && <Slot island={island} />}
        {island.atNotch && <Balcony island={island} />}
        {island.atNotch && <>
        <div className="island-ear island-ear-left" aria-hidden="true">
          <span className="island-heads" style={{ width: heads.span }}>
            {island.pinned && (
              <span className="island-head island-pinned-head glow" data-moment={tucked.pinned?.moment ?? 'ready'} style={{ left: 0, zIndex: figures }}>
                <FigureStill figure={figureFor(island.pinned.id, island.pinned.job.figure)} alt="" />
              </span>
            )}
            {first === 'mark' && (
              <span className="island-head island-mark" style={{ left: 0, width: heads.mark, zIndex: figures }}>
                <LoomMark size={heads.mark} />
              </span>
            )}
            {tucked.heads.map((team, index) => (
              <span key={team.runId} className="island-head glow" data-moment={team.moment} style={{ left: heads.first + index * heads.step, zIndex: figures - index - 1 }}>
                <FigureStill figure={island.figure(team.teamPath, team.agent)} alt="" />
              </span>
            ))}
          </span>
          {tucked.more > 0 && <span className="island-more">+{tucked.more}</span>}
        </div>
        <div className="island-ear island-ear-right" aria-hidden="true" data-right={tucked.right}>
          {tucked.right === 'count' && <span className="island-count">{tucked.asks}</span>}
          {tucked.right === 'slip' && <i className="island-slip-mark" />}
          {tucked.right === 'time' && <span className="island-time">{workedFor((tucked.heads[0] ?? tucked.pinned)?.startedAt ?? null, island.now)}</span>}
        </div>
        </>}
        {(view === 'list' || view === 'box' || view === 'bench') && <List island={island} mode={view} />}
        {!island.atNotch && <Pill island={island} />}
        </div>
      </div>
      {island.folding && <Fold island={island} />}
    </div>
  )
}

/**
 * The words just sent, folding into the head of their agent at its workbench, which takes the box's
 * place: from where they were written to where its head is on the bench.
 */
function Fold({ island }: { island: IslandState }) {
  const folding = island.folding!
  if (!folding.from) return null
  const listTop = island.atNotch ? island.bar + 4 : island.bar + 10
  const style = {
    '--fx': `${folding.from.x}px`,
    '--fy': `${folding.from.y}px`,
    '--tx': `${window.innerWidth / 2}px`,
    '--ty': `${listTop + BENCH_HEAD}px`,
  } as CSSProperties
  return <span key={folding.at} className="island-fold" style={style} aria-hidden="true">{folding.text}</span>
}

/** How far below the top of the list its agent's head is on the bench: its row, then about a third
    of the way down the bench. */
const BENCH_HEAD = 160

/**
 * Without a notch: after a message from the box, its agent tucked away in a pill hanging from the
 * menu bar, sitting at a little desk, the sign that its workbench is there, with how long it has
 * worked; pointed at, the workbench opens. Then what it asks or answers slides out below.
 */
function Pill({ island }: { island: IslandState }) {
  const work = island.teams.find((team) => team.pinned) ?? null
  const phase = useActing(island.view === 'pill' ? work : null, work?.agent ?? null, island.now)
  const box = island.box
  if (!box) return null
  const moment = island.view === 'pill' ? 'work' : work?.moment ?? 'ready'
  // How long, once there is a minute to say: until then the pill is only as wide as its figure.
  const time = island.view === 'pill' && work?.moment === 'work' ? workedFor(work.startedAt, island.now) : ''
  return (
    <div className="island-pill" aria-hidden="true">
      <span className="island-pill-desk">
        <span className="island-pill-figure glow" data-moment={moment} data-phase={phase ?? undefined}>
          <FigureStill figure={figureFor(box.id, box.job.figure)} alt="" />
        </span>
      </span>
      {time && <span className="island-time">{time}</span>}
    </div>
  )
}

/** The agent at work, peeking up below the notch: every agent of the run has its place, so at a
    handover one ducks and the next pops up. */
function Balcony({ island }: { island: IslandState }) {
  const shown = island.shown
  const current = !shown ? null : shown.pop.kind === 'start' || shown.pop.kind === 'handover' ? shown.pop.key : shown.team.agent
  const phase = useActing(island.view === 'work' ? shown?.team : null, current, island.now)
  if (!shown) return null
  const agents = shown.team.agents.length ? shown.team.agents : current ? [current] : []
  return (
    <div className="island-balcony" aria-hidden="true">
      {agents.map((agent) => (
        <span key={agent} className={`island-slot glow${agent === current ? ' is-on' : ''}`} data-agent={agent} data-moment={shown.team.moment} data-phase={agent === current ? phase ?? undefined : undefined}>
          <FigureStill figure={island.figure(shown.team.teamPath, agent)} alt="" />
        </span>
      ))}
    </div>
  )
}

/**
 * What `agent` is at in `team`'s run while it works, from the run's events, for its figure to act
 * out as Team at work's does: `null` when it isn't at work, for an answer in the chat, which has no
 * run, and until the run's events have arrived, which would otherwise read as its first moments.
 * Only a figure that is out follows its run, one connection each, while it is drawn.
 */
function useActing(team: TeamNow | null | undefined, agent: string | null, now: number): WorkPhase | null {
  const runId = team?.moment === 'work' && !team.chat && agent ? team.runId : ''
  const { events, loading } = useSessionEvents(runId)
  return runId && agent && !loading ? workPhase(events, agent, now) : null
}

/** A question, dropped on a gold line, held by the agent that asks it. */
function Hang({ island, onPointerEnter, onPointerLeave }: { island: IslandState; onPointerEnter: (event: ReactPointerEvent) => void; onPointerLeave: (event: ReactPointerEvent) => void }) {
  const shown = island.shown?.pop.kind === 'ask' ? island.shown : null
  // The pinned agent asking to start one of your teams hangs on the same gold line.
  const teamAsk = shown ? shown.team.teamAsks?.find((request) => teamAskKey(request) === shown.pop.key) ?? null : null
  const ticket = teamAsk ? null : shown?.team.asks.find((ask) => ask.id === shown.pop.key) ?? shown?.team.asks[0] ?? null
  return (
    <div className="island-hang" aria-hidden={island.view !== 'ask'} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <div className="island-swing">
        <i className="island-line" />
        {shown && teamAsk && (
          <>
            <span className="island-hang-figure glow" data-moment="ask">
              <FigureStill figure={island.figure(shown.team.teamPath, shown.team.agent)} alt="" />
            </span>
            <div className="island-card" role="group" aria-label={`${shown.team.teamName} wants ${teamAsk.team.name} to do this: ${teamAsk.request}`}>
              <TeamAskBody island={island} request={teamAsk} first start decline={false} />
            </div>
          </>
        )}
        {shown && ticket && (
          <>
            <span className="island-hang-figure glow" data-moment="ask">
              <FigureStill figure={island.figure(shown.team.teamPath, ticket.node ?? shown.team.agent)} alt="" />
            </span>
            <div className="island-card" role="group" aria-label={`${shown.team.teamName}: ${ticket.text}`}>
              <AskBody island={island} team={shown.team} ticket={ticket} first />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * What a question says, and its answers. A permission for the web, a file or a connected tool takes
 * Deny or Allow here; anything else opens LoomWatch at its run, where it can be read in full.
 */
function AskBody({ island, team, ticket, first }: { island: IslandState; team: TeamNow; ticket: Ticket; first: boolean }) {
  const failed = island.failed === ticket.id
  const here = ticket.kind === 'permission' && team.quick.includes(ticket.id) && !failed
  const said = island.said?.ticket === ticket.id ? island.said.text : null
  const text = ticket.text.trim() || (ticket.kind === 'review' ? 'Waiting for your review.' : 'Waiting for your answer.')
  const context = ticket.kind === 'permission' || ticket.kind === 'spend' ? ticket.context : null
  return (
    <>
      <div className="island-words">
        <small>{team.teamName}</small>
        <p className="island-ask">{text}</p>
        {context && <small className="island-detail">{context}</small>}
        {failed && <small className="island-problem" role="alert">That didn’t go through. Answer it in LoomWatch.</small>}
        {said && <small className="island-said" role="status">{said}</small>}
      </div>
      {!said && (
        <div className="island-acts">
          {here ? (
            <>
              <button type="button" className="island-button" disabled={island.busy === ticket.id} onClick={() => island.answer(team, ticket, 'deny')}>Deny</button>
              <button type="button" className={`island-button${first ? ' is-primary' : ''}`} disabled={island.busy === ticket.id} onClick={() => island.answer(team, ticket, 'allow_once')}>Allow</button>
            </>
          ) : (
            <button type="button" className="island-button" onClick={() => island.open(team)}>{OPEN_WORDS[ticket.kind]}</button>
          )}
        </div>
      )}
    </>
  )
}

/** What a result says: "Trip planner is done" or "Trip planner stopped"; "Writer answered in Trip
    planner" for an answer in the chat, where the team did no work, or "Writer didn't answer" ("Trip
    planner didn't answer" when three or more didn't); "Maya answered" from the agent pinned to the
    notch, and "Trip planner didn't start" for a team it asked that couldn't. */
function resultWords(team: TeamNow): string {
  if (team.didNotStart) return `${team.teamName} didn’t start`
  if (team.chat && team.moment === 'fail') return `${team.agentName ?? team.teamName} didn’t answer`
  if (team.moment === 'fail') return `${team.teamName} stopped`
  if (team.pinned) return `${team.teamName} answered`
  if (team.chat) return `${team.agentName ?? 'The team'} answered in ${team.teamName}`
  return `${team.teamName} is done`
}

/** Where a result's button goes: why a run stopped, an answer, the chat an agent didn't answer in,
    or a team the pinned agent asked that didn't start. */
function resultButton(team: TeamNow): string {
  if (team.didNotStart) return `Open ${team.teamName}`
  if (team.moment !== 'fail') return 'See answer'
  return team.chat ? 'Open chat' : 'See why'
}

/** A finished or stopped run's result, sliding out below the agent that did the work. */
function Slip({ island, onPointerEnter, onPointerLeave }: { island: IslandState; onPointerEnter: (event: ReactPointerEvent) => void; onPointerLeave: (event: ReactPointerEvent) => void }) {
  const shown = island.shown && (island.shown.pop.kind === 'done' || island.shown.pop.kind === 'fail') ? island.shown : null
  // The pinned agent's answer can also be copied whole.
  const answer = shown?.team.pinned && shown.team.moment === 'done'
  return (
    <div className={`island-slip${answer ? ' is-answer' : ''}`} aria-hidden={island.view !== 'done' && island.view !== 'fail'} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      {shown && (answer ? <AnswerSlip island={island} team={shown.team} /> : <ResultBody island={island} team={shown.team} />)}
    </div>
  )
}

function ResultBody({ island, team }: { island: IslandState; team: TeamNow }) {
  return (
    <>
      <div className="island-words">
        <small>{resultWords(team)}</small>
        <p>{team.result}</p>
      </div>
      <div className="island-acts">
        <button type="button" className="island-button" onClick={() => island.open(team)}>{resultButton(team)}</button>
      </div>
    </>
  )
}

/**
 * Pointing at the notch: the box's agent, then one row per team, questions first. As the box
 * without a notch (`box`), and while the agent's workbench is open, only the agent: its workbench
 * takes the rows' place. Its agent at its workbench on its own (`bench`), for a moment after a
 * message goes and while it is pointed at then, or at its pill without a notch, is the same list.
 * While a message is written its bench is set up out of sight, so the bench is there as the box
 * gives way to it, and the words fold into a head already there.
 */
function List({ island, mode }: { island: IslandState; mode: 'list' | 'box' | 'bench' }) {
  const watching = mode === 'bench'
  const pinnedWork = island.box && island.pinned?.id === island.box.id ? island.teams.find((team) => team.pinned) ?? null : null
  // A team the pinned agent started works on its stage, in its row; a question from it stays a row.
  const crews = island.teams.filter((team) => team.crewFor && team.moment === 'work')
  const teams = mode !== 'list' || island.bench ? [] : island.teams.filter((team) => !team.pinned && !(team.crewFor && team.moment === 'work'))
  const rows = teams.slice(0, LIST_ROWS)
  const more = teams.length - rows.length
  const firstPermission = [...(pinnedWork ? [pinnedWork] : []), ...rows].flatMap((team) => team.asks.filter((ask) => team.quick.includes(ask.id)))[0]?.id
  // The island grows to the list's height, which only the drawn list knows.
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = list.current
    element?.closest<HTMLElement>('.island')?.style.setProperty('--list-h', `${element.offsetTop + element.offsetHeight + 10}px`)
  })
  return (
    <div ref={list} className="island-list">
      {island.box && <PinnedRow island={island} work={pinnedWork} crews={crews} firstPermission={firstPermission} watching={watching} foot={mode === 'list'} />}
      {island.box && (island.bench || watching || island.composing || island.sending) && <Suspense fallback={null}><BenchCard island={island} hidden={!island.bench && !watching} /></Suspense>}
      {rows.length === 0 && !island.box && <p className="island-quiet">Nothing is running</p>}
      {rows.map((team) => (
        <div key={team.runId} className="island-row" data-moment={team.moment}>
          <RowFigures island={island} team={team} />
          {team.moment === 'ask' && team.asks[0] ? (
            <AskBody island={island} team={team} ticket={team.asks[0]} first={team.asks[0].id === firstPermission} />
          ) : team.moment === 'work' ? (
            <div className="island-words">
              <small>{team.teamName}</small>
              <p>{working(team, island.now)}</p>
            </div>
          ) : (
            <ResultBody island={island} team={team} />
          )}
        </div>
      ))}
      {mode === 'list' && <div className="island-list-foot">
        {more > 0 && <span>{more === 1 ? '1 more team' : `${more} more teams`} in LoomWatch</span>}
        {/* The box's agent's answer, when it has one, opens from here: its row has Copy only. */}
        <button type="button" className="island-button" onClick={() => (pinnedWork?.moment === 'done' ? island.open(pinnedWork) : island.openApp())}>Open in LoomWatch</button>
        {inApp() && (
          <button
            type="button"
            className="island-button island-more-button"
            aria-label="More"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              tellApp({ kind: 'menu', x: Math.round(box.left), y: Math.round(box.bottom) })
            }}
          >
            ⋯
          </button>
        )}
      </div>}
    </div>
  )
}

/** A team's figures in its row: the one acting in front, acting out what it is at while it works,
    and the rest a step behind. */
function RowFigures({ island, team }: { island: IslandState; team: TeamNow }) {
  const phase = useActing(team, team.agent, island.now)
  return (
    <span className="island-row-figures" aria-hidden="true" data-moment={team.moment}>
      {(team.agents.length ? team.agents : [team.agent]).slice(0, 3).map((agent, index) => (
        <span key={agent ?? index} className={`island-row-figure${agent === team.agent ? ' glow' : ' is-behind'}`} data-moment={team.moment} data-phase={agent === team.agent ? phase ?? undefined : undefined} style={{ left: index * 16, zIndex: agent === team.agent ? 4 : 3 - index }}>
          <FigureStill figure={island.figure(team.teamPath, agent)} alt="" />
        </span>
      ))}
    </span>
  )
}

/**
 * The box's agent: what it is doing, if anything, and a box to message it. A message starts its
 * work, or joins it as a note while it works; its answer slides out as any team's does. Its figure
 * opens its workbench; the other agents beside it, or Tab, switch the box to one of them. Watching
 * it at its workbench (`watching`), its row only says what it is doing: a click on the island
 * opens the box again. Under the list's foot (`foot`), its answer opens from the foot.
 */
function PinnedRow({ island, work, crews, firstPermission, watching, foot }: { island: IslandState; work: TeamNow | null; crews: readonly TeamNow[]; firstPermission: string | undefined; watching: boolean; foot: boolean }) {
  const pinned = island.box!
  const others = island.agents.filter((agent) => agent.id !== pinned.id)
  const field = useRef<HTMLInputElement>(null)
  // Writing began without the box, from ⌃⌥Space or a drop, and the app gave the panel the
  // keyboard: the box takes it. Only then; pointing at the notch never does.
  const writing = island.composing
  useEffect(() => {
    if (writing && document.activeElement !== field.current) field.current?.focus()
  }, [writing])
  const moment = work?.moment ?? 'ready'
  const phase = useActing(work, work?.agent ?? null, island.now)
  const teamAsk = work?.teamAsks?.[0]
  // Its request to start a team waits for Start, which sits in Send's place until something is
  // written there, or under the request while something dropped has the box.
  const asking = teamAsk && island.teamSaid?.id !== teamAsk.id ? teamAsk : null
  const limit = useRunLimit(asking?.team.path ?? null)
  const startHere = asking && !island.draft.trim() && !island.intake ? asking : null
  // While it works, a message is a note it reads after its current step, as its Chat tab says; the
  // box shows the short form, and the whole of it is its name and tooltip.
  const to = island.intake ? 'Or say what to do' : asking ? `Or message ${pinned.name}` : island.pinnedWorking ? `Note for ${pinned.name}` : `Message ${pinned.name}`
  const toWhole = island.pinnedWorking && !island.intake ? `${to} · after its current step` : to
  const figure = (
    <span className="island-row-figure glow" data-moment={moment} data-phase={phase ?? undefined}>
      <FigureStill figure={figureFor(pinned.id, pinned.job.figure)} alt="" />
    </span>
  )
  if (watching) {
    const doing = work?.moment === 'work' ? working(work, island.now) : work?.moment === 'done' ? `${pinned.name} answered` : work?.moment === 'fail' ? `${pinned.name} stopped` : `${pinned.name} just started`
    return (
      <div className="island-row island-pinned" data-moment={moment}>
        <span className="island-row-figures" aria-hidden="true">{figure}</span>
        <div className="island-box-head"><p className="island-box-doing">{doing}</p></div>
      </div>
    )
  }
  return (
    <div className={`island-row island-pinned${asking ? ' is-asking' : ''}`} data-moment={moment}>
      {/* Pressing a figure keeps the keyboard in the box: WebKit would otherwise take it away from
          the box without giving it to the button, and the box would close. */}
      <button
        type="button"
        className="island-row-figures island-bench-toggle"
        aria-label={island.bench ? `Hide ${pinned.name}’s workbench` : `See ${pinned.name}’s workbench`}
        aria-expanded={island.bench}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => island.setBench(!island.bench)}
      >
        {figure}
      </button>
      {/* Who the message goes to, by name: the field's own words go once something is written. */}
      <div className="island-box-head">
        <b className="island-box-name">{pinned.name}</b>
        {others.length > 0 && (
          <div className="island-agents" role="group" aria-label="Switch agent">
            {others.slice(0, OTHER_AGENTS).map((agent) => (
              <button key={agent.id} type="button" className="island-agent" aria-label={`Message ${agent.name.trim() || agent.id} instead`} onPointerDown={(event) => event.preventDefault()} onClick={() => island.choose(agent.id)}>
                <FigureStill figure={figureFor(agent.id, agent.figure)} alt="" />
              </button>
            ))}
            {others.length > OTHER_AGENTS && <span className="island-more">+{others.length - OTHER_AGENTS}</span>}
            {!island.draft && <kbd className="island-key" aria-hidden="true">tab</kbd>}
          </div>
        )}
      </div>
      {teamAsk ? (
        <TeamAskBody island={island} request={teamAsk} first={!firstPermission} start={Boolean(island.intake)} decline />
      ) : work?.moment === 'ask' && work.asks[0] ? (
        <AskBody island={island} team={work} ticket={work.asks[0]} first={work.asks[0].id === firstPermission} />
      ) : work?.moment === 'work' ? (
        <div className="island-words">
          <p>{working(work, island.now)}</p>
        </div>
      ) : work?.moment === 'done' ? (
        <AnswerSlip island={island} team={work} foot={foot} />
      ) : work ? (
        <ResultBody island={island} team={work} />
      ) : null}
      {crews.map((crew) => <CrewStage key={crew.runId} island={island} crew={crew} />)}
      <IntakeJobs island={island} />
      {island.away && <small className="island-away" role="alert"><StatusGlyph status="failed" /><span>{island.away}</span></small>}
      <form
        className="island-compose"
        onSubmit={(event) => {
          event.preventDefault()
          island.send()
        }}
      >
        {/* Send is a mark in the field's end, there once something is written; Enter sends too. A
            note while it works is the team chat's mark for one: a return arrow, not up. */}
        <span className="island-field-box" data-written={island.draft.trim() ? '' : undefined}>
        <input
          ref={field}
          className="island-field"
          value={island.draft}
          placeholder={to}
          aria-label={toWhole}
          title={toWhole}
          maxLength={4000}
          disabled={island.sending}
          onChange={(event) => island.setDraft(event.target.value)}
          onFocus={() => island.compose(true)}
          // Tab to Copy, Open in LoomWatch or Start keeps the island writing, and the keyboard with it.
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.closest('.island-list')?.contains(event.relatedTarget)) return
            island.compose(false)
          }}
          onKeyDown={(event) => {
            // Escape folds an open workbench first (`useIsland`), then puts the box away.
            if (event.key === 'Escape' && !island.bench) event.currentTarget.blur()
            // Before anything is written, Tab switches the box to the next agent, Shift-Tab back.
            // Once something is, Tab moves on, as anywhere: a habit Tab to reach Send must not send
            // the message to someone else. Option-Tab moves on too, as in any Mac app.
            if (event.key === 'Tab' && !event.altKey && others.length > 0 && !island.draft) {
              event.preventDefault()
              island.choose(nextAgent(island.agents, pinned.id, event.shiftKey ? -1 : 1))
            }
          }}
        />
        {!startHere && (
          <button type="submit" className="island-send" aria-label={island.pinnedWorking ? 'Send note' : 'Send'} disabled={island.sending || !island.draft.trim()}>{island.pinnedWorking ? <CornerDownLeft size={16} aria-hidden="true" /> : <ArrowUp size={17} aria-hidden="true" />}</button>
        )}
        </span>
        {startHere && <StartTeam island={island} request={startHere} first={!firstPermission} limit={limit} />}
      </form>
      {island.sent?.ok && <small className="island-sent" role="status">{island.sent.text}</small>}
      {island.sent && !island.sent.ok && (
        <div className="island-sent island-sent-failed">
          <small className="island-problem" role="alert"><StatusGlyph status="failed" /><span>{island.sent.text}</span></small>
          <button type="button" className="island-button" onClick={island.openPinned}>Open chat</button>
        </div>
      )}
    </div>
  )
}

/** The agent after `id` in My agents, or before it with `step` -1, round from the end. */
function nextAgent(agents: readonly { id: string }[], id: string, step: 1 | -1): string {
  const at = agents.findIndex((agent) => agent.id === id)
  return agents[(at + step + agents.length) % agents.length].id
}

/** "Writer is working · 4 min", or "Writer just started"; "Writer is answering" in the chat. */
function working(team: TeamNow, now: number): ReactNode {
  const who = team.agentName ?? 'The team'
  const time = workedFor(team.startedAt, now, 'long')
  if (team.chat) return time ? <>{who} is answering <span className="island-nowrap">· {time}</span></> : `${who} is answering`
  if (!time) return `${who} just started`
  return <>{who} is working <span className="island-nowrap">· {time}</span></>
}

/** Where the figures beside the notch go: the pinned agent at the left, then each other team's head,
    overlapping the one before; or LoomWatch's mark alone, when there is no figure. */
function headsLayout(first: 'pinned' | 'mark' | 'none', others: number, bar: number): { mark: number; first: number; step: number; span: number } {
  const head = Math.round(bar * 1.06)
  const mark = Math.round(bar * 0.78)
  const step = Math.round(bar * 0.62)
  if (first === 'mark') return { mark, first: 0, step, span: mark }
  const start = first === 'pinned' ? step : 0
  return { mark, first: start, step, span: others ? start + (others - 1) * step + head : first === 'pinned' ? head : 0 }
}

/** What a screen reader hears of the island as a whole: without a notch, what a press on it does,
    and nothing once it is the box, whose own controls say what they do. */
function shapeLabel(island: IslandState): string {
  if (island.atNotch) return label(island)
  if (!island.box || island.view === 'box') return 'LoomWatch'
  return island.view === 'pill' ? `See ${island.box.name}’s workbench` : `Message ${island.box.name}`
}

/** What a screen reader hears of the island. */
function label(island: IslandState): string {
  const { asks } = island.tucked
  if (asks) return asks === 1 ? 'LoomWatch: 1 thing needs you' : `LoomWatch: ${asks} things need you`
  const result = island.teams.find((team) => team.moment === 'done' || team.moment === 'fail')
  if (result) return `LoomWatch: ${resultWords(result)}`
  const busy = island.teams.filter((team) => team.moment === 'work').length
  if (busy) return busy === 1 ? 'LoomWatch: 1 team is working' : `LoomWatch: ${busy} teams are working`
  return 'LoomWatch'
}

/**
 * Tell the Mac app where the island and whatever dropped out of it are, so the panel takes the
 * pointer there and lets every other click through. Measured after each change and whenever a
 * resize or a slide ends.
 */
function useReportAreas(root: RefObject<HTMLDivElement | null>, view: string) {
  const last = useRef('')
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const report = () => {
      // The island first, then what dropped out of it: the app numbers them in this order.
      const parts = view === 'hidden' ? [] : [
        element.querySelector<HTMLElement>('.island-shape'),
        ...[...element.querySelectorAll<HTMLElement>('.island-card, .island-slip')].filter((part) => part.closest('[aria-hidden="false"]')),
      ]
      const rects: Area[] = parts
        .flatMap((part) => (part ? [part.getBoundingClientRect()] : []))
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }))
      const key = JSON.stringify(rects)
      if (key === last.current) return
      last.current = key
      tellApp({ kind: 'areas', rects })
    }
    const frame = window.requestAnimationFrame(report)
    element.addEventListener('transitionend', report)
    element.addEventListener('animationend', report)
    return () => {
      window.cancelAnimationFrame(frame)
      element.removeEventListener('transitionend', report)
      element.removeEventListener('animationend', report)
    }
  })
}
