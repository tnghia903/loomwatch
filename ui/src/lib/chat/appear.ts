import { createContext, useContext, useState } from 'react'

/**
 * Whether what mounts now is news — it arrived while you watched — rather than history being
 * drawn (ADR 0051). Opening a chat, or reading back an older page, must not set every message in
 * motion; a message, an answer or a question that arrives afterwards should.
 *
 * The chat provides `true` once its first page has painted, and `false` again while an older page
 * is read; a piece of work provides `false` for its own first frame, so a new piece rises as one
 * and its parts do not rise again inside it.
 */
export const AppearContext = createContext(false)

/** Whether this element is news: decided once, when it mounts, and never changed afterwards. */
export function useAppear(): boolean {
  const news = useContext(AppearContext)
  const [appear] = useState(news)
  return appear
}
