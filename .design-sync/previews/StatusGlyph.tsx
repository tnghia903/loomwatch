import type { ReactNode } from 'react'
import { AgentMark, StatusGlyph } from '@loomwatch/design-system'

function Themes({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      {(['dark', 'light'] as const).map((theme) => (
        <div key={theme} data-theme={theme} style={{ padding: 20, borderRadius: 14, border: '1px solid var(--color-hairline)' }}>{children}</div>
      ))}
    </div>
  )
}

const STATES = [
  ['idle', 'idle', 'Ready'], ['starting', 'live', 'Starting'], ['running', 'live', 'Running'], ['waiting', 'waiting', 'Queued'],
  ['succeeded', 'ok', 'Done'], ['failed', 'alert', 'Error'], ['stopped', 'stopped', 'Cancelled'], ['unavailable', 'unavailable', 'Offline'],
] as const

export function AllStatuses() {
  return (
    <Themes>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content)', gap: '12px 28px' }}>
        {STATES.map(([status, tone, word]) => (
          <span key={status} className={`status ${tone}`}><StatusGlyph status={status} /> {word}</span>
        ))}
      </div>
    </Themes>
  )
}

export function OnARunCard() {
  return (
    <Themes>
      <div className="build-node has-run st-running">
        <span className="step">1</span>
        <div className="build-node-body">
          <div className="build-node-row">
            <span className="build-node-icon"><AgentMark id="news-collector" name="News Collector" state="working" animate={false} /></span>
            <div><span className="node-kind">Agent</span><strong>News Collector</strong><small>Collects what is needed</small></div>
          </div>
          <div className="build-node-task"><StatusGlyph status="running" /><b style={{ color: 'var(--color-live)' }}>Running</b><span className="task-text">Reading techcrunch.com front page</span></div>
        </div>
      </div>
    </Themes>
  )
}

export function Sizes() {
  return (
    <Themes>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {[12, 16, 20, 28].map((size) => (
          <span key={size} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <StatusGlyph status="succeeded" size={size} title="Done" />
            <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{size}px</span>
          </span>
        ))}
      </div>
    </Themes>
  )
}
