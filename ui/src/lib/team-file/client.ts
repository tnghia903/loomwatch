// Thin wrapper over the daemon REST surface added in TNG-52 (crates/loomwatch-backend/src/api.rs).

export interface TeamFilePayload {
  path: string
  yaml: string
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
