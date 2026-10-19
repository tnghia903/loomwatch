import { useEffect, useState } from 'react'

import { type AiStatus, type KeyStatus, fetchAiStatus } from './client'
import { setConnectedSources } from './modelIds'
import { connectedSources, offeredModels } from './sources'

// How agents' models are paid, shared by everything that waits on it: the connection cards, Ask,
// the Run button, the model picker. Connecting or removing a source in any of them tells the others
// at once.
let known: AiStatus | null = null
let pending: Promise<AiStatus> | null = null
const listeners = new Set<(status: AiStatus) => void>()

/** Tell everything showing the sources what they are now. A part not given keeps what was known. */
export function announceAiStatus(status: Partial<AiStatus> & Pick<AiStatus, 'openrouter'> | Partial<AiStatus>) {
  const merged = { ...(known ?? { openrouter: { connected: false }, anthropic: { connected: false }, chatgpt: { available: false, connected: false, planUse: false } }), ...status } as AiStatus
  known = merged
  setConnectedSources(connectedSources(merged), offeredModels(merged))
  for (const listener of listeners) listener(merged)
}

/** Tell everything showing the OpenRouter key's state what it is now. */
export function announceKeyStatus(status: KeyStatus) {
  announceAiStatus({ openrouter: status })
}

function load(): Promise<AiStatus> {
  pending ??= fetchAiStatus().then(
    (status) => { announceAiStatus(status); return status },
    (error: unknown) => { pending = null; throw error },
  )
  return pending
}

/** Asks the daemon again, as after a sign-in in another tab. */
export function reloadAiStatus(): Promise<AiStatus> {
  pending = null
  return load()
}

/** Every source's state, or null until the daemon has answered. */
export function useAiStatus(): AiStatus | null {
  const [status, setStatus] = useState<AiStatus | null>(known)
  useEffect(() => {
    listeners.add(setStatus)
    if (!known) load().catch(() => { /* the connection cards say why */ })
    return () => { listeners.delete(setStatus) }
  }, [])
  return status
}

/** The OpenRouter key's state, or null until the daemon has answered. */
export function useKeyStatus(): KeyStatus | null {
  return useAiStatus()?.openrouter ?? null
}

/** For tests: forget what was read. */
export function forgetKeyStatus() {
  known = null
  pending = null
  setConnectedSources([])
}
