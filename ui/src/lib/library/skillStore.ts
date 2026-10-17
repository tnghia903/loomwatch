import { daemonFetch } from '../daemonFetch'

/**
 * LoomWatch's own skills folder (backend `skills_store.rs`, `marketplace.rs`, `skills_api.rs`).
 *
 * LoomWatch keeps a copy of every skill its agents can use in `<state folder>/skills/<name>/`, and
 * records where each came from. Skills come in two ways, both only when the person asks:
 * - **Bring in from your apps** copies skills from the skill folders apps on this computer keep.
 *   It reads skill folders only, and copies what the person ticks.
 * - **Install** fetches from skills.sh, ClawHub or a GitHub link. The daemon does every fetch; this
 *   page never calls those sites itself. Inspect shows what a download holds before anything is
 *   installed.
 *
 * A skill whose license says "All rights reserved" is restricted and never comes in either way.
 */

/** How a skill reached the folder. `found`: someone put its folder there by hand. */
export type OriginKind = 'brought_in' | 'installed' | 'found'
export type SkillSource = 'github' | 'skills.sh' | 'clawhub'
export type SearchSource = Exclude<SkillSource, 'github'>
export type Runtime = 'node' | 'python'

export interface SkillOrigin {
  kind: OriginKind
  /** The app whose skill folder it was brought in from, e.g. `Claude Code`. */
  app?: string
  /** The folder it was copied from: on this computer, or inside the repository or download. */
  sourcePath?: string
  source?: SkillSource
  /** What was asked for: `owner/repo[/path][@ref]`, a skills.sh id, a ClawHub `owner/slug`. */
  ref?: string
  commit?: string
  /** A page about it the person can open. */
  url?: string
}

export interface SkillLicense {
  /** `MIT`, `Apache-2.0`, `All rights reserved`… Absent when the skill names none. */
  id?: string
  /** Its license says "All rights reserved" or "proprietary": it can never come in. */
  restricted: boolean
}

/** One skill in LoomWatch's folder: `GET /api/skills`. */
export interface SkillRecord {
  name: string
  description: string
  origin: SkillOrigin
  license: SkillLicense
  /** What its instructions assume, in the Library's words (`skill_routing::SkillNeed::label`). */
  needs: string[]
  runtimes: Runtime[]
  hasScripts: boolean
  sizeBytes: number
  /** Empty for a folder put there by hand. */
  sha256: string
  addedAt: string
  /** The bring-in it came with; Undo takes that bring-in back whole. */
  batchId?: string
}

export interface SkillsFolder {
  /** Where the folder is on this computer. */
  folder: string
  skills: SkillRecord[]
}

/** One skill an app on this computer has: `POST /api/skills/bring-in/preview`. */
export interface BringInCandidate {
  /** What `bringIn` takes. */
  key: string
  name: string
  description: string
  app: string
  /** The plugin it came with, when it came with one. */
  plugin?: string
  path: string
  license: SkillLicense
  restricted: boolean
  /** Why it can't be brought in (license, size, name), when it can't. */
  reason?: string
  needs: string[]
  runtimes: Runtime[]
  hasScripts: boolean
  sizeBytes: number
  fileCount: number
  alreadyInLoomWatch: boolean
  /** Ticked to start with: it can come in, isn't there yet, and no earlier app has one by its name. */
  defaultSelected: boolean
}

export interface SkippedSkill {
  name: string
  reason: string
}

/** `POST /api/skills/bring-in`. */
export interface BringInOutcome {
  batchId: string
  imported: SkillRecord[]
  skipped: SkippedSkill[]
}

/** One search hit: `GET /api/skills/search`. A ClawHub search can find skills.sh skills too. */
export interface SearchResult {
  source: SearchSource
  id: string
  name: string
  description?: string
  installs?: number
  url: string
  /** What `inspectInstall` takes, with `source`. */
  ref: string
}

/** One skill folder in an inspected download. */
export interface InstallCandidate {
  /** Its folder inside the download; `.` when the download is the skill. What `installSkills` takes. */
  path: string
  name: string
  description: string
  license: SkillLicense
  restricted: boolean
  reason?: string
  /** Every file it holds; empty when it is too big to unpack. */
  files: string[]
  hasScripts: boolean
  runtimes: Runtime[]
  needs: string[]
  sizeBytes: number
  /** A skill with this name is already in LoomWatch: installing replaces it only when asked. */
  conflict: boolean
}

/** ClawHub's own safety check, when it has one. A skill it found harmful is never offered. */
export interface SafetyScan {
  status: 'clean' | 'suspicious' | 'pending' | 'error' | string
  hasWarnings: boolean
  url?: string
}

/** `POST /api/skills/install/inspect`: held by the daemon under `token` for 30 minutes. */
export interface Inspection {
  token: string
  source: SkillSource
  /** What was fetched, as the person would name it. */
  title: string
  url?: string
  commit?: string
  scan?: SafetyScan
  /** Things worth knowing that aren't about one skill: links left out, skills not shown. */
  notes: string[]
  candidates: InstallCandidate[]
}

