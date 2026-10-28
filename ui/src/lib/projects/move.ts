import { useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'
import { baseName, dirName, isAbsolutePath, joinUnderRoot } from '../files/paths'
import { fetchMemory } from '../memory/client'
import { fetchTeamFile, fetchTeamsDiscovery, saveTeamFile } from '../team-file/client'
import { TeamFileModel } from '../team-file/document'
import { hashTeamYaml } from '../team-file/useTeamDocument'
import { ABOUT_CHARS, fetchProjects, projectsChanged, saveProject, projectIdFor, type ProjectFolder } from './client'

/** Where the move into projects stands (`GET /api/move-into-projects`). */
export interface ProjectMoveStatus {
  moved: boolean
  /** Each team in no project yet, and whether it may be moved: one that waits for a review isn't. */
  teams: { path: string; approved: boolean }[]
}

export async function fetchProjectMoveStatus(): Promise<ProjectMoveStatus | null> {
  const response = await daemonFetch('/api/move-into-projects', { cache: 'no-store' })
  // A daemon from before projects: nothing to move.
  if (!response.ok) return null
  return (await response.json()) as ProjectMoveStatus
}

/** One move however many times the app asks: React runs an effect twice while developing. */
let moving: Promise<void> | null = null

/**
 * Every team lives in a project (ADR 0097). Once the teams are on My agents (`ready`), each team
 * the person approved that works in no project yet becomes a project of its own: `checking` until
 * the daemon says, `moving` meanwhile, `done` after. The daemon kept a copy of every team before the
 * first move. A team that waits for a review moves once it is saved after the review.
 */
export function useMoveIntoProjects(ready: boolean): 'checking' | 'moving' | 'done' {
  const [state, setState] = useState<'checking' | 'moving' | 'done'>('checking')
  useEffect(() => {
    if (!ready) return
    let live = true
    moving ??= (async () => {
      try {
        const status = await fetchProjectMoveStatus()
        const waiting = status?.teams.filter((team) => team.approved) ?? []
        if (!status || (status.moved && waiting.length === 0)) return
        if (live) setState('moving')
        await moveIntoProjects(waiting.map((team) => team.path))
        if (!status.moved) await daemonFetch('/api/move-into-projects', { method: 'POST' })
        projectsChanged()
      } catch {
        // The teams work as they are until the next open tries again.
      } finally {
        moving = null
      }
    })()
    void moving?.then(() => { if (live) setState('done') })
    return () => { live = false }
  }, [ready])
  return state
}

/**
 * What a team brings to the project it becomes: its own Brief as the project's About, unless it is
 * longer than an About may be (then the Brief stays the team's), and every folder or file connected
 * to its agents as the project's folders, by full path. The agents keep their own connections.
 */
export function projectFromTeam(
  team: { name?: string; agents?: { kind?: string; capabilities?: { kind: string; name: string; path?: string }[] }[] },
  teamFile: string,
  brief: readonly string[],
): { name: string; about: string; folders: ProjectFolder[]; briefMoves: boolean } {
  const name = team.name?.trim() || baseName(teamFile).replace(/\.ya?ml$/i, '')
  const about = brief.map((body) => body.trim()).filter(Boolean).join('\n\n')
  const briefMoves = about.length > 0 && about.length <= ABOUT_CHARS
  const folders: ProjectFolder[] = []
  for (const agent of team.agents ?? []) {
    if (agent.kind === 'operator') continue
    for (const capability of agent.capabilities ?? []) {
      if (capability.kind !== 'knowledge' || !capability.path) continue
      // A file added beside the team (ADR 0035) is named from the team's folder.
      const path = isAbsolutePath(capability.path) || capability.path.startsWith('~/') ? capability.path : joinUnderRoot(dirName(teamFile), capability.path)
      if (folders.some((folder) => folder.path === path)) continue
      folders.push({ name: capability.name || baseName(path), path })
    }
  }
  return { name, about: briefMoves ? about : '', folders, briefMoves }
}

/**
 * Make each of `paths` (relative to the teams root) a project of its own, named after the team, and
 * save the team as working in it, as the editor saves it. One that can't be read or saved now moves
 * on a later open.
 */
export async function moveIntoProjects(paths: readonly string[]): Promise<string[]> {
  const root = (await fetchTeamsDiscovery()).root
  const taken = ((await fetchProjects())?.projects ?? []).map((project) => project.id)
  const moved: string[] = []
  for (const path of paths) {
    try {
      const file = await fetchTeamFile(path)
      const model = TeamFileModel.parse(file.yaml)
      const team = model.snapshot()
      if (team.project) continue
      const memory = await fetchMemory(path).catch(() => null)
      // A Brief entry for some agents only stays the team's: an About is every agent's.
      const own = (memory?.entries ?? []).filter((entry) => !entry.appliesTo?.length)
      const made = projectFromTeam(team, joinUnderRoot(root, path), own.map((entry) => entry.body))
      const id = projectIdFor(made.name, taken)
      await saveProject(id, { name: made.name, ...(made.about ? { about: made.about } : {}), ...(made.folders.length ? { folders: made.folders } : {}) })
      taken.push(id)
      model.setProject(id)
      // The Brief now reaches every agent as the project's About; its files stay on disk.
      if (made.briefMoves) for (const entry of own) model.removeBriefEntry(entry.path)
      await saveTeamFile(path, model.toYaml(), file.revision ?? await hashTeamYaml(file.yaml))
      moved.push(path)
    } catch {
      // Moves on a later open.
    }
  }
  return moved
}
