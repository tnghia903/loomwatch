/**
 * The chat's width beside Details (ADR 0051), when you drag its edge. Until then CSS draws the
 * default, `clamp(380px, 32vw, 480px)` (`--tc-chat-w`); a width you chose is kept within what
 * leaves Details room to be read.
 */
export const CHAT_WIDTH = { min: 340, step: 16, details: 480 }

/** The default as CSS draws it, for a viewport this wide. */
export function defaultChatWidth(viewport: number): number {
  return Math.round(Math.min(480, Math.max(380, viewport * 0.32)))
}

/** The widest the chat may be here: Details keeps at least `CHAT_WIDTH.details`. */
export function widestChat(viewport: number): number {
  return Math.max(CHAT_WIDTH.min, viewport - CHAT_WIDTH.details)
}

export function clampChatWidth(width: number, viewport: number): number {
  return Math.round(Math.min(widestChat(viewport), Math.max(CHAT_WIDTH.min, width)))
}
