// Thin wrapper over the daemon's run-control surface (crates/loomwatch-backend/src/runs.rs,
// docs/decisions/0008-run-control-api.md). A run's `runId` doubles as the archive
// `sessionId`, so the evidence stream at /api/session/stream can be opened immediately.
import { useCallback, useEffect, useState } from 'react'

export type RunStatus = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RunTrigger = 'manual' | 'schedule'

/** Where a routine's reply went after the run (docs/decisions/0010). */
export interface Delivery {
  target: 'notion'
  status: 'published' | 'skipped' | 'failed'
  url: string | null
  pageId: string | null
  message: string
  deliveredAt: string
}

/** One team file's `schedule` block as the daemon sees it (`GET /api/schedules`). */
export interface ScheduleEntry {
  teamPath: string
  teamName: string
  cron: string
  timezone: string | null
  describe: string
  prompt: string
  enabled: boolean
  nextAt: string | null
  lastRunId: string | null
  lastStatus: RunStatus | null
  lastFiredAt: string | null
  lastDelivery: Delivery | null
  deliver: { notion?: { title: string } } | null
  problem: string | null
}

export interface RunRecord {
  runId: string
  sessionId: string
  teamPath: string
  prompt: string
  status: RunStatus
  mode: 'team' | 'pipeline'
  entrypoint: string
  responder: string
  agentIds: string[]
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  exitCode: number | null
  /**
   * The daemon's stable machine-readable error code, verbatim (CONTRACT §3). Optional in
   * the type until the backend emits it — the UI carries what the daemon sends and says
   * `no code reported` when it sends none, never a token manufactured here.
   */
  errorCode?: string | null
  /** The daemon's terminal stop reason, verbatim (CONTRACT §3). Optional for the same reason. */
  stopReason?: string | null
  eventCount: number | null
  reply: string | null
  trigger?: RunTrigger
  delivery?: Delivery | null
}

/** §1.5: the file moved between the save and the start, so no run was created. */
export const STALE_TEAM_REVISION = 'stale_team_revision'
/** §1.6: this start key is already bound to a different request fingerprint. */
export const IDEMPOTENCY_CONFLICT = 'idempotency_conflict'

export class RunApiError extends Error {
  readonly status: number
  /** The daemon's machine-readable reason, where it sends one — both 409s carry it. */
  readonly code: string | null
  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled']
export const isTerminalRun = (status: RunStatus | null | undefined) => !!status && TERMINAL_RUN_STATUSES.includes(status)

async function readRun<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | { error?: string; code?: string } | null
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && body.error ? String(body.error) : `${response.status} ${response.statusText}`
    const code = body && typeof body === 'object' && 'code' in body && body.code ? String(body.code) : null
    throw new RunApiError(message, response.status, code)
  }
  return body as T
}

