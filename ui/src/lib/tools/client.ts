// Tools you connect (ADR 0069): MCP servers on the internet, such as Linear's, that an agent you
// give one to can call. Each call asks you first unless you always allow it. The daemon keeps the
// connection and its secret; the app only ever sees names, addresses and what each tool offers.
import { useCallback, useEffect, useRef, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

export type ToolAuth = 'none' | 'token' | 'signIn'

/** One call a tool offers, as its server describes it. */
export interface ToolCallInfo {
  /** The tool's own name for it: `create_issue`. */
  name: string
  /** What a person reads: "Create issue". */
  label: string
  description: string
  /** The server says it only reads. A hint: it still asks first. */
  readOnly: boolean
}

export interface ConnectedTool {
  id: string
  name: string
  url: string
  auth: ToolAuth
  calls: ToolCallInfo[]
  checkedAt: string | null
  /** Still waiting for its sign-in or token. */
  pending: boolean
  /** What went wrong the last time it was used, until it works again. */
  problem: string | null
  /** For a token: where to make one. */
  tokenHelp: string | null
  /** For a tool from the starter list: something to ask an agent given it. */
  example?: string | null
  /** Where LoomWatch serves its icon from (`icons.rs`). */
  icon?: string | null
  /** Notion's: its sign-in also sends teams' answers to Notion and reads pages for agents (ADR 0070). */
  notion?: boolean
}

/** Where the Notion tool is connected — `notion::MCP_URL`. */
export const NOTION_TOOL_URL = 'https://mcp.notion.com/mcp'

/** What a starter tool is for, for the headings the list is shown under (`catalog::Group`). */
export type CatalogGroup = 'work' | 'create' | 'travel' | 'lookUp' | 'build'

export const CATALOG_GROUPS: readonly { group: CatalogGroup; title: string }[] = [
  { group: 'work', title: 'Work' },
  { group: 'create', title: 'Create' },
  { group: 'travel', title: 'Travel and fun' },
  { group: 'lookUp', title: 'Look things up' },
  { group: 'build', title: 'Build and sell' },
]

/** A tool to start from, checked to connect as its `auth` says. */
export interface CatalogEntry {
  name: string
  url: string
  does: string
  auth: ToolAuth
  /** Absent from a daemon older than the groups: shown under no heading. */
  group?: CatalogGroup
  /** Something to ask an agent given it. */
  example?: string
  /** Where LoomWatch serves its icon from (`icons.rs`). */
  icon?: string | null
  tokenHelp?: string
}

/** Where secrets are kept on this computer, for the line that says so. */
export type KeptIn = 'keychain' | 'credentialManager' | 'file' | 'nowhere'

/** Where a secret is kept, as a sentence names it. */
export function keptInWords(keptIn: KeptIn): string {
  switch (keptIn) {
    case 'credentialManager': return 'Windows Credential Manager'
    case 'file': return 'a private file in LoomWatch’s folder'
    case 'nowhere': return 'nowhere on this computer'
    default: return 'this Mac’s Keychain'
  }
}

export type ToolsState =
  | { state: 'loading' }
  | { state: 'unavailable'; message: string }
  | { state: 'ready'; tools: ConnectedTool[]; catalog: CatalogEntry[]; keptIn: KeptIn }

export const TOOLS_UNAVAILABLE = 'Tools can be connected only when LoomWatch runs on this computer.'

/** What a sign-in's landing page and every connect or remove posts on, so every window refreshes. */
export const TOOLS_CHANNEL = 'loomwatch-tools'

/** How a sign-in in its own window ended (`sign_in::Outcome` in connected_tools/sign_in.rs). */
export type SignInOutcome = 'connected' | 'denied' | 'expired' | 'failed'

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const response = await daemonFetch(path, {
    ...rest,
    cache: 'no-store',
    headers: { 'X-LoomWatch-Request': '1', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
  if (response.status === 404 && path === '/api/tools') throw new Error(TOOLS_UNAVAILABLE)
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || !body) throw new Error(body?.error ?? 'LoomWatch could not do that. Try again.')
  return body
}

export function fetchTools(signal?: AbortSignal): Promise<{ tools: ConnectedTool[]; catalog: CatalogEntry[]; keptIn: KeptIn }> {
  return request('/api/tools', { signal })
}

/** What connecting answered: the tool, and what it still needs, if anything. */
export interface ConnectAnswer {
  tool: ConnectedTool
  needs?: 'signIn' | 'token'
  /** For a sign-in: the tool's consent page. */
  url?: string
}

export async function connectTool(url: string, name?: string): Promise<ConnectAnswer> {
  const answer = await request<ConnectAnswer>('/api/tools', { method: 'POST', json: { url, ...(name ? { name } : {}) } })
  announceToolsChanged()
  return answer
}

export async function sendToolToken(id: string, token: string): Promise<ConnectedTool> {
  const { tool } = await request<{ tool: ConnectedTool }>(`/api/tools/${encodeURIComponent(id)}/token`, { method: 'POST', json: { token } })
  announceToolsChanged()
  return tool
}

export async function signInToToolAgain(id: string): Promise<string> {
  const { url } = await request<{ url: string }>(`/api/tools/${encodeURIComponent(id)}/sign-in`, { method: 'POST' })
  return url
}

export async function checkTool(id: string): Promise<ConnectedTool> {
  const { tool } = await request<{ tool: ConnectedTool }>(`/api/tools/${encodeURIComponent(id)}/check`, { method: 'POST' })
  announceToolsChanged()
  return tool
}

export async function removeTool(id: string): Promise<void> {
  await request(`/api/tools/${encodeURIComponent(id)}`, { method: 'DELETE' })
  announceToolsChanged()
}

/**
 * The words the app uses (ADR 0069): a **tool** is a service you connect, such as Linear or
 * Kiwi.com; each thing a tool can do ("Create issue") is an **action**. "MCP" is said only where it
 * helps find a tool's address, and "connection" names only the Connections page.
 */
export function actionCount(count: number): string {
  return `${count} action${count === 1 ? '' : 's'}`
}

/** The connected tool called `name`, ignoring case, as the daemon finds it for a run. */
export function toolNamed(tools: readonly ConnectedTool[], name: string): ConnectedTool | undefined {
  const wanted = name.trim().toLowerCase()
  return tools.find((tool) => !tool.pending && tool.name.trim().toLowerCase() === wanted)
}

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(TOOLS_CHANNEL)
  } catch {
    return null
  }
}

