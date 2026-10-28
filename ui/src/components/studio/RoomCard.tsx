import type { Room, Seat } from '../../lib/projects/studio'
import { leadTeam, markOf, type FigureOf } from '../../lib/projects/studioUi'
import { TeamDesks } from './TeamDesks'

/** The small square beside a project's name: the only colour a room has. */
export function ProjectMark({ id, mark, size = 14 }: { id: string; mark?: string; size?: number }) {
  return <span className="project-mark" data-mark={markOf(id, mark)} style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * A project's room on Home: neutral, with its mark, its busiest team's desks, and one line saying
 * what is happening. The whole card opens the room.
 */
export function RoomCard({ room, figureOf, onOpen, onAway }: { room: Room; figureOf: FigureOf; onOpen: () => void; onAway?: (seat: Seat) => void }) {
  const team = leadTeam(room)
  const others = room.teams.length - 1
  return (
    <article className="room-card" data-state={room.state} aria-labelledby={`room-${room.id}`}>
      <h3 className="room-card-name">
        <button type="button" id={`room-${room.id}`} onClick={onOpen}>
          <ProjectMark id={room.id} mark={room.mark} />
          <span>{room.name}</span>
        </button>
      </h3>
      <div className="room-card-floor">
        {team ? <TeamDesks team={team} figureOf={figureOf} onAway={onAway} /> : <span className="desk-empty">No team yet</span>}
      </div>
      <p className={`room-line ${room.state}`}>
        {room.line}
        {others > 0 && <span className="room-more">{` · ${others} more team${others === 1 ? '' : 's'}`}</span>}
      </p>
    </article>
  )
}
