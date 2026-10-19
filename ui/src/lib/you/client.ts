import { useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

/**
 * What the person tells their agents about themselves (ADR 0074): the name agents call them by,
 * and a few lines about who they are and how they like answers. Every agent reads it at the start
 * of its work. Both parts are optional.
 */
export interface AboutYou {
  name?: string | null
  about?: string | null
  /** They pressed Not now on Home's card, or cleared what they had: the card isn't offered again. */
  skipped: boolean
}

/** The daemon's limits, in characters (crates/loomwatch-backend/src/you.rs). */
export const MAX_NAME_CHARS = 60
export const MAX_ABOUT_CHARS = 1_000

const PATH = '/api/you'

async function read(response: Response): Promise<AboutYou> {
  const result = await response.json().catch(() => null) as (AboutYou & { error?: string }) | null
  if (!response.ok) throw new Error(result?.error ?? 'LoomWatch couldn’t answer. Restart LoomWatch and try again.')
  // An answer that doesn't say is no answer: nothing shows rather than a card asking again.
  if (!result || typeof result.skipped !== 'boolean') throw new Error('LoomWatch didn’t say what your agents know about you. Restart LoomWatch and try again.')
  return result
}

export async function fetchYou(): Promise<AboutYou> {
  return read(await daemonFetch(PATH, { cache: 'no-store' }))
}

/** Replaces what agents are told, whole. Empty parts are dropped. */
export async function saveYou(next: AboutYou): Promise<AboutYou> {
  const body: AboutYou = { skipped: next.skipped }
  const name = next.name?.trim()
  const about = next.about?.trim()
  if (name) body.name = name
  if (about) body.about = about
  return read(await daemonFetch(PATH, {
    method: 'PUT',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    body: JSON.stringify(body),
  }))
}

/** Neither a name nor an About you is saved: agents are told nothing. */
export function toldNothing(you: AboutYou): boolean {
  return !you.name?.trim() && !you.about?.trim()
}

// Shared by everything that shows it: Home's card, the About you page, the line on My agents.
// Saving in one tells the others at once.
let known: AboutYou | null = null
let pending: Promise<AboutYou> | null = null
const listeners = new Set<(you: AboutYou) => void>()

export function announceYou(you: AboutYou) {
  known = you
  for (const listener of listeners) listener(you)
}

function load(): Promise<AboutYou> {
  pending ??= fetchYou().then(
    (you) => { announceYou(you); return you },
    (error: unknown) => { pending = null; throw error },
  )
  return pending
}

/** What the agents are told, or null until the daemon answers (and when it can't). */
export function useYou(): AboutYou | null {
  const [you, setYou] = useState<AboutYou | null>(known)
  useEffect(() => {
    listeners.add(setYou)
    if (!known) load().catch(() => { /* nothing to show: the About you page says why */ })
    return () => { listeners.delete(setYou) }
  }, [])
  return you
}

/** For tests: forget what was read. */
export function forgetYou() {
  known = null
  pending = null
}
