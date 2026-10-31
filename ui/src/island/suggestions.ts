// What the person may want to ask the agent at the notch next, as buttons under its box: the next
// steps from its last answer, and what they ask it again and again. The daemon works them out
// (`crates/loomwatch-backend/src/suggestions.rs`); pressing one only puts it in the box.
import { daemonFetch } from '../lib/daemonFetch'

/** One thing to ask: a next step from the last answer (`next`), or something asked before (`again`). */
export interface Suggestion {
  text: string
  kind: 'next' | 'again'
}

/** At most this many, under the box. */
export const MOST_SUGGESTIONS = 3

export interface Suggested {
  suggestions: Suggestion[]
  /** Next steps from the last answer are still being written: ask again in a moment. */
  writing: boolean
}

const NONE: Suggested = { suggestions: [], writing: false }

/** What to suggest for the pinned agent now. A daemon without suggestions suggests nothing. */
export async function fetchSuggestions(signal?: AbortSignal): Promise<Suggested> {
  const response = await daemonFetch('/api/pinned-agent/suggestions', { cache: 'no-store', signal })
  if (!response.ok) return NONE
  const body = (await response.json().catch(() => null)) as { suggestions?: unknown; writing?: unknown } | null
  const suggestions = Array.isArray(body?.suggestions) ? body.suggestions.filter(isSuggestion) : []
  return { suggestions: suggestions.slice(0, MOST_SUGGESTIONS), writing: body?.writing === true }
}

function isSuggestion(value: unknown): value is Suggestion {
  const each = value as Partial<Suggestion> | null
  return typeof each?.text === 'string' && each.text.trim() !== '' && (each.kind === 'next' || each.kind === 'again')
}
