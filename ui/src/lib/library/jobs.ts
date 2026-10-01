import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'
import type { AgentConfig } from '../team-file/types'
import { ROLE_ICON_IDS, type RoleIcon, type RolePreset } from './roles'

/**
 * Jobs the operator saved for reuse (ADR 0030).
 *
 * A saved job is an agent that worked, kept: its instructions, the app and model it ran on, and its
 * skills. The daemon stores each one as `<teams root>/.jobs/<id>.yaml`; the palette lists them under
 * "Your jobs" and places them exactly like the built-in jobs. Placing copies the fields into the
 * team, so editing or removing a job later changes no team.
 */

/** What is saved, as `PUT /api/jobs/{id}` takes it (backend `jobs::JobSpec`). */
export interface JobSpec {
  name: string
  does?: string
  instructions: string
  icon?: RoleIcon
  apps?: string[]
  model?: string
  skills?: string[]
}

/** A saved job as `GET /api/jobs` lists it. `file` is relative to the teams folder. */
export interface SavedJob extends JobSpec {
  id: string
  file: string
}

export interface JobProblem {
  file: string
  message: string
}

export interface JobList {
  folder: string
  jobs: SavedJob[]
  problems: JobProblem[]
}

/** Dispatched on `window` after a save or removal, so every list of jobs reloads. */
export const JOBS_CHANGED_EVENT = 'loomwatch:jobs-changed'

export class JobApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function failure(response: Response): Promise<JobApiError> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return new JobApiError(body?.error ?? response.statusText, response.status)
}

/** The saved jobs, or `null` when this daemon predates them (it answers 404 until restarted). */
export async function fetchJobs(): Promise<JobList | null> {
  const response = await daemonFetch('/api/jobs')
  if (response.status === 404) return null
  if (!response.ok) throw await failure(response)
  return (await response.json()) as JobList
}

/**
 * Save `spec` as job `id`. Without `replace`, an existing job is never overwritten: the daemon
 * answers 412 and this throws a `JobApiError` with that status, so the caller can ask first.
 */
export async function saveJob(id: string, spec: JobSpec, { replace = false } = {}): Promise<SavedJob> {
  const response = await daemonFetch(`/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(replace ? {} : { 'If-None-Match': '*' }) },
    body: JSON.stringify(spec),
  })
  if (!response.ok) throw await failure(response)
  window.dispatchEvent(new Event(JOBS_CHANGED_EVENT))
  return (await response.json()) as SavedJob
}

/** Remove a saved job. Its file is moved to `.jobs/.removed/`, so it can be put back by hand. */
export async function removeJob(id: string): Promise<void> {
  const response = await daemonFetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw await failure(response)
  window.dispatchEvent(new Event(JOBS_CHANGED_EVENT))
}

/** A job's id and file name: the name in lowercase letters, digits and single hyphens. */
export function jobIdFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || 'job'
}

const ICON_WORDS: ReadonlyArray<readonly [RoleIcon, RegExp]> = [
  ['review', /\b(review|check|critic|qa|verif|audit|approv)/],
  ['edit', /\b(edit|proofread|polish|tighten|copyedit)/],
  ['research', /\b(research|search|find|source|scout|investigat)/],
  ['analyse', /\b(analy[sz]|data|metric|number|statistic|spreadsheet)/],
  ['design', /\b(design|slide|deck|visual|layout|diagram|ui\b)/],
  ['code', /\b(code|coder|develop|engineer|program|bug|test|refactor)/],
  ['write', /\b(write|writer|draft|author|copy|blog|post|notes?)\b/],
]

/** An icon for a job from its name, then its instructions; none when nothing fits. */
export function guessIcon(name: string, instructions = ''): RoleIcon | undefined {
  for (const text of [name, instructions]) {
    const lower = text.toLowerCase()
    const hit = ICON_WORDS.find(([, pattern]) => pattern.test(lower))
    if (hit) return hit[0]
  }
  return undefined
}

/** What "Save as job" keeps of an agent: its instructions, app, model and skills. */
export function jobFromAgent(agent: AgentConfig, options: { name: string; does?: string; appId?: string }): JobSpec {
  const name = options.name.trim()
  const icon = guessIcon(name, agent.role)
  const skills = (agent.capabilities ?? []).filter((capability) => capability.kind === 'skill').map((capability) => capability.name)
  return {
    name,
    ...(options.does?.trim() ? { does: options.does.trim() } : {}),
    instructions: agent.role,
    ...(icon ? { icon } : {}),
    ...(options.appId ? { apps: [options.appId] } : {}),
    ...(options.appId && agent.model ? { model: agent.model } : {}),
    ...(skills.length ? { skills } : {}),
  }
}

/** A short line for a job saved without one: the first sentence of its instructions. */
function summary(instructions: string): string {
  const first = instructions.trim().split(/(?<=[.!?])\s|\n/)[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first
}

/** A saved job as a palette preset, placed exactly like a built-in one. */
export function savedJobPreset(job: SavedJob): RolePreset {
  const icon = job.icon && ROLE_ICON_IDS.includes(job.icon) ? job.icon : undefined
  return {
    id: `saved-${job.id}`,
    label: job.name,
    does: job.does?.trim() || summary(job.instructions) || 'Your job',
    role: job.instructions,
    ...(icon ? { icon } : {}),
    prefers: job.apps ?? [],
    ...(job.model ? { model: job.model } : {}),
    ...(job.skills?.length ? { skills: job.skills } : {}),
  }
}

export interface SavedJobsState {
  jobs: SavedJob[]
  problems: JobProblem[]
  /** False when the daemon predates saved jobs: it must be restarted before they can be used. */
  available: boolean
  error: string | null
  reload: () => void
}

// Stable empties, so a component that lists jobs in a dependency array does not re-run every render.
const NO_JOBS: SavedJob[] = []
const NO_PROBLEMS: JobProblem[] = []

/** The saved jobs, reloaded whenever any part of the page saves or removes one. */
export function useSavedJobs(): SavedJobsState {
  const [list, setList] = useState<JobList | null>(null)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    fetchJobs().then(
      (result) => {
        if (cancelled) return
        setAvailable(result !== null)
        setList(result)
        setError(null)
      },
      (failed: unknown) => {
        if (!cancelled) setError(failed instanceof Error ? failed.message : String(failed))
      },
    )
    return () => { cancelled = true }
  }, [generation])
  useEffect(() => {
    window.addEventListener(JOBS_CHANGED_EVENT, reload)
    return () => window.removeEventListener(JOBS_CHANGED_EVENT, reload)
  }, [reload])
  return { jobs: list?.jobs ?? NO_JOBS, problems: list?.problems ?? NO_PROBLEMS, available, error, reload }
}
