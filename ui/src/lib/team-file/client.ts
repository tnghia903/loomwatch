// Thin wrapper over the daemon REST surface added in TNG-52 (crates/loomwatch-backend/src/api.rs).

export interface TeamFilePayload {
  path: string
  yaml: string
}

export interface TeamsDiscoveryPayload {
  root: string
  files: string[]
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
export async function saveTeamFile(path: string, yaml: string): Promise<TeamFilePayload> {
  const response = await fetch('/api/team', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
