import { useEffect, useState } from 'react'

import { type KeyStatus, fetchKeyStatus } from './client'

// Whether an OpenRouter key is set, shared by everything that waits on one: Home's key card, Ask,
// the Run button. Saving or removing the key in any of them tells the others at once.
let known: KeyStatus | null = null
let pending: Promise<KeyStatus> | null = null
const listeners = new Set<(status: KeyStatus) => void>()

/** Tell everything showing the key's state what it is now. */
export function announceKeyStatus(status: KeyStatus) {
  known = status
  for (const listener of listeners) listener(status)
}

function load(): Promise<KeyStatus> {
  pending ??= fetchKeyStatus().then(
    (status) => { announceKeyStatus(status); return status },
    (error: unknown) => { pending = null; throw error },
  )
  return pending
}

/** The key's state, or null until the daemon has answered. */
export function useKeyStatus(): KeyStatus | null {
  const [status, setStatus] = useState<KeyStatus | null>(known)
  useEffect(() => {
    listeners.add(setStatus)
    if (!known) load().catch(() => { /* the key card says why */ })
    return () => { listeners.delete(setStatus) }
  }, [])
  return status
}

/** For tests: forget what was read. */
export function forgetKeyStatus() {
  known = null
  pending = null
}
