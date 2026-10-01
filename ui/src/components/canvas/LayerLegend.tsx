export type LayerSolo = 'both' | 'configured' | 'observed'

// UX_REDESIGN §6.7: conditional chrome — present only in run view while ≥1 observed edge exists.
// Observed (weft) edges are projected from a run; the compose view draws configured edges only,
// so there this legend is inert chrome and the `L` cycle is gated off with it. Click a row to
// solo that layer; `L` cycles. View state, never document state.
export function LayerLegend({ configured, observed, solo, onSolo }: { configured: number; observed: number; solo: LayerSolo; onSolo: (layer: LayerSolo) => void }) {
  const rowClass = (layer: Exclude<LayerSolo, 'both'>) => `legend-row t-meta ${solo === layer ? 'soloed' : solo !== 'both' ? 'dimmed' : ''}`
  return (
    <div className="panel bottom e1 lw-legend" aria-label="Edge layers" role="group">
      <button type="button" className={rowClass('configured')} onClick={() => onSolo(solo === 'configured' ? 'both' : 'configured')} aria-pressed={solo === 'configured'} title="Configured edges: structure you drew">
        <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="var(--lw-edge-warp)" strokeWidth="1.5" /></svg>
        Configured <span className="count t-mono-sm">{configured}</span>
      </button>
      <button type="button" className={rowClass('observed')} onClick={() => onSolo(solo === 'observed' ? 'both' : 'observed')} aria-pressed={solo === 'observed'} title="Observed edges: delegations projected from the run">
        <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="var(--lw-edge-weft)" strokeWidth="1.5" strokeDasharray="6 4" /></svg>
        Observed <span className="count t-mono-sm">×{observed}</span>
      </button>
    </div>
  )
}
