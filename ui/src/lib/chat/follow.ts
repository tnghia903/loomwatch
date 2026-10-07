import { createContext, useContext, useLayoutEffect, useRef } from 'react'

/**
 * How the team's chat keeps what waits on you in sight (ADR 0051). The chat follows the newest
 * work while you are at the bottom, but not right after a click of yours, so what you open stays
 * put. A request for you is different: it can arrive within that moment — an app asks for its next
 * tool the instant you allow the last — and it must not land out of sight.
 */
export interface ChatFollow {
  /** Follow the newest work again: you answered, so what comes next is for you. */
  pin: () => void
  /** Bring this into view, if the chat is following the newest work. */
  reveal: (element: HTMLElement) => void
}

export const FollowContext = createContext<ChatFollow | null>(null)

export function useFollow(): ChatFollow | null {
  return useContext(FollowContext)
}

/** A ref for something that waits on you: once it is drawn, the chat shows it. */
export function useRevealOnArrival<T extends HTMLElement>(active = true) {
  const follow = useFollow()
  const element = useRef<T>(null)
  useLayoutEffect(() => {
    if (active && element.current) follow?.reveal(element.current)
  }, [active, follow])
  return element
}
