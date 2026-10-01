/**
 * The daemon's file endpoints (crates/loomwatch-backend/src/files.rs): what a produced file is, and
 * asking the system to open it or show it in its folder. Paths outside the teams folder are refused
 * by the daemon; the UI only reports that.
 */
export interface FileFacts {
  path: string
  name: string
  exists: boolean
  isDir: boolean
  sizeBytes: number | null
  modifiedAt: string | null
  kind: string
  folder: string | null
  openable: boolean
}

export type FileLookup =
  | { state: 'found'; facts: FileFacts }
  | { state: 'outside'; message: string }
  | { state: 'unknown'; message: string }

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `${response.status} ${response.statusText}`
}

export async function statFile(path: string, signal?: AbortSignal): Promise<FileLookup> {
  const response = await fetch(`/api/files/stat?path=${encodeURIComponent(path)}`, { signal, cache: 'no-store' })
  if (response.ok) return { state: 'found', facts: (await response.json()) as FileFacts }
  // 403 is the daemon's boundary; anything else (an older daemon without the route, a hiccup) is
  // reported as not knowing, so the card still offers what it can: the path to copy.
  if (response.status === 403) return { state: 'outside', message: await errorMessage(response) }
  return { state: 'unknown', message: await errorMessage(response) }
}

const inFlight = new Map<string, Promise<FileLookup>>()

/**
 * `statFile` shared by everything on screen that shows the same file — the reply's inline chip and
 * the output header's card ask once between them. Never rejects: a failure is `unknown`.
 */
export function lookupFile(path: string): Promise<FileLookup> {
  const pending = inFlight.get(path)
  if (pending) return pending
  const request = statFile(path)
    .catch((caught: unknown): FileLookup => ({ state: 'unknown', message: caught instanceof Error ? caught.message : String(caught) }))
    .finally(() => inFlight.delete(path))
  inFlight.set(path, request)
  return request
}

export async function openFile(path: string, reveal = false): Promise<void> {
  const response = await fetch('/api/files/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, reveal }),
  })
  if (!response.ok) throw new Error(await errorMessage(response))
}
