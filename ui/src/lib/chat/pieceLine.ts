// The live piece's line, and the header's pill: one thing in two places (lib/chat/baton.ts). While
// the line is on screen it says who has the work and the header shows the faces alone; once it is
// scrolled out of view it flies up into the header and becomes the pill, and when it comes back the
// pill flies down into it again.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export interface Box { left: number; top: number; width: number; height: number }

/** What flies: the pill's words and colour as they were when it set off. */
export interface Holding { agent: string; words: string; hue: number; waiting: boolean }

export interface Flight extends Holding {
  id: number
  /** `up`: the line left view and flies into the header. `down`: it came back, and the pill flies to it. */
  way: 'up' | 'down'
  from: Box
  /** Where it lands. Going up, it is measured once the header has drawn where the pill will be. */
  to: Box | null
}

/** The flying pill's own left padding, before its dots. */
export const GHOST_PAD = 5
/** How tall a pill is. */
const PILL_HEIGHT = 20
/** A header pill's left padding: what it keeps under the face it grows from. */
const PILL_PAD = 15

export function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/** A pill-high box on the line's words, so the pill's words sit where the line's do. */
export function lineBox(words: Box): Box {
  return { left: words.left - GHOST_PAD, top: words.top + (words.height - PILL_HEIGHT) / 2, width: words.width + GHOST_PAD + 12, height: PILL_HEIGHT }
}

/** The part of a header pill clear of its face, where the flying pill's words land on the pill's own. */
export function pillBox(pill: Box): Box {
  const under = PILL_PAD - GHOST_PAD
  return { left: pill.left + under, top: pill.top, width: Math.max(0, pill.width - under), height: pill.height }
}

/** A box kept within the scroller's visible part: a line that has just left view is last seen at its edge. */
export function withinView(box: Box, view: Box): Box {
  const top = Math.min(Math.max(box.top, view.top), view.top + view.height - box.height)
  return { ...box, top }
}

/**
 * Where the header says who has the work: the pill when the team is folded, the words when the list
 * is open. There is one at a time, and it is whoever has the work now: the work can move in the
 * very moment the line leaves view — a handover that pushes the line up is the move.
 */
export function batonTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-baton-target]')
}

/** Whether the header shows it as a pill, rather than as words in the open list. */
export function isPill(target: Element): boolean {
  return target.classList.contains('tc-baton')
}

/**
 * Where a flight up lands: the pill as it will be once grown — it is still growing, and hidden,
 * while the flight is on its way — or the words in the open list.
 */
export function landingOf(target: HTMLElement): Box {
  if (!isPill(target)) return lineBox(boxOf(target))
  const grown = target.cloneNode(true) as HTMLElement
  grown.removeAttribute('data-baton-target')
  // Its own width, not one squeezed into the face it sits in, which has not made room for it yet.
  grown.style.cssText = 'position:absolute;visibility:hidden;transition:none;width:max-content'
  target.parentElement?.append(grown)
  const size = boxOf(grown)
  grown.remove()
  const at = boxOf(target)
  return pillBox({ left: at.left, top: at.top, width: size.width, height: size.height })
}

function motionWelcome(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: no-preference)').matches
}

/**
 * Watches the line of the piece the header follows. `inView` is `null` until it is known; where it
 * cannot be watched, the line counts as out of view, so the header says who has the work.
 */
export function usePieceLine(scroller: RefObject<HTMLElement | null>, runId: string | null, holding: Holding | null) {
  const lines = useRef(new Map<string, HTMLElement>())
  const [drawn, setDrawn] = useState(0)
  const onLine = useCallback((id: string, element: HTMLElement | null) => {
    if ((lines.current.get(id) ?? null) === element) return
    if (element) lines.current.set(id, element)
    else lines.current.delete(id)
    setDrawn((count) => count + 1)
  }, [])

  const [inView, setInView] = useState<boolean | null>(null)
  const watchable = typeof IntersectionObserver !== 'undefined'
  const [flight, setFlight] = useState<Flight | null>(null)
  const seen = useRef<{ runId: string | null; inView: boolean | null }>({ runId: null, inView: null })
  const held = useRef(holding)
  useEffect(() => { held.current = holding }, [holding])
  // The line a flight down is landing on, hidden until it lands.
  const landing = useRef<HTMLElement | null>(null)
  const flights = useRef(0)

  useEffect(() => {
    if (seen.current.runId !== runId) seen.current = { runId, inView: null }
    const root = scroller.current
    const element = runId ? lines.current.get(runId) ?? null : null
    if (!runId || !root || !element || !watchable) return
    const watcher = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1].isIntersecting
      const was = seen.current.inView
      seen.current.inView = visible
      setInView(visible)
      const now = held.current
      // The first look says where the line is; only a change of it flies.
      if (was === null || was === visible || !now || !motionWelcome()) return
      landing.current?.classList.remove('tc-talk-landing')
      landing.current = null
      const at = withinView(lineBox(boxOf(element.querySelector('.tc-talk-line') ?? element)), boxOf(root))
      flights.current += 1
      if (!visible) {
        setFlight({ ...now, id: flights.current, way: 'up', from: at, to: null })
        return
      }
      const target = batonTarget()
      if (!target) return
      element.classList.add('tc-talk-landing')
      landing.current = element
      setFlight({ ...now, id: flights.current, way: 'down', from: isPill(target) ? pillBox(boxOf(target)) : lineBox(boxOf(target)), to: at })
    }, { root, threshold: 0 })
    watcher.observe(element)
    return () => watcher.disconnect()
  }, [scroller, runId, drawn, watchable])

  const done = useCallback((id: number) => {
    if (flights.current !== id) return
    landing.current?.classList.remove('tc-talk-landing')
    landing.current = null
    setFlight(null)
  }, [])

  return { onLine, inView: watchable ? inView : runId ? false : null, flight, done }
}
