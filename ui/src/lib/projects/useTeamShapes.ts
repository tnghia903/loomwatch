import { useEffect, useRef, useState } from 'react'

import { fetchJobs, type SavedJob } from '../library/jobs'
import { fetchTeamFile, fetchTeamsDiscovery, teamSummaries } from '../team-file/client'
import { teamShapeOf, type TeamShape } from './studio'

/**
 * Every team in the teams folder as the studio draws it, and My agents, whose names and figures
 * its desks wear. Read again each time `again` changes, reading only the team files changed since
 * (the folder's list says when each last changed). `shapes` is `null` until read.
 */
export function useTeamShapes(again?: unknown): { root: string | null; shapes: TeamShape[] | null; jobs: SavedJob[] } {
  const [found, setFound] = useState<{ root: string | null; shapes: TeamShape[] | null; jobs: SavedJob[] }>({ root: null, shapes: null, jobs: [] })
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
          return teamShapeOf(team.path, yaml, jobs)
        }))
        const shapes = read.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
        if (!cancelled) setFound({ root: discovery.root, shapes, jobs })
      } catch {
        if (!cancelled) setFound((current) => (current.shapes ? current : { root: null, shapes: [], jobs: [] }))
      }
    })()
    return () => { cancelled = true }
  }, [again])
  return found
}
