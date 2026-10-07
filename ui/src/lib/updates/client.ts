// New versions of LoomWatch (ADR 0052). The daemon asks GitHub once a day which release is the
// newest; the app reads what it found. Installing is the launcher's: the operator runs the update
// command in its terminal, or, for a ready-built copy whose launcher stays beside it, asks for
// Update and restart here, and the launcher installs the release and starts LoomWatch again.
import { useSyncExternalStore } from 'react'

import { fetchAbout } from '../feedback/report'
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
  /**
   * The app can install the newest release itself: a ready-built copy whose launcher starts it
   * again. Absent from daemons that cannot.
   */
  canInstall?: boolean
  /** Why the last update asked for here did not finish, when the launcher started this version again. */
  installError?: string | null
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

/** `POST /api/updates/install`'s answer: LoomWatch is stopping so its launcher can update it. */
export interface InstallStarted {
  from: string
  to: string
  /** When the daemon that answered started, to tell it from the one the launcher starts next. */
  startedAt: string
  stoppedRuns: number
}

/** A run updating would stop, as the daemon names it when it refuses to stop one unasked. */
export interface LiveRun {
  runId: string
  teamPath: string
  status: string
}

/** The daemon would not update: `code` says why, `liveRuns` names the runs in the way. */
export class InstallRefused extends Error {
  readonly code: string | null
  readonly liveRuns: LiveRun[]

  constructor(message: string, code: string | null, liveRuns: LiveRun[]) {
    super(message)
    this.name = 'InstallRefused'
    this.code = code
    this.liveRuns = liveRuns
  }
}

/**
 * Update and restart. `stopRuns` agrees to stop the teams at work; without it the daemon refuses
 * while any is, naming them.
 */
export async function installUpdate(stopRuns: boolean): Promise<InstallStarted> {
  const response = await daemonFetch('/api/updates/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stopRuns }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string; liveRuns?: LiveRun[] } | null
    throw new InstallRefused(body?.error ?? `The server answered ${response.status}.`, body?.code ?? null, body?.liveRuns ?? [])
  }
  return await response.json() as InstallStarted
}

/** How the launcher's update ended, as far as the app can tell. */
export type Restarted =
  | { outcome: 'updated'; version: string }
  /** The launcher started the version that was running again: the update did not finish. */
  | { outcome: 'failed'; version: string; error: string | null }
  /** Nothing answered in time: the terminal running LoomWatch says what happened. */
  | { outcome: 'lost' }

/** How often to ask whether LoomWatch is back, and when to stop asking. */
export const RESTART_POLL_MS = 1500
export const RESTART_GIVE_UP_MS = 10 * 60 * 1000

export interface WaitOptions {
  signal?: AbortSignal
  everyMs?: number
  giveUpMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const pause = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms) })

/**
 * Waits for the launcher to start LoomWatch again after `installUpdate`, asking `GET /api/about`
 * until a different start answers. The daemon that took the request answers for a moment longer,
 * and nothing answers while the launcher updates. A newer version means the update worked; the same
 * one means the launcher started it again because the update did not finish, and `GET /api/updates`
 * says why.
 */
export async function waitForRestart(started: InstallStarted, options: WaitOptions = {}): Promise<Restarted> {
  const { signal, everyMs = RESTART_POLL_MS, giveUpMs = RESTART_GIVE_UP_MS, now = Date.now, sleep = pause } = options
  const deadline = now() + giveUpMs
  while (now() < deadline) {
    signal?.throwIfAborted()
    const about = await fetchAbout(signal).catch((caught: unknown) => {
      if (signal?.aborted) throw caught
      return null
    })
    // Before Update and restart, a daemon said nothing of its start: then only the version tells.
    const anotherStart = about !== null && (about.startedAt ? about.startedAt !== started.startedAt : about.version !== started.from)
    if (about && anotherStart) {
      if (about.version !== started.from) return { outcome: 'updated', version: about.version }
      const status = await fetchUpdateStatus(signal).catch(() => null)
      if (status) setUpdateStatus(status)
      return { outcome: 'failed', version: about.version, error: status?.installError ?? null }
    }
    await sleep(everyMs)
  }
  return { outcome: 'lost' }
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

/** Update and restart, as the app follows it once the daemon agreed to stop. */
export type InstallProgress =
  | { phase: 'idle' }
  | { phase: 'updating'; from: string; to: string }
  | { phase: 'updated'; from: string; version: string }
  | { phase: 'failed'; from: string; to: string; version: string; error: string | null }
  | { phase: 'lost'; from: string; to: string }

const IDLE: InstallProgress = { phase: 'idle' }
let progress: InstallProgress = IDLE

function setInstallProgress(next: InstallProgress): void {
  progress = next
  for (const notify of listeners) notify()
}

/** Where Update and restart is, shared so closing the dialog midway loses nothing. */
export function useInstallProgress(): InstallProgress {
  return useSyncExternalStore(subscribe, () => progress, () => IDLE)
}

/**
 * Update and restart: asks the daemon to stop for its launcher, then follows the launcher's update
 * in the background and opens the updates dialog on how it ended. Throws only when the daemon
 * refused, such as `InstallRefused` with `code: 'runs_live'` when a team started working since.
 */
export async function updateAndRestart(stopRuns: boolean): Promise<void> {
  const started = await installUpdate(stopRuns)
  setInstallProgress({ phase: 'updating', from: started.from, to: started.to })
  void waitForRestart(started).then((restarted) => {
    if (restarted.outcome === 'updated') {
      setInstallProgress({ phase: 'updated', from: started.from, version: restarted.version })
      fetchUpdateStatus().then(setUpdateStatus).catch(() => {
        // The new version's news arrives with the next refresh.
      })
    } else if (restarted.outcome === 'failed') {
      setInstallProgress({ phase: 'failed', from: started.from, to: started.to, version: restarted.version, error: restarted.error })
    } else {
      setInstallProgress({ phase: 'lost', from: started.from, to: started.to })
    }
    openUpdates()
  })
}

/** Tests start from nothing. */
export function resetUpdateStatus(): void {
  current = null
  progress = IDLE
  for (const notify of listeners) notify()
}

export const UPDATES_EVENT = 'loomwatch:updates'

/** Open the updates dialog from anywhere: Home's pill and the command palette call this. */
export function openUpdates(): void {
  window.dispatchEvent(new Event(UPDATES_EVENT))
}
