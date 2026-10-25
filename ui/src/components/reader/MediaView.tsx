import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import type { BoxAt, TimeAt } from '../../lib/chat/client'
import { boxBetween, boxLabel, boxOnScreen, boxStyle, type Point } from '../../lib/files/parts'
import { clockTime, timeBetween, timeLabel } from '../../lib/files/moments'
import type { Marked } from './PageFrame'

/** How far a press may move and still be a click: a moment on the bar, or play on the frame. */
const CLICK_PX = 6
/** The smallest box a drag on a paused frame marks, each way. */
const BOX_MIN_PX = 12
/** How near the frame shown must be to a box's moment for the box to show on it. */
const NEAR_MS = 500
/** The bottom of a video left to the player's own controls: Chromium's buttons and time line. */
const CONTROLS_PX = 72
/** Bubbles nearer than this on the bar would cover one another: the later goes to another row. */
const BUBBLE_GAP_PX = 30
/** How far below the bar each extra row of bubbles sits. */
const ROW_PX = 26
/** How far one press of an arrow key moves the recording, and with Shift. */
const STEP_MS = 1_000
const LEAP_MS = 5_000

/** A moment, a span, or a box on a frame asked about, by its part's id, with how its asks look. */
export interface MediaMark {
  id: string
  at: TimeAt | BoxAt
  look: string
}

interface MediaViewProps {
  src: string
  /** A recording of sound only: no frames to mark a box on, or to send. */
  audio: boolean
  name: string
  askable: boolean
  /** The agent asked, by name, for the bar's labels; and its face, at the bar's start until a part is asked about. */
  agent: string
  face: ReactNode
  marks: readonly MediaMark[]
  /** The part marked now and not yet asked about. */
  marking: TimeAt | BoxAt | null
  asking: string | null
  /** The part whose answer is open: the recording goes to its moment. */
  open: string | null
  /** The page under it is dark: the bubbles take its lightness. */
  dark: boolean
  onMarked: (marked: Marked | null) => void
  onOpen: (id: string) => void
  /** The marks have moved on the bar (the recording's length became known, or the bar's width): measure them. */
  onDrawn?: () => void
}

const startOf = (at: TimeAt | BoxAt) => (at.kind === 'time' ? at.start : at.ms ?? 0)

/**
 * Puts each mark's bubbles where none covers another: above the bar, or in a row of their own under
 * it when they would sit within `BUBBLE_GAP_PX` of others, and never past the bar's ends.
 */
function placeBubbles(bar: HTMLElement) {
  const across = bar.getBoundingClientRect().width
  if (!across) return
  const placed = [...bar.querySelectorAll<HTMLElement>(':scope > .rd-moment[data-part]')]
    .map((mark) => ({ slot: mark.querySelector<HTMLElement>(':scope > .rd-slot'), x: ((parseFloat(mark.style.left) || 0) + (parseFloat(mark.style.width) || 0) / 2) * across / 100 }))
    .sort((a, b) => a.x - b.x)
  const ends: number[] = []
  for (const { slot, x } of placed) {
    if (!slot) continue
    let row = ends.findIndex((end) => x - end >= BUBBLE_GAP_PX)
    if (row < 0) row = ends.length
    ends[row] = x
    slot.dataset.row = String(row)
    slot.style.top = row ? `calc(100% + ${6 + (row - 1) * ROW_PX}px)` : ''
    const wide = slot.offsetWidth
    const shift = Math.min(Math.max(x - wide / 2, 0), Math.max(0, across - wide)) - (x - wide / 2)
    slot.style.translate = shift ? `calc(-50% + ${shift}px) 0` : ''
  }
}

/**
 * A recording an agent made, with a part of it to ask about (ADR 0091). Under it is its bar: a
 * press on the bar marks that moment and a drag along it marks a span, and the recording goes
 * there. On a paused video a drag over the picture marks a box on that frame (a click plays it; a
 * finger scrolls, as on a picture). Each part asked about stays on the bar — a tick for a moment, a
 * bar for a span, a full-height mark for a box's frame — with the bubble of every agent asked,
 * which opens its answer and goes to its moment; a box shows on its frame.
 */
