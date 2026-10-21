import { ArrowRight } from 'lucide-react'

import type { Attention } from '../../lib/watch/events'

interface AttentionAlertsProps {
  alerts: readonly Attention[]
  nodeNames: ReadonlyMap<string, string>
  /** Whether an alert has a Build field that would stop it happening again. */
  canFix: (alert: Attention) => boolean
  onFix: (alert: Attention) => void
  onReveal: (alert: Attention) => void
  onDismiss: (alert: Attention) => void
}

/** The run's attention alerts, each with the routes out of it: fix, reveal or dismiss. */
export function AttentionAlerts({ alerts, nodeNames, canFix, onFix, onReveal, onDismiss }: AttentionAlertsProps) {
  if (alerts.length === 0) return null
  return (
    // A run is read in the team's chat, whose box is on the left, so alerts sit at the bottom
    // right, over Details.
    <div className="panel e1" style={{ right: 'var(--lw-panel-inset)', bottom: 'var(--lw-panel-inset)', width: 'min(320px, calc(100vw - 40px))', maxHeight: '40vh', overflow: 'auto', padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', zIndex: 45 }} role="region" aria-label={`Attention, ${alerts.length}`}>
      <span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Attention · {alerts.length}</span>
      {alerts.map((alert) => (
        <div key={alert.id} className={`rt-strip ${alert.id.startsWith('waiting:') ? 'operator-attention' : 'alert'} t-meta`} style={{ borderTop: 0, padding: '6px 8px', borderRadius: 'var(--r-sm)', background: 'var(--color-panel-solid)', alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
          <span className="msg" style={{ whiteSpace: 'normal' }}><b style={{ color: 'var(--color-ink)' }}>{nodeNames.get(alert.agentId) ?? alert.agentId}</b> · {alert.message}</span>
          <span className="alert-acts t-meta">
            {canFix(alert) && <button type="button" className="link alert-fix" onClick={() => onFix(alert)}>Fix in Workflow <ArrowRight size={12} aria-hidden="true" /></button>}
            <button type="button" className="link" onClick={() => onReveal(alert)}>{alert.evidenceId ? 'Show evidence' : 'Show the agent'}</button>
            <button type="button" className="link" onClick={() => onDismiss(alert)}>Dismiss</button>
          </span>
        </div>
      ))}
    </div>
  )
}
