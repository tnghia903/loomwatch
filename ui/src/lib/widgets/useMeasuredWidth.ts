import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The width of the element `ref` is put on, measured before the first paint and kept up as it
 * changes, so a widget lays itself out by its own room. `fallback` where the page can't measure
 * (tests).
 */
export function useMeasuredWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const measured = ref.current?.getBoundingClientRect().width
    if (measured) setWidth(Math.round(measured))
  }, [])
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => { if (entry?.contentRect.width) setWidth(Math.round(entry.contentRect.width)) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}