export function MediaView({ src, audio, name, askable, agent, face, marks, marking, asking, open, dark, onMarked, onOpen, onDrawn }: MediaViewProps) {
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const line = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [duration, setDuration] = useState(0)
  const [now, setNow] = useState(0)
  const [paused, setPaused] = useState(true)
  useEffect(() => {
    const media = player.current
    if (!media) return
    const timing = () => { setNow(media.currentTime * 1000); setPaused(media.paused) }
    const length = () => setDuration(Number.isFinite(media.duration) ? media.duration * 1000 : 0)
    const events = ['timeupdate', 'seeked', 'play', 'pause'] as const
    for (const kind of events) media.addEventListener(kind, timing)
    media.addEventListener('loadedmetadata', length)
    media.addEventListener('durationchange', length)
    length()
    return () => {
      for (const kind of events) media.removeEventListener(kind, timing)
      media.removeEventListener('loadedmetadata', length)
      media.removeEventListener('durationchange', length)
    }
  }, [src])
  const goTo = (ms: number) => {
    const media = player.current
    if (!media) return
    media.pause()
    media.currentTime = ms / 1000
  }
  // The answer opened for a part: the recording goes to its moment.
  const openAt = open ? marks.find((each) => each.id === open)?.at : undefined
  const openStart = openAt ? startOf(openAt) : null
  useEffect(() => {
    if (openStart !== null) goTo(openStart)
  }, [openStart])

  // The marks sit on the bar by the recording's length, known only once it has loaded, and their
  // bubbles by the bar's width.
  const drawn = useRef(onDrawn)
  useEffect(() => { drawn.current = onDrawn }, [onDrawn])
  useLayoutEffect(() => { drawn.current?.() }, [duration])
  useLayoutEffect(() => { if (line.current) placeBubbles(line.current) })
  useEffect(() => {
    const bar = line.current
    if (!bar || typeof ResizeObserver === 'undefined') return
    const watching = new ResizeObserver(() => { placeBubbles(bar); drawn.current?.() })
    watching.observe(bar)
    return () => watching.disconnect()
  }, [])

  const fraction = (ms: number) => (duration ? Math.min(1, Math.max(0, ms / duration)) : 0)
  const msAt = (event: PointerEvent): number => {
    const box = line.current?.getBoundingClientRect()
    if (!box || !box.width) return 0
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration
  }
  const pressable = askable && duration > 0

  // The bar: a press marks a moment, a drag a span. A mouse over it shows the time it would mark.
  const [sliding, setSliding] = useState<{ from: number; to: number; x: number; pointer: number } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const markTime = (at: TimeAt) => {
    const box = line.current?.getBoundingClientRect()
    if (!box) return
    const left = box.left + box.width * fraction(at.start)
    const right = at.end === undefined ? left : box.left + box.width * fraction(at.end)
    onMarked({ text: timeLabel(at), at, rect: { top: box.top, bottom: box.bottom, left, right } })
  }
  const lineDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!pressable || event.button !== 0 || (event.target as Element).closest('.rd-slot')) return
    event.preventDefault()
    line.current?.setPointerCapture?.(event.pointerId)
    const ms = msAt(event)
    setSliding({ from: ms, to: ms, x: event.clientX, pointer: event.pointerId })
    setHover(null)
    onMarked(null)
  }
  const lineMove = (event: PointerEvent<HTMLDivElement>) => {
    if (sliding?.pointer === event.pointerId) { setSliding({ ...sliding, to: msAt(event) }); return }
    const onAMark = (event.target as Element).closest('.rd-box[data-part], .rd-slot')
    setHover(pressable && event.pointerType !== 'touch' && !onAMark ? msAt(event) : null)
  }
  const lineUp = (event: PointerEvent<HTMLDivElement>) => {
    if (sliding?.pointer !== event.pointerId) return
    setSliding(null)
    const moved = Math.abs(event.clientX - sliding.x)
    if (moved < CLICK_PX) {
      const asked = (event.target as Element).closest<HTMLElement>('.rd-box[data-part]')
      if (asked?.dataset.part) {
        onOpen(asked.dataset.part)
        return
      }
      goTo(sliding.from)
      markTime(timeBetween(sliding.from, sliding.from))
      return
    }
    const at = timeBetween(sliding.from, msAt(event))
    goTo(at.start)
    markTime(at)
  }
  // From the keyboard: the arrows move the recording (with Shift, further), Enter marks where it is.
  const lineKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = (event.shiftKey ? LEAP_MS : STEP_MS) * (event.key === 'ArrowLeft' ? -1 : 1)
      goTo(Math.min(duration, Math.max(0, now + step)))
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    markTime(timeBetween(now, now))
  }

  // A paused frame: a drag marks a box on it, a click plays. The box is placed on the whole frame,
  // though the bottom of it is left to the player's controls to press.
  const [drawing, setDrawing] = useState<{ from: Point; to: Point; pointer: number; touch: boolean } | null>(null)
  const pointAt = (event: PointerEvent): Point => {
    const box = frame.current?.getBoundingClientRect()
    if (!box || !box.width || !box.height) return { x: 0, y: 0 }
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) }
  }
  const frameDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!askable || event.button !== 0) return
    const touch = event.pointerType === 'touch'
    const point = pointAt(event)
    setDrawing({ from: point, to: point, pointer: event.pointerId, touch })
    // A finger may be starting to scroll: it plays the recording only if it lifts without moving.
    if (touch) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    onMarked(null)
  }
  const frameMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drawing?.pointer === event.pointerId && !drawing.touch) setDrawing({ ...drawing, to: pointAt(event) })
  }
  const frameUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drawing?.pointer !== event.pointerId) return
    setDrawing(null)
    const box = frame.current?.getBoundingClientRect()
    const to = pointAt(event)
    const across = box ? Math.abs(to.x - drawing.from.x) * box.width : 0
    const down = box ? Math.abs(to.y - drawing.from.y) * box.height : 0
    if (drawing.touch && Math.max(across, down) >= CLICK_PX) return
    if (drawing.touch || across < BOX_MIN_PX || down < BOX_MIN_PX) { void player.current?.play().catch(() => undefined); return }
    const at: BoxAt = { ...boxBetween(drawing.from, to), ms: Math.round(now) }
    if (box) onMarked({ text: boxLabel(at, `the frame at ${clockTime(now)}`), at, rect: boxOnScreen(at, box) })
  }

  const live = sliding ? timeBetween(sliding.from, sliding.to) : null
  const liveBox = drawing && !drawing.touch ? boxBetween(drawing.from, drawing.to) : null
  const lineStyle = (at: TimeAt | BoxAt): CSSProperties => {
    const left = fraction(startOf(at)) * 100
    const width = at.kind === 'time' && at.end !== undefined ? (fraction(at.end) - fraction(at.start)) * 100 : 0
    return { left: `${left}%`, width: width ? `${width}%` : undefined }
  }
  const shownBoxes = marks.filter((each): each is MediaMark & { at: BoxAt } => each.at.kind === 'box' && paused && Math.abs((each.at.ms ?? 0) - now) <= NEAR_MS)
  const markingBox = marking?.kind === 'box' ? marking : null
  const markingTime = marking?.kind === 'time' ? marking : null

  return (
    <div className={`rd-media-view${audio ? ' audio' : ''}`}>
      <div className="rd-media-frame">
        {audio
          ? <audio ref={player} className="rd-media" controls src={src} />
          : <video ref={player} className="rd-media" controls src={src} aria-label={name} />}
        {!audio && askable && paused && (
          <div ref={frame} className="rd-media-drawing" aria-hidden="true">
            <div className="rd-media-catch" style={{ bottom: CONTROLS_PX }} title={`Drag over the picture to ask ${agent} about a part of this frame`}
              onPointerDown={frameDown} onPointerMove={frameMove} onPointerUp={frameUp} onPointerCancel={() => setDrawing(null)} />
            {shownBoxes.map((each) => <div key={each.id} className={`rd-box ${each.look}${each.id === asking ? ' asking' : ''}`} style={boxStyle(each.at)} />)}
            {markingBox && !liveBox && <div className="rd-box marking" style={boxStyle(markingBox)} />}
            {liveBox && <div className="rd-box drawing" style={boxStyle(liveBox)} />}
          </div>
        )}
      </div>
      {(askable || marks.length > 0) && (
        <div ref={line} className={`rd-media-line${pressable ? ' askable' : ''}`} onPointerDown={lineDown} onPointerMove={lineMove} onPointerUp={lineUp}
          onPointerCancel={() => setSliding(null)} onPointerLeave={() => setHover(null)}
          onKeyDown={pressable ? lineKey : undefined} tabIndex={pressable ? 0 : undefined} role={pressable ? 'button' : undefined}
          aria-label={pressable ? `Ask ${agent} about a moment` : undefined} title={pressable ? `Click or drag to ask ${agent} about a moment` : undefined}>
          <span className="rd-media-now" style={{ left: `${fraction(now) * 100}%` }} aria-hidden="true" />
          {pressable && marks.length === 0 && !live && !markingTime && <span className="rd-media-face" aria-hidden="true">{face}</span>}
          {hover !== null && !sliding && (
            <span className="rd-media-hover" style={{ left: `${fraction(hover) * 100}%` }} aria-hidden="true"><span>{clockTime(hover)}</span></span>
          )}
          {marks.map((each) => (
            <div key={each.id} className={`rd-box rd-moment ${each.look}${each.id === asking ? ' asking' : ''}${each.at.kind === 'box' ? ' frame' : ''}`} data-part={each.id} style={lineStyle(each.at)}>
              <span className={`rd-slot${dark ? ' on-dark' : ''}`} data-reader-chrome data-part={each.id} contentEditable={false} />
            </div>
          ))}
          {markingTime && !live && <div className="rd-box rd-moment marking" style={lineStyle(markingTime)} aria-hidden="true" />}
          {live && <div className="rd-box rd-moment drawing" style={lineStyle(live)} aria-hidden="true" />}
        </div>
      )}
    </div>
  )
}
