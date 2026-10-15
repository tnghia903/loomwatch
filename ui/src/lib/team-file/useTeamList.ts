import { useCallback, useEffect, useState } from 'react'

import { fetchTeamsDiscovery, teamDisplayName, teamSummaries, type TeamSummary } from './client'

/** A team's three views, in the order you work through them: its agents, its workflow, its chat. */
export type TeamView = 'agents' | 'workflow' | 'chat'

/**
 * Open a team by its path, on one of its views. A full navigation, so every per-team state starts
 * clean. Workflow is the address with no `view`.
 */
export function openTeam(path: string, view: TeamView = 'workflow') {
  window.location.assign(`/?path=${encodeURIComponent(path)}${view === 'workflow' ? '' : `&view=${view}`}`)
}

/**
 * Where a team picks up: in its chat once it has one (ADR 0051); with no agents yet, on its agents,
 * the first thing to set up; otherwise on its workflow.
 */
export function teamViewFor(team: Pick<TeamSummary, 'agentCount' | 'problem'>, hasChat: boolean): TeamView {
  if (hasChat) return 'chat'
  return team.agentCount === 0 && !team.problem ? 'agents' : 'workflow'
}

/** How often a failed list asks again: the usual cause is a daemon that is being restarted. */
const RETRY_MS = 5000

/**
 * The teams in the teams folder, newest first. `null` while the first answer is pending. `trashed`
 * lists where deleted teams used to live, so a new team is never filed under one of their names.
 */
export function useTeamList() {
  const [teams, setTeams] = useState<TeamSummary[] | null>(null)
  const [trashed, setTrashed] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetchTeamsDiscovery()
      .then((discovery) => {
        if (cancelled) return
        const sorted = [...teamSummaries(discovery)].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || teamDisplayName(a).localeCompare(teamDisplayName(b)))
        setTeams(sorted)
        setTrashed(discovery.trashed ?? [])
        setError(null)
      })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)) })
    return () => { cancelled = true }
  }, [generation])
  // While the list cannot be read, keep asking, so restarting the daemon brings the teams back
  // without a reload. A list that loaded is left alone.
  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setGeneration((value) => value + 1), RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [error, generation])
  const retry = useCallback(() => setGeneration((value) => value + 1), [])
  // A team the operator just deleted leaves the list at once, and its name stays taken.
  const forget = useCallback((path: string) => {
    setTeams((current) => current?.filter((team) => team.path !== path) ?? current)
    setTrashed((current) => (current.includes(path) ? current : [...current, path]))
  }, [])
  return { teams, trashed, error, retry, forget }
}

