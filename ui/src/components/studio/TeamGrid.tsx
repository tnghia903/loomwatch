import type { ReactNode } from 'react'

import type { MadeFile } from '../../lib/projects/glance'
import { litAt, type RoomTeam } from '../../lib/projects/studio'
import type { FigureOf } from '../../lib/projects/studioUi'
import { PRESENCE_WORDS } from '../../lib/rail/presence'
import { teamHref } from '../../lib/team-file/teamHref'
import { FileChip } from '../ui/FileChip'
import { TeamDesks } from './TeamDesks'

/** What a team is doing, when none of its desks shows it: it stopped, or nobody is at work yet. */
function said(team: RoomTeam): string | null {
  if (team.state === 'ready' || litAt(team)) return null
  return PRESENCE_WORDS[team.state]
}

/**
 * A room's teams as cards, in the order the room ranks them (ADR 0097): each with its name and how
 * it is, its agents at their desks, and the newest thing it made, one press from each. The name
 * opens the team's chat. A room with one team draws its desks bigger.
 */
export function TeamGrid({ teams, figureOf, newest, menu }: {
  teams: readonly RoomTeam[]
  figureOf: FigureOf
  /** The newest thing each team made, by the team's path. */
  newest: ReadonlyMap<string, MadeFile>
  /** A team's ⋯ menu, such as moving it to another project. */
  menu?: (team: RoomTeam) => ReactNode
}) {
  const one = teams.length === 1
  return (
    <div className={`team-grid${one ? ' one' : ''}`}>
      {teams.map((team) => {
        const file = newest.get(team.path)
        const words = said(team)
        return (
          <article key={team.path} className="team-card" data-state={team.state} aria-label={team.name}>
            <div className="team-card-head">
              {/* When no desk shows what the team is doing (it stopped, or nobody is at work yet), its name says it. */}
              <a className="room-team-name" href={teamHref(team.path, 'chat')}>
                <b>{team.name}</b>
                {words && <>{' '}<span className={`room-state ${team.state}`}>{words}</span></>}
                {team.schedule && <>{' '}<span className="room-team-when">{words ? `· ${team.schedule}` : team.schedule}</span></>}
              </a>
              {menu?.(team)}
            </div>
            <TeamDesks team={team} figureOf={figureOf} size={one ? 56 : 40} all />
            {file && <div className="team-card-made"><FileChip path={file.path} /></div>}
          </article>
        )
      })}
    </div>
  )
}
