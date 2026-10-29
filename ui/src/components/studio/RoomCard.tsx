import { Fragment } from 'react'

import { otherTeams, type Room, type Seat } from '../../lib/projects/studio'
import { leadTeam, markOf, type FigureOf } from '../../lib/projects/studioUi'
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
  const dot = <span className="room-sep">{'\u00a0·'}</span>
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

/**
 * A project's room on Home: neutral, with its mark, its busiest team's desks, and one line saying
 * what is happening. With more teams, the desks carry their team's name and the line names every
 * other team at work. The whole card opens the room.
 */
export function RoomCard({ room, figureOf, onOpen, onAway }: { room: Room; figureOf: FigureOf; onOpen: () => void; onAway?: (seat: Seat) => void }) {
  const team = leadTeam(room)
  return (
    <article className="room-card" data-state={room.state} aria-labelledby={`room-${room.id}`}>
      <h3 className="room-card-name">
        <button type="button" id={`room-${room.id}`} onClick={onOpen}>
          <ProjectMark id={room.id} mark={room.mark} />
          <span>{room.name}</span>
        </button>
      </h3>
      <div className="room-card-floor">
        {team && room.teams.length > 1 && <span className="room-card-team">{team.name}</span>}
        {team ? <TeamDesks team={team} figureOf={figureOf} onAway={onAway} /> : <span className="desk-empty">No team yet</span>}
      </div>
      <p className={`room-line ${room.state}`}><RoomWords room={room} /></p>
    </article>
  )
}
