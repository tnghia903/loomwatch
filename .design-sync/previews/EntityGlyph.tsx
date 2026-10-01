import type { ReactNode } from 'react'
import { EntityGlyph } from '@loomwatch/design-system'

function Themes({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      {(['dark', 'light'] as const).map((theme) => (
        <div key={theme} data-theme={theme} style={{ padding: 20, borderRadius: 14, border: '1px solid var(--color-hairline)' }}>{children}</div>
      ))}
    </div>
  )
}

const KINDS = ['prompt', 'response', 'agent', 'reasoning', 'skill', 'tool', 'command', 'source', 'file', 'search', 'delegation', 'permission', 'plan', 'run'] as const

export function AllKinds() {
  return (
    <Themes>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '12px 8px', color: 'var(--color-ink-2)' }}>
        {KINDS.map((kind) => (
          <span key={kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <EntityGlyph kind={kind} size={16} /><span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{kind}</span>
          </span>
        ))}
      </div>
    </Themes>
  )
}

const TRACE = [
  ['prompt', 'You asked for the Sunday edition of the news digest', 'var(--color-ink-2)'],
  ['delegation', 'News Collector handed 16 stories to News Editor', 'var(--color-ink-2)'],
  ['skill', 'Digest Writer opened the claude-design skill', 'var(--color-accent)'],
  ['tool', 'Ran 3 searches for “AI chips”', 'var(--color-ink-2)'],
  ['response', 'Team response — 1,240 words', 'var(--color-ok)'],
] as const

export function InARunTrace() {
  return (
    <Themes>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {TRACE.map(([kind, text, colour]) => (
          <li key={text} className="t-meta" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-ink-2)' }}>
            <EntityGlyph kind={kind} style={{ color: colour }} />{text}
          </li>
        ))}
      </ol>
    </Themes>
  )
}
