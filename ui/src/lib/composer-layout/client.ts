import { STALE_DAEMON, servesHtml } from '../library/client'
import { EMPTY_LAYOUT, type ComposerLayout } from './types'

async function failure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string }
    return body.error ?? body.message ?? response.statusText
  } catch {
    return response.statusText || `HTTP ${response.status}`
  }
}

/** An absent sidecar is not an error: a team that never had a capability placed on it has none.
 * A daemon too old to know this route answers with the SPA's HTML, which must not be mistaken for
 * "no wiring" — that would autosave an empty layout over a real one. */
export async function fetchLayout(path: string, signal?: AbortSignal): Promise<ComposerLayout> {
  const response = await fetch(`/api/team/layout?path=${encodeURIComponent(path)}`, { signal })
  if (response.status === 404) return EMPTY_LAYOUT
  if (!response.ok) throw new Error(await failure(response))
  if (servesHtml(response)) throw new Error(STALE_DAEMON)
  return (await response.json()) as ComposerLayout
}

export async function saveLayout(path: string, layout: ComposerLayout): Promise<void> {
  const response = await fetch('/api/team/layout', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, layout }),
  })
  if (!response.ok) throw new Error(await failure(response))
}
