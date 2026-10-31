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

/** The keys of a team file that are each place's own (`team_places::PLACE_KEYS` in the daemon). */
const PLACE_KEYS = ['id', 'project', 'schedule', 'deliver', 'memory', 'shares']

/** Whether `current` changes the team's setup from `saved`: anything but a place's own keys, which a
    save keeps in this place alone (ADR 0103). */
export function setupDiffers(saved: string | null, current: string): boolean {
  const setup = (text: string | null): string => {
    let doc: unknown
    try { doc = text ? parse(text) : null } catch { return text ?? '' }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return JSON.stringify(doc)
    const kept = Object.fromEntries(Object.entries(doc as Record<string, unknown>).filter(([key]) => !PLACE_KEYS.includes(key)))
    return stable(kept)
  }
  return setup(saved) !== setup(current)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
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
