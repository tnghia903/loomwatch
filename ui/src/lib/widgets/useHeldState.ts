import { useCallback, useState } from 'react'

import type { KeptWidget, WidgetState } from './types'

interface Held {
  state: WidgetState
  /** Not yet kept by the daemon. */
  pending: boolean
  /** When the daemon kept it: the chat page's copy shows it once it is as new. */
  changedAt?: string
}

/**
 * What you made of one widget (ADR 0114): yours while it is on its way, the chat's once its page
 * has caught up. The chat reads its page every few seconds, and an older page must not undo a tick.
 * `show` is yours at once; `keep` also sends it to be kept.
 */
export function useHeldState(kept: KeptWidget, onChange: (n: number, state: WidgetState) => Promise<KeptWidget>) {
  const [held, setHeld] = useState<Held | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ours = held !== null && (held.pending || !kept.changedAt || !held.changedAt || kept.changedAt < held.changedAt)
  const state = ours ? held.state : kept.state
  const show = useCallback((next: WidgetState) => {
    setError(null)
    setHeld({ state: next, pending: true })
  }, [])
  const keep = useCallback((next: WidgetState) => {
    setError(null)
    setHeld({ state: next, pending: true })
    onChange(kept.n, next).then(
      (saved) => setHeld((current) => (current?.state === next ? { state: next, pending: false, changedAt: saved.changedAt } : current)),
      (failed: unknown) => {
        setHeld((current) => (current?.state === next ? null : current))
        setError(failed instanceof Error ? failed.message : String(failed))
      },
    )
  }, [kept.n, onChange])
  return { state, show, keep, error }
}
