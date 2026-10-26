import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'
import { safeFileStem, splitPath } from '../files/paths'
import { movedInPlace } from '../team-file/inPlace'
import type { AgentAllow, AgentConfig } from '../team-file/types'
import type { FigureChoice } from './figures'
import type { AgentRead } from './reads'
import { ROLE_ICON_IDS, type RoleIcon, type RolePreset } from './roles'

/**
 * Your agents: agents the operator built or saved for reuse (ADR 0030 began them as saved jobs).
 *
 * Each is its instructions, the model it runs on, its skills and tools, what it reads, and what it
 * may do without asking. The daemon stores each one as `<teams root>/.jobs/<id>.yaml` and numbers its versions;
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
  /** The figure it wears in Your agents (lib/library/figures.ts). Absent, it wears one picked from its id. */
  figure?: FigureChoice
  /** The OpenRouter model it runs on; absent is the default model. The daemon reads a name saved
      for an AI app (`sonnet`) as the matching OpenRouter id. */
  model?: string
  /** How hard that model thinks. Absent, the model's own default. */
  thinkingEffort?: string
  skills?: string[]
  /** The tools it is given, by the name of a tool connected in LoomWatch (ADR 0069); a team copies
      them into its capabilities. */
  tools?: string[]
  /** Calls of those tools it may make without asking, by tool name (ADR 0069). A team copies each
      list into the tool's `alwaysAllow`. */
  toolAllow?: Record<string, string[]>
  /** The folders, files and Notion pages it reads in every team it joins; a team copies each into
      its capabilities as knowledge, and can give it more. */
  reads?: AgentRead[]
  /** What the finished result must satisfy (ADR 0062), copied into a team with the rest. */
  doneWhen?: string[]
  /** What it may do without asking (ADR 0037); only switches that are on are written. */
  allow?: AgentAllow
  /** `false`: it does not bring in helpers for a big task (ADR 0079), and a team copies that as
      `allowRecruiting: false`. Absent, it may. */
  helpers?: false
  /** `false`: it does not bring in other agents from My agents for a part no one on its team does
      (ADR 0092), filled into a team as `allowMyAgents: false`. Absent, it may. */
  bringsIn?: false
  /** Set by the daemon: which version this is. Absent means 1. */
  version?: number
  /** What changed in this version, in the operator's words. */
  note?: string
  /** Set by the daemon: when this version was saved. */
  savedAt?: string
}

/** A job's version number; a file written before versions existed is version 1. */
export const versionOf = (job: Pick<JobSpec, 'version'>): number => job.version ?? 1

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

/** The folder agents' chats keep their one-agent teams in (`.jobs/.bench`), made when missing. */
export async function benchFolder(): Promise<string> {
  const response = await daemonFetch('/api/bench', { method: 'POST', cache: 'no-store' })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { folder: string }).folder
}

/**
 * Whose chat a team file is: `<id>` for `.jobs/.bench/<id>.yaml`, the one-agent team an agent's
 * own chat keeps (the daemon's `pinned.rs` reads the same path back), or `null` for any other team.
 */
export function benchChatOwner(teamPath: string | null | undefined): string | null {
  const names = splitPath(teamPath ?? '')
  const [jobs, bench, file] = names.slice(-3)
  return names.length >= 3 && jobs === '.jobs' && bench === '.bench' && /\.yaml$/.test(file) ? file.replace(/\.yaml$/, '') : null
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
  return safeFileStem(slug || 'job')
}

const ICON_WORDS: ReadonlyArray<readonly [RoleIcon, RegExp]> = [
  ['review', /\b(review|check|critic|qa|verif|audit|approv)/],
  ['edit', /\b(edit|proofread|polish|tighten|copyedit)/],
  ['research', /\b(research|search|find|source|scout|investigat)/],
  ['slides', /\b(slides?|deck|presentation|powerpoint|pptx)\b/],
  ['sheet', /\b(spreadsheet|workbook|excel|xlsx)\b/],
  ['dashboard', /\bdashboards?\b/],
  ['chart', /\b(charts?|graphs?|plots?)\b/],
  ['video', /\b(videos?|clips?|voice-?over|animation)\b/],
  ['document', /\b(word documents?|docx|pdfs?)\b/],
  ['analyse', /\b(analy[sz]|data|metric|number|statistic)/],
  ['design', /\b(design|visual|layout|diagram|ui\b)/],
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

/** The calls of its tools a team agent may make without asking, by tool name (ADR 0069). */
export function toolAllowOf(agent: Pick<AgentConfig, 'capabilities'>): Record<string, string[]> {
  const allow: Record<string, string[]> = {}
  for (const capability of agent.capabilities ?? []) {
    if (capability.kind === 'tool' && capability.alwaysAllow?.length) allow[capability.name] = [...capability.alwaysAllow]
  }
  return allow
}

/** A short line for a job saved without one: the first sentence of its instructions, whole, with
 * its Markdown; the palette's line cuts it, so a mark is never split. */
function summary(instructions: string): string {
  return instructions.trim().split(/(?<=[.!?])\s|\n/)[0] ?? ''
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
    ...(job.model ? { model: job.model, ...(job.thinkingEffort ? { thinkingEffort: job.thinkingEffort } : {}) } : {}),
    ...(job.skills?.length ? { skills: job.skills } : {}),
    ...(job.tools?.length ? { tools: job.tools } : {}),
    ...(job.toolAllow && Object.keys(job.toolAllow).length ? { toolAllow: job.toolAllow } : {}),
    ...(job.reads?.length ? { reads: job.reads } : {}),
    ...(job.doneWhen?.length ? { doneWhen: job.doneWhen } : {}),
    ...(allow ? { allow } : {}),
    ...(job.helpers === false ? { helpers: false as const } : {}),
    ...(job.bringsIn === false ? { bringsIn: false as const } : {}),
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

let lastList: JobList | null = null

/** The saved jobs, reloaded whenever any part of the page saves or removes one. */
export function useSavedJobs(): SavedJobsState {
  // A team page that moved in place starts from the list it last read, so figures keep their looks.
  const [list, setList] = useState<JobList | null>(() => (movedInPlace() ? lastList : null))
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    fetchJobs().then(
      (result) => {
        if (cancelled) return
        lastList = result
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
