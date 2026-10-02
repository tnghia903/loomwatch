import { describeNextFire, type ScheduleEntry } from '../../lib/runs/client'

export interface RoutineNoteProps {
  schedule: ScheduleEntry
  onRunNow: () => void
  busy: boolean
}

/**
 * The composer's one line about a team's `schedule:` block: when it runs next, where the reply
 * goes, what went wrong last time, and a way to run it now. It used to live in the mode popover,
 * which was retired because nothing else in it was something an operator needed to see.
 */
export function RoutineNote({ schedule, onRunNow, busy }: RoutineNoteProps) {
  const when = schedule.enabled ? `${schedule.describe} · next ${describeNextFire(schedule.nextAt)}` : 'paused'
  const lastRan = schedule.lastFiredAt
    ? `Last ran ${new Date(schedule.lastFiredAt).toLocaleString()}${schedule.lastStatus ? ` (${schedule.lastStatus})` : ''}.`
    : 'Has not run yet.'
  // A scheduler problem outranks a failed delivery: it means the routine is not firing at all.
  const trouble = schedule.problem
    ?? (schedule.lastDelivery?.status === 'failed' ? `Last delivery to Notion failed: ${schedule.lastDelivery.message}` : null)
  return (
    <>
      <span className="routine-summary" title={`Each run asks: ${schedule.prompt}\n${lastRan}`}>
        Routine: {when}{schedule.deliver?.notion ? ' · delivers to Notion' : ''}
      </span>
      {trouble && <span className="routine-trouble" role="alert" title={trouble}>{trouble}</span>}
      <button type="button" className="link" onClick={onRunNow} disabled={busy} title="Run this routine now, with its own prompt and delivery">
        {busy ? 'Starting…' : 'Run now'}
      </button>
    </>
  )
}
