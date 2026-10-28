import { seatWords, shownSeats, type RoomTeam, type Seat } from '../../lib/projects/studio'
import type { FigureOf } from '../../lib/projects/studioUi'
import { FigureStill } from '../agents/FigureStill'

/** An agent's outline where it isn't now: its desk keeps its place in the row. */
function Outline({ size }: { size: number }) {
  return (
    <svg className="desk-outline" width={size} height={Math.round(size * 1.3)} viewBox="0 0 40 52" aria-hidden="true">
      <circle cx="20" cy="13" r="9" />
      <path d="M6 50 C6 34 11 26 20 26 C29 26 34 34 34 50 Z" />
    </svg>
  )
}

/** The arrow between two desks: work moves on to the next one. */
function Onward() {
  return (
    <svg className="desk-onward" width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
      <path d="M1 5 H17" />
      <path d="M14 1.5 L19 5 L14 8.5" />
    </svg>
  )
}

/**
 * One desk: the agent at it, glowing with its state (green ready, blue working, gold waiting for
 * you, red failed), or its outline when it is somewhere else now, with where; or the ring where you
 * check. The figure alone carries the glow, one light per element (WebKit drops a second).
 */
function Desk({ seat, figureOf, size, onAway }: { seat: Seat; figureOf: FigureOf; size: number; onAway?: (seat: Seat) => void }) {
  const words = seatWords(seat)
  const label = seat.kind === 'you' ? 'You check' : seat.name
  const body = (
    <>
      {seat.kind === 'you'
        ? <span className="desk-you" aria-hidden="true" />
        : seat.away
          ? <Outline size={size} />
          : <span className="desk-figure" data-glow={seat.state}><FigureStill figure={figureOf(seat)} alt="" width={size} height={Math.round(size * 1.3)} loading="lazy" decoding="async" /></span>}
      <span className="desk-top" aria-hidden="true" />
      <span className={`desk-name ${seat.away ? '' : seat.state}`}>{label}</span>
    </>
  )
  if (seat.away && onAway) {
    return <button type="button" className="desk away" title={words} aria-label={words} onClick={() => onAway(seat)}>{body}</button>
  }
  return <span className={`desk${seat.away ? ' away' : ''}`} title={words}>{body}</span>
}

/**
 * A team's row of desks, in the order work moves, with arrows between them. A room card shows at
 * most four, then "+N"; the room itself shows them all.
 */
export function TeamDesks({ team, figureOf, size = 34, all = false, onAway }: { team: RoomTeam; figureOf: FigureOf; size?: number; all?: boolean; onAway?: (seat: Seat) => void }) {
  const { shown, more } = all ? { shown: team.seats, more: 0 } : shownSeats(team.seats)
  const said = team.seats.map((seat) => seatWords(seat)).join(', then ')
  return (
    <div className="team-desks" role="group" aria-label={`${team.name}: ${said || 'no agents yet'}`}>
      {shown.map((seat, index) => (
        <span key={seat.id} className="desk-slot">
          {index > 0 && <Onward />}
          <Desk seat={seat} figureOf={figureOf} size={size} onAway={onAway} />
        </span>
      ))}
      {more > 0 && <span className="desk-more" aria-label={`and ${more} more`}>+{more}</span>}
      {team.seats.length === 0 && <span className="desk-empty">No agents yet</span>}
    </div>
  )
}
