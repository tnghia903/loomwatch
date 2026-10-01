import type { AgentStatus } from '../team-file/types'
import type { RunPhase, TaskState } from '../watch/events'

export interface SettledState {
  status: AgentStatus
  taskState: TaskState
  task: string
}

const UNFINISHED: ReadonlySet<AgentStatus> = new Set(['running', 'starting', 'waiting'])
const OVER: ReadonlySet<RunPhase> = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

/**
 * What a card says once its run is over. The projection keeps each agent's last live state, so a
 * run stopped at a review step still read "Researcher running · You waiting" — on cards, and on the
 * receipt that follows them — long after nothing was running or waiting.
 *
 * A pipeline stage that was kept alive after handing over (so the next step could send work
 * back) did finish its part; that is known because a later step started. Anyone else still
 * mid-task ended with the run. `null` leaves the state as recorded.
 */
export function settleAfterRun(
  status: AgentStatus,
  { phase, operator, laterStageStarted }: { phase: RunPhase; operator: boolean; laterStageStarted: boolean },
): SettledState | null {
  if (!OVER.has(phase) || !UNFINISHED.has(status)) return null
  const byYou = phase === 'cancelled'
  if (operator) return { status: 'stopped', taskState: 'STOPPED', task: byYou ? 'Not answered — you stopped the run' : 'Not answered before the run ended' }
  if (laterStageStarted) return { status: 'succeeded', taskState: 'DONE', task: 'Handed over' }
  return { status: 'stopped', taskState: 'STOPPED', task: byYou ? 'Stopped when you stopped the run' : 'Stopped when the run ended' }
}
