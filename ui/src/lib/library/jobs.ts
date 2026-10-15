import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'
import type { AgentAllow, AgentConfig } from '../team-file/types'
import { ROLE_ICON_IDS, type RoleIcon, type RolePreset } from './roles'

/**
 * Your agents: agents the operator built or saved for reuse (ADR 0030 began them as saved jobs).
 *
 * Each is its instructions, the app and model it runs on, its skills and what it may do without
 * asking. The daemon stores each one as `<teams root>/.jobs/<id>.yaml` and numbers its versions;
 * the palette lists them under "Your agents". Placing one copies its current version's fields into
 * the team with a `from: {agent, version}` link (lib/library/link.ts), so the team runs exactly
 * what it was approved with until the operator chooses Update there.
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
  /** What it may do without asking (ADR 0037); only switches that are on are written. */
  allow?: AgentAllow
  /** Set by the daemon: which version this is. Absent means 1. */
  version?: number
  /** What changed in this version, in the operator's words. */
  note?: string
  /** Set by the daemon: when this version was saved. */
  savedAt?: string
}

/** A job's version number; a file written before versions existed is version 1. */
export const versionOf = (job: Pick<JobSpec, 'version'>): number => job.version ?? 1

/** One version of a saved job, newest first in `fetchJobVersions`. */
export interface JobVersion {
  version: number
  savedAt?: string
  note?: string
  spec: JobSpec
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
 * answers 412 and this throws a `JobApiError` with that status, so the caller can ask first. With
 * `expectedVersion`, a job saved elsewhere since that version also answers 412, instead of being
 * overwritten.
 */
export async function saveJob(id: string, spec: JobSpec, { replace = false, expectedVersion }: { replace?: boolean; expectedVersion?: number } = {}): Promise<SavedJob> {
  const precondition: Record<string, string> = !replace ? { 'If-None-Match': '*' } : expectedVersion ? { 'If-Match': `"${expectedVersion}"` } : {}
  const response = await daemonFetch(`/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...precondition },
    body: JSON.stringify(spec),
  })
  if (!response.ok) throw await failure(response)
  window.dispatchEvent(new Event(JOBS_CHANGED_EVENT))
  return (await response.json()) as SavedJob
}

/** Every version of job `id`, newest first, each with its fields. */
export async function fetchJobVersions(id: string): Promise<JobVersion[]> {
  const response = await daemonFetch(`/api/jobs/${encodeURIComponent(id)}/versions`, { cache: 'no-store' })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { versions: JobVersion[] }).versions
}

/** The folder the test bench writes its one-agent teams to (`.jobs/.bench`), made when missing. */
export async function benchFolder(): Promise<string> {
  const response = await daemonFetch('/api/bench', { method: 'POST', cache: 'no-store' })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { folder: string }).folder
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

/** Only the switches that are on, or nothing: how a team file and a job file both write `allow`. */
export function onlyOn(allow: AgentAllow | undefined): AgentAllow | undefined {
  const kept = Object.fromEntries(Object.entries(allow ?? {}).filter(([, on]) => on === true)) as AgentAllow
  return Object.keys(kept).length > 0 ? kept : undefined
}

/** What "Add to Your agents" keeps of an agent: its instructions, app, model, skills and switches. */
export function jobFromAgent(agent: AgentConfig, options: { name: string; does?: string; appId?: string }): JobSpec {
  const name = options.name.trim()
  const icon = guessIcon(name, agent.role)
  const skills = (agent.capabilities ?? []).filter((capability) => capability.kind === 'skill').map((capability) => capability.name)
  const allow = onlyOn(agent.allow)
  return {
    name,
    ...(options.does?.trim() ? { does: options.does.trim() } : {}),
    instructions: agent.role,
    ...(icon ? { icon } : {}),
    ...(options.appId ? { apps: [options.appId] } : {}),
    ...(options.appId && agent.model ? { model: agent.model } : {}),
    ...(skills.length ? { skills } : {}),
    ...(allow ? { allow } : {}),
  }
}

/** A short line for a job saved without one: the first sentence of its instructions. */
function summary(instructions: string): string {
  const first = instructions.trim().split(/(?<=[.!?])\s|\n/)[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first
}

/** A saved job as a palette preset, placed like a built-in one, plus a link to this version. */
export function savedJobPreset(job: SavedJob): RolePreset {
  const icon = job.icon && ROLE_ICON_IDS.includes(job.icon) ? job.icon : undefined
  const allow = onlyOn(job.allow)
  return {
    id: `saved-${job.id}`,
    label: job.name,
    does: job.does?.trim() || summary(job.instructions) || 'Your agent',
    role: job.instructions,
    ...(icon ? { icon } : {}),
    prefers: job.apps ?? [],
    ...(job.model ? { model: job.model } : {}),
    ...(job.skills?.length ? { skills: job.skills } : {}),
    ...(allow ? { allow } : {}),
    from: { agent: job.id, version: versionOf(job) },
  }
}

export interface SavedJobsState {
  jobs: SavedJob[]
  problems: JobProblem[]
  /** False when the daemon predates saved jobs: it must be restarted before they can be used. */
  available: boolean
  /** The first answer has come back (or failed). */
  loaded: boolean
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
  return { jobs: list?.jobs ?? NO_JOBS, problems: list?.problems ?? NO_PROBLEMS, available, loaded: list !== null || !available || error !== null, error, reload }
}
