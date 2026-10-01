import type { LoadFailure } from '../../lib/team-file/useTeamDocument'
import { ChipDot } from '../ui/glyphs'

// §9.5: the product's only modal, because there is no document to fall back to.
export function ParseFailureModal({ failure, path }: { failure: LoadFailure; path?: string | null }) {
  const title = failure.kind === 'shape' ? 'This file isn’t a LoomWatch team.' : 'This file isn’t valid YAML.'
  return (
    <div className="lw-modal-scrim">
      <div role="alertdialog" aria-modal="true" aria-label={title} className="e2 lw-dialog">
        <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
          <ChipDot state="invalid" />
          <span>
            <div className="t-title">{title}</div>
            <div className="t-meta" style={{ color: 'var(--color-ink-3)' }}>{failure.message}</div>
          </span>
        </div>
        {failure.line && <pre className="code t-mono"><span className="bad">{failure.line}</span></pre>}
        <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
          <button type="button" className="btn btn-primary" onClick={() => { window.history.replaceState({}, '', '/'); window.location.reload() }}>Open another team…</button>
          {path && <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(path)}>Copy path</button>}
        </div>
      </div>
    </div>
  )
}
