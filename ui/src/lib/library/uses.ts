import { useCallback, useEffect, useState } from 'react'
import { parse } from 'yaml'

import { fetchTeamFile, fetchTeamsDiscovery, teamDisplayName, teamSummaries } from '../team-file/client'
import type { TeamDocument } from '../team-file/types'
import { JOBS_CHANGED_EVENT } from './jobs'

/** One team agent placed from one of Your agents. */
export interface AgentUse {
  agent: string
  version: number
  teamPath: string
  teamName: string
  /** The agent's id and name in that team. */
  agentId: string
  agentName: string
  /** The team runs on a schedule, where anything it would ask you is declined. */
  scheduled: boolean
}

/**
 * An agent that is a team's own: written in the team file, not placed from Your agents. It is not
 * one of Your agents, but it is an agent the operator has, so the lists of agents show it with its team.
 */
export interface TeamOwnAgent {
  teamPath: string
  teamName: string
  agentId: string
  agentName: string
}

/** Where a team's own agent is worked on: that team, on its Agents tab, with this agent open. */
export function teamAgentHref(agent: Pick<TeamOwnAgent, 'teamPath' | 'agentId'>): string {
  return `/?${new URLSearchParams({ path: agent.teamPath, view: 'agents', agent: agent.agentId })}`
}

/**
 * Every agent in every listed team, read from the team files themselves, so it is what the teams
 * would run, not a record kept on the side. `uses` are the ones placed from Your agents (they carry
 * a `from` link); `own` are the rest. The operator's stop in a workflow is not an agent and is in
 * neither. A team that does not open is skipped; the team list already says it is broken.
 */
export async function findTeamAgents(): Promise<{ uses: AgentUse[]; own: TeamOwnAgent[] }> {
  const teams = teamSummaries(await fetchTeamsDiscovery()).filter((team) => !team.problem)
  const files = await Promise.allSettled(teams.map(async (team) => ({ team, file: await fetchTeamFile(team.path) })))
  const uses: AgentUse[] = []
  const own: TeamOwnAgent[] = []
  for (const result of files) {
    if (result.status !== 'fulfilled') continue
    const { team, file } = result.value
    let doc: Partial<TeamDocument> | null = null
    try { doc = parse(file.yaml) as Partial<TeamDocument> } catch { continue }
    const scheduled = Boolean(doc?.schedule?.cron) && doc?.schedule?.enabled !== false
    const teamName = doc?.name?.trim() || teamDisplayName(team)
    for (const agent of doc?.agents ?? []) {
      if (!agent?.id || agent.kind === 'operator') continue
      if (agent.from?.agent && typeof agent.from.version === 'number') {
        uses.push({ agent: agent.from.agent, version: agent.from.version, teamPath: team.path, teamName, agentId: agent.id, agentName: agent.name, scheduled })
      } else {
        own.push({ teamPath: team.path, teamName, agentId: agent.id, agentName: agent.name?.trim() || agent.id })
      }
    }
  }
  const byTeam = (a: { teamName: string }, b: { teamName: string }) => a.teamName.localeCompare(b.teamName)
  return { uses: uses.sort(byTeam), own: own.sort(byTeam) }
}

/**
 * Where Your agents are used, and the agents that are only a team's own, reloaded whenever an agent
 * is saved or removed. Both `null` while loading.
 */
export function useAgentUses(): { uses: AgentUse[] | null; own: TeamOwnAgent[] | null; reload: () => void } {
  const [found, setFound] = useState<{ uses: AgentUse[]; own: TeamOwnAgent[] } | null>(null)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    findTeamAgents().then((next) => { if (!cancelled) setFound(next) }, () => { if (!cancelled) setFound({ uses: [], own: [] }) })
    return () => { cancelled = true }
  }, [generation])
  useEffect(() => {
    window.addEventListener(JOBS_CHANGED_EVENT, reload)
    return () => window.removeEventListener(JOBS_CHANGED_EVENT, reload)
  }, [reload])
  return { uses: found?.uses ?? null, own: found?.own ?? null, reload }
}
