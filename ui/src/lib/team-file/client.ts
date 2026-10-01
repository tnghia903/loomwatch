// Thin wrapper over the daemon REST surface added in TNG-52 (crates/loomwatch-backend/src/api.rs).

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
}

export interface TeamsDiscoveryPayload {
  root: string
  files: string[]
  /** Added after `files`; an older daemon omits it, so readers fall back to `files`. */
  teams?: TeamSummary[]
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
  const response = await fetch(`/api/team?${query}`)
  return readTeamFileResponse(response)
}

/** docs/CANVAS_SPEC.md §15.4: the canonical root is the source for absolute display paths. */
export async function fetchTeamsDiscovery(): Promise<TeamsDiscoveryPayload> {
  const response = await fetch('/api/teams')
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
  const response = await fetch('/api/team', {
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
  const response = await fetch('/api/config/schema')
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new TeamFileApiError(body?.error ?? response.statusText, response.status)
  }
  return (await response.json()) as object
}