/** Tell every window the tools changed. */
export function announceToolsChanged(): void {
  const sending = channel()
  sending?.postMessage({ changed: true })
  sending?.close()
}

/** Calls `listen` with each message on the tools channel, until the returned function is called. */
export function onToolsMessage(listen: (message: { tool?: string | null; outcome?: SignInOutcome; changed?: boolean }) => void): () => void {
  const listening = channel()
  if (!listening) return () => {}
  listening.onmessage = (event: MessageEvent) => {
    if (event.data && typeof event.data === 'object') listen(event.data as { tool?: string; outcome?: SignInOutcome; changed?: boolean })
  }
  return () => listening.close()
}

let inFlight: { read: Promise<ToolsState>; startedAt: number } | null = null

/** The tools, read once for everything on the page that asks at the same time. */
function readShared(notBefore: number): Promise<ToolsState> {
  if (inFlight && inFlight.startedAt >= notBefore) return inFlight.read
  const read = fetchTools()
    .then((body): ToolsState => ({ state: 'ready', tools: body.tools ?? [], catalog: body.catalog ?? [], keptIn: body.keptIn ?? 'keychain' }))
    .catch((caught: unknown): ToolsState => ({ state: 'unavailable', message: caught instanceof Error ? caught.message : TOOLS_UNAVAILABLE }))
  const entry = { read, startedAt: Date.now() }
  inFlight = entry
  void read.finally(() => { if (inFlight === entry) inFlight = null })
  return read
}

/**
 * The connected tools, read again whenever they change (here or in another window) and when the
 * window regains focus.
 */
export function useConnectedTools(enabled = true): ToolsState & { refresh: () => void } {
  const [tools, setTools] = useState<ToolsState>({ state: 'loading' })
  const [generation, setGeneration] = useState(0)
  const askedAt = useRef(0)
  const refresh = useCallback(() => { askedAt.current = Date.now(); setGeneration((value) => value + 1) }, [])

  useEffect(() => {
    if (!enabled) return
    let current = true
    void readShared(askedAt.current).then((next) => { if (current) setTools(next) })
    return () => { current = false }
  }, [enabled, generation])

  useEffect(() => {
    if (!enabled) return
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    const stop = onToolsMessage(() => refresh())
    return () => {
      window.removeEventListener('focus', onFocus)
      stop()
    }
  }, [enabled, refresh])

  return { ...tools, refresh }
}
