// The island at the notch, drawn (ADR 0083): Peek. The agent at work peeks out below the notch; a
// question drops down on a gold line; a result slides out as a slip; then it all tucks into the
// menu bar beside the camera, one figure per busy team. Pointing at the notch opens the list.
import { useLayoutEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'

import { FigureStill } from '../components/agents/FigureStill'
import type { Ticket } from '../lib/story/needsYou'
import { inApp, tellApp, type Area } from './bridge'
import { workedFor, type TeamNow } from './teams'
import { useIsland, type Island as IslandState } from './useIsland'

/** Rows in the list before "N more teams in LoomWatch", as in the menu. */
const LIST_ROWS = 5

/** What a question's button says when it opens LoomWatch at its run rather than answering here. */
const OPEN_WORDS: Record<Ticket['kind'], string> = { question: 'Answer', review: 'Review', permission: 'Open', spend: 'Open', failed: 'Open' }

export function Island() {
  const island = useIsland()
  const { view, notch, bar, tucked } = island
  const root = useRef<HTMLDivElement>(null)
  useReportAreas(root, view)

  const headsWidth = headsSpan(tucked.heads.length, bar)
  const ear = Math.max(Math.round(bar * 1.5), headsWidth + 14 + (tucked.more ? 16 : 0))
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
    <div ref={root} className={`island${island.nudge ? ' is-nudging' : ''}`} data-view={view} style={style}>
      <div className="island-drop">
        <Hang island={island} onPointerEnter={onDrop(true)} onPointerLeave={onDrop(false)} />
        <Slip island={island} onPointerEnter={onDrop(true)} onPointerLeave={onDrop(false)} />
      </div>
      <div
        className="island-shape"
        role="button"
        tabIndex={view === 'hidden' ? -1 : 0}
        aria-label={label(island)}
        aria-expanded={view === 'list'}
        onPointerEnter={onIsland(true)}
        onPointerLeave={onIsland(false)}
        onClick={() => island.pointerOnIsland(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            island.pointerOnIsland(view !== 'list')
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          tellApp({ kind: 'menu', x: event.clientX, y: event.clientY })
        }}
      >
        <div className="island-body">
        <Balcony island={island} />
        <div className="island-ear island-ear-left" aria-hidden="true">
          <span className="island-heads" style={{ width: headsWidth }}>
            {tucked.heads.map((team, index) => (
              <span key={team.runId} className="island-head glow" data-moment={team.moment} style={{ left: index * Math.round(bar * 0.62), zIndex: tucked.heads.length - index }}>
                <FigureStill figure={island.figure(team.teamPath, team.agent)} alt="" />
              </span>
            ))}
          </span>
          {tucked.more > 0 && <span className="island-more">+{tucked.more}</span>}
        </div>
        <div className="island-ear island-ear-right" aria-hidden="true" data-right={tucked.right}>
          {tucked.right === 'count' && <span className="island-count">{tucked.asks}</span>}
          {tucked.right === 'slip' && <i className="island-slip-mark" />}
          {tucked.right === 'time' && <span className="island-time">{workedFor(tucked.heads[0]?.startedAt ?? null, island.now)}</span>}
        </div>
        {view === 'list' && <List island={island} />}
        </div>
      </div>
    </div>
  )
}

/** The agent at work, peeking up below the notch: every agent of the run has its place, so at a
    handover one ducks and the next pops up. */
function Balcony({ island }: { island: IslandState }) {
  const shown = island.shown
  if (!shown) return null
  const current = shown.pop.kind === 'start' || shown.pop.kind === 'handover' ? shown.pop.key : shown.team.agent
  const agents = shown.team.agents.length ? shown.team.agents : current ? [current] : []
  return (
    <div className="island-balcony" aria-hidden="true">
      {agents.map((agent) => (
        <span key={agent} className={`island-slot glow${agent === current ? ' is-on' : ''}`} data-agent={agent} data-moment={shown.team.moment}>
          <FigureStill figure={island.figure(shown.team.teamPath, agent)} alt="" />
        </span>
      ))}
    </div>
  )
}

