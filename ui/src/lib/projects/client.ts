import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

/**
 * Projects hold the work (ADR 0097). A project is `<teams root>/.projects/<id>.yaml`: its name, its
 * About, the folders every agent in it may read, and the notes kept in it. A team names the one
 * project it works in with `project: <id>`. The daemon keeps them (`crates/.../projects.rs`).
 */

/** A folder or file every agent in a project may read, by its full path. */
export interface ProjectFolder {
  name: string
  path: string
}

/** One note kept in a project: the person's, or a lesson about the project an agent learned. */
export interface ProjectNote {
  text: string
  /** When it was kept (RFC 3339). */
  at?: string
  /** The agent whose lesson it was; absent for the person's own note. */
  by?: string
}

/** A project as its file holds it (`PUT /api/projects/{id}` takes it whole). */
export interface Project {
  name: string
  about?: string
  folders?: ProjectFolder[]
  notes?: ProjectNote[]
  /** The colour of the small mark beside its name (`projectMark`). */
  mark?: string
  putAway?: boolean
}

/** A project as `GET /api/projects` lists it: its id, its file, and its teams' paths. */
export interface ProjectEntry extends Project {
  id: string
  /** Each team in it, by its path relative to the teams root. */
  teams: string[]
}

export interface ProjectList {
  projects: ProjectEntry[]
  /** Teams in no project yet. */
  loose: string[]
  /** Teams that name a project with no file. */
  missing: string[]
  /** Deleted projects' ids, which a new project never takes: their notebooks are kept under them. */
  removed: string[]
}

/** The schema's limits, as the daemon holds them (`projects::ABOUT_CHARS`, `NOTE_CHARS`). */
export const ABOUT_CHARS = 4000
export const NOTE_CHARS = 500

async function failure(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: string; message?: string }
    return new Error(body.error ?? body.message ?? text)
  } catch {
    return new Error(text || `LoomWatch answered ${response.status}.`)
  }
}

/** The project without the fields the list adds, as `PUT /api/projects/{id}` takes it. */
export function projectFile(project: ProjectEntry): Project {
  const { id: _id, teams: _teams, ...file } = project
  return file
}

/** Every project with its teams, or `null` from a LoomWatch before projects. */
export async function fetchProjects(): Promise<ProjectList | null> {
  const response = await daemonFetch('/api/projects', { cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw await failure(response)
  const body = (await response.json()) as Partial<ProjectList>
  // Anything but a list of projects is a LoomWatch from before them.
  return Array.isArray(body.projects) ? { projects: body.projects, loose: body.loose ?? [], missing: body.missing ?? [], removed: body.removed ?? [] } : null
}

/**
 * Delete project `id` (ADR 0100): its teams stay, in no project, and its file moves to a hidden
 * folder. Returns the teams it had.
 */
export async function deleteProject(id: string): Promise<string[]> {
  const response = await daemonFetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw await failure(response)
  const body = (await response.json()) as { teams?: string[] }
  projectsChanged()
  return body.teams ?? []
}

/**
 * Put the team at `path` into `project` as well (ADR 0103): the daemon makes it a place of its own
 * there, with the team's setup, and answers with that place's path.
 */
export async function addTeamToProject(path: string, project: string): Promise<string> {
  const response = await daemonFetch('/api/team/places', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, project }),
  })
  if (!response.ok) throw await failure(response)
  const body = (await response.json()) as { path: string }
  projectsChanged()
  return body.path
}

/**
 * Take the team at `path` out of its project (ADR 0103): a team in other projects too loses only
 * this place (to the trash); a team's only place stays, in no project.
 */
export async function takeTeamOut(path: string): Promise<void> {
  const response = await daemonFetch('/api/team/take-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!response.ok) throw await failure(response)
  projectsChanged()
}

/** Keep project `id` as `project` says, whole. */
export async function saveProject(id: string, project: Project): Promise<ProjectEntry> {
  const response = await daemonFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as ProjectEntry
}

/** Add the person's note to project `id`. */
export async function addProjectNote(id: string, text: string): Promise<ProjectEntry> {
  const response = await daemonFetch(`/api/projects/${encodeURIComponent(id)}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as ProjectEntry
}

/**
 * A free id for a project called `name`: its words in lowercase joined by hyphens, with a number
 * when one in `taken` has it. The twin of `projects::id_for`.
 */
export function projectIdFor(name: string, taken: readonly string[] = []): string {
  // Accents off and `đ` as `d`, as the daemon folds them: "Đà Nẵng" is `da-nang`.
  const folded = name.toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/\p{M}/gu, '')
  const words = folded.replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).join('-')
  const base = words.slice(0, 56).replace(/-+$/, '') || 'project'
  let id = base
  for (let counter = 2; taken.includes(id); counter += 1) id = `${base}-${counter}`
  return id
}

/** Tell every open page the projects changed, so each reads them again. */
export function projectsChanged(): void {
  window.dispatchEvent(new Event('loomwatch:projects-changed'))
}

/** Call `then` each time the projects change; the answer stops listening. */
export function onProjectsChanged(then: () => void): () => void {
  window.addEventListener('loomwatch:projects-changed', then)
  return () => window.removeEventListener('loomwatch:projects-changed', then)
}

/** The projects as the daemon has them, read again whenever they change. `null` while loading. */
export function useProjects(): { list: ProjectList | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<ProjectList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    let live = true
    fetchProjects().then(
      (next) => { if (live) { setList(next ?? { projects: [], loose: [], missing: [], removed: [] }); setError(null) } },
      (caught: unknown) => { if (live) setError(caught instanceof Error ? caught.message : String(caught)) },
    )
    return () => { live = false }
  }, [generation])
  useEffect(() => {
    window.addEventListener('loomwatch:projects-changed', reload)
    return () => window.removeEventListener('loomwatch:projects-changed', reload)
  }, [reload])
  return { list, error, reload }
}
