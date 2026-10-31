import { Search } from '../ui/icon'
import { useMemo, useState, type MouseEvent } from 'react'

import { isOpenTeam } from '../../lib/library/uses'
import { useProjects } from '../../lib/projects/client'
import { findTeams, looseProjects, roomsOf, teamGroups, type RoomTeam } from '../../lib/projects/studio'
import { defaultFigureOf } from '../../lib/projects/studioUi'
import { useTeamShapes } from '../../lib/projects/useTeamShapes'
import type { RunRecord } from '../../lib/runs/client'
import { teamHref } from '../../lib/team-file/teamHref'
import { useTeamList, type TeamView } from '../../lib/team-file/useTeamList'
import { ProjectMark, TeamLine } from '../studio/RoomCard'

/** From this many teams, the list starts with a box to find one by its name or an agent's. */
export const FIND_FROM = 7

export interface TeamSwitchProps {
  /** The team on screen, by its path as the page opened it. */
  open: string
  /** The tab on screen, which the next team opens on too. */
  view: TeamView
  /** The teams' runs, which light their figures. */
  runs: readonly RunRecord[]
  /** Go to the team at `href`; null is the team on screen, which only closes the menu. */
  onPick: (href: string | null) => void
}

/**
 * Every other team, in a team's name menu: each on its line from Projects (what it is doing, its
 * agents' figures), by project, the open team's own first. A pick opens that team on the tab on
 * screen, so the chat stays the chat. Read each time the menu opens.
 */
export function TeamSwitch({ open, view, runs, onPick }: TeamSwitchProps) {
  const { list } = useProjects()
  const { teams: summaries } = useTeamList()
  const { root, shapes, jobs } = useTeamShapes(list)
  const figureOf = useMemo(() => defaultFigureOf(new Map(jobs.map((job) => [job.id, job.figure]))), [jobs])
  const groups = useMemo(
    () => (list && shapes ? teamGroups(roomsOf([...list.projects, ...looseProjects(list.loose, summaries ?? [])], shapes, runs, root), open, root) : null),
    [list, shapes, summaries, runs, root, open],
  )
  const [query, setQuery] = useState('')
  const count = groups?.reduce((sum, group) => sum + group.teams.length, 0) ?? 0
  const shown = useMemo(() => (groups ? findTeams(groups, query) : null), [groups, query])

  // Nothing else to go to: the chip already names the team on screen.
  if (groups && count <= 1) return null
  const pick = (team: RoomTeam) => onPick(isOpenTeam(team.path, open, root) ? null : teamHref(team.path, view))
  // A plain click moves here; a click that asks for a new tab or window gets one.
  const follow = (event: MouseEvent<HTMLAnchorElement>, team: RoomTeam) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    pick(team)
  }
  return (
    <nav className="team-switch" aria-label="Teams">
      {count >= FIND_FROM && (
        <div className="pop-search">
          <Search size={15} aria-hidden="true" />
          <input
            autoFocus placeholder="Find a team" aria-label="Find a team" value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const first = shown?.[0]?.teams[0]
              if (event.key === 'Enter' && first) { event.preventDefault(); pick(first) }
            }}
          />
        </div>
      )}
      <div className="pop-list team-switch-list">
        {shown === null && <p className="pop-empty t-meta">Finding teams…</p>}
        {shown?.length === 0 && <p className="pop-empty t-meta">No team matches.</p>}
        {shown?.map((group) => (
          <div key={group.id ?? 'none'} className="team-switch-group">
            {/* With one group, its name would only repeat what the chip says. */}
            {(groups?.length ?? 0) > 1 && (
              <div className="team-switch-head t-meta" aria-hidden="true">
                {group.id && <ProjectMark id={group.id} mark={group.mark} size={10} />}
                <span>{group.name}</span>
              </div>
            )}
            <ul aria-label={group.name}>
              {group.teams.map((team) => (
                <li key={team.path}>
                  <TeamLine team={team} figureOf={figureOf} href={teamHref(team.path, view)} current={isOpenTeam(team.path, open, root)} onClick={(event) => follow(event, team)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}
