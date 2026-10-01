import type { ReactNode } from 'react'
import { ChipDot } from '@loomwatch/design-system'

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
  ['clean', 'Saved on disk'], ['dirty', 'Unsaved changes'], ['new', 'New, not saved yet'], ['saving', 'Saving…'], ['saved', 'Saved'],
  ['failed', 'Couldn’t save'], ['incomplete', '1 thing to finish'], ['invalid', '2 problems'], ['readonly', 'Read-only'],
] as const

export function AllStates() {
  return (
    <Themes>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content)', gap: '10px 24px' }}>
        {STATES.map(([state, word]) => (
          <span key={state} className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-2)' }}><ChipDot state={state} /> {word}</span>
        ))}
      </div>
    </Themes>
  )
}

export function InTheDocumentChip() {
  return (
    <Themes>
      <div className="e1" style={{ display: 'flex', alignItems: 'center', gap: 12, height: 44, padding: '0 16px', maxWidth: 360 }}>
        <ChipDot state="dirty" />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <span className="t-ui">Daily AI, tech &amp; business news</span>
          <span className="t-meta" style={{ color: 'var(--color-ink-3)' }}>daily-news.yaml · unsaved changes</span>
        </span>
        <button className="btn" style={{ marginLeft: 'auto' }}>Save <kbd className="key">⌘S</kbd></button>
      </div>
    </Themes>
  )
}
