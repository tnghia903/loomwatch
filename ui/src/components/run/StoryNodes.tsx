import type { NodeProps } from '@xyflow/react'

import { CardPorts } from '../canvas/CardPorts'

import type { EvidenceNode, MoreNode, OutputNode, PromptNode, RunNode } from '../../lib/runs/graph'
import { RUN_PHASE_STATUS } from '../../lib/runs/graph'
import { formatOffset } from '../../lib/watch/events'
import { EntityGlyph, StatusGlyph } from '../ui/glyphs'
import { useCanvasActions } from '../canvas/CanvasActionsContext'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

// TNG89 §12.2: the durable input is the graph's first node — exact submitted text,
// `Original kept`, survives every terminal state.
//
// §15.2.2 makes it permanent. Before a run it is the composer's draft: the text mirrors in as the
// operator types and a click focuses the composer, so there is one editor seen in two places and
// never two editors. On submit it locks, names its attempt, and stops being editable at all —
// editing a submitted prompt would imply the run changed (§3.2).
export function PromptNodeCard({ data }: NodeProps<PromptNode>) {
  const { focusComposer } = useCanvasActions()
  const draft = data.draft === true
  const label = draft
    ? 'Prompt, your draft. Click to focus the composer.'
    : `Prompt, original user request for run ${data.attempt}${data.lineage ? `, ${data.lineage}` : ''}`
  const body = draft
    ? data.text || 'Your prompt appears here as you type it in the composer.'
    : data.text
  if (draft) {
    return (
      <button
        type="button"
        className={cx('rt story-prompt story-draft nodrag', !data.text && 'empty')}
        aria-label={label}
        onClick={() => focusComposer?.()}
      >
        <span className="rt-head t-micro">
          <EntityGlyph kind="prompt" /> Prompt · your draft
          <span className="spacer" />
          <span className="t-meta prompt-draft-hint">Click to type</span>
        </span>
        <span className={cx('rt-body t-body', !data.text && 'empty')}>{body}</span>
        <CardPorts input={false} />
      </button>
    )
  }
  return (
    <article className="rt story-prompt" aria-label={label}>
      <div className="rt-head t-micro">
        <EntityGlyph kind="prompt" /> Prompt · user request
        <span className="spacer" />
        <span className="t-meta">Run {String(data.attempt ?? 1).padStart(2, '0')}{data.lineage ? ` · ${data.lineage}` : ''}</span>
        <span className="prompt-lock t-meta">Original kept</span>
      </div>
      <div className="rt-body t-body selectable">{data.text}</div>
      <CardPorts input={false} />
    </article>
  )
}

// One immutable attempt: number, state, live/replay, retry parent when present.
export function RunNodeCard({ data }: NodeProps<RunNode>) {
  const label = `Run ${String(data.attempt).padStart(2, '0')}`
  const status = RUN_PHASE_STATUS[data.phase]
  return (
    <div className={cx('rt run-node', `st-${status}`)} role="status" aria-label={`${label}, ${data.phase}, initiated by the prompt`}>
      <div className="rt-head t-micro"><StatusGlyph status={status} /> {label}</div>
      <div className="run-meta t-meta">{data.trigger === 'schedule' ? 'Routine' : data.branch} · <b>{data.phase}</b>{data.elapsed !== '—' ? ` · ${data.elapsed}` : ''}</div>
      <CardPorts />
    </div>
  )
}

// TNG-113 live activity projection: every card has an exact owner, ordinal, time, status
// and relationship word. Kind and ownership live in the words, not in decorative colour.
// TNG89 §6.4: the accessible name also carries the capture word, read from the entity's
// own `capture` field — the projector sets it from its accepted-event invariant (CONTRACT
// §8.1), so no surface asserts a capture word of its own.
export function EvidenceNodeCard({ data }: NodeProps<EvidenceNode>) {
  const { evidence, ownerLabel } = data
  const { inspectEvidence } = useCanvasActions()
  const status = evidence.status === 'succeeded' ? 'succeeded' : evidence.status === 'failed' || evidence.status === 'rejected' ? 'failed' : evidence.status === 'pending' ? 'starting' : 'running'
  const word = evidence.status.toUpperCase()
  const kindGlyph = evidence.kind === 'delegation' ? 'delegation' : evidence.kind
  return (
    <button
      type="button"
      className={cx('activity-ent', `st-${status}`, data.selected && 'selected')}
      onClick={() => inspectEvidence?.(evidence.id)}
      aria-pressed={data.selected}
      aria-label={`Inspect ${evidence.kind}: ${evidence.name}, ${evidence.capture}, ${ownerLabel}, ${evidence.status}, event ${evidence.order}, ${formatOffset(evidence.offsetMs)}`}
    >
      <span className="ae-order t-micro">#{String(evidence.order).padStart(2, '0')} · {formatOffset(evidence.offsetMs)}</span>
      <span className="ae-main t-body-m"><EntityGlyph kind={kindGlyph} size={13} /><span className="ae-name">{evidence.name}</span></span>
      <span className="ae-sub t-meta"><StatusGlyph status={status} /> {word} · {ownerLabel.split(' · ')[0]} {evidence.relation}</span>
      <span className="ae-detail t-mono-sm">{evidence.detail}</span>
      <span className="ae-drag t-body" aria-hidden="true">⠿</span>
      <CardPorts output={false} />
    </button>
  )
}

