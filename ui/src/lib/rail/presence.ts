import { baseName, splitPath } from '../files/paths'
import { isOpenTeam } from '../library/uses'
import { isTerminalRun, type RunRecord } from '../runs/client'

/**
 * What an agent or a team in the rail is doing, as its figure glows it (the team chat's colours):
 * waiting for you (gold), working (blue), failed (red), or ready, which does not glow.
 */
export type Presence = 'waiting' | 'working' | 'failed' | 'ready'

/** The words for each, as the team chat says them; ready says nothing, it is how things rest. */
export const PRESENCE_WORDS: Record<Presence, string | null> = {
  waiting: 'waiting for you',
  working: 'working',
  failed: 'failed',
  ready: null,
}

const asksYou = (run: RunRecord) => Boolean(run.waitingOn || run.permissionRequests?.length || run.spendStops?.length)

/**
 * What one chat's runs add up to. Something waiting on you outranks work in progress; a newest
 * run that failed stays failed until the next one starts, as a face in the team chat does.
 */
export function presenceOf(runs: readonly RunRecord[]): Presence {
  const live = runs.filter((run) => !isTerminalRun(run.status))
  if (live.some(asksYou)) return 'waiting'
  if (live.length > 0) return 'working'
  const newest = runs.reduce<RunRecord | null>((found, run) => (!found || found.createdAt < run.createdAt ? run : found), null)
  // The schedule trying a run again is nothing to fix.
  return newest?.status === 'failed' && !newest.nextTryAt ? 'failed' : 'ready'
}

/**
 * The agent whose own chat a run's team file is: one of the one-agent teams kept in the teams
 * folder's `.jobs/.bench/<chat id>.yaml` (AgentChat). `null` for any other team.
 */
export function benchChatId(teamPath: string): string | null {
  const parts = splitPath(teamPath)
  if (parts.length < 3 || parts[parts.length - 3] !== '.jobs' || parts[parts.length - 2] !== '.bench') return null
  const file = baseName(teamPath)
  return /\.ya?ml$/i.test(file) ? file.replace(/\.ya?ml$/i, '') : null
}

/** What the agent saved as `agentId` is doing in its own chat. */
export function agentPresence(runs: readonly RunRecord[], agentId: string): Presence {
  return presenceOf(runs.filter((run) => benchChatId(run.teamPath) === agentId))
}

/**
 * What the team listed at `teamPath` (under the teams folder `root`) is doing. A run names its
 * team as it was opened, which in the running app is the full path.
 */
export function teamPresence(runs: readonly RunRecord[], teamPath: string, root: string | null): Presence {
  return presenceOf(runs.filter((run) => isOpenTeam(teamPath, run.teamPath, root)))
}
