import { CircleCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const SHOWN_FOR = 15_000

/**
 * What just happened, at the bottom of the page, with a way to take it back when there is one.
 * It goes after a while, but never while the pointer or keyboard is on it.
 */
export function Toast({ text, action, onAction, onClose }: { text: string; action?: string; onAction?: () => void; onClose: () => void }) {
  const [held, setHeld] = useState(false)
  // Each toast is its own (the page keys it), so the close it was given stays the one to call;
  // the timer restarts only when the toast is let go, not each time the page renders.
  const close = useRef(onClose)
  useEffect(() => {
    if (held) return
    const timer = setTimeout(() => close.current(), SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [held])
  return (
    <div className="lw-skills-toast e2" role="status" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <CircleCheck size={16} aria-hidden="true" />
      <span>{text}</span>
      {action && onAction && <button type="button" className="link" onClick={onAction}>{action}</button>}
      <button type="button" className="iconbtn" aria-label="Dismiss" onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </div>
  )
}