// TNG89 §4: one hop at a time. Past two rows an agent's evidence folds into this card; the
// full list stays reachable in the provenance panel, with every ordinal and time intact.
export function MoreEvidenceCard({ data }: NodeProps<MoreNode>) {
  const { toggleProvenance } = useCanvasActions()
  return (
    <button type="button" className="activity-ent more nodrag" onClick={() => toggleProvenance?.()} aria-label={`${data.hidden} more evidence items from ${data.ownerLabel}; open provenance`}>
      <span className="ae-order t-micro">+{data.hidden} more</span>
      <span className="ae-main t-body-m"><span className="ae-name">{data.total} events from {data.ownerLabel.split(' · ')[0]}</span></span>
      <span className="ae-sub t-meta">Open provenance for the full list</span>
      <CardPorts output={false} />
    </button>
  )
}

// §15.2.2 makes it permanent and docks it right of the terminal stage. Until it has content it is
// drawn dashed and says whose reply will fill it; the answer then streams in place rather than
// arriving in a node that appears from nowhere. It deliberately shares the Prompt card's shell:
// input and output are the two bookends of one pipeline, not two unrelated interface patterns.
export function OutputNodeCard({ data }: NodeProps<OutputNode>) {
  const { toggleProvenance, reusePrompt } = useCanvasActions()
  const status = RUN_PHASE_STATUS[data.phase]
  const awaiting = data.awaiting === true
  const clickable = data.terminal && !awaiting
  // §3.4: `failed` has no content, so the node is the strip — code, verbatim message,
  // `[ Reuse ]`. A placeholder is a promise only a run that can still answer may keep, and the
  // accessible name must not credit a response the run never produced.
  const isFailed = data.phase === 'failed'
  // `placeholder: null` is the producer saying there is nothing coming; `undefined` leaves the
  // decision to the phase, which is what keeps the older `failed`-with-no-text path intact.
  const suppressed = data.placeholder === null || (data.placeholder === undefined && isFailed)
  const terminalEmpty = !data.text && !data.pending && suppressed
  const placeholder = data.placeholder ?? 'No response text yet.'
  // Dashed while the node is still waiting for content — never once it is certain none is coming.
  const waiting = !data.text && !data.pending && !terminalEmpty
  return (
    <article
      className={cx('rt story-prompt rt-response story-output', `st-${status}`, clickable && 'clickable', data.compact && 'compact', waiting && 'awaiting')}
      role={clickable ? 'button' : 'status'}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={clickable ? data.expanded : undefined}
      onClick={clickable ? () => toggleProvenance?.() : undefined}
      onKeyDown={clickable ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleProvenance?.() } } : undefined}
      aria-label={awaiting ? `Output, ${data.phaseText}` : terminalEmpty ? `Output, ${data.phaseText}` : `Output response from ${data.producerLabel}, ${data.phaseText}`}
    >
      <div className="rt-head t-micro">
        <EntityGlyph kind="response" />
        <span className="response-title">Output / response · {data.producerLabel}</span>
        <span className="spacer" />
        {!awaiting && <span className="response-phase t-meta" title={data.phaseText}><StatusGlyph status={status} /> {data.phase}</span>}
        {!awaiting && <span className={cx('badge t-micro', data.mode === 'live' ? 'badge-live' : 'badge-replay')}><span className="pip" />{data.mode === 'live' ? 'Live' : 'Replay'}</span>}
        {clickable && <span className="rr-toggle">{data.expanded ? 'Hide provenance' : 'Show provenance'}</span>}
      </div>
      {data.pending ? (
        <div className="rt-body rr-body"><div className="skel-bars"><i className="skel-bar" style={{ width: '88%' }} /><i className="skel-bar" style={{ width: '96%' }} /><i className="skel-bar" style={{ width: '64%' }} /></div></div>
      ) : terminalEmpty && !awaiting ? null : (
        <div className={cx('rt-body t-body rr-body selectable', !data.text && 'empty')}>{data.text || placeholder}{data.streaming && <span key={data.text.length} className="caret" aria-hidden="true" />}</div>
      )}
      {data.streaming && data.mode === 'live' && <div className="rr-stream" aria-hidden="true" />}
      {data.strip && <div className={cx('rt-strip t-meta', data.strip.tone)}><span className="msg">{data.strip.message}</span><span className="wm">{data.strip.watermark}</span></div>}
      {terminalEmpty && reusePrompt && (
        <button
          type="button"
          className="rr-reuse nodrag"
          onClick={(event) => { event.stopPropagation(); reusePrompt() }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          [ Reuse ]
        </button>
      )}
      <CardPorts output={false} connectIn={data.configurable === true} />
    </article>
  )
}

/** The strip under the response: transport, failure, cancellation, or delivery. */
export function StripLine({ strip }: { strip: NonNullable<OutputNode['data']['strip']> }) {
  return (
    <div className={cx('rt-strip t-meta', strip.tone)}>
      <span className="msg">{strip.href ? <a className="link" href={strip.href} target="_blank" rel="noreferrer">{strip.message}</a> : strip.message}</span>
      <span className="wm">{strip.watermark}</span>
    </div>
  )
}
