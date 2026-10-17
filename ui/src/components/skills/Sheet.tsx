import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * The Skills page's one dialog: a sheet over a dimmed page, where every add and bring-in is
 * reviewed before it happens. It takes focus when it opens and gives it back when it closes;
 * Escape and a click on the dimmed page close it, unless something is in progress.
 */
export function Sheet({ title, kicker, onClose, busy = false, children, footer, returnFocus }: {
  title: ReactNode
  /** A line above the title: what kind of thing this is. */
  kicker?: ReactNode
  onClose: () => void
  busy?: boolean
  children: ReactNode
  footer?: ReactNode
  /** Where focus goes on close when what opened the sheet is gone (an Add that became Added). */
  returnFocus?: string
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  // Read once: a sheet is opened by one thing, and closes back to it.
  const fallback = useRef(returnFocus)
  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const otherwise = fallback.current
    // The page behind keeps its scroll: the sheet is over it, not in it.
    panel.current?.focus({ preventScroll: true })
    return () => {
      if (returnTo?.isConnected && returnTo !== document.body) returnTo.focus({ preventScroll: true })
      else if (otherwise) document.querySelector<HTMLElement>(otherwise)?.focus({ preventScroll: true })
    }
  }, [])
  const close = () => { if (!busy) onClose() }
  return (
    <div className="lw-skills-scrim" onMouseDown={close}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        className="e2 lw-skills-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
      >
        <header className="lw-skills-sheet-head">
          <div className="lw-skills-sheet-title">
            {kicker && <span className="lw-skills-kicker">{kicker}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={close}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="lw-skills-sheet-body">{children}</div>
        {footer && <footer className="lw-skills-sheet-foot">{footer}</footer>}
      </div>
    </div>
  )
}
