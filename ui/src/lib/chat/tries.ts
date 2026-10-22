// A routine's run that couldn't reach its AI source, the first seconds after the computer woke, say,
// is tried again by the schedule a little later (`schedule.retryAfterMinutes`). Each try is a run of
// its own, a retry of the one before, but it is one job: the chat shows it once, at its newest try,
// with one line for the tries before it.
import { clockTime, listNames } from './format'
import type { RunRecord } from '../runs/client'

type Try = Pick<RunRecord, 'runId' | 'trigger' | 'retryOfRunId' | 'createdAt' | 'error'>

/** From this many tries that couldn't reach their AI, the line counts them instead of listing every time. */
const COUNTED = 3

/** A try the schedule made by itself, after the run it retries couldn't reach its AI source. */
function triedBySchedule(run: Pick<RunRecord, 'trigger' | 'retryOfRunId'>): boolean {
  return run.trigger === 'schedule' && Boolean(run.retryOfRunId)
}

/** The runs the schedule tried again: each is folded into the try that followed it. */
export function triedAgain(runs: Iterable<Pick<RunRecord, 'trigger' | 'retryOfRunId'>>): Set<string> {
  const tried = new Set<string>()
  for (const run of runs) if (triedBySchedule(run) && run.retryOfRunId) tried.add(run.retryOfRunId)
  return tried
}

/** The tries before `run` the chat has, oldest first. */
export function earlierTries<T extends Try>(run: Try, runs: ReadonlyMap<string, T>): T[] {
  const earlier: T[] = []
  const seen = new Set([run.runId])
  let tried: Try = run
  while (triedBySchedule(tried) && tried.retryOfRunId && !seen.has(tried.retryOfRunId)) {
    const before = runs.get(tried.retryOfRunId)
    if (!before) break
    seen.add(before.runId)
    earlier.unshift(before)
    tried = before
  }
  return earlier
}

// The daemon's words for a source it couldn't reach (`AgentError::Network` in agent/error.rs).
const UNREACHABLE = /LoomWatch couldn't reach (OpenRouter|ChatGPT|Anthropic)\b/

/**
 * The one line about a job's tries, state first: that the schedule tries again and when, or that it
 * did, and which source it couldn't reach when. `null` when there is nothing to say: no earlier try,
 * and none to come.
 */
export function triesLine(run: Try & Pick<RunRecord, 'nextTryAt'>, earlier: readonly Try[]): string | null {
  const failed = run.nextTryAt ? [...earlier, run] : earlier
  if (failed.length === 0) return null
  const source = failed.map((tried) => UNREACHABLE.exec(tried.error ?? '')?.[1]).find(Boolean) ?? 'the AI'
  const what = failed.length >= COUNTED
    ? `couldn’t reach ${source} ${failed.length} times since ${clockTime(failed[0].createdAt)}`
    : `couldn’t reach ${source} at ${listNames(failed.map((tried) => clockTime(tried.createdAt)))}`
  // The schedule's request just above says when this try started.
  return run.nextTryAt ? `Trying again at ${clockTime(run.nextTryAt)} · ${what}` : `Tried again · ${what}`
}

/** A run the schedule is waiting to try again: nothing has failed that anyone must act on yet. */
export function tryingAgain(run: Pick<RunRecord, 'status' | 'nextTryAt'>): boolean {
  return run.status === 'failed' && Boolean(run.nextTryAt)
}
