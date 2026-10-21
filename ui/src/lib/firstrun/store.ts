/**
 * Whether Home opens on the first run (ADR 0075).
 *
 * The first run is for someone who has never had anything made in this LoomWatch: no run in its
 * history, none of My agents and no team (a new install has none). All are kept by LoomWatch itself, so a fresh install opens on
 * the first run even in a browser that used an earlier one. The browser remembers what a page
 * stored for as long as its address (127.0.0.1 and the port) stays the same, which outlives
 * removing and installing LoomWatch again, so nothing kept there decides it.
 *
 * Within one visit (this tab, until it closes) the answer is kept: "Just look around", the first
 * run's end and a check that found work all hold until then. Someone who still has nothing made
 * is offered it again next time, which is the person it is for.
 */

const STORAGE_KEY = 'loomwatch:first-run'

/** Looked around instead, finished it, or found to have made something already. */
export type FirstRunState = 'skipped' | 'done' | 'not-new'

export function readFirstRun(): FirstRunState | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY)
    return value === 'skipped' || value === 'done' || value === 'not-new' ? value : null
  } catch {
    return null
  }
}

export function markFirstRun(state: FirstRunState) {
  try { sessionStorage.setItem(STORAGE_KEY, state) } catch { /* the first run still ends on this page */ }
}

/** What the first run is decided from, as the daemon answers it. */
export interface MadeSoFar {
  listRuns: () => Promise<readonly unknown[]>
  /** My agents, or null from a daemon too old to keep them. */
  listAgents: () => Promise<{ jobs: readonly unknown[] } | null>
  /** The team files in the teams folder. */
  listTeams: () => Promise<{ files: readonly unknown[] }>
}

/**
 * Whether to open on the first run: nothing decided in this visit, no run ever, none of My agents
 * and no team. When any of them can't be read, the answer is no: a returning person sent back to the first
 * run is worse than a newcomer seeing Home.
 */
export async function opensOnFirstRun({ listRuns, listAgents, listTeams }: MadeSoFar): Promise<boolean> {
  if (readFirstRun()) return false
  try {
    const [runs, agents, teams] = await Promise.all([listRuns(), listAgents(), listTeams()])
    if (!Array.isArray(runs) || (agents !== null && !Array.isArray(agents.jobs)) || !Array.isArray(teams.files)) return false
    const fresh = runs.length === 0 && (agents?.jobs.length ?? 0) === 0 && teams.files.length === 0
    if (!fresh) markFirstRun('not-new')
    return fresh
  } catch {
    return false
  }
}

/** Tests only. */
export function resetFirstRunForTests() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
