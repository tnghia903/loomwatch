import { useCallback, useEffect, useState } from 'react'
import { parse } from 'yaml'

import { fetchTeamFile, fetchTeamsDiscovery, teamDisplayName, teamPathUnderRoot, teamSummaries } from '../team-file/client'
import { TeamFileModel } from '../team-file/document'
import { takeAgentOff } from '../team-file/takeOff'
import type { AgentConfig, TeamDocument } from '../team-file/types'
import { JOBS_CHANGED_EVENT } from './jobs'
import type { LibrarySource } from './types'

/** One team agent that is one of My agents (ADR 0094). */
export interface AgentUse {
  agent: string
  teamPath: string
  teamName: string
  /** The agent's id and name in that team. */
  agentId: string
  agentName: string
  /** The team runs on a schedule, where anything it would ask you is declined. */
  scheduled: boolean
  /** What taking it off this team does beyond closing its place in the line (ADR 0100): only an
      agent that starts the team changes more. */
  takeOff?: { startsInstead?: TeamCard; withoutCheck?: boolean; empty?: boolean; chooseStart?: TeamCard[] }
  /** The team's other places, in other projects (ADR 0103): one team, listed once, whose setup a
      save at `teamPath` writes into each of these too. */
  places?: string[]
}

/** An agent card in a team, as a person is told about it: its name in the team file, or the one of
    My agents it is (`agent`), whose name is in My agents. */
export interface TeamCard {
  id: string
  name: string
  agent?: string
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
  /** The agent as its team file has it, so another team can be given a copy. */
  agent: AgentConfig
}

/**
 * A copy of another team's own agent, for this team to own: its instructions, model, skills,
 * tools, checks and switches. Not its knowledge, its work folder or anything else that names
 * where the first team keeps its files, and no link back, since it is not one of Your agents.
 */
export function teamAgentSource(agent: AgentConfig): LibrarySource {
  const capabilities = (agent.capabilities ?? []).filter((capability) => capability.kind !== 'knowledge')
  return {
    group: 'agents',
    id: `team-${agent.id}`,
    label: agent.name?.trim() || agent.id,
    role: agent.role,
    ...(agent.model ? { model: agent.model, ...(agent.thinkingEffort ? { thinkingEffort: agent.thinkingEffort } : {}) } : {}),
    ...(capabilities.length ? { capabilities: capabilities.map((capability) => ({ ...capability })) } : {}),
    ...(agent.doneWhen?.length ? { doneWhen: [...agent.doneWhen] } : {}),
    ...(agent.allow ? { allow: { ...agent.allow } } : {}),
    ...(agent.allowRecruiting === false ? { helpers: false as const } : {}),
    ...(agent.allowMyAgents === false ? { bringsIn: false as const } : {}),
  }
}

/** Where a team's own agent is worked on: that team, with this agent's workbench open over its Team tab. */
export function teamAgentHref(agent: Pick<TeamOwnAgent, 'teamPath' | 'agentId'>): string {
  return `/?${new URLSearchParams({ path: agent.teamPath, view: 'agents', agent: agent.agentId })}`
}

/**
 * Every agent in every listed team, read from the team files themselves, so it is what the teams
 * would run, not a record kept on the side. `uses` are the ones placed from Your agents (they carry
 * a `from` link); `own` are the rest. The operator's stop in a workflow is not an agent and is in
 * neither. A team that does not open is skipped; the team list already says it is broken.
 */
export async function findTeamAgents(): Promise<{ uses: AgentUse[]; own: TeamOwnAgent[]; root: string }> {
  const discovery = await fetchTeamsDiscovery()
  const teams = teamSummaries(discovery).filter((team) => !team.problem)
  const files = await Promise.allSettled(teams.map(async (team) => ({ team, file: await fetchTeamFile(team.path) })))
  const uses: AgentUse[] = []
  const own: TeamOwnAgent[] = []
  // A team in several projects is one team (ADR 0103): its agents are listed once, at its first place.
  const shared = new Map<string, AgentUse[]>()
  for (const result of files) {
    if (result.status !== 'fulfilled') continue
    const { team, file } = result.value
    let doc: Partial<TeamDocument> | null = null
    try { doc = parse(file.yaml) as Partial<TeamDocument> } catch { continue }
    const scheduled = Boolean(doc?.schedule?.cron) && doc?.schedule?.enabled !== false
    const teamName = doc?.name?.trim() || teamDisplayName(team)
    const cardsById = new Map((doc?.agents ?? []).map((agent) => [agent?.id, agent]))
    const shares = typeof doc?.shares === 'string' && doc.shares.trim() ? doc.shares.trim() : null
    const first = shares ? shared.get(shares) : undefined
    if (first) {
      for (const use of first) use.places = [...(use.places ?? []), team.path]
      continue
    }
    const before = uses.length
    for (const agent of doc?.agents ?? []) {
      if (!agent?.id || agent.kind === 'operator') continue
      if (agent.from?.agent) {
        let takeOff: AgentUse['takeOff']
        if (doc?.entrypoint === agent.id) {
          const outcome = takeAgentOff(TeamFileModel.parse(file.yaml), [agent.id])
          const card = (id: string): TeamCard => { const found = cardsById.get(id); return { id, name: found?.name?.trim() || id, ...(found?.from?.agent ? { agent: found.from.agent } : {}) } }
          takeOff = { ...(outcome.startsInstead ? { startsInstead: card(outcome.startsInstead) } : {}), ...(outcome.stopsGone.length ? { withoutCheck: true } : {}), ...(outcome.empty ? { empty: true } : {}), ...(outcome.chooseStart ? { chooseStart: outcome.chooseStart.map(card) } : {}) }
        }
        uses.push({ agent: agent.from.agent, teamPath: team.path, teamName, agentId: agent.id, agentName: agent.name?.trim() || agent.from.agent, scheduled, ...(takeOff ? { takeOff } : {}) })
      } else {
        own.push({ teamPath: team.path, teamName, agentId: agent.id, agentName: agent.name?.trim() || agent.id, agent })
      }
    }
    if (shares) shared.set(shares, uses.slice(before))
  }
  const byTeam = (a: { teamName: string }, b: { teamName: string }) => a.teamName.localeCompare(b.teamName)
  return { uses: uses.sort(byTeam), own: own.sort(byTeam), root: discovery.root }
}

/**
 * Is `listed` (a team path as the teams list has it, under the teams folder) the team open at
 * `open` (the path the canvas opened, which may be the full one)?
 */
export function isOpenTeam(listed: string, open: string | null | undefined, root: string | null): boolean {
  if (!open) return false
  return listed === open || (root !== null && listed === teamPathUnderRoot(root, open))
}

/**
 * Where Your agents are used, and the agents that are only a team's own, reloaded whenever an agent
 * is saved or removed. Both `null` while loading. `root` is the teams folder they are listed under.
 */
export function useAgentUses(): { uses: AgentUse[] | null; own: TeamOwnAgent[] | null; root: string | null; reload: () => void } {
  const [found, setFound] = useState<{ uses: AgentUse[]; own: TeamOwnAgent[]; root: string | null } | null>(null)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    findTeamAgents().then((next) => { if (!cancelled) setFound(next) }, () => { if (!cancelled) setFound({ uses: [], own: [], root: null }) })
    return () => { cancelled = true }
  }, [generation])
  useEffect(() => {
    window.addEventListener(JOBS_CHANGED_EVENT, reload)
    return () => window.removeEventListener(JOBS_CHANGED_EVENT, reload)
  }, [reload])
  return { uses: found?.uses ?? null, own: found?.own ?? null, root: found?.root ?? null, reload }
}
