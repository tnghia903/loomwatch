/**
 * The request the operator just sent, lifted from the composer into the Request box of the run it
 * started (DESIGN.md § Motion, "entrance"). The composer and the Run view share no parent that
 * knows both positions, so the composer leaves its rectangle here and the run collects it.
 *
 * Only a send that changes what the Request box says lifts. Before a first run the box already
 * mirrors the composer as the operator types, so that text is in place before ↵; flying it in
 * would make it vanish and come back. A follow-up, or a new run from a finished one, replaces the
 * old request, and that is the text that travels.
 */

/** A send whose run has not appeared after this long is not coming; never lift into a stranger. */
const STALE_MS = 15_000

let shown = ''
let origin: { rect: DOMRect; text: string; at: number } | null = null

/** The Request box on screen now reads `text` (empty when there is none). */
export function noteShownRequest(text: string) {
  shown = text.trim()
}

/** The composer is sending `text` from `from`. */
export function markLiftOrigin(from: Element | null, text: string) {
  const sent = text.trim()
  origin = from && sent && sent !== shown ? { rect: from.getBoundingClientRect(), text: sent, at: Date.now() } : null
}

/**
 * `target` has just started showing `text`. If that is what the composer sent, fly a copy of it
 * from the composer to `target` and keep `target` hidden until the copy lands. The copy lives on
 * `document.body` because the Request box sits in a scrolling column that would clip it on the way.
 */
export function liftInto(target: HTMLElement | null, text: string): boolean {
  const from = origin
  if (!from || !target || Date.now() - from.at > STALE_MS || !text.includes(from.text)) return false
  origin = null
  if (typeof target.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  const to = target.getBoundingClientRect()
  const look = getComputedStyle(target)
  const tokens = getComputedStyle(document.documentElement)
  const duration = parseFloat(tokens.getPropertyValue('--t-entrance')) || 320
  const easing = tokens.getPropertyValue('--ease-out').trim() || 'cubic-bezier(.2, 0, 0, 1)'
  const copy = document.createElement('div')
  copy.className = 'lift-ghost'
  copy.setAttribute('aria-hidden', 'true')
  copy.textContent = target.textContent
  Object.assign(copy.style, {
    left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`,
    font: look.font, letterSpacing: look.letterSpacing, color: look.color,
    whiteSpace: look.whiteSpace, overflowWrap: look.overflowWrap,
  })
  document.body.append(copy)
  // The copy holds its landing spot until it is removed; the real text reappears at the same moment,
  // so the frame where both show is two identical lines in one place.
  copy.animate(
    [{ translate: `${from.rect.left - to.left}px ${from.rect.top - to.top}px`, opacity: 0.5 }, { translate: '0 0', opacity: 1 }],
    { duration, easing, fill: 'forwards' },
  ).finished.catch(() => undefined).finally(() => copy.remove())
  target.animate([{ opacity: 0 }, { opacity: 0 }], { duration })
  return true
}
