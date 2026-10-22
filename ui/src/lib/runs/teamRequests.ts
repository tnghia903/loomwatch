import { daemonFetch } from '../daemonFetch'

/**
 * One of the person's teams the agent pinned to the notch asked to do part of a job (ADR 0083,
 * decision 10). Nothing runs until the person presses Start; the team's answer then goes back to
 * the agent in its own chat. Kept by `loomwatchd` in memory, as the agents' chat answers are.
 */
export interface TeamRequest {
  id: string
  askedBy: { runId: string; agent: string; chatPath: string }
  team: { path: string; name: string }
  /** What the agent asked the team to do. */
  request: string
  status: 'waiting' | 'started' | 'declined' | 'done' | 'failed'
  /** The team's run, once started. */
  runId: string | null
  /** Why it could not start, or why the team stopped, in plain words. */
  problem: string | null
  createdAt: string
  finishedAt: string | null
}

async function read<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok) throw new Error(body?.error ?? 'LoomWatch couldn’t answer. Restart LoomWatch and try again.')
  return body as T
}

/** Requests waiting or under way, and those that ended in the last `seconds`. A daemon older than
    them has none. */
export async function fetchTeamRequests(seconds: number, signal?: AbortSignal): Promise<TeamRequest[]> {
  const response = await daemonFetch(`/api/team-requests?finishedWithin=${seconds}`, { signal, cache: 'no-store' })
  if (response.status === 404) return []
  return read<TeamRequest[]>(response)
}

/** Start the team on it, or say not now. */
export async function answerTeamRequest(id: string, decision: 'start' | 'decline'): Promise<TeamRequest> {
  const response = await daemonFetch(`/api/team-requests/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
    cache: 'no-store',
  })
  return read<TeamRequest>(response)
}
