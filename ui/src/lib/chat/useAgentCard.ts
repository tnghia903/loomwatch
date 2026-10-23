import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the pointer rests on a face before its card opens, so passing over the team opens nothing. */
const HOVER_DELAY_MS = 280
/** How long the card takes to leave (--t-quick); where motion is reduced it simply goes. */
const LEAVE_MS = 160
export const AGENT_CARD_WIDTH = 264

type Phase = 'closed' | 'open' | 'leaving'
type Box = { top: number; bottom: number; left: number }
export type CardPlace = { left: number; top?: number; bottom?: number }

/**
 * An agent's card, opened from one of its faces: after the pointer has rested on the face, so
 * passing over the team opens nothing, or at once from the keyboard. It belongs to where the face
 * was: closing it, or scrolling the chat or the page, takes it away.
 */
export function useAgentCard() {
  const [phase, setPhase] = useState<Phase>('closed')
  const [place, setPlace] = useState<CardPlace | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const clear = () => window.clearTimeout(timer.current)
  const open = useCallback((at: Box) => {
    clear()
    const left = Math.max(8, Math.min(at.left, window.innerWidth - AGENT_CARD_WIDTH - 8))
    // Below the face, unless that is the bottom of the window: then above it.
    setPlace(at.bottom > window.innerHeight * 0.6 ? { left, bottom: window.innerHeight - at.top + 8 } : { left, top: at.bottom + 8 })
    setPhase('open')
  }, [])
  const rest = useCallback((at: () => Box | null | undefined) => {
    clear()
    timer.current = window.setTimeout(() => {
      const box = at()
      if (box) open(box)
    }, HOVER_DELAY_MS)
  }, [open])
  const close = useCallback(() => {
    clear()
    setPhase((now) => (now === 'open' ? 'leaving' : now))
    timer.current = window.setTimeout(() => setPhase((now) => (now === 'leaving' ? 'closed' : now)), LEAVE_MS)
  }, [])
  const shut = useCallback(() => {
    clear()
    setPhase('closed')
  }, [])

  useEffect(() => {
    if (phase !== 'open') return
    const away = () => close()
    window.addEventListener('scroll', away, true)
    window.addEventListener('resize', away)
    return () => {
      window.removeEventListener('scroll', away, true)
      window.removeEventListener('resize', away)
    }
  }, [phase, close])
  useEffect(() => clear, [])

  return { phase, place, shown: phase !== 'closed' && place !== null, open, rest, close, shut }
}
