import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import type { BoxAt } from '../../lib/chat/client'
import { boxBetween, boxLabel, boxOnScreen, boxStyle, WHOLE, wholeBox, type Point } from '../../lib/files/parts'
import type { Marked } from './PageFrame'

/** How far a press may move and still be a click: the whole picture, or a box's answer. */
const CLICK_PX = 6
/** The smallest box a drag marks, each way; a thinner one was meant as a click. */
const BOX_MIN_PX = 12

export interface PictureBox {
  /** The part's id (`partId`): its bubbles' slot is found by it. */
  id: string
  at: BoxAt
  /** How its asks look (`wordsLook`), as classes. */
  look: string
}

interface PictureViewProps {
  src: string
  alt: string
  /** A part of it can be asked about: a drag marks a box, a click the whole picture. */
  askable: boolean
  /** The boxes asked about on it, each with a slot after it for its bubbles. */
  boxes: readonly PictureBox[]
  /** The box marked now and not yet asked about. */
  marking: BoxAt | null
  /** The part in the message box now, by its id. */
  asking: string | null
  onMarked: (marked: Marked | null) => void
  /** A box asked about was clicked: its answer opens. */
  onOpen: (id: string) => void
}

const isWhole = (at: BoxAt) => at.x === 0 && at.y === 0 && at.w === WHOLE && at.h === WHOLE

/**
 * A picture an agent made, with a part of it to ask about (ADR 0091), as words are marked in a
 * document (ADR 0077): drag over any part of it and the ask bubble leans in over the box; a click,
 * a tap, or Enter on the picture marks the whole of it. Each box asked about stays drawn on it, the
 * smaller over the larger, with the bubble of every agent asked about it at its corner, which opens
 * the answer as the box itself does. A finger scrolls the picture rather than drawing on it.
 */
export function PictureView({ src, alt, askable, boxes, marking, asking, onMarked, onOpen }: PictureViewProps) {
  const frame = useRef<HTMLDivElement>(null)
  const [drawing, setDrawing] = useState<{ from: Point; to: Point; pointer: number; touch: boolean } | null>(null)
  const at = (event: PointerEvent): Point => {
    const box = frame.current?.getBoundingClientRect()
    if (!box || !box.width || !box.height) return { x: 0, y: 0 }
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }
  }
  const mark = (part: BoxAt) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    onMarked({ text: boxLabel(part), at: part, rect: boxOnScreen(part, box) })
  }

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!askable || event.button !== 0 || (event.target as Element).closest('.rd-slot')) return
    const touch = event.pointerType === 'touch'
    const point = at(event)
    setDrawing({ from: point, to: point, pointer: event.pointerId, touch })
    // A finger may be starting to scroll: what is marked stays until it lifts without moving.
    if (touch) return
    event.preventDefault()
    frame.current?.setPointerCapture?.(event.pointerId)
    onMarked(null)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drawing?.pointer === event.pointerId && !drawing.touch) setDrawing({ ...drawing, to: at(event) })
  }
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (drawing?.pointer !== event.pointerId) return
    setDrawing(null)
    const box = frame.current?.getBoundingClientRect()
    const to = at(event)
    const across = box ? Math.abs(to.x - drawing.from.x) * box.width : 0
    const down = box ? Math.abs(to.y - drawing.from.y) * box.height : 0
    if (drawing.touch && Math.max(across, down) >= CLICK_PX) return
    if (!drawing.touch && across >= BOX_MIN_PX && down >= BOX_MIN_PX) { mark(boxBetween(drawing.from, to)); return }
    // A click on a box asked about opens its answer; anywhere else marks the whole picture.
    const asked = (event.target as Element).closest<HTMLElement>('.rd-box[data-part]')
    if (asked?.dataset.part) onOpen(asked.dataset.part)
    else mark(wholeBox())
  }
  const key = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    mark(wholeBox())
  }

  const live = drawing && !drawing.touch ? boxBetween(drawing.from, drawing.to) : null
  // The larger drawn first, so a smaller box and its bubbles sit over a larger one.
  const drawn = [...boxes].sort((a, b) => b.at.w * b.at.h - a.at.w * a.at.h)
  return (
    <figure className="rd-picture">
      <div ref={frame} className={`rd-picture-frame${askable ? ' askable' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrawing(null)}>
        {/* Only the picture is the button: the bubbles on it are buttons of their own. */}
        <span className="rd-picture-target" onKeyDown={askable ? key : undefined} tabIndex={askable ? 0 : undefined}
          role={askable ? 'button' : undefined} aria-label={askable ? `Ask about ${alt}` : undefined}>
          <img src={src} alt={askable ? '' : alt} draggable={false} />
        </span>
        {drawn.map((box) => (
          <div key={box.id} className={`rd-box ${box.look}${box.id === asking ? ' asking' : ''}${isWhole(box.at) ? ' whole' : ''}`} data-part={box.id} style={boxStyle(box.at)}>
            <span className="rd-slot" data-reader-chrome data-part={box.id} contentEditable={false} />
          </div>
        ))}
        {marking && !live && <div className={`rd-box marking${isWhole(marking) ? ' whole' : ''}`} style={boxStyle(marking)} aria-hidden="true" />}
        {live && <div className="rd-box drawing" style={boxStyle(live)} aria-hidden="true" />}
      </div>
    </figure>
  )
}
