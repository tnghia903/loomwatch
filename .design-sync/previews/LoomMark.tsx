import type { ReactNode } from 'react'
import { LoomMark } from '@loomwatch/design-system'

function Themes({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      {(['dark', 'light'] as const).map((theme) => (
        <div key={theme} data-theme={theme} style={{ padding: 24, borderRadius: 14, border: '1px solid var(--color-hairline)' }}>{children}</div>
      ))}
    </div>
  )
}

export function Wordmark() {
  return (
    <Themes>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, font: '600 17px/1 var(--font-sans)', letterSpacing: '-.01em' }}>
        <LoomMark width={46} height={20} />LoomWatch
      </span>
    </Themes>
  )
}

export function FirstRunHero() {
  return (
    <Themes>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 14 }}>
        <LoomMark />
        <h1 className="t-display" style={{ margin: 0 }}>Put AI agents to work as a team.</h1>
        <p className="t-body" style={{ margin: 0, color: 'var(--color-ink-2)' }}>Give your team a task, watch each step as it happens, and review the result before you use it.</p>
        <button className="btn btn-lg btn-primary">New team</button>
      </div>
    </Themes>
  )
}
