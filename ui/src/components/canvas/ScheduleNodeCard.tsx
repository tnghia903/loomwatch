import type { Node, NodeProps } from '@xyflow/react'

import { CardPorts } from './CardPorts'
import { AlertCircle, Clock3 } from 'lucide-react'

import { summarizeSchedule } from '../../lib/team-file/schedule'
import type { ScheduleConfig } from '../../lib/team-file/types'

export interface ScheduleNodeData extends Record<string, unknown> {
  schedule: ScheduleConfig
  invalid: boolean
  editorOpen: boolean
  onOpen: () => void
}

export type ScheduleNode = Node<ScheduleNodeData, 'schedule'>


// The editor itself lives in the right-hand panel (SchedulePanel) next to the Inspector, so the
// node stays a small, always-legible trigger card rather than growing a 420 px form over the
// canvas it is meant to start.
export function ScheduleNodeCard({ data }: NodeProps<ScheduleNode>) {
  return (
    <article className={`schedule-node ${data.invalid ? 'invalid' : ''}`} aria-label={`Schedule trigger, ${data.invalid ? 'needs attention' : summarizeSchedule(data.schedule)}`}>
      <span className="schedule-step" aria-hidden="true">1</span>
      <button type="button" className="schedule-node-main nodrag" onClick={data.onOpen} aria-expanded={data.editorOpen}>
        <span className="schedule-icon">{data.invalid ? <AlertCircle size={23} aria-hidden="true" /> : <Clock3 size={23} aria-hidden="true" />}</span>
        <span className="schedule-copy">
          <strong className="t-node">Schedule trigger</strong>
          <span className={`t-meta ${data.invalid ? 'alert-copy' : ''}`}>{data.invalid ? 'Needs attention' : summarizeSchedule(data.schedule)}</span>
          {data.invalid && <span className="t-mono-sm">Currently: {data.schedule.cron || 'not set'}</span>}
        </span>
        <span className={`schedule-state ${data.invalid ? 'error' : ''}`} aria-hidden="true" />
      </button>
      <CardPorts input={false} />
    </article>
  )
}