/** The daemon's own words for what went wrong, and its status (409: the name is taken). */
export class SkillsApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** An older daemon has no skills routes yet: its page answers instead of the API. */
export const SKILLS_UNAVAILABLE = 'This LoomWatch can’t manage skills yet. Update LoomWatch, then open Skills again.'

const CHANGE = { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await daemonFetch(path, { cache: 'no-store', ...init })
  const html = response.headers?.get('content-type')?.includes('html') ?? false
  if (html) throw new SkillsApiError(SKILLS_UNAVAILABLE, response.status)
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || body === null) {
    throw new SkillsApiError(body?.error ?? (response.status === 404 ? SKILLS_UNAVAILABLE : 'Something went wrong. Try again.'), response.status)
  }
  return body
}

const change = <T>(path: string, method: string, body?: unknown) =>
  call<T>(path, { method, headers: CHANGE, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export const fetchSkills = () => call<SkillsFolder>('/api/skills')

/** Moves the skill to the folder's `.removed/`; answers its name. */
export const removeSkill = async (name: string) =>
  (await change<{ removed: string }>(`/api/skills/${encodeURIComponent(name)}`, 'DELETE')).removed

export const previewBringIn = async () =>
  (await change<{ candidates: BringInCandidate[] }>('/api/skills/bring-in/preview', 'POST')).candidates

export const bringIn = (keys: string[]) => change<BringInOutcome>('/api/skills/bring-in', 'POST', { keys })

/** Takes a bring-in back whole; answers the names it removed. */
export const undoBringIn = async (batchId: string) =>
  (await change<{ removed: string[] }>(`/api/skills/bring-in/${encodeURIComponent(batchId)}/undo`, 'POST')).removed

export const searchSkills = async (query: string, source: SearchSource) =>
  (await call<{ results: SearchResult[] }>(`/api/skills/search?${new URLSearchParams({ q: query, source })}`)).results

/** Without `source`, `ref` is a GitHub `owner/repo[/path][@ref]` or any GitHub, skills.sh or ClawHub link. */
export const inspectInstall = (ref: string, source?: SkillSource) =>
  change<Inspection>('/api/skills/install/inspect', 'POST', source ? { ref, source } : { ref })

/** Without `replace`, a name already in LoomWatch answers 409 and nothing is installed. */
export const installSkills = async (token: string, paths: string[], replace = false) =>
  (await change<{ installed: SkillRecord[] }>('/api/skills/install', 'POST', { token, paths, replace })).installed

// --- Words for the page -------------------------------------------------------------------------

export const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : 'Something went wrong. Try again.')

/** `1 skill`, `3 skills`. */
export const skillCount = (count: number): string => `${count} skill${count === 1 ? '' : 's'}`

export const RUNTIME_LABEL: Record<Runtime, { label: string; hint: string }> = {
  node: { label: 'Needs Node', hint: 'It comes with scripts that run with Node.js, which this computer needs to have.' },
  python: { label: 'Needs Python', hint: 'It comes with scripts that run with Python, which this computer needs to have.' },
}

/** `skill_routing::SkillNeed::label` → what it means for the person. */
const NEED_LABEL: Record<string, string> = {
  subagents: 'Uses helper agents',
  scripts: 'Runs scripts',
  'slash commands': 'Uses slash commands',
  'named tools': 'Names specific tools',
  'Claude surfaces': 'Written for another app',
  'other skills': 'Uses other skills',
}

export const needLabel = (need: string): string => NEED_LABEL[need] ?? need

const SOURCE_NAME: Record<SkillSource, string> = { github: 'GitHub', 'skills.sh': 'skills.sh', clawhub: 'ClawHub' }

export const sourceName = (source: SkillSource): string => SOURCE_NAME[source] ?? source

/** Where a skill came from, in a few words. */
export function describeOrigin(origin: SkillOrigin): string {
  switch (origin.kind) {
    case 'brought_in': return origin.app ? `Brought in from ${origin.app}` : 'Brought in from your apps'
    case 'installed': return origin.source ? `Installed from ${sourceName(origin.source)}` : 'Installed'
    default: return 'Added to the folder by hand'
  }
}

export function licenseLabel(license: SkillLicense): string {
  if (license.restricted) return license.id ? `${license.id} (can’t be copied)` : 'All rights reserved (can’t be copied)'
  return license.id ? `License: ${license.id}` : 'No license given'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** ClawHub's safety check, said plainly. */
export function scanLabel(scan: SafetyScan): string {
  const status = {
    clean: scan.hasWarnings ? 'passed, with warnings' : 'passed',
    suspicious: 'found something suspicious',
    pending: 'hasn’t finished yet',
    error: 'couldn’t finish',
  }[scan.status] ?? scan.status
  return `ClawHub’s safety check ${status}.`
}

/** `/Users/me/.claude/skills/pdf` → `~/.claude/skills/pdf`, which reads the same on every Mac. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, '~')
}