// TNG89 §1.6: "`⌘↵` generates one start key and holds it for the life of the attempt."
// The key is the operator's protection against a lost response: re-posting the same key returns
// the run the daemon already started (200) instead of starting a second one, so a connection
// loss during submit never retries blind.
export const newStartKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `sk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export interface StartRunOptions {
  /** One key for the life of one submit attempt (§1.6). */
  startKey: string
  /**
   * §1.4: the revision the conditional `PUT` returned — the bytes this run must execute.
   * The daemon answers `409 stale_team_revision` rather than running what is on disk.
   */
  expectedRevision: string | null
  signal?: AbortSignal
}

export async function startRun(teamPath: string, prompt: string, { startKey, expectedRevision, signal }: StartRunOptions): Promise<RunRecord> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamPath, prompt, startKey, expectedRevision }),
    signal,
    cache: 'no-store',
  })
  // 202 = started, 200 = this key already started it. Both answer with that one run record.
  return readRun<RunRecord>(response)
}

export async function cancelRun(runId: string): Promise<RunRecord> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', cache: 'no-store' })
  return readRun<RunRecord>(response)
}

export async function fetchRun(runId: string, signal?: AbortSignal): Promise<RunRecord> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { signal, cache: 'no-store' })
  return readRun<RunRecord>(response)
}

export async function fetchSchedules(signal?: AbortSignal): Promise<ScheduleEntry[]> {
  const response = await fetch('/api/schedules', { signal, cache: 'no-store' })
  return readRun<ScheduleEntry[]>(response)
}

/** "Run the routine now": expands the schedule's prompt, runs it, and delivers like a timed fire. */
export async function runScheduleNow(teamPath: string): Promise<RunRecord> {
  const response = await fetch('/api/schedules/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamPath }),
    cache: 'no-store',
  })
  return readRun<RunRecord>(response)
}

export async function fetchRuns(signal?: AbortSignal): Promise<RunRecord[]> {
  const response = await fetch('/api/runs', { signal, cache: 'no-store' })
  return readRun<RunRecord[]>(response)
}

/**
 * Follow one run's registry record. Polls while the run is non-terminal; a run the daemon
 * no longer knows (restart) resolves to `null` and the caller falls back to archive evidence.
 */
export function useRunRecord(runId: string | null) {
  // Keyed by run id so switching runs never shows the previous run's record for a frame.
  const [state, setState] = useState<{ runId: string | null; record: RunRecord | null; error: string | null; missing: boolean }>({ runId, record: null, error: null, missing: false })
  const current = state.runId === runId ? state : { runId, record: null, error: null, missing: false }

  useEffect(() => {
    if (!runId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function tick() {
      try {
        const next = await fetchRun(runId!, controller.signal)
        if (controller.signal.aborted) return
        setState({ runId, record: next, error: null, missing: false })
        if (!isTerminalRun(next.status)) timer = setTimeout(() => void tick(), 1000)
      } catch (caught) {
        if (controller.signal.aborted) return
        if (caught instanceof RunApiError && caught.status === 404) { setState((previous) => ({ runId, record: previous.runId === runId ? previous.record : null, error: null, missing: true })); return }
        setState((previous) => ({ runId, record: previous.runId === runId ? previous.record : null, error: caught instanceof Error ? caught.message : String(caught), missing: false }))
        timer = setTimeout(() => void tick(), 3000)
      }
    }
    void tick()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [runId])

  const apply = useCallback((next: RunRecord) => setState({ runId: next.runId, record: next, error: null, missing: false }), [])
  return { record: current.record, error: current.error, missing: current.missing, apply }
}

/** The daemon's routines, refreshed once a minute; `null` until the first answer. */
export function useSchedules() {
  const [state, setState] = useState<{ entries: ScheduleEntry[] | null; error: string | null }>({ entries: null, error: null })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function tick() {
      try {
        const entries = await fetchSchedules(controller.signal)
        if (!controller.signal.aborted) setState({ entries, error: null })
      } catch (caught) {
        if (controller.signal.aborted) return
        // A daemon without the archive (503) or an older daemon (404) simply has no routines.
        if (caught instanceof RunApiError && (caught.status === 503 || caught.status === 404)) setState({ entries: [], error: null })
        else setState((previous) => ({ entries: previous.entries, error: caught instanceof Error ? caught.message : String(caught) }))
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), 60_000)
    }
    void tick()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [generation])
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])
  return { ...state, refresh }
}

/** Match a routine to the open document: the API path is relative to the teams root. */
export function scheduleForPath(entries: ScheduleEntry[] | null, path: string | null): ScheduleEntry | null {
  if (!entries || !path) return null
  const normalised = path.replace(/\\/g, '/')
  return entries.find((entry) => normalised === entry.teamPath || normalised.endsWith(`/${entry.teamPath}`)) ?? null
}

export function describeNextFire(iso: string | null, now = Date.now()): string {
  if (!iso) return 'not scheduled'
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'due now'
  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`
  return `in ${Math.round(ms / 86_400_000)}d`
}
