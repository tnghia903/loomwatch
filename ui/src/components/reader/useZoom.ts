import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

import { canZoom, ZOOM_NEAR, zoomStep, zoomWithin } from '../../lib/files/zoom'

/** The picture or the video the reader shows, whole in its pane or zoomed. */
const MEDIA = '.rd-picture img, .rd-media-view:not(.audio) video'
/** How far a pinch (a wheel with Ctrl, as browsers send it) zooms for each pixel it moves. */
const PINCH = 0.01
/** A wheel moving this far at once is a mouse's notch, not a pinch: it zooms one step. */
const NOTCH = 50

/** Safari's pinch on a trackpad, which is not a wheel there. */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number }
type Point = { x: number; y: number }

export interface Zoom {
  /** Whether this file zooms: a picture or a video. */
  on: boolean
  /** The share of the file's own pixels it is zoomed to, or `null` while it is shown whole. */
  scale: number | null
  /** The share it is drawn at now, zoomed or whole; `null` until it has loaded. */
  shown: number | null
  /** How wide it is drawn when zoomed, in CSS pixels. */
  width: number | null
  canIn: boolean
  canOut: boolean
  zoomIn: () => void
  zoomOut: () => void
  whole: () => void
  /** + and − (with ⌘ or Ctrl too) zoom, and 0 shows it whole, while the reader has the keyboard. */
  onKey: (event: KeyboardEvent) => void
}

/**
 * Zooming the reader's picture or video (`on`): − and + step through the zoom steps, a pinch goes
 * between them, and 0 shows it whole in the pane again; a step that reaches or passes the share it
 * is shown whole at stops there, so − undoes +. The point under the pointer, or the middle of the
 * pane for a button, stays where it is as it grows or shrinks. Each file opens whole.
 */
export function useZoom(scroller: RefObject<HTMLDivElement | null>, path: string, on: boolean): Zoom {
  const [zoom, setZoom] = useState<{ path: string; scale: number } | null>(null)
  const [size, setSize] = useState<{ path: string; natural: number; whole: number } | null>(null)
  const scale = on && zoom?.path === path ? zoom.scale : null
  const fitted = on && size?.path === path ? size : null
  const shown = scale ?? fitted?.whole ?? null
  // What the listeners read: they are added once for each file.
  const now = useRef(shown)
  now.current = shown
  const wholeAt = useRef(fitted?.whole ?? null)
  wholeAt.current = fitted?.whole ?? null
  /** The point to keep still through the next change, as a share of the media and on screen. */
  const anchor = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)

  const change = useCallback((to: number | null, at?: Point) => {
    const pane = scroller.current
    const media = pane?.querySelector(MEDIA)
    if (pane && media) {
      const box = media.getBoundingClientRect()
      const view = pane.getBoundingClientRect()
      const x = at?.x ?? view.left + view.width / 2
      const y = at?.y ?? view.top + view.height / 2
      anchor.current = { fx: box.width ? (x - box.left) / box.width : 0.5, fy: box.height ? (y - box.top) / box.height : 0.5, x, y }
    }
    setZoom(to === null ? null : { path, scale: to })
  }, [scroller, path])

  const step = useCallback((way: 1 | -1, at?: Point) => {
    const from = now.current
    if (from === null) return
    const to = zoomStep(from, way)
    const whole = wholeAt.current
    const passes = whole !== null && Math.abs(from - whole) > ZOOM_NEAR && (way > 0 ? from < whole && to >= whole - ZOOM_NEAR : from > whole && to <= whole + ZOOM_NEAR)
    if (passes) change(null, at)
    else if (to !== from) change(to, at)
  }, [change])

  // Its size whole in the pane, measured as it loads and whenever it or the pane changes size (a
  // very long picture widens once it is known to be one).
  useEffect(() => {
    const pane = scroller.current
    if (!on || !pane) return
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null
    const measure = () => {
      const media = pane.querySelector<HTMLImageElement | HTMLVideoElement>(MEDIA)
      // Zoomed, what is drawn is not what is shown whole.
      if (!media || scale !== null) return
      sized?.observe(media)
      const natural = media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth
      const drawn = media.getBoundingClientRect().width
      if (natural > 0 && drawn > 0) setSize({ path, natural, whole: drawn / natural })
    }
    sized?.observe(pane)
    measure()
    pane.addEventListener('load', measure, true)
    pane.addEventListener('loadedmetadata', measure, true)
    return () => {
      pane.removeEventListener('load', measure, true)
      pane.removeEventListener('loadedmetadata', measure, true)
      sized?.disconnect()
    }
  }, [scroller, path, on, scale])

  // A pinch: a wheel with Ctrl in Chromium, a gesture in Safari. A mouse's wheel with Ctrl or ⌘
  // held steps, a notch at a time.
  useEffect(() => {
    const pane = scroller.current
    if (!on || !pane) return
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || now.current === null) return
      event.preventDefault()
      const at = { x: event.clientX, y: event.clientY }
      if (Math.abs(event.deltaY) >= NOTCH) step(event.deltaY < 0 ? 1 : -1, at)
      else change(zoomWithin(now.current * Math.exp(-event.deltaY * PINCH)), at)
    }
    let from = 1
    const start = (event: Event) => { event.preventDefault(); from = now.current ?? 1 }
    const pinch = (event: Event) => {
      event.preventDefault()
      const { scale: by, clientX, clientY } = event as GestureEvent
      if (now.current !== null) change(zoomWithin(from * by), { x: clientX, y: clientY })
    }
    pane.addEventListener('wheel', wheel, { passive: false })
    pane.addEventListener('gesturestart', start)
    pane.addEventListener('gesturechange', pinch)
    return () => {
      pane.removeEventListener('wheel', wheel)
      pane.removeEventListener('gesturestart', start)
      pane.removeEventListener('gesturechange', pinch)
    }
  }, [scroller, on, change, step])

  // The kept point back under where it was.
  useLayoutEffect(() => {
    const pane = scroller.current
    const kept = anchor.current
    anchor.current = null
    const media = pane?.querySelector(MEDIA)
    if (!pane || !kept || !media) return
    const box = media.getBoundingClientRect()
    pane.scrollLeft += box.left + kept.fx * box.width - kept.x
    pane.scrollTop += box.top + kept.fy * box.height - kept.y
  }, [scroller, scale])

  const zoomIn = useCallback(() => step(1), [step])
  const zoomOut = useCallback(() => step(-1), [step])
  const whole = useCallback(() => change(null), [change])
  const onKey = useCallback((event: KeyboardEvent) => {
    const target = event.target as HTMLElement
    if (!on || now.current === null || event.altKey || target.isContentEditable || target.closest('input, textarea, select')) return
    const act = event.key === '+' || event.key === '=' ? zoomIn : event.key === '-' || event.key === '_' ? zoomOut : event.key === '0' ? whole : null
    if (!act) return
    event.preventDefault()
    // ⌘+ and ⌘− zoom the team's canvas elsewhere; here they are this file's.
    event.stopPropagation()
    act()
  }, [on, zoomIn, zoomOut, whole])

  return {
    on,
    scale,
    shown,
    width: scale !== null && fitted ? Math.round(fitted.natural * scale) : null,
    canIn: shown !== null && canZoom(shown, 1),
    canOut: shown !== null && canZoom(shown, -1),
    zoomIn,
    zoomOut,
    whole,
    onKey,
  }
}
