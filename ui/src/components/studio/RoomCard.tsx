import { Fragment, type ReactNode } from 'react'

import { otherTeams, type Room, type RoomTeam } from '../../lib/projects/studio'
import { markOf, type FigureOf } from '../../lib/projects/studioUi'
import { PRESENCE_WORDS } from '../../lib/rail/presence'
import { listNames } from '../../lib/format'
import { teamHref } from '../../lib/team-file/teamHref'
import { FileChip } from '../ui/FileChip'
import { TeamDesks } from './TeamDesks'

/** The small square beside a project's name: the only colour a room has. */
export function ProjectMark({ id, mark, size = 14 }: { id: string; mark?: string; size?: number }) {
  return <span className="project-mark" data-mark={markOf(id, mark)} style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * A room's line, then the other teams at work by name, then how many more: "Researcher is waiting
 * for you · Product pages is working · 1 other team ready". The list on Home, which names every
 * team, leaves out the count.
 */
export function RoomWords({ room, count = true }: { room: Room; count?: boolean }) {
  const { named, more, moreQuiet } = otherTeams(room)
  const s = more === 1 ? '' : 's'
  // A dot is held to the words before it, so the line breaks only between teams.
  const dot = <span className="room-sep">{' ·'}</span>
  return (
    <>
      {room.line}
      {named.map((other) => (
        <Fragment key={other.path}>{dot}{' '}<span className="room-other">{other.name} <span className={`room-state ${other.state}`}>{other.words}</span></span></Fragment>
      ))}
      {/* After a team at work, a bare "1 more team" would read as one more at work. */}
      {count && more > 0 && <>{dot}{' '}<span className="room-more">{room.state === 'ready' || !moreQuiet ? `${more} more team${s}` : `${more} other team${s} ready`}</span></>}
    </>
  )
}

/** How many teams a room card lists before "N more". */
const TEAMS_LISTED = 4

/** What a team is doing, in words: who is waiting or working, that it stopped, when it runs, or ready. */
function teamLine(team: RoomTeam): string {
  const seat = team.seats.find((candidate) => candidate.kind === 'agent' && candidate.state === team.state)
  if (team.state === 'waiting' || team.state === 'working') return seat ? `${seat.name} is ${PRESENCE_WORDS[team.state]}` : `${PRESENCE_WORDS[team.state]}`
  if (team.state === 'failed') return 'Didn’t finish'
  if (team.schedule) return `Runs ${team.schedule.charAt(0).toLowerCase()}${team.schedule.slice(1)}`
  return 'Ready'
}

/** The shape that says a team's state beside its colour and words: a ring waits, a dot works, a cross stopped. */
function StateShape({ state }: { state: RoomTeam['state'] }) {
  if (state === 'waiting') return <svg className="glance-shape waiting" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /></svg>
  if (state === 'working') return <span className="glance-dot" aria-hidden="true" />
  if (state === 'failed') return <svg className="glance-shape failed" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
  return <span className="room-card-noshape" aria-hidden="true" />
}

/** A team on one line, the whole line opening its chat: on a room's card, and under "Not in a project". */
export function TeamLine({ team, figureOf }: { team: RoomTeam; figureOf: FigureOf }) {
  return (
    <a className="room-card-team" href={teamHref(team.path, 'chat')}>
      <StateShape state={team.state} />
      <span className="room-card-team-words">
        <b>{team.name}</b>
        <small className={`room-state ${team.state}`}>{teamLine(team)}</small>
        {/* The same team works in other projects too, each with its own work (ADR 0103). */}
        {team.alsoIn?.length ? <small className="room-card-also">Also in {listNames(team.alsoIn.map((project) => project.name))}</small> : null}
      </span>
      <TeamDesks team={team} figureOf={figureOf} size={26} compact />
    </a>
  )
}

/**
 * A project's room on Home (ADR 0097), at a glance: each team on a line, most pressing first, with
 * what it is doing and its agents' figures, the whole line opening its chat; then the newest thing
 * made here, one press from being read, and what this month cost. The rest of the card opens the
 * room.
 */
export function RoomCard({ room, figureOf, onOpen, newest = null, spend = null, menu = null }: {
  room: Room
  figureOf: FigureOf
  onOpen: () => void
  /** Its "…", above the card's link: what is done to the project itself. */
  menu?: ReactNode
  /** The newest file the agents here made. */
  newest?: string | null
  /** What this month cost here, in words. */
  spend?: string | null
}) {
  const more = room.teams.length - TEAMS_LISTED
  return (
    <article className="room-card" data-state={room.state} aria-labelledby={`room-${room.id}`}>
      <div className="room-card-top">
        <h3 className="room-card-name">
          <button type="button" id={`room-${room.id}`} onClick={onOpen}>
            <ProjectMark id={room.id} mark={room.mark} />
            <span>{room.name}</span>
          </button>
        </h3>
        {room.teams.length > 1 && <span className="room-card-count">{room.teams.length} teams</span>}
        {menu}
      </div>
      {room.teams.length === 0 ? <p className="desk-empty">No team yet</p> : (
        <ul className="room-card-teams" aria-label={`${room.name}’s teams`}>
          {room.teams.slice(0, TEAMS_LISTED).map((team) => (
            <li key={team.path}><TeamLine team={team} figureOf={figureOf} /></li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="room-card-more">{more} more team{more === 1 ? '' : 's'}</p>}
      {(newest || spend) && (
        <div className="room-card-foot">
          {newest && <span className="room-card-file"><FileChip path={newest} /></span>}
          {spend && <span className="room-card-spend">{spend}</span>}
        </div>
      )}
    </article>
  )
}
