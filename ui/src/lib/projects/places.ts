import { useEffect, useState } from 'react'
import { parse } from 'yaml'

import { fetchTeamFile, fetchTeamsDiscovery, teamPathUnderRoot, teamSummaries } from '../team-file/client'
import { fetchProjects, onProjectsChanged } from './client'

/** One place of a team (ADR 0103): its file, relative to the teams folder, and its project's name. */
export interface Place {
  path: string
  /** The project's name, or null for a place in no project. */
  project: string | null
}

/** Where a team works (ADR 0103): the project of the place open, and its other places. */
export interface Places {
  here: string | null
  others: Place[]
}

/**
 * The places of the team `shares` names, seen from its file at `path` (relative, or absolute as the
 * open document names it): that place's project, and every other team file naming the same
 * `shares`, each with its project's name.
 */
export async function loadPlaces(shares: string, path: string): Promise<Places> {
  const [discovery, list] = await Promise.all([fetchTeamsDiscovery(), fetchProjects()])
  const self = teamPathUnderRoot(discovery.root, path)
  const nameOf = (id: unknown) => (typeof id === 'string' ? list?.projects.find((project) => project.id === id)?.name ?? null : null)
  const read = await Promise.all(teamSummaries(discovery).filter((team) => !team.problem).map(async (team) => {
    try {
      const doc = parse((await fetchTeamFile(team.path)).yaml) as { shares?: unknown; project?: unknown } | null
      return doc?.shares === shares ? { path: team.path, project: nameOf(doc.project) } : null
    } catch {
      return null
    }
  }))
  const places = read.filter((place): place is Place => place !== null)
  return { here: places.find((place) => place.path === self)?.project ?? null, others: places.filter((place) => place.path !== self) }
}

/** [`loadPlaces`] for the team open now, read again when a project changes; none without `shares`. */
export function usePlaces(shares: string | null, path: string | null): Places | null {
  const [found, setFound] = useState<{ key: string; places: Places } | null>(null)
  const [again, setAgain] = useState(0)
  useEffect(() => onProjectsChanged(() => setAgain((count) => count + 1)), [])
  const key = shares && path ? `${shares}\n${path}` : null
  useEffect(() => {
    if (!shares || !path) return
    let live = true
    loadPlaces(shares, path).then((places) => { if (live) setFound({ key: `${shares}\n${path}`, places }) }, () => {})
    return () => { live = false }
  }, [shares, path, again])
  return key && found?.key === key ? found.places : null
}
