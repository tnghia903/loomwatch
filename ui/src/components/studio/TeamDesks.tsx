import { PRESENCE_WORDS } from '../../lib/rail/presence'
import { AT_YOUR_DESK, seatWords, shownSeats, type RoomTeam, type Seat } from '../../lib/projects/studio'
import type { FigureOf } from '../../lib/projects/studioUi'
import { FigureStill } from '../agents/FigureStill'
import { AgentMark } from '../ui/AgentMark'

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
 * you, red failed), or faint with no glow when it is somewhere else now, with where; or, where you
 * check, the ring you wear on the canvas and in Details. The figure alone carries the glow, one
 * light per element (WebKit drops a second).
 */
function Desk({ seat, figureOf, size, onAway }: { seat: Seat; figureOf: FigureOf; size: number; onAway?: (seat: Seat) => void }) {
  const words = seatWords(seat)
  const label = seat.kind === 'you' ? 'You check' : seat.name
  const body = (
    <>
      {seat.kind === 'you'
        ? <span className="desk-you" aria-hidden="true"><AgentMark id={seat.id} operator size={Math.round(size * 0.78)} /></span>
        // An agent elsewhere is still itself here, faint: its desk keeps its place in the row.
        : <span className={`desk-figure${seat.away ? ' away' : ''}`} data-glow={seat.away ? undefined : seat.state}><FigureStill figure={figureOf(seat)} alt="" width={size} height={size} decoding="async" /></span>}
      <span className="desk-top" aria-hidden="true" />
      <span className="desk-name">{label}</span>
      {/* Never colour alone: a desk that isn't simply ready says how it is, or where its agent is. */}
      {seat.kind === 'agent' && (seat.away ?? PRESENCE_WORDS[seat.state]) && <span className={`desk-state ${seat.away ? 'away' : seat.state}`}>{seat.away ?? PRESENCE_WORDS[seat.state]}</span>}
    </>
  )
  // Only an agent at your desk is pressed here, to go to it; any other desk opens the room with its card.
  if (seat.away === AT_YOUR_DESK && onAway) {
    return <button type="button" className="desk away" title={words} aria-label={words} onClick={() => onAway(seat)}>{body}</button>
  }
  return <span className={`desk${seat.away ? ' away' : ''}`} title={words}>{body}</span>
}

/**
 * A team's row of desks, in the order work moves, with arrows between them. A room card shows at
 * most four, then "+N"; the room itself shows them all.
 */
export function TeamDesks({ team, figureOf, size = 44, all = false, onAway }: { team: RoomTeam; figureOf: FigureOf; size?: number; all?: boolean; onAway?: (seat: Seat) => void }) {
  const { shown, more } = all ? { shown: team.seats, more: 0 } : shownSeats(team.seats)
  const said = team.seats.map((seat) => seatWords(seat)).join(', then ')
  return (
    <div className={`team-desks${all ? ' all' : ''}`} style={{ ['--fig' as string]: `${size}px` }} role="group" aria-label={`${team.name}: ${said || 'no agents yet'}`}>
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
