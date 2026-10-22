import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

/**
 * The agent pinned to the notch (ADR 0083, decision 9): one of My agents, kept at the island at the
 * top of a Mac's screen so a message reaches it without opening LoomWatch. One at a time; the
 * daemon keeps which (`crates/loomwatch-backend/src/pinned.rs`), and forgets an agent taken out of
 * My agents.
 */

const PATH = '/api/pinned-agent'

/** Dispatched on `window` after the pin changes, so every place that shows it reads it again. */
export const PINNED_CHANGED_EVENT = 'loomwatch:pinned-changed'

async function read(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { agent?: string | null; error?: string } | null
  if (!response.ok) throw new Error(body?.error ?? 'LoomWatch couldn’t answer. Restart LoomWatch and try again.')
  return typeof body?.agent === 'string' ? body.agent : null
}

/** The id of the pinned agent, or `null`. A daemon older than the pin pins nothing. */
export async function fetchPinnedAgent(signal?: AbortSignal): Promise<string | null> {
  const response = await daemonFetch(PATH, { cache: 'no-store', signal })
  if (response.status === 404) return null
  return read(response)
}

/** Pin agent `id` to the notch in place of any other, or none. Returns what is pinned now. */
export async function pinAgent(id: string | null): Promise<string | null> {
  const pinned = await read(await daemonFetch(PATH, {
    method: 'PUT',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    body: JSON.stringify({ agent: id }),
  }))
  window.dispatchEvent(new Event(PINNED_CHANGED_EVENT))
  return pinned
}

export interface PinnedAgentState {
  /** The pinned agent's id; `null` when none is, or before the first answer. */
  pinned: string | null
  /** Pin `id`, or unpin with `null`. Throws when the daemon refuses. */
  pin: (id: string | null) => Promise<void>
}

/** Which agent is pinned, kept up to date as it changes on this page or another. */
export function usePinnedAgent(): PinnedAgentState {
  const [pinned, setPinned] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const load = () => { fetchPinnedAgent(controller.signal).then(setPinned, () => {}) }
    load()
    window.addEventListener(PINNED_CHANGED_EVENT, load)
    window.addEventListener('focus', load)
    return () => {
      controller.abort()
      window.removeEventListener(PINNED_CHANGED_EVENT, load)
      window.removeEventListener('focus', load)
    }
  }, [])
  const pin = useCallback(async (id: string | null) => { setPinned(await pinAgent(id)) }, [])
  return { pinned, pin }
}
