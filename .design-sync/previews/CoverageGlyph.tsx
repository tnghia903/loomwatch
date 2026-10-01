import type { ReactNode } from 'react'
import { CoverageGlyph, EntityGlyph } from '@loomwatch/design-system'

function Themes({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      {(['dark', 'light'] as const).map((theme) => (
        <div key={theme} data-theme={theme} style={{ padding: 20, borderRadius: 14, border: '1px solid var(--color-hairline)' }}>{children}</div>
      ))}
    </div>
  )
}

export function Levels() {
  return (
    <Themes>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-2)' }}><CoverageGlyph level="complete" /> Complete record</span>
        <span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-2)' }}><CoverageGlyph level="partial" /> Partly recorded</span>
        <span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-2)' }}><CoverageGlyph level="unavailable" /> Not recorded</span>
      </div>
    </Themes>
  )
}

const EVIDENCE = [
  ['source', 'Opened techcrunch.com', 'complete'],
  ['tool', 'Searched “AI chips” — 33 results', 'complete'],
  ['source', 'Couldn’t open usnews.com', 'unavailable'],
  ['skill', 'claude-design — loaded, steps partly logged', 'partial'],
] as const

export function InAnEvidenceList() {
  return (
    <Themes>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {EVIDENCE.map(([kind, text, level]) => (
          <li key={text} className="t-meta" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-ink-2)' }}>
            <EntityGlyph kind={kind} style={{ color: kind === 'skill' ? 'var(--color-accent)' : 'var(--color-ink-3)' }} />
            <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
            <CoverageGlyph level={level} />
          </li>
        ))}
      </ul>
    </Themes>
  )
}
