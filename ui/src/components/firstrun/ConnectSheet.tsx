import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** One AI the first agent can answer with. */
export interface AiOption {
  id: string
  /** What it is, in the person's words: "OpenRouter key". */
  title: string
  /** What it costs, in one plain line. Never "free" unless it is (ADR 0075). */
  cost: string
  /** The colour the first run shows it in once connected: LoomWatch's own, not the brand's. */
  color: string
  /** The provider's logo, in its own colours. */
  logo: ReactNode
  /** How it is connected: that source's own form, which says when it is done. */
  connect: ReactNode
}

/**
 * "Which AI should answer?" (ADR 0075): asked on the first Send, and only then, when no AI is
 * connected yet. Every option has the same weight and says plainly what it costs; with one option
 * its form is open at once. The first run closes the sheet when the form connects, and goes on with
 * the Send that opened it.
 */
export function ConnectSheet({ options, onClose }: { options: readonly AiOption[]; onClose: () => void }) {
  const [picked, setPicked] = useState<string | null>(options.length === 1 ? options[0].id : null)
  const titleId = useId()
  const sheet = useRef<HTMLElement>(null)
  useEffect(() => { sheet.current?.focus() }, [])
  const chosen = options.find((option) => option.id === picked) ?? null
  return (
    <div className="fr-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={sheet} className="fr-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
        <button type="button" className="iconbtn fr-sheet-close" onClick={onClose} aria-label="Not yet"><X size={16} aria-hidden="true" /></button>
        <header className="fr-sheet-head">
          <h2 id={titleId} className="t-title">Which AI should answer?</h2>
          <p className="t-body">{options.length > 1
            ? 'Use a plan you already pay for, or an OpenRouter key. You can add the others later in Connections.'
            : 'Connect the AI your agents use. You can add others later in Connections.'}</p>
        </header>
        <div className={`fr-options${options.length > 1 ? ' many' : ''}`}>
          {options.map((option) => (
            <button key={option.id} type="button" className={`fr-option${option.id === picked ? ' on' : ''}`} aria-pressed={option.id === picked}
              style={{ ['--fr-ai' as string]: option.color }} onClick={() => setPicked(option.id)}>
              <span className="fr-option-logo">{option.logo}</span>
              <span className="fr-option-text"><b>{option.title}</b><small>{option.cost}</small></span>
            </button>
          ))}
        </div>
        {chosen && <div className="fr-option-connect">{chosen.connect}</div>}
        {options.length > 1 && <p className="t-meta fr-sheet-fine">Every answer says which one paid for it.</p>}
      </section>
    </div>
  )
}
