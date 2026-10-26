import { useCallback, useState } from 'react'

/** A piece of work's Details, asked for from the chat: its run, and the record or agent a finding points at. */
export interface DetailsAsked {
  runId: string
  evidenceId?: string
  agentId?: string
}

/**
 * Details over the bench, for an agent's page: which piece's is open, opening one (a piece's own
 * Details again closes it, as in a team's chat; `show` only opens, for a link to the piece), and a
 * message it asks the chat to show. It belongs to the chat it was opened from (`chatId`), so moving
 * to another agent leaves it behind.
 */
export function useBenchDetails(chatId: string) {
  const [state, setState] = useState<(DetailsAsked & { chatId: string; at: number }) | null>(null)
  const [reveal, setReveal] = useState<{ runId: string; id: string; at: number } | null>(null)
  const asked = state?.chatId === chatId ? state : null
  const open = useCallback((next: DetailsAsked) => {
    setState((current) => (current?.chatId === chatId && current.runId === next.runId && !next.evidenceId && !next.agentId ? null : { ...next, chatId, at: Date.now() }))
  }, [chatId])
  const show = useCallback((next: DetailsAsked) => setState({ ...next, chatId, at: Date.now() }), [chatId])
  const close = useCallback(() => setState(null), [])
  const revealMessage = useCallback((runId: string, id: string) => setReveal({ runId, id, at: Date.now() }), [])
  return { asked, open, show, close, reveal, revealMessage }
}
