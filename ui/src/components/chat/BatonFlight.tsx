import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { batonTarget, isPill, landingOf, type Box, type Flight, type Holding } from '../../lib/chat/pieceLine'

/** A little longer than the pill takes to grow, so the pill is grown when it lands. */
const FLIGHT_MS = 460

const at = (box: Box) => ({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` })

/**
 * The piece's line on its way to the header's pill, or back (lib/chat/pieceLine.ts). Going up it
 * leaves the edge of the chat as words, gathers its colour and lands as the pill; coming down it
 * leaves the pill and settles into the line as words. Where it lands is hidden until it has. It says
 * what the pill says now — `holding` — or, once nobody has the work, what it said when it set off.
 */
export function BatonFlight({ flight, holding, onDone }: { flight: Flight; holding: Holding | null; onDone: (id: number) => void }) {
  const ghost = useRef<HTMLSpanElement>(null)
  const says = holding ?? flight
  useLayoutEffect(() => {
    const element = ghost.current
    const target = flight.to ? null : batonTarget()
    const to = flight.to ?? (target ? landingOf(target) : null)
    if (!element || !to || typeof element.animate !== 'function') {
      onDone(flight.id)
      return
    }
    const plain = { backgroundColor: 'transparent', borderColor: 'transparent' }
    // Landing on words in the open list, it settles into them as it does into the line.
    const intoWords = flight.way === 'down' || (target !== null && !isPill(target))
    // It is words while it is as wide as the line, and a pill once it is near a pill's size: the
    // colour comes in over the second half of the way up, and goes over the first half of the way down.
    const keyframes: Keyframe[] = flight.way === 'up'
      ? [{ ...at(flight.from), ...plain, opacity: 0, offset: 0 }, { opacity: 1, offset: 0.2 }, { ...plain, offset: 0.5 }, intoWords ? { ...at(to), ...plain, opacity: 0, offset: 1 } : { ...at(to), offset: 1 }]
      : [{ ...at(flight.from), offset: 0 }, { ...plain, offset: 0.5 }, { opacity: 1, offset: 0.65 }, { ...at(to), ...plain, opacity: 0, offset: 1 }]
    const animation = element.animate(keyframes, { duration: FLIGHT_MS, easing: 'cubic-bezier(.2, 0, 0, 1)', fill: 'both' })
    animation.onfinish = () => onDone(flight.id)
    return () => {
      animation.onfinish = null
      animation.cancel()
    }
  }, [flight, onDone])
  return createPortal(
    <span ref={ghost} className={`tc-baton on tc-baton-ghost hue-${says.hue}${says.waiting ? ' waiting' : ''}`} aria-hidden="true">
      <span className="tc-baton-in">
        {!says.waiting && <span className="chat-dots"><i /><i /><i /></span>}
        <span className="tc-baton-words">{says.words}</span>
      </span>
    </span>,
    document.body,
  )
}
