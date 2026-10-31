import { useEffect, useState } from 'react'

import { modelNameFromId } from '../ai/modelIds'
import { daemonFetch } from '../daemonFetch'
import { listNames } from '../format'
import { fetchJobs, saveJob, type SavedJob } from '../library/jobs'
import { fetchTeamFile, saveTeamFile } from './client'
import { TeamFileModel } from './document'
import { diskYamlOf, fillModel, pointsAt, runsDifferently, settleAgents } from './myAgents'
import type { AgentConfig } from './types'
import { hashTeamYaml } from './useTeamDocument'

/** One move however many times the app asks: React runs an effect twice while developing. */
let moving: Promise<void> | null = null

/**
 * Where the first open after the move came in stands: `checking` until the daemon says, `moving`
 * while the teams move onto My agents, `done` after, or when there is nothing to move. A page that
 * shows a team waits for `done`, so nobody edits a team mid-move.
 */
export function useMoveOntoMyAgents(): 'checking' | 'moving' | 'done' {
  const [state, setState] = useState<'checking' | 'moving' | 'done'>('checking')
  useEffect(() => {
    let live = true
    moving ??= (async () => {
      try {
        const status = await fetchMoveStatus()
        if (!status || status.moved) return
        if (live) setState('moving')
        await moveOntoMyAgents(status)
      } catch {
        // Teams run as they are written until the next open tries again.
      }
    })()
    void moving.then(() => { if (live) setState('done') })
    return () => { live = false }
  }, [])
  return state
}

/** What a team's chat says once about what the move changed in it: the lines kept for that team. */
export function movedLine(lines: readonly string[]): string {
  return lines.join(' ')
}

/**
 * The lines a team's chat says about the move: which agents now run as they are saved in My agents
 * (a copy the team kept gave way to it), the model one of them now thinks with when that changed,
 * and a name the move had to change so two different agents aren't called the same.
 */
export function movedLines(changed: readonly { name: string; model?: string }[], renamed: readonly { from: string; to: string }[]): string[] {
  const lines: string[] = []
  const names = changed.map((agent) => agent.name)
  if (names.length === 1) lines.push(`${names[0]} now works as you last saved it in My agents, not as this team’s older copy.`)
  if (names.length > 1) lines.push(`${listNames(names)} now work as you last saved them in My agents, not as this team’s older copies.`)
  for (const agent of changed) if (agent.model) lines.push(`${agent.name} now thinks with ${modelNameFromId(agent.model)}.`)
  for (const name of renamed) lines.push(`${name.from} is now called ${name.to}, since My agents already has a different ${name.from}.`)
  return lines
}

/** Where the move onto My agents stands (`GET /api/my-agents/move`). */
export interface MoveStatus {
  moved: boolean
  /** Every listed team, and whether it may be moved: one that waits for a review isn't. */
  teams: { path: string; approved: boolean }[]
  /** What the move changed in each team, by the team's path: the lines its chat says once. */
  changed: Record<string, string[]>
}

export async function fetchMoveStatus(): Promise<MoveStatus | null> {
  const response = await daemonFetch('/api/my-agents/move', { cache: 'no-store' })
  // A daemon from before My agents was the one pool: nothing to move.
  if (!response.ok) return null
  return (await response.json()) as MoveStatus
}

/**
 * Move every team the person approved onto My agents, once (ADR 0094). Each is saved as a save in
 * the editor saves it: a copy of one of My agents gives way to the agent as it is there, an agent
 * of the team's own becomes one of My agents (joining an identical one), and the file keeps only
 * what is the team's, its comments included. The daemon kept a copy of every team and agent before
 * anything could change, and moves each agent's lessons as the team is saved. A team that waits
 * for a review is left as it is: it runs as written, and moves when it is saved after the review.
 * Returns what the move changed in each team, as its chat says it, which is also kept.
 */
export async function moveOntoMyAgents(status: MoveStatus): Promise<Record<string, string[]>> {
  let jobs: SavedJob[] = (await fetchJobs())?.jobs ?? []
  const changed: Record<string, string[]> = {}
  for (const team of status.teams.filter((candidate) => candidate.approved)) {
    try {
      const file = await fetchTeamFile(team.path)
      const model = TeamFileModel.parse(file.yaml)
      const filled = fillModel(model, jobs)
      const agents = model.snapshot().agents
      const before = Array.isArray(agents) ? agents : []
      // Only an agent written out in full has anything to move.
      if (!before.some((agent) => agent.kind !== 'operator' && !pointsAt(agent))) continue
      const settled = await settleAgents(model, jobs, filled, model.snapshot().name ?? '', saveJob)
      jobs = settled.jobs
      // A copy that gave way to the agent as it is in My agents may run differently from now on,
      // and an agent of the team's own may have had to take the team's name after its own.
      const settledAgents = model.snapshot().agents
      const now = new Map((Array.isArray(settledAgents) ? settledAgents : []).map((agent) => [agent.id, agent]))
      const moved = before.filter((agent) => agent.kind !== 'operator' && !pointsAt(agent) && now.has(agent.id))
      const different = moved.filter((agent) => runsDifferently(agent, now.get(agent.id) as AgentConfig))
      const lines = movedLines(
        different.map((agent) => {
          const after = now.get(agent.id) as AgentConfig
          return { name: after.name, ...(after.model && after.model !== agent.model ? { model: after.model } : {}) }
        }),
        moved.filter((agent) => now.get(agent.id)?.name !== agent.name).map((agent) => ({ from: agent.name, to: (now.get(agent.id) as AgentConfig).name })),
      )
      if (lines.length > 0) changed[team.path] = lines
      await saveTeamFile(team.path, diskYamlOf(model, jobs), file.revision ?? await hashTeamYaml(file.yaml))
    } catch {
      // A team that can't be read or saved now moves when it is next saved in the editor.
    }
  }
  await daemonFetch('/api/my-agents/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changed: { ...status.changed, ...changed } }),
  })
  return changed
}
