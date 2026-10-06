import { createElement, useMemo, useState } from 'react'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { OutputNodeData } from '../../lib/runs/graph'
import { RUN_PHASE_STATUS } from '../../lib/runs/graph'
import { formatOffset, type Capture, type CoverageKey, type Evidence, type RunPhase, type RunProjection } from '../../lib/watch/events'
import { useCanvasActions } from '../canvas/CanvasActionsContext'
import { roleGlyph } from '../canvas/roleGlyph'
import { StripLine } from './StoryNodes'
import { CoverageGlyph, EntityGlyph, StatusGlyph } from '../ui/glyphs'
import { CATEGORIES, coverageFor, coverageSummary, coverageWord } from './coverage'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

// §5.1: the four capture states are "visibly and textually distinct" — the word is never
// omitted to save space, which at this width is the only channel the card still has.
const CAPTURE_WORD: Record<Capture, string> = {
  recorded: 'Recorded',
  derived: 'Derived',
  redacted: 'Redacted',
  unavailable: 'Not captured',
}

const CATEGORY_OF = new Map<Evidence['kind'], CoverageKey>(
  CATEGORIES.flatMap((category) => category.kinds.map((kind) => [kind, category.key] as const)),
)

export interface RunColumnProps {
  prompt: string
  attempt: number
  phase: RunPhase
  branch: string
  elapsed: string
  mode: 'live' | 'replay'
  agents: AgentNode[]
  evidenceByAgent: ReadonlyMap<string, Evidence[]>
  ownerLabels: ReadonlyMap<string, string>
  output: OutputNodeData
  projection: RunProjection
  selectedEvidenceId: string | null
  onInspectEvidence: (id: string) => void
  onSelectAgent: (id: string) => void
}

