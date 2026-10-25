import { useEffect, useRef, useState } from 'react'
import { parse } from 'yaml'

import { fetchTeamFile, fetchTeamsDiscovery, teamDisplayName, teamSummaries } from '../team-file/client'
import { fetchJobs, type SavedJob } from '../library/jobs'
import type { AgentConfig, TeamDocument } from '../team-file/types'

/** What the rail needs of an agent: who it is, and the agent in My agents it was placed from. */
export type CrewAgent = Pick<AgentConfig, 'id' | 'name' | 'from'>

/** A team as the rail shows it: its name and its agents, in its file's order. */
export interface TeamCrew {
  path: string
  name: string
  agents: readonly CrewAgent[]
}

/**
 * A team file's name and agents, leaving out your own review stops; `null` when it isn't one. An
 * agent that is one of My agents is named as it is there (ADR 0094): the team file holds no name.
 */
export function crewOf(yaml: string, jobs: readonly Pick<SavedJob, 'id' | 'name'>[] = []): { name: string | null; agents: CrewAgent[] } | null {
  let doc: Partial<TeamDocument> | null
  try { doc = parse(yaml) as Partial<TeamDocument> | null } catch { return null }
  if (!doc || typeof doc !== 'object') return null
  const agents = (Array.isArray(doc.agents) ? doc.agents : [])
    .filter((agent): agent is AgentConfig => Boolean(agent?.id) && agent.kind !== 'operator')
    .map((agent) => {
      const name = agent.name?.trim() || jobs.find((job) => job.id === agent.from?.agent)?.name.trim() || agent.id
      return { id: agent.id, name, ...(agent.from ? { from: agent.from } : {}) }
    })
  return { name: doc.name?.trim() || null, agents }
}

/** Teams in name order, so each keeps its place in the rail while work moves between them. */
export function byName(teams: readonly TeamCrew[]): TeamCrew[] {
  return [...teams].sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
}

/**
 * Every team in the teams folder with its agents, read from the team files, for the team rail.
 * `teams` is `null` until read. A file that is not a team is left out: Home lists it to be fixed.
 * Read again each time `again` changes (the team on screen), keeping the list shown meanwhile and
 * reading only the files changed since: the folder's list says when each one last changed.
 */
export function useTeamCrews(again?: unknown): { root: string | null; teams: TeamCrew[] | null } {
  const [found, setFound] = useState<{ root: string | null; teams: TeamCrew[] | null }>({ root: null, teams: null })
  // The files' text, kept by when each last changed; the agents are named from My agents each time,
  // since an agent renamed there changes no team file.
  const known = useRef(new Map<string, { modifiedAt: string; yaml: string }>())
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [discovery, jobs] = await Promise.all([fetchTeamsDiscovery(), fetchJobs().then((list) => list?.jobs ?? [], () => [])])
        const listed = teamSummaries(discovery).filter((team) => !team.problem)
        const read = await Promise.allSettled(listed.map(async (team) => {
          const kept = known.current.get(team.path)
          const yaml = kept && team.modifiedAt && kept.modifiedAt === team.modifiedAt ? kept.yaml : (await fetchTeamFile(team.path)).yaml
          if (team.modifiedAt) known.current.set(team.path, { modifiedAt: team.modifiedAt, yaml })
          return { team, crew: crewOf(yaml, jobs) }
        }))
        const teams = read.flatMap((result) => {
          if (result.status !== 'fulfilled' || !result.value.crew) return []
          const { team, crew } = result.value
          return [{ path: team.path, name: crew.name ?? teamDisplayName(team), agents: crew.agents }]
        })
        if (!cancelled) setFound({ root: discovery.root, teams: byName(teams) })
      } catch {
        if (!cancelled) setFound((current) => (current.teams ? current : { root: null, teams: [] }))
      }
    })()
    return () => { cancelled = true }
  }, [again])
  return found
}
