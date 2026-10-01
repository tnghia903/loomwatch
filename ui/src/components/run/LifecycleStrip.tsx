import { ChevronLeft, ChevronRight } from 'lucide-react'

import type { RunPhase } from '../../lib/watch/events'

export interface LifecycleStripProps {
  attempt: number
  waiting?: boolean
  phase: RunPhase
  leadTask: string
  result: string
  mode: 'live' | 'replay'
  lastSeq: number
  cursor: number | null
  onCursor: (seq: number | null) => void
  onClose: () => void
  costUsd: number | null
  elapsed: string
}

// TNG89 §11.2: three lifecycles, never collapsed. An agent task can be done while the run is
// still running; a run can succeed while its durable result is done. Replay gets a scrubber:
// the projection is pure, so every seq is a complete, byte-equivalent picture.
//
// §15.2.4 makes this strip the run chip: it *is* the view switch now, because there is no second
// view to switch to. `Clear` returns to the design alone — the configured graph without a run
// drawn onto it — and there is no "Back to the team canvas", because the canvas never left.
export function LifecycleStrip({ attempt, phase, waiting = false, leadTask, result, mode, lastSeq, cursor, onCursor, onClose, costUsd, elapsed }: LifecycleStripProps) {
  const position = cursor === null ? lastSeq : cursor
  const scrubbable = lastSeq > 0
  return (
    <div className="e1 life-strip" style={{ pointerEvents: 'auto' }} aria-label="Lifecycle summary" role="group">
      <span><b>Lead task</b>{leadTask}</span>
      <span><b>Run {String(attempt).padStart(2, '0')}</b>{waiting ? 'waiting for you' : phase}</span>
      <span><b>Result</b>{result}</span>
      <span><b>Elapsed</b>{elapsed}</span>
      {costUsd !== null && <span><b>Spend</b>${costUsd.toFixed(costUsd < 1 ? 4 : 2)}</span>}
      <span className={`badge t-micro ${mode === 'live' ? 'badge-live' : 'badge-replay'}`}><span className="pip" />{mode === 'live' ? 'Live' : 'Replay'}</span>
      {scrubbable && (
        <span className="scrub" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, textTransform: 'none', letterSpacing: 0, flexDirection: 'row' }}>
          <button type="button" className="iconbtn" style={{ width: 24, height: 24 }} onClick={() => onCursor(Math.max(0, position - 1))} disabled={position <= 0} aria-label="Previous event" title="Previous event (←)"><ChevronLeft size={14} aria-hidden="true" /></button>
          <input type="range" min={0} max={lastSeq} value={position} onChange={(event) => onCursor(Number(event.target.value))} aria-label="Replay position" style={{ width: 120, accentColor: 'var(--color-accent)' }} />
          <button type="button" className="iconbtn" style={{ width: 24, height: 24 }} onClick={() => onCursor(position + 1)} disabled={cursor === null} aria-label="Next event" title="Next event (→)"><ChevronRight size={14} aria-hidden="true" /></button>
          <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)', minWidth: 64 }}>{cursor === null ? 'latest' : `seq ${cursor}`} / {lastSeq}</span>
          {cursor !== null && <button type="button" className="btn" style={{ height: 22, padding: '0 8px' }} onClick={() => onCursor(null)}>Follow latest</button>}
        </span>
      )}
      <button type="button" className="btn" style={{ height: 24, padding: '0 10px' }} onClick={onClose} aria-label="Clear this run and show the design alone" title="Clear the run (Esc)">Clear</button>
    </div>
  )
}
