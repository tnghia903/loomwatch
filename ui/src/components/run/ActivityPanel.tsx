import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { describeEvidence } from '../../lib/story/weft'
import { formatOffset, type Evidence } from '../../lib/watch/events'
import { EntityGlyph, StatusGlyph } from '../ui/glyphs'

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    const record = block as Record<string, unknown>
    const inner = record.content as Record<string, unknown> | undefined
    if (inner && typeof inner.text === 'string') return inner.text
    if (typeof record.text === 'string') return record.text
    return ''
  }).filter(Boolean).join('\n')
}

// Live activity uses a compact inspection panel. It is deliberately not modal: the run stays
// visible and Escape/Close returns focus to the card that opened it.
export function ActivityPanel({ evidence, ownerLabel, onClose }: { evidence: Evidence; ownerLabel: string; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeButton.current?.focus() }, [evidence.id])
  const status = evidence.status === 'succeeded' ? 'succeeded' : evidence.status === 'failed' || evidence.status === 'rejected' ? 'failed' : evidence.status === 'pending' ? 'starting' : 'running'
  const output = contentText(evidence.content) || (evidence.rawOutput !== null && evidence.rawOutput !== undefined ? pretty(evidence.rawOutput) : '')
  return (
    <aside className="panel right top e1 lw-activity" aria-labelledby="activity-title activity-raw" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header className="insp-head">
        <span className="node-glyph"><EntityGlyph kind={evidence.kind} size={20} /></span>
        <span className="insp-text">
          {/* Plain words first; the exact call, as recorded, right under it. */}
          <div className="insp-title t-title" id="activity-title">{describeEvidence(ownerLabel.split(' · ')[0], evidence).replace(/\.$/, '')}</div>
          <div className="insp-raw t-mono-sm" id="activity-raw" title={evidence.name}>{evidence.name}</div>
          <div className="insp-id t-mono">#{String(evidence.order).padStart(2, '0')} · {formatOffset(evidence.offsetMs)} · seq {evidence.seq}</div>
          <div className="insp-status t-micro"><StatusGlyph status={status} /> {evidence.status} observed activity</div>
        </span>
        <button ref={closeButton} type="button" className="iconbtn" onClick={onClose} aria-label="Close activity details" title="Close (Esc)"><X size={15} aria-hidden="true" /></button>
      </header>
      <div className="zone">
        <div className="zone-head t-micro">Observed event</div>
        <dl className="proc-list t-mono-sm">
          <dt>Owner</dt><dd>{ownerLabel}</dd>
          <dt>Relation</dt><dd>{evidence.relation}{evidence.target ? ` ${evidence.target}` : ''}</dd>
          <dt>Kind</dt><dd>{evidence.kind}{evidence.toolKind ? ` · ${evidence.toolKind}` : ''}</dd>
          <dt>Time</dt><dd>{new Date(evidence.ts).toLocaleTimeString()}</dd>
          <dt>Detail</dt><dd>{evidence.detail}</dd>
          {evidence.locations.length > 0 && <><dt>Paths</dt><dd>{evidence.locations.map((location) => location.path + (location.line ? `:${location.line}` : '')).join('\n')}</dd></>}
        </dl>
      </div>
      {evidence.rawInput !== null && evidence.rawInput !== undefined && (
        <div className="zone">
          <div className="zone-head t-micro">Input</div>
          <pre className="ent-out t-mono-sm">{pretty(evidence.rawInput)}</pre>
        </div>
      )}
      {output && (
        <div className="zone">
          <div className="zone-head t-micro">Output</div>
          <pre className="ent-out t-mono-sm">{output}</pre>
        </div>
      )}
      <div className="zone">
        <details>
          <summary className="t-micro">Raw events · {evidence.events.length}</summary>
          <pre className="ent-out t-mono-sm" style={{ marginTop: 8 }}>{pretty(evidence.events.map((event) => ({ seq: event.seq, kind: event.kind, ts: event.ts, payload: event.payload })))}</pre>
        </details>
        <p className="hint t-meta">Projected from an observed activity event. It never changes the saved team file.</p>
      </div>
    </aside>
  )
}
