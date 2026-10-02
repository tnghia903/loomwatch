// The canvas's read of the Notion connection (docs/NOTION.md), so the Team response can say where
// an answer will land without sending the operator to Connections to find out. Connections itself
// stays the one place that changes it.
import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

export type NotionConnection =
  | { state: 'loading' }
  /** The daemon mounts the Notion API on loopback only, or could not be asked. */
  | { state: 'unavailable'; message: string }
  | { state: 'disconnected' }
  | { state: 'connected'; workspace: string; destination: { id: string; title: string } | null }

export const NOTION_UNAVAILABLE = 'Notion can be connected only when LoomWatch runs on this computer.'

/** The title every run's page gets when the team names none — `DEFAULT_RUN_NOTION_TITLE` in config.rs. */
export const DEFAULT_RUN_NOTION_TITLE = '{{team}} — {{date}} {{time}}'
/** A routine's default — `DEFAULT_NOTION_TITLE` in config.rs: one page a day. */
export const DEFAULT_ROUTINE_NOTION_TITLE = '{{team}} — {{date}}'

/** Where to connect Notion or pick its page; opened beside the canvas so no edit is left behind. */
export const CONNECTIONS_HREF = '/connections'

export async function fetchNotionConnection(signal?: AbortSignal): Promise<NotionConnection> {
  const response = await daemonFetch('/api/notion/connection', { signal, cache: 'no-store', headers: { 'X-LoomWatch-Request': '1' } })
  if (response.status === 404) return { state: 'unavailable', message: NOTION_UNAVAILABLE }
  const body = (await response.json().catch(() => null)) as { connected?: boolean; name?: string; destination?: { id: string; title: string } | null; error?: string } | null
  if (!response.ok || !body) return { state: 'unavailable', message: body?.error ?? NOTION_UNAVAILABLE }
  return body.connected ? { state: 'connected', workspace: body.name ?? 'Notion', destination: body.destination ?? null } : { state: 'disconnected' }
}

/**
 * The connection as the daemon reports it, read again whenever the window regains focus: the
 * operator connects in the Connections tab and comes back, and the canvas should already know.
 */
export function useNotionConnection(enabled = true): NotionConnection & { refresh: () => void } {
  const [connection, setConnection] = useState<NotionConnection>({ state: 'loading' })
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetchNotionConnection(controller.signal)
      .then((next) => { if (!controller.signal.aborted) setConnection(next) })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return
        setConnection({ state: 'unavailable', message: caught instanceof Error ? caught.message : NOTION_UNAVAILABLE })
      })
    return () => controller.abort()
  }, [enabled, generation])

  useEffect(() => {
    if (!enabled) return
    const onFocus = () => refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh])

  return { ...connection, refresh }
}

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * A page title template as it would read now: the daemon's placeholders (`expand_template` in
 * config.rs) filled in with this browser's clock. A preview only — the daemon expands the real one
 * when the page is made, in the schedule's zone when the team has one.
 */
export function previewNotionTitle(template: string, team: string, at: Date = new Date()): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const weekday = at.toLocaleDateString('en-US', { weekday: 'long' })
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return template
    .replaceAll('{{date}}', date)
    .replaceAll('{{weekday}}', weekday)
    .replaceAll('{{time}}', time)
    .replaceAll('{{team}}', team)
}
