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

/** The pinned agent, and whether the Mac app shows the island at the notch to reach it from. */
export interface PinnedReading {
  agent: string | null
  /** False while Show at the notch is off in LoomWatch's menu: the agent stays pinned, but there
      is no island and no shortcut to reach it. A daemon that doesn't say has the island. */
  notchShown: boolean
}

async function read(response: Response): Promise<PinnedReading> {
  const body = (await response.json().catch(() => null)) as { agent?: string | null; notchShown?: boolean; error?: string } | null
  if (!response.ok) throw new Error(body?.error ?? 'LoomWatch couldn’t answer. Restart LoomWatch and try again.')
  return { agent: typeof body?.agent === 'string' ? body.agent : null, notchShown: body?.notchShown !== false }
}

async function fetchPinned(signal?: AbortSignal): Promise<PinnedReading> {
  const response = await daemonFetch(PATH, { cache: 'no-store', signal })
  if (response.status === 404) return { agent: null, notchShown: true }
  return read(response)
}

/** The id of the pinned agent, or `null`. A daemon older than the pin pins nothing. */
export async function fetchPinnedAgent(signal?: AbortSignal): Promise<string | null> {
  return (await fetchPinned(signal)).agent
}

/** Pin agent `id` to the notch in place of any other, or none. Returns what is pinned now. */
export async function pinAgent(id: string | null): Promise<PinnedReading> {
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
  /** Whether the island is at the notch to message it from (see `PinnedReading`). */
  notchShown: boolean
  /** Pin `id`, or unpin with `null`, and hear what is pinned now. Throws when the daemon refuses. */
  pin: (id: string | null) => Promise<PinnedReading>
}

/** Which agent is pinned, kept up to date as it changes on this page or another. */
export function usePinnedAgent(): PinnedAgentState {
  const [reading, setReading] = useState<PinnedReading>({ agent: null, notchShown: true })
  useEffect(() => {
    const controller = new AbortController()
    const load = () => { fetchPinned(controller.signal).then(setReading, () => {}) }
    load()
    window.addEventListener(PINNED_CHANGED_EVENT, load)
    window.addEventListener('focus', load)
    return () => {
      controller.abort()
      window.removeEventListener(PINNED_CHANGED_EVENT, load)
      window.removeEventListener('focus', load)
    }
  }, [])
  const pin = useCallback(async (id: string | null) => {
    const now = await pinAgent(id)
    setReading(now)
    return now
  }, [])
  return { pinned: reading.agent, notchShown: reading.notchShown, pin }
}