/** A question, dropped on a gold line, held by the agent that asks it. */
function Hang({ island, onPointerEnter, onPointerLeave }: { island: IslandState; onPointerEnter: (event: ReactPointerEvent) => void; onPointerLeave: (event: ReactPointerEvent) => void }) {
  const shown = island.shown?.pop.kind === 'ask' ? island.shown : null
  const ticket = shown?.team.asks.find((ask) => ask.id === shown.pop.key) ?? shown?.team.asks[0] ?? null
  return (
    <div className="island-hang" aria-hidden={island.view !== 'ask'} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <div className="island-swing">
        <i className="island-line" />
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
    planner" for an answer in the chat, where the team did no work. */
function resultWords(team: TeamNow): string {
  if (team.moment === 'fail') return `${team.teamName} stopped`
  if (team.chat) return `${team.agentName ?? 'The team'} answered in ${team.teamName}`
  return `${team.teamName} is done`
}

/** A finished or stopped run's result, sliding out below the agent that did the work. */
function Slip({ island, onPointerEnter, onPointerLeave }: { island: IslandState; onPointerEnter: (event: ReactPointerEvent) => void; onPointerLeave: (event: ReactPointerEvent) => void }) {
  const shown = island.shown && (island.shown.pop.kind === 'done' || island.shown.pop.kind === 'fail') ? island.shown : null
  return (
    <div className="island-slip" aria-hidden={island.view !== 'done' && island.view !== 'fail'} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      {shown && <ResultBody island={island} team={shown.team} />}
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
        <button type="button" className="island-button" onClick={() => island.open(team)}>{team.moment === 'fail' ? 'See why' : 'See answer'}</button>
      </div>
    </>
  )
}

/** Pointing at the notch: one row per team, questions first. */
function List({ island }: { island: IslandState }) {
  const rows = island.teams.slice(0, LIST_ROWS)
  const more = island.teams.length - rows.length
  const firstPermission = rows.flatMap((team) => team.asks.filter((ask) => team.quick.includes(ask.id)))[0]?.id
  // The island grows to the list's height, which only the drawn list knows.
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = list.current
    element?.closest<HTMLElement>('.island')?.style.setProperty('--list-h', `${element.offsetTop + element.offsetHeight + 10}px`)
  })
  return (
    <div ref={list} className="island-list">
      {rows.length === 0 && <p className="island-quiet">Nothing is running</p>}
      {rows.map((team) => (
        <div key={team.runId} className="island-row" data-moment={team.moment}>
          <span className="island-row-figures" aria-hidden="true" data-moment={team.moment}>
            {(team.agents.length ? team.agents : [team.agent]).slice(0, 3).map((agent, index) => (
              <span key={agent ?? index} className={`island-row-figure${agent === team.agent ? ' glow' : ' is-behind'}`} data-moment={team.moment} style={{ left: index * 16, zIndex: agent === team.agent ? 4 : 3 - index }}>
                <FigureStill figure={island.figure(team.teamPath, agent)} alt="" />
              </span>
            ))}
          </span>
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
      <div className="island-list-foot">
        {more > 0 && <span>{more === 1 ? '1 more team' : `${more} more teams`} in LoomWatch</span>}
        <button type="button" className="island-button" onClick={island.openApp}>Open LoomWatch</button>
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
      </div>
    </div>
  )
}

/** "Writer is working · 4 min", or "Writer just started"; "Writer is answering" in the chat. */
function working(team: TeamNow, now: number): ReactNode {
  const who = team.agentName ?? 'The team'
  const time = workedFor(team.startedAt, now, 'long')
  if (team.chat) return time ? <>{who} is answering <span className="island-nowrap">· {time}</span></> : `${who} is answering`
  if (!time) return `${who} just started`
  return <>{who} is working <span className="island-nowrap">· {time}</span></>
}

/** The span of the tucked heads: each overlaps the one before. */
function headsSpan(count: number, bar: number): number {
  const head = Math.round(bar * 1.06)
  return count ? head + (count - 1) * Math.round(bar * 0.62) : 0
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
