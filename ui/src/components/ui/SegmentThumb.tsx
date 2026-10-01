import { useLayoutEffect, useRef } from 'react'

/**
 * A switch's selected-segment tint, drawn once and slid between segments (DESIGN.md § Switches,
 * § Motion "move"). Put it first inside the group: it follows whichever child is `aria-pressed` or
 * `aria-checked`, so the group keeps owning its state and the buttons keep their own semantics.
 * Its look and the transition live in styles/motion.css.
 */
export function SegmentThumb() {
  const thumb = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = thumb.current
    const group = element?.parentElement
    if (!element || !group) return
    // Measured, not assumed: the two segments are not the same width at every breakpoint.
    const place = () => {
      const on = group.querySelector<HTMLElement>(':scope > [aria-pressed="true"], :scope > [aria-checked="true"]')
      element.hidden = !on
      if (!on) return
      element.style.width = `${on.offsetWidth}px`
      element.style.height = `${on.offsetHeight}px`
      element.style.translate = `${on.offsetLeft}px ${on.offsetTop}px`
    }
    place()
    // The first placement lands before paint; only later moves glide.
    const settled = requestAnimationFrame(() => element.classList.add('ready'))
    const selection = new MutationObserver(place)
    selection.observe(group, { subtree: true, childList: true, attributeFilter: ['aria-pressed', 'aria-checked'] })
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    size?.observe(group)
    return () => { cancelAnimationFrame(settled); selection.disconnect(); size?.disconnect() }
  }, [])
  return <span ref={thumb} className="segment-thumb" aria-hidden="true" />
}
