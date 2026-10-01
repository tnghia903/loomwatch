import { useEffect, useRef, type ReactNode } from 'react'

export function YamlSheet({ title, yaml, onClose, footer, highlightLine }: { title: string; yaml: string; onClose: () => void; footer?: ReactNode; highlightLine?: number | null }) {
  const highlightedRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!highlightLine) return
    highlightedRef.current?.scrollIntoView?.({ block: 'center' })
    highlightedRef.current?.focus({ preventScroll: true })
  }, [highlightLine])
  const lines = yaml.split('\n')
  return (
    <aside role="dialog" aria-label={title} className="e2" style={{ position: 'absolute', top: 'var(--lw-panel-inset)', right: 'var(--lw-panel-inset)', bottom: 'var(--lw-panel-inset)', zIndex: 110, width: 'min(520px, calc(100vw - 40px))', display: 'flex', flexDirection: 'column' }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--color-hairline)' }}>
        <h2 className="t-body-m" style={{ flex: 1, margin: 0 }}>{title}</h2>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close YAML">×</button>
      </header>
      <pre className="t-mono selectable yaml-lines" style={{ flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 'var(--sp-4)', color: 'var(--color-ink-2)', whiteSpace: 'pre' }}>
        <code>{lines.map((line, index) => {
          const lineNumber = index + 1
          const highlighted = lineNumber === highlightLine
          return <span key={lineNumber} ref={highlighted ? highlightedRef : undefined} className={highlighted ? 'yaml-line problem-line' : 'yaml-line'} tabIndex={highlighted ? -1 : undefined} aria-label={highlighted ? `Problem at YAML line ${lineNumber}` : undefined}>{line || ' '}{index < lines.length - 1 ? '\n' : ''}</span>
        })}</code>
      </pre>
      {footer}
    </aside>
  )
}
