import { describeNextFire, type ScheduleEntry } from '../../lib/runs/client'
import type { PipelineStep } from '../../lib/team-file/pipelineOrder'
import type { GuardsConfig } from '../../lib/team-file/types'
import type { ExecutionMode } from '../../lib/team-file/useTeamDocument'

export interface ModePopoverProps {
  mode: ExecutionMode
  steps: PipelineStep[]
  nodeNames: ReadonlyMap<string, string>
  entrypointName: string | null
  guards: GuardsConfig | null
  anomalies: { from: string; to: string; kind: string }[]
  readOnly: boolean
  onUpdateGuards: (field: keyof GuardsConfig, value: number) => void
  onClose: () => void
  /** The team file's `schedule` block, as the daemon reports it; null when the team has none. */
  schedule?: ScheduleEntry | null
  onRunRoutineNow?: () => void
  routineBusy?: boolean
}

// CANVAS_SPEC §8.1: mode is a consequence of the file, never a toggle. This popover is the
// only place execution semantics are explained, and it is disclosed rather than resident.
export function ModePopover({ mode, steps, nodeNames, entrypointName, guards, anomalies, readOnly, onUpdateGuards, onClose, schedule, onRunRoutineNow, routineBusy }: ModePopoverProps) {
  return (
    <div className="pop e2 mode-pop" role="dialog" aria-label="What this mode means" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <div className="mp-body t-body">
        {mode === 'team' ? (
          <>
            <p><code>edges</code> is empty, so <b>{entrypointName ?? 'the entrypoint'}</b> receives the goal and decides who else to involve. All six Team Bus tools are available.</p>
            <p className="mp-tools t-meta">roster · dispatch · ask · handoff · report · escalate</p>
          </>
        ) : (
          <>
            <p>{steps.length} step{steps.length === 1 ? '' : 's'} run in the order you drew. <code>dispatch</code> and <code>handoff</code> are withdrawn; the backend sequences the run.</p>
            <ol className="mp-order t-body">
              {steps.map((step) => (
                <li key={step.id}>
                  <span className="mp-step t-mono-sm">{step.step}</span>
                  <span>{nodeNames.get(step.id) ?? step.id}</span>
                  {step.joinFrom.length > 0 && <span className="t-meta mp-note">← {step.joinFrom.map((id) => nodeNames.get(id) ?? id).join(', ')}</span>}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      {anomalies.length > 0 && (
        <>
          <div className="pop-sep" />
          <div className="mp-guards">
            <span className="mp-head alert t-micro">Anomalies</span>
            {anomalies.map((anomaly) => (
              <span key={`${anomaly.from}-${anomaly.to}-${anomaly.kind}`} className="t-meta">{anomaly.kind} observed from <b>{nodeNames.get(anomaly.from) ?? anomaly.from}</b> to <b>{nodeNames.get(anomaly.to) ?? anomaly.to}</b> with no configured counterpart.</span>
            ))}
          </div>
        </>
      )}
      {schedule && (
        <>
          <div className="pop-sep" />
          <div className="mp-guards mp-routine" aria-label="Routine">
            <span className="mp-head t-micro">Routine</span>
            <span className="t-meta"><b>{schedule.enabled ? 'Runs' : 'Paused —'} {schedule.describe}</b>{schedule.timezone ? '' : ' (daemon local time)'} · next {describeNextFire(schedule.nextAt)}</span>
            {schedule.deliver?.notion && <span className="t-meta">Delivers the reply to your Notion destination as “{schedule.deliver.notion.title}”.</span>}
            {schedule.lastFiredAt && <span className="t-meta">Last fired {new Date(schedule.lastFiredAt).toLocaleString()}{schedule.lastStatus ? ` · ${schedule.lastStatus}` : ''}{schedule.lastDelivery ? ` · Notion ${schedule.lastDelivery.status}` : ''}</span>}
            {schedule.problem && <span className="t-meta" role="alert" style={{ color: 'var(--color-alert)' }}>{schedule.problem}</span>}
            <span className="mp-prompt t-meta" title="The prompt every fire submits">{schedule.prompt}</span>
            <span className="mp-acts">
              <button type="button" className="btn" onClick={onRunRoutineNow} disabled={routineBusy || !onRunRoutineNow} title="Run this routine now with its own prompt and delivery">{routineBusy ? 'Starting…' : 'Run routine now'}</button>
              <span className="mp-note t-meta"><code>schedule:</code> lives in the team file.</span>
            </span>
          </div>
        </>
      )}
      <div className="pop-sep" />
      <div className="mp-guards">
        <span className="mp-head t-micro">Guards</span>
        <label className="mp-field t-meta">Max dispatch depth
          <input type="number" min={1} value={guards?.maxDispatchDepth ?? 8} disabled={readOnly} onChange={(event) => onUpdateGuards('maxDispatchDepth', Number(event.target.value))} aria-label="Max dispatch depth" />
        </label>
        <label className="mp-field t-meta">Max concurrent dispatches
          <input type="number" min={1} value={guards?.maxConcurrentDispatches ?? 8} disabled={readOnly} onChange={(event) => onUpdateGuards('maxConcurrentDispatches', Number(event.target.value))} aria-label="Max concurrent dispatches" />
        </label>
      </div>
    </div>
  )
}
