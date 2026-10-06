// New versions of LoomWatch (ADR 0052). The daemon asks GitHub once a day which release is the
// newest; the app reads what it found, and installing stays the operator's step in the terminal.
import { useSyncExternalStore } from 'react'

import { daemonFetch } from '../daemonFetch'

/** How this copy was installed, which decides how it is updated. */
export type Install = 'release' | 'source' | 'other'

/** The newest published release. */
export interface Release {
  /** `0.1.6`, without the tag's `v`. */
  version: string
  tag: string
  name: string | null
  publishedAt: string | null
  /** The release's page on GitHub. */
  url: string
  /** Its notes, Markdown as written on GitHub. */
  notes: string
}

/** `GET /api/updates`. */
export interface UpdateStatus {
  /** The running version. */
  current: string
  install: Install
  /** The command that updates this copy, such as `loomwatch update`. Null for `other`. */
  command: string | null
  /** The daily check is on. */
  automatic: boolean
  /** The setting that turned every check off on this computer, which the app cannot change. */
  turnedOffBy: string | null
  checkedAt: string | null
  /** Why the last check failed, until one succeeds. */
  error: string | null
  latest: Release | null
  /** The newest release is newer than the running version. */
  available: boolean
  /** A version the operator chose not to be told about again. */
  skipped: string | null
  releasesUrl: string
}

export interface UpdateSettings {
  automatic?: boolean
  /** A version to stop pointing at, or `null` to point at it again. */
  skipped?: string | null
}

async function answer(response: Response): Promise<UpdateStatus> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `The server answered ${response.status}.`)
  }
  return await response.json() as UpdateStatus
}

export async function fetchUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  return answer(await daemonFetch('/api/updates', signal ? { signal } : undefined))
}

/** Ask GitHub now. The daemon answers with what it already has if it asked moments ago. */
export async function checkForUpdates(): Promise<UpdateStatus> {
  return answer(await daemonFetch('/api/updates/check', { method: 'POST' }))
}

export async function saveUpdateSettings(settings: UpdateSettings): Promise<UpdateStatus> {
  return answer(await daemonFetch('/api/updates/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  }))
}

/** Whether to point the operator at the newest release: newer, and not a version they skipped. */
export function offerUpdate(status: UpdateStatus | null): boolean {
  return Boolean(status?.available && status.latest && status.skipped !== status.latest.version)
}

/** The command that undoes an update, beside the one that makes it: `loomwatch rollback`. */
export function rollbackCommand(command: string | null): string | null {
  return command?.endsWith(' update') ? `${command.slice(0, -' update'.length)} rollback` : null
}

// One answer shared by the Home pill and the dialog, so skipping in one hides the other at once.
let current: UpdateStatus | null = null
const listeners = new Set<() => void>()

export function setUpdateStatus(next: UpdateStatus): void {
  current = next
  for (const notify of listeners) notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** What the daemon last said, or null until it has answered. */
export function useUpdateStatus(): UpdateStatus | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

/** Tests start from nothing. */
export function resetUpdateStatus(): void {
  current = null
  for (const notify of listeners) notify()
}

export const UPDATES_EVENT = 'loomwatch:updates'

/** Open the updates dialog from anywhere: Home's pill and the command palette call this. */
export function openUpdates(): void {
  window.dispatchEvent(new Event(UPDATES_EVENT))
}
