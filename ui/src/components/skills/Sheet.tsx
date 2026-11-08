import { X } from '../ui/icon'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Tab and Shift+Tab go round the sheet's own controls, never to the page behind it. */
function keepFocusIn(event: KeyboardEvent<HTMLDivElement>, panel: HTMLDivElement | null) {
  if (!panel) return
  const inside = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const first = inside[0]
  const last = inside[inside.length - 1]
  if (!first || !last) { event.preventDefault(); return }
  const at = document.activeElement
  if (event.shiftKey && (at === first || at === panel)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && at === last) { event.preventDefault(); first.focus() }
}

/**
 * The Skills page's one dialog: a sheet over a dimmed page, where every add and bring-in is
 * reviewed before it happens. It takes focus when it opens and gives it back when it closes;
 * Escape and a click on the dimmed page close it, unless something is in progress. It also opens
 * over other screens (a suggestion in the chat, a skill Ask proposed), so it keeps the keyboard:
 * Tab stays in it, and no key reaches the page's own shortcuts behind it, such as the canvas's
 * Cmd+Enter, which starts a run.
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
  // The latest one counts: what opened the sheet can be gone by the time it closes.
  const fallback = useRef(returnFocus)
  useEffect(() => { fallback.current = returnFocus })
  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const latest = fallback
    // The page behind keeps its scroll: the sheet is over it, not in it.
    panel.current?.focus({ preventScroll: true })
    return () => {
      const otherwise = latest.current
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
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') close()
          else if (event.key === 'Tab') keepFocusIn(event, panel.current)
        }}
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
