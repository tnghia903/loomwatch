import { X } from 'lucide-react'
import { useState } from 'react'

import { formatOffset, type CoverageKey, type RunProjection } from '../../lib/watch/events'
import { CoverageGlyph, EntityGlyph, StatusGlyph } from '../ui/glyphs'
import { CATEGORIES, EMPTY_REASONS, coverageFor, coverageSummary, coverageWord } from './coverage'

// The six categories, their empty reasons, the level lookup and the §5.2 coverage sentence
// live in ./coverage, shared with the narrow RunColumn — which states coverage on its own
// face because this panel is an overlay at that width (TNG-173 N1/N4). Two independently
// built sentences could disagree, and a column reading "Complete capture" over a panel that
// names gaps is the one failure §5 exists to prevent.

// TNG89 §6.4: an entity's accessible name is "<kind>: <name>, <capture word>" (CONTRACT
// §8.1 defines the words). The word is the entity's own `capture` field — set by the
// projector from its accepted-event invariant, never asserted here — so a first genuinely
// `derived` or `redacted` entity is named truthfully with no surface edit. A category that
// captured nothing renders no rows and states its reason instead — the honest
// `unavailable` boundary (§5.1).

export function ProvenancePanel({ projection, ownerLabels, onInspect, onClose }: { projection: RunProjection; ownerLabels: ReadonlyMap<string, string>; onInspect: (id: string) => void; onClose: () => void }) {
  const { complete, text: coverageText } = coverageSummary(projection)
  // §6.1: the six summaries occupy the tab order as disclosure buttons; `aria-expanded`
  // tracks the state and expansion never steals focus.
  const [collapsed, setCollapsed] = useState<ReadonlySet<CoverageKey>>(new Set())
  return (
    <aside className="panel right top e1 lw-activity" aria-labelledby="prov-title" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header className="insp-head">
        <span className="node-glyph"><EntityGlyph kind="response" size={20} /></span>
        <span className="insp-text">
          <div className="insp-title t-title" id="prov-title">Provenance</div>
          <div className="insp-status t-micro" title="Complete for what the adapters can observe — never an agent's private internal state."><CoverageGlyph level={complete ? 'complete' : 'partial'} /> {coverageText}</div>
        </span>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close provenance" title="Back to response (Esc)"><X size={15} aria-hidden="true" /></button>
      </header>
      {CATEGORIES.map((category) => {
        const items = projection.evidence.filter((item) => category.kinds.includes(item.kind))
        const count = projection.coverage[category.key].observed
        const level = coverageFor(category.key, projection)
        const open = !collapsed.has(category.key)
        return (
          <div className="zone" key={category.key}>
            <button type="button" className="zone-head toggle t-micro" aria-expanded={open} aria-controls={`prov-zone-${category.key}`} aria-label={`${category.label}, ${count} ${count === 1 ? 'entity' : 'entities'}, ${coverageWord(level)}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(category.key)) next.delete(category.key); else next.add(category.key); return next })}>
              <EntityGlyph kind={category.kind} size={13} /> {category.label} <span className="lib-count">{count || '—'}</span> <span className="t-meta" style={{ textTransform: 'none', letterSpacing: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CoverageGlyph level={level} /> {level === 'complete' ? 'complete' : level === 'partial' ? 'partial' : 'Not captured'}</span>
            </button>
            {open && (
              <div className="zone-body" id={`prov-zone-${category.key}`}>
                {category.key === 'agents' && (
                  <ul className="pop-list" style={{ padding: 0 }}>
                    {projection.agents.map((agent) => (
                      <li key={agent.id} className="pop-row" style={{ cursor: 'default' }} aria-label={`agent: ${ownerLabels.get(agent.id) ?? agent.id}, ${agent.capture}`}><StatusGlyph status={agent.status} /><span className="name t-body">{ownerLabels.get(agent.id) ?? agent.id}</span><span className="aside t-mono-sm">{agent.toolCalls} calls · {agent.turns} turn{agent.turns === 1 ? '' : 's'}</span></li>
                    ))}
                  </ul>
                )}
                {category.key === 'reasoning' && projection.totals.thoughts > 0 && <p className="hint t-meta" style={{ margin: 0 }}>{projection.totals.thoughts} thought chunk{projection.totals.thoughts === 1 ? '' : 's'} recorded as <code>thought</code> events. Hidden chain-of-thought is never requested or displayed.</p>}
                {items.length > 0 && (
                  <ul className="pop-list" style={{ padding: 0 }}>
                    {items.map((item) => (
                      <li key={item.id}>
                        <button type="button" className="pop-row" aria-label={`${item.kind}: ${item.name}, ${item.capture}`} onClick={() => onInspect(item.id)}>
                          <StatusGlyph status={item.status === 'succeeded' ? 'succeeded' : item.status === 'failed' || item.status === 'rejected' ? 'failed' : 'running'} />
                          <span className="name t-body">{item.name}</span>
                          <span className="aside t-mono-sm">#{String(item.order).padStart(2, '0')} · {formatOffset(item.offsetMs)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {items.length === 0 && level === 'unavailable' && <p className="hint t-meta" style={{ margin: 0 }}>{EMPTY_REASONS[category.key]}</p>}
              </div>
            )}
          </div>
        )
      })}
      <p className="hint t-meta">Every entry is projected from an accepted event with an exact owner, order and time. Filters are view state; they never re-run the projector.</p>
    </aside>
  )
}
