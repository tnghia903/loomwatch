// Thin wrapper over the daemon REST surface added in TNG-52 (crates/loomwatch-backend/src/api.rs).
import { daemonFetch } from '../daemonFetch'

export interface TeamFilePayload {
  path: string
  yaml: string
  revision?: string
}

/** One discovered team as the picker shows it (backend `TeamSummary`). */
export interface TeamSummary {
  path: string
  /** Absent when the file does not parse as a team; show the path instead. */
  name?: string
  agentCount: number
  modifiedAt?: string
  /** Set when the file cannot be opened as a team: not YAML at all, or YAML that is not a team. */
  problem?: 'unreadable' | 'not_a_team'
}

export interface TeamsDiscoveryPayload {
  root: string
  files: string[]
  /** Added after `files`; an older daemon omits it, so readers fall back to `files`. */
  teams?: TeamSummary[]
  /**
   * Where deleted teams waiting in the trash used to live. Not teams, but names a new team must not
   * take: their run history and Notebook notes are still filed under them. Absent from older daemons.
   */
  trashed?: string[]
}

/** Summaries for every discovered file, synthesised from `files` when the daemon predates them. */
export function teamSummaries(discovery: TeamsDiscoveryPayload): TeamSummary[] {
  return discovery.teams ?? discovery.files.map((path) => ({ path, agentCount: 0 }))
}

/** "Review stop demo" for a named team, "research-team" for a file without a usable name. */
export function teamDisplayName(team: Pick<TeamSummary, 'path' | 'name'>): string {
  if (team.name) return team.name
  const file = team.path.split('/').pop() ?? team.path
  return file.replace(/\.ya?ml$/i, '')
}

/** `path` as the run registry files it: relative to the teams folder. `null` when it is outside. */
export function teamPathUnderRoot(root: string, path: string): string | null {
  if (!path.startsWith('/')) return path
  const prefix = `${root.replace(/\/+$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

export class TeamFileApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function readTeamFileResponse(response: Response): Promise<TeamFilePayload> {
  const body = (await response.json()) as TeamFilePayload | { error: string }
  if (!response.ok) {
    const message = 'error' in body ? body.error : response.statusText
    throw new TeamFileApiError(message, response.status)
  }
  return body as TeamFilePayload
}

export async function fetchTeamFile(path: string): Promise<TeamFilePayload> {
  const query = new URLSearchParams({ path })
  const response = await daemonFetch(`/api/team?${query}`)
  return readTeamFileResponse(response)
}

/** docs/CANVAS_SPEC.md §15.4: the canonical root is the source for absolute display paths. */
export async function fetchTeamsDiscovery(): Promise<TeamsDiscoveryPayload> {
  const response = await daemonFetch('/api/teams')
  const body = (await response.json()) as TeamsDiscoveryPayload | { error: string }
  if (!response.ok) {
    const message = 'error' in body ? body.error : response.statusText
    throw new TeamFileApiError(message, response.status)
  }
  return body as TeamsDiscoveryPayload
}

// The daemon re-validates and rejects (422) before touching the file on disk, so an
// invalid in-memory edit never overwrites a good one (crates/loomwatch-backend/src/api.rs).
export async function saveTeamFile(path: string, yaml: string, revision: string | null): Promise<TeamFilePayload> {
  const response = await daemonFetch('/api/team', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(revision === null ? { 'If-None-Match': '*' } : { 'If-Match': `"${revision}"` }),
    },
    body: JSON.stringify({ path, yaml } satisfies TeamFilePayload),
  })
  return readTeamFileResponse(response)
}

// docs/CANVAS_SPEC.md §9.2: "Fetch it once at load; do not bundle a copy into the UI, because
// a bundled copy is a second source of truth that silently drifts from the daemon that will
// reject the save." `schemas/team.schema.yaml` embedded in the running binary is the only copy.
export async function fetchConfigSchema(): Promise<object> {
  const response = await daemonFetch('/api/config/schema')
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new TeamFileApiError(body?.error ?? response.statusText, response.status)
  }
  return (await response.json()) as object
}

/** What `DELETE /api/team` moved (backend `DeletedTeam`). Paths are relative to the teams folder. */
export interface DeletedTeam {
  path: string
  name?: string
  /** The folder in the trash that now holds the team, e.g. `.trash/2026-10-01T090000Z-trip`. */
  trash: string
  moved: string[]
  deletedAt: string
}

/**
 * Move a team, its layout and its own Brief folder into the teams folder's `.trash/`. The daemon
 * refuses (409) while a run of the team is unfinished or another team inherits its memory, and
 * says why in words the operator can act on.
 */
export async function deleteTeamFile(path: string): Promise<DeletedTeam> {
  const query = new URLSearchParams({ path })
  const response = await daemonFetch(`/api/team?${query}`, { method: 'DELETE' })
  const body = (await response.json().catch(() => null)) as DeletedTeam | { error?: string } | null
  if (!response.ok) {
    const message = body && 'error' in body && body.error ? body.error : response.statusText
    throw new TeamFileApiError(message, response.status)
  }
  return body as DeletedTeam
}
