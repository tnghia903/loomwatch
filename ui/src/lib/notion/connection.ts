// The canvas's read of the Notion connection (docs/NOTION.md), so the Team response can say where
// an answer will land without sending the operator to Connections to find out. Notion is
// connected as a tool, and its sign-in also sends answers and reads pages (ADR 0070); its card in
// Connections stays the one place that changes it.
import { useCallback, useEffect, useRef, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

export type NotionConnection =
  | { state: 'loading' }
  /** The daemon mounts the Notion API on loopback only, or could not be asked. */
  | { state: 'unavailable'; message: string }
  | { state: 'disconnected' }
  /**
   * `name`: what the Notion tool is called, "Notion" unless you named it. `problem`: what went
   * wrong the last time the tool was used, such as a sign-in that has ended.
   */
  | { state: 'connected'; name: string; destination: { id: string; title: string } | null; problem: string | null }

export const NOTION_UNAVAILABLE = 'Notion can be connected only when LoomWatch runs on this computer.'

/** The title every run's page gets when the team names none — `DEFAULT_RUN_NOTION_TITLE` in config.rs. */
export const DEFAULT_RUN_NOTION_TITLE = '{{team}} — {{date}} {{time}}'
/** A routine's default — `DEFAULT_NOTION_TITLE` in config.rs: one page a day. */
export const DEFAULT_ROUTINE_NOTION_TITLE = '{{team}} — {{date}}'

/**
 * Where to connect Notion or pick its page, opened beside the canvas so no edit is left behind:
 * Connections, at the Notion tool's card, or connecting it when it isn't yet.
 */
export const CONNECT_NOTION_HREF = '/connections?tool=notion'

/** What a Notion page card says it is, under its title — `NOTION_SOURCE` in delivery.rs. */
export const NOTION_PAGE_SOURCE = 'Notion page'

/** A page Notion's search found. */
export interface NotionPageHit {
  id: string
  title: string
}

/**
 * Pages whose title matches `query`, or recent pages for a blank one, through the operator's own
 * connection. The same search Connections uses to choose the destination.
 */
export async function searchNotionPages(query: string, cursor?: string | null, signal?: AbortSignal): Promise<{ pages: NotionPageHit[]; nextCursor: string | null }> {
  const response = await daemonFetch('/api/notion/pages', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    body: JSON.stringify({ query, ...(cursor ? { cursor } : {}) }),
  })
  if (response.status === 404) throw new Error(NOTION_UNAVAILABLE)
  const body = (await response.json().catch(() => null)) as { pages?: NotionPageHit[]; nextCursor?: string | null; error?: string } | null
  if (!response.ok || !body) throw new Error(body?.error ?? 'Notion could not be searched. Try again.')
  return { pages: body.pages ?? [], nextCursor: body.nextCursor ?? null }
}

/** Make page `pageId` the one answers go under, once Notion says it can hold pages. */
export async function chooseNotionDestination(pageId: string): Promise<NotionConnection> {
  const response = await daemonFetch('/api/notion/destination', {
    method: 'PUT',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    body: JSON.stringify({ pageId }),
  })
  if (response.status === 404) throw new Error(NOTION_UNAVAILABLE)
  const body = (await response.json().catch(() => null)) as ConnectionBody | null
  if (!response.ok || !body) throw new Error(body?.error ?? 'That page couldn’t be chosen. Try again.')
  return connectionFrom(body)
}

/** The page's address in Notion, from its id — `page_url` in notion/mod.rs. */
export function notionPageUrl(page: string): string {
  return `https://www.notion.so/${page.replace(/-/g, '')}`
}

/** What `/api/notion/connection` answers, and choosing the page does too. */
interface ConnectionBody {
  connected?: boolean
  name?: string
  destination?: { id: string; title: string } | null
  problem?: string | null
  error?: string
}

function connectionFrom(body: ConnectionBody): NotionConnection {
  return body.connected
    ? { state: 'connected', name: body.name ?? 'Notion', destination: body.destination ?? null, problem: body.problem ?? null }
    : { state: 'disconnected' }
}

export async function fetchNotionConnection(signal?: AbortSignal): Promise<NotionConnection> {
  const response = await daemonFetch('/api/notion/connection', { signal, cache: 'no-store', headers: { 'X-LoomWatch-Request': '1' } })
  if (response.status === 404) return { state: 'unavailable', message: NOTION_UNAVAILABLE }
  const body = (await response.json().catch(() => null)) as ConnectionBody | null
  if (!response.ok || !body) return { state: 'unavailable', message: body?.error ?? NOTION_UNAVAILABLE }
  return connectionFrom(body)
}

let inFlight: { read: Promise<NotionConnection>; startedAt: number } | null = null

/**
 * The connection, read once for everything on the page that asks at the same time: every answer
 * in a chat shows where it can be sent, and they all mount (and re-read on focus) together. The
 * daemon's first read can wait on macOS asking you about the Keychain, and the browser opens only
 * six connections to it, so a read per answer could leave the rest of the page queued behind them.
 */
function readShared(notBefore: number): Promise<NotionConnection> {
  // A read asked for after something may have changed (the window came back from Connections) is
  // never answered by one that started before it.
  if (inFlight && inFlight.startedAt >= notBefore) return inFlight.read
  const read = fetchNotionConnection().catch((caught: unknown): NotionConnection => (
    { state: 'unavailable', message: caught instanceof Error ? caught.message : NOTION_UNAVAILABLE }
  ))
  const entry = { read, startedAt: Date.now() }
  inFlight = entry
  void read.finally(() => { if (inFlight === entry) inFlight = null })
  return read
}

/**
 * The connection as the daemon reports it, read again whenever the window regains focus: the
 * operator connects in the Connections tab and comes back, and the canvas should already know.
 */
export function useNotionConnection(enabled = true): NotionConnection & { refresh: () => void } {
  const [connection, setConnection] = useState<NotionConnection>({ state: 'loading' })
  const [generation, setGeneration] = useState(0)
  const askedAt = useRef(0)
  const refresh = useCallback(() => { askedAt.current = Date.now(); setGeneration((value) => value + 1) }, [])

  useEffect(() => {
    if (!enabled) return
    let current = true
    void readShared(askedAt.current).then((next) => { if (current) setConnection(next) })
    return () => { current = false }
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
