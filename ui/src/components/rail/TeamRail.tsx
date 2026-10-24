import { useMemo, useState } from 'react'

import { agentFigure, type FigureChoice } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import { isOpenTeam } from '../../lib/library/uses'
import { teamPresence } from '../../lib/rail/presence'
import { useTeamCrews, type CrewAgent } from '../../lib/rail/teamCrews'
import type { RunRecord } from '../../lib/runs/client'
import { teamHref } from '../../lib/team-file/teamPage'
import type { TeamView } from '../../lib/team-file/useTeamList'
import { FigureStill } from '../agents/FigureStill'
import { CrewRail, type LeaveGuard } from './CrewRail'
import { useShownTeamRail } from './teamRailStore'

/** A team's face in the rail: up to three of its agents' figures, standing together. */
export function TeamCrewArt({ figures }: { figures: readonly FigureChoice[] }) {
  const shown = figures.slice(0, 3)
  if (shown.length === 0) return <span className="crew-team none" />
  return (
    <span className={`crew-team n${shown.length}`}>
      {shown.map((figure, index) => <FigureStill key={index} figure={figure} alt="" width={46} height={46} decoding="async" />)}
    </span>
  )
}

export interface TeamRailProps {
  /** The team on screen, as it is now: its name and agents may not be saved yet. */
  open: { path: string; name: string; agents: readonly CrewAgent[] }
  runs: readonly RunRecord[]
  savedJobs: readonly SavedJob[]
  /** The tab on screen, which another team opens on too. */
  view: TeamView
  go: (href: string) => void
  onNewTeam: () => void
  leave: () => LeaveGuard | null
}

/**
 * My team, down the side of a team's page, as the agent rail is down the side of an agent's: one
 * click is another team, on the same tab, without going back to Home. Each team is its crew, and
 * glows what its newest work is doing, so a team waiting for you is seen from any other.
 */
export function TeamRail({ open, runs, savedJobs, view, go, onNewTeam, leave }: TeamRailProps) {
  // The rail stays as teams change beside it (App.tsx), and reads the folder again as they do.
  const { root, teams } = useTeamCrews(open.path)
  // The team just left, as it was on screen, until that read is back. A team is left in place only
  // once nothing on it is unsaved, so its file says the same.
  const [seen, setSeen] = useState<{ open: TeamRailProps['open']; teams: typeof teams; left: TeamRailProps['open'] | null }>({ open, teams, left: null })
  if (seen.open !== open || seen.teams !== teams) setSeen({ open, teams, left: seen.open.path !== open.path ? seen.open : seen.teams !== teams ? null : seen.left })
  const left = seen.left
  const items = useMemo(() => {
    if (!teams) return null
    const listed = teams.map((team) => (isOpenTeam(team.path, open.path, root)
      ? { ...team, name: open.name, agents: open.agents, current: true }
      : left && isOpenTeam(team.path, left.path, root) ? { ...team, name: left.name, agents: left.agents, current: false } : { ...team, current: false }))
    // A team opened from outside the teams folder is still the one you are on.
    const all = listed.some((team) => team.current) ? listed : [{ path: open.path, name: open.name, agents: open.agents, current: true }, ...listed]
    const names = new Map<string, number>()
    for (const team of all) names.set(team.name, (names.get(team.name) ?? 0) + 1)
    return all.map((team) => ({
      key: team.path,
      href: teamHref(team.path, view),
      name: team.name,
      // Two teams may share a name; their files never do. Otherwise its agents, so finding an agent finds its team.
      detail: (names.get(team.name) ?? 0) > 1 ? team.path : team.agents.map((agent) => agent.name ?? agent.id).join(', ') || undefined,
      presence: teamPresence(runs, team.path, team.current && !listed.some((other) => other.current) ? null : root),
      current: team.current,
      art: <TeamCrewArt figures={team.agents.map((agent) => agentFigure(agent, savedJobs))} />,
    }))
  }, [teams, root, open, left, runs, savedJobs, view])
  return <CrewRail label="My team" items={items} find="Find a team" none="No teams yet." add={{ label: 'New team', onAdd: onNewTeam }} go={go} leave={leave} />
}

/** The page frame's team rail, as the team on screen sets it (`teamRailStore.ts`). */
export function FrameTeamRail() {
  const rail = useShownTeamRail()
  return rail ? <TeamRail {...rail} /> : null
}