// TNG-115 / §12.5: at phone widths the coordinate graph yields to a reading column whose DOM
// order is the causal sentence — Prompt → Run → lead → evidence → responder → Output — with the
// relationship words kept on the cards, since the edge geometry is gone.
//
// §11.6 fixes what follows the response: coverage → filters → summaries → selected evidence,
// then the docked composer. TNG-173: those three stages had no counterpart here, so below
// 768 px §4.1's summaries, §4.4's filters and every visible trace of the §5 honesty layer
// were unreachable — ProvenancePanel's only opener lives on the canvas this column replaces.
export function RunColumn({ prompt, attempt, phase, branch, elapsed, mode, agents, evidenceByAgent, ownerLabels, output, projection, selectedEvidenceId, onInspectEvidence, onSelectAgent }: RunColumnProps) {
  const { reusePrompt, toggleProvenance } = useCanvasActions()
  // §4.4 / §6.7: filtering is view state, never document state, and never re-runs the
  // projector — so it lives here and dies with the column.
  const [hidden, setHidden] = useState<ReadonlySet<CoverageKey>>(new Set())
  const [onlyRedacted, setOnlyRedacted] = useState(false)
  const [onlyNotCaptured, setOnlyNotCaptured] = useState(false)
  const coverage = coverageSummary(projection)
  const filtered = hidden.size > 0 || onlyRedacted || onlyNotCaptured
  const shows = useMemo(() => {
    return (item: Evidence) => {
      const key = CATEGORY_OF.get(item.kind)
      if (key && hidden.has(key)) return false
      // The two capture filters are additive: with both on, the run shows redacted *and*
      // not-captured entities, which is how "only" reads in §4.4's pair.
      if (onlyRedacted || onlyNotCaptured) {
        return (onlyRedacted && item.capture === 'redacted') || (onlyNotCaptured && item.capture === 'unavailable')
      }
      return true
    }
  }, [hidden, onlyRedacted, onlyNotCaptured])
  const shownCount = useMemo(() => projection.evidence.filter(shows).length, [projection.evidence, shows])
  const clearFilters = () => { setHidden(new Set()); setOnlyRedacted(false); setOnlyNotCaptured(false) }
  const toggleCategory = (key: CoverageKey) => setHidden((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const label = `Run ${String(attempt).padStart(2, '0')}`
  // §3.4: a terminally failed run has no answer coming — the node is the strip plus
  // `[ Reuse ]`, never a "yet" placeholder.
  const terminalEmpty = output.phase === 'failed' && !output.text
  return (
    <div className="run-column" role="list" aria-label="Run, in causal order">
      <article className="rt story-prompt" role="listitem" aria-label={`Prompt, original user request for run ${attempt}`}>
        <div className="rt-head t-micro"><EntityGlyph kind="prompt" /> Prompt · user request<span className="spacer" /><span className="prompt-lock t-meta">Original kept</span></div>
        <div className="rt-body t-body selectable">{prompt}</div>
      </article>
      <span className="rel t-micro">starts</span>
      <div className={cx('rt run-node', `st-${RUN_PHASE_STATUS[phase]}`)} role="listitem" aria-label={`${label}, ${phase}`}>
        <div className="rt-head t-micro"><StatusGlyph status={RUN_PHASE_STATUS[phase]} /> {label}</div>
        <div className="run-meta t-meta">{branch} · <b>{phase}</b>{elapsed !== '—' ? ` · ${elapsed}` : ''}</div>
      </div>
      {agents.map((node, index) => {
        const { agent, runtime } = node.data
        const items = evidenceByAgent.get(node.id) ?? []
        const status = runtime?.status ?? 'idle'
        return (
          <div key={node.id} className="run-column-agent" role="listitem">
            <span className="rel t-micro">{index === 0 ? 'assigns lead' : 'delegates to'}</span>
            <button type="button" className={cx('node has-task static', `st-${status}`, node.data.isEntrypoint && 'entry')} onClick={() => onSelectAgent(node.id)} aria-label={`${agent.name}, ${runtime?.ownerLabel ?? ''}, ${runtime?.taskState ?? status}`}>
              <span className="rail" aria-hidden="true" />
              <span className="node-top">
                <span className="node-glyph">{createElement(roleGlyph(agent.role), { size: 18, 'aria-hidden': 'true' })}</span>
                <span className="node-id">
                  <span className="node-name t-node">{agent.name}</span>
                  <span className={cx('node-role t-meta', !agent.role && 'empty')}>{agent.role || 'Add a role'}</span>
                </span>
                <StatusGlyph status={status} />
              </span>
              {runtime && <span className="node-task t-meta"><StatusGlyph status={status} /><b>{runtime.ownerLabel} · {runtime.taskState}</b><span className="task-text">{runtime.task}</span></span>}
            </button>
            {items.filter(shows).map((item) => {
              const itemStatus = item.status === 'succeeded' ? 'succeeded' : item.status === 'failed' || item.status === 'rejected' ? 'failed' : item.status === 'pending' ? 'starting' : 'running'
              return (
                <button key={item.id} type="button" className={cx('activity-ent', `st-${itemStatus}`, selectedEvidenceId === item.id && 'selected')} onClick={() => onInspectEvidence(item.id)} aria-label={`Inspect ${item.kind}: ${item.name}, ${item.capture}, ${ownerLabels.get(item.agentId) ?? item.agentId}, ${item.status}, event ${item.order}, ${formatOffset(item.offsetMs)}`}>
                  <span className="ae-order t-micro">#{String(item.order).padStart(2, '0')} · {formatOffset(item.offsetMs)}</span>
                  <span className="ae-main t-body-m"><EntityGlyph kind={item.kind} size={13} /><span className="ae-name">{item.name}</span></span>
                  <span className="ae-sub t-meta"><StatusGlyph status={itemStatus} /> {item.status.toUpperCase()} · {(ownerLabels.get(item.agentId) ?? item.agentId).split(' · ')[0]} {item.relation}</span>
                  {/* §11.6: the edge geometry is gone at this width, the information it carried is
                      not — and capture quality is the one field that reached the accessible name
                      only (TNG-173 N4). The word is the entity's own projector-set `capture`. */}
                  <span className={cx('ae-cap t-micro', `cap-${item.capture}`)}>{CAPTURE_WORD[item.capture]}</span>
                  <span className="ae-detail t-mono-sm">{item.detail}</span>
                </button>
              )
            })}
          </div>
        )
      })}
      <span className="rel t-micro">responds with</span>
      <article className={cx('rt rt-response story-output', `st-${RUN_PHASE_STATUS[output.phase]}`)} role="listitem" aria-label={terminalEmpty ? `Output, ${output.phaseText}` : `Output response from ${output.producerLabel}, ${output.phaseText}`}>
        <div className="rr-head t-body-m">
          <StatusGlyph status={RUN_PHASE_STATUS[output.phase]} />
          <span className="rr-phase">{output.phaseText}</span>
          <span className={cx('badge t-micro', mode === 'live' ? 'badge-live' : 'badge-replay')}><span className="pip" />{mode === 'live' ? 'Live' : 'Replay'}</span>
        </div>
        <div className="rr-sub t-micro">Output / response · {output.producerLabel}</div>
        {output.pending ? (
          <div className="rr-body"><div className="skel-bars"><i className="skel-bar" style={{ width: '88%' }} /><i className="skel-bar" style={{ width: '96%' }} /><i className="skel-bar" style={{ width: '64%' }} /></div></div>
        ) : terminalEmpty ? null : (
          <div className={cx('rr-body selectable', !output.text && 'empty')}>{output.text || 'No response text yet.'}{output.streaming && <span key={output.text.length} className="caret" aria-hidden="true" />}</div>
        )}
        {output.streaming && mode === 'live' && <div className="rr-stream" aria-hidden="true" />}
        {output.strip && <StripLine strip={output.strip} />}
        {terminalEmpty && reusePrompt && (
          <button
            type="button"
            className="rr-reuse nodrag"
            onClick={(event) => { event.stopPropagation(); reusePrompt() }}
          >
            [ Reuse ]
          </button>
        )}
      </article>
      {/* §11.6: coverage → filters → summaries. The overlay ProvenancePanel stays the one
          detail surface (§4.4 — "one detail surface in the product, not two"), so the column
          never re-lists entities; it states the run's coverage, carries the filters, and the
          six summaries are the way in. */}
      <section className="run-prov" role="listitem" aria-labelledby="run-prov-title">
        <h2 className="rt-head t-micro" id="run-prov-title"><EntityGlyph kind="response" size={13} /> Provenance</h2>
        <p className="run-prov-cov t-micro" title="Complete for what the adapters can observe — never an agent's private internal state.">
          <CoverageGlyph level={coverage.complete ? 'complete' : 'partial'} /> {coverage.text}
        </p>
        <div className="run-prov-filters" role="group" aria-label="Filter the evidence this run shows">
          {CATEGORIES.map((category) => (
            <button key={category.key} type="button" className="filter-chip t-micro" aria-pressed={!hidden.has(category.key)} onClick={() => toggleCategory(category.key)}>
              <EntityGlyph kind={category.kind} size={12} /> {category.label}
            </button>
          ))}
          <button type="button" className="filter-chip t-micro" aria-pressed={onlyRedacted} onClick={() => setOnlyRedacted((on) => !on)}>Only redacted</button>
          <button type="button" className="filter-chip t-micro" aria-pressed={onlyNotCaptured} onClick={() => setOnlyNotCaptured((on) => !on)}>Only not captured</button>
        </div>
        {/* An emptied list must not read as an empty run — that is the §5.1 confusion the
            honesty layer exists to prevent. The filters say so, and offer their own way back. */}
        {filtered && shownCount === 0 && projection.evidence.length > 0 && (
          <p className="run-prov-empty t-meta">No evidence matches these filters. {projection.evidence.length} {projection.evidence.length === 1 ? 'entity was' : 'entities were'} captured for this run. <button type="button" className="link" onClick={clearFilters}>Clear filters</button></p>
        )}
        <ul className="run-prov-sums" aria-label="Provenance summaries">
          {CATEGORIES.map((category) => {
            const level = coverageFor(category.key, projection)
            const count = projection.coverage[category.key].observed
            return (
              <li key={category.key}>
                {/* The count and level are the projector's, never the filter's: a filtered
                    view that also restated the counts would let view state look like capture. */}
                <button type="button" className="prov-sum" onClick={toggleProvenance} aria-label={`${category.label}, ${count} ${count === 1 ? 'entity' : 'entities'}, ${coverageWord(level)}. Open full provenance.`}>
                  <EntityGlyph kind={category.kind} size={13} />
                  <span className="ps-label t-micro">{category.label}</span>
                  <span className="ps-count t-body-m">{count || '—'}</span>
                  <span className="ps-level t-meta"><CoverageGlyph level={level} /> {coverageWord(level)}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <button type="button" className="btn" onClick={toggleProvenance}>Open full provenance</button>
      </section>
    </div>
  )
}
