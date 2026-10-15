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
 * Where Your agents are used: every agent in every listed team that carries a `from` link. Read
 * from the team files themselves, so it is what the teams would run, not a record kept on the side.
 * A team that does not open is skipped; the team list already says it is broken.
 */
export async function findUses(): Promise<AgentUse[]> {
  const teams = teamSummaries(await fetchTeamsDiscovery()).filter((team) => !team.problem)
  const files = await Promise.allSettled(teams.map(async (team) => ({ team, file: await fetchTeamFile(team.path) })))
  const uses: AgentUse[] = []
  for (const result of files) {
    if (result.status !== 'fulfilled') continue
    const { team, file } = result.value
    let doc: Partial<TeamDocument> | null = null
    try { doc = parse(file.yaml) as Partial<TeamDocument> } catch { continue }
    const scheduled = Boolean(doc?.schedule?.cron) && doc?.schedule?.enabled !== false
    for (const agent of doc?.agents ?? []) {
      if (!agent?.from?.agent || typeof agent.from.version !== 'number') continue
      uses.push({ agent: agent.from.agent, version: agent.from.version, teamPath: team.path, teamName: doc?.name?.trim() || teamDisplayName(team), agentId: agent.id, agentName: agent.name, scheduled })
    }
  }
  return uses.sort((a, b) => a.teamName.localeCompare(b.teamName))
}

/** Where Your agents are used, reloaded whenever an agent is saved or removed. `null` while loading. */
export function useAgentUses(): { uses: AgentUse[] | null; reload: () => void } {
  const [uses, setUses] = useState<AgentUse[] | null>(null)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    findUses().then((found) => { if (!cancelled) setUses(found) }, () => { if (!cancelled) setUses([]) })
    return () => { cancelled = true }
  }, [generation])
  useEffect(() => {
    window.addEventListener(JOBS_CHANGED_EVENT, reload)
    return () => window.removeEventListener(JOBS_CHANGED_EVENT, reload)
  }, [reload])
  return { uses, reload }
}
