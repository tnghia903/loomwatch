import type { KeyboardEvent, PointerEvent } from 'react'

import { CHAT_WIDTH, clampChatWidth, defaultChatWidth, widestChat } from '../../lib/chat/chatWidth'

/**
 * The edge between the chat and Details, dragged to give either more room. Arrow keys move it
 * too, Home and End take it to either end, and a double click puts the default back.
 */
export function ChatResizer({ width, onResize }: { width: number | null; onResize: (width: number | null) => void }) {
  const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
  const now = width === null ? defaultChatWidth(viewport) : clampChatWidth(width, viewport)
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const left = handle.parentElement?.getBoundingClientRect().left ?? 0
    handle.setPointerCapture?.(event.pointerId)
    document.body.classList.add('chat-resizing')
    const move = (next: globalThis.PointerEvent) => onResize(clampChatWidth(next.clientX - left, window.innerWidth))
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      document.body.classList.remove('chat-resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = {
      ArrowLeft: now - CHAT_WIDTH.step,
      ArrowRight: now + CHAT_WIDTH.step,
      Home: CHAT_WIDTH.min,
      End: widestChat(viewport),
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    onResize(clampChatWidth(next, viewport))
  }
  return (
    <div
      className="tc-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the chat"
      aria-valuemin={CHAT_WIDTH.min}
      aria-valuemax={widestChat(viewport)}
      aria-valuenow={now}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => onResize(null)}
      onKeyDown={keys}
    />
  )
}
