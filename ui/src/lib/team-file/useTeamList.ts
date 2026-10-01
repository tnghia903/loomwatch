import { useEffect, useState } from 'react'

import { fetchTeamsDiscovery, teamDisplayName, teamSummaries, type TeamSummary } from './client'

/** Open a team by its path. A full navigation, so every per-team state starts clean. */
export function openTeam(path: string) {
  window.location.assign(`/?path=${encodeURIComponent(path)}`)
}

/** The teams in the teams folder, newest first. `null` while the first answer is pending. */
export function useTeamList() {
  const [teams, setTeams] = useState<TeamSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchTeamsDiscovery()
      .then((discovery) => {
        if (cancelled) return
        const sorted = [...teamSummaries(discovery)].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || teamDisplayName(a).localeCompare(teamDisplayName(b)))
        setTeams(sorted)
        setError(null)
      })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)) })
    return () => { cancelled = true }
  }, [])
  return { teams, error }
}

