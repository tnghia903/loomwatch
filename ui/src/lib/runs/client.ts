// Thin wrapper over the daemon's run-control surface (crates/loomwatch-backend/src/runs.rs,
// docs/decisions/0008-run-control-api.md). A run's `runId` doubles as the archive
// `sessionId`, so the evidence stream at /api/session/stream can be opened immediately.
import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

export type RunStatus = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RunTrigger = 'manual' | 'schedule'

/** Where a run's reply went after it finished (ADR 0010 routines, ADR 0038 every run). */
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

/**
 * A request an agent's app is blocked on until you answer (ADR 0040) — something its `allow:`
 * switches do not cover, such as a web search with "Use the web" off. Declined by itself at
 * `expiresAt` when nobody answers.
 */
export interface PermissionRequest {
  id: string
  /** The agent asking, and its name. */
  agent: string
  name: string
  /** What the app calls the action: "Web search", "Bash". */
  title: string
  /** ACP tool kind: `fetch`, `execute`, `edit`, `read`, … */
  kind: string
  /** The switch that would allow it without asking. */
  switch?: 'web' | 'commands' | 'edits' | null
  /** The query, command, address or path, when there is one. */
  detail?: string | null
  since: string
  expiresAt: string
}

export type PermissionDecision = 'allow_once' | 'allow_run' | 'deny'

export interface WaitingOn {
  node: string
  name: string
  kind: 'review_stop' | 'question'
  since: string
  question: string
  context?: string | null
  handoverFrom?: string | null
  park: 'reloadable' | 'kept_alive' | 'released' | 'none'
  parkNote: string
  sendBackAvailable: boolean
  questionId?: string | null
}

export interface RunRecord {
  replyableAgents?: string[]
  waitingOn?: WaitingOn | null
  /** Requests an agent is blocked on until you answer (ADR 0040); absent when there are none. */
  permissionRequests?: PermissionRequest[]
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
  /**
   * The Notion page title this run's answer is published under once it succeeds, fixed at launch
   * from the team's `deliver`; absent when the run delivers nowhere. Between the run's end and its
   * `delivery` it is what "Sending to Notion…" means.
   */
  deliverTitle?: string | null
  /**
   * The run this one continues (Canvas B, decision 8). Its stages before `startAt` were not
   * executed: their stored handovers were replayed into this run.
   */
  followsRunId?: string | null
  /** The stage this run started executing at. `null`/absent means the whole pipeline. */
  startAt?: string | null
  /**
   * The run this one is another attempt at. Written by "Start a new run from this checkpoint" and,
   * once the composer stops synthesising it, by Retry. Server-side lineage, so it survives a
   * reload — unlike the React `Map` the workspace still keeps for retries.
   */
  retryOfRunId?: string | null
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
   * Canvas B: the run this one follows. Stages before `startAt` are replayed from the archive
   * rather than re-executed.
   */
  followsRunId?: string | null
  /**
   * The stage to start executing at. Must be a stage of the current pipeline order; team mode
   * allows only the whole pipeline, and the daemon refuses anything else *before* a harness
   * spawns rather than discovering it mid-run.
   */
  startAt?: string | null
  /** "Start a new run from this checkpoint": implies the run followed and the stage started at. */
  fromCheckpointId?: string | null
  retryOfRunId?: string | null
  /**
   * §1.4: the revision the conditional `PUT` returned — the bytes this run must execute.
   * The daemon answers `409 stale_team_revision` rather than running what is on disk.
   */
  expectedRevision: string | null
  signal?: AbortSignal
}

export async function startRun(teamPath: string, prompt: string, { startKey, expectedRevision, followsRunId, startAt, fromCheckpointId, retryOfRunId, signal }: StartRunOptions): Promise<RunRecord> {
  const response = await daemonFetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The lineage keys are omitted rather than sent as null: a plain run's body stays byte-identical
    // to what it was, which is what keeps the idempotency fingerprint of an ordinary submit stable.
    body: JSON.stringify({
      teamPath,
      prompt,
      startKey,
      expectedRevision,
      ...(followsRunId ? { followsRunId } : {}),
      ...(startAt ? { startAt } : {}),
      ...(fromCheckpointId ? { fromCheckpointId } : {}),
      ...(retryOfRunId ? { retryOfRunId } : {}),
    }),
    signal,
    cache: 'no-store',
  })
  // 202 = started, 200 = this key already started it. Both answer with that one run record.
  return readRun<RunRecord>(response)
}

/**
 * §1.6: "A connection loss during submit **never** retries blind: the client re-`GET`s by
 * start key." Answers the run this key started, or `null` when the daemon has never seen it —
 * which is the difference between a submit that was lost on the way back and one that never
 * landed, and the only way the client can tell them apart.
 */
export async function findRunByStartKey(startKey: string, signal?: AbortSignal): Promise<RunRecord | null> {
  const response = await daemonFetch(`/api/runs?startKey=${encodeURIComponent(startKey)}`, { signal, cache: 'no-store' })
  if (response.status === 404) return null
  return readRun<RunRecord>(response)
}

export async function answerRun(runId: string, node: string, text: string, sendBack?: string): Promise<RunRecord> {
  return readRun<RunRecord>(await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/answers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node, text, ...(sendBack ? { sendBack } : {}) }), cache: 'no-store',
  }))
}

/** Your answer to one permission request (ADR 0040). Resolves with the run once the agent has it. */
export async function answerPermission(runId: string, requestId: string, decision: PermissionDecision): Promise<RunRecord> {
  return readRun<RunRecord>(await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/permissions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, decision }), cache: 'no-store',
  }))
}

export async function askRunAgent(runId: string, agent: string, text: string): Promise<{ agent: string; reply: string }> {
  return readRun(await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agent)}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), cache: 'no-store',
  }))
}

export async function cancelRun(runId: string): Promise<RunRecord> {
  const response = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', cache: 'no-store' })
  return readRun<RunRecord>(response)
}

export async function fetchRun(runId: string, signal?: AbortSignal): Promise<RunRecord> {
  const response = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}`, { signal, cache: 'no-store' })
  return readRun<RunRecord>(response)
}

/**
 * "Send to Notion" (ADR 0038): publish a finished run's answer now, whatever the team file says.
 * Answers the run with its new `delivery` — a publish Notion refused is still a record, with the
 * reason in `delivery.message`. Without `title` the daemon uses the run's own delivery title, else
 * the team's template.
 */
export async function deliverRun(runId: string, title?: string): Promise<RunRecord> {
  return readRun<RunRecord>(await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/deliver`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title === undefined ? {} : { title }), cache: 'no-store',
  }))
}

export async function fetchSchedules(signal?: AbortSignal): Promise<ScheduleEntry[]> {
  const response = await daemonFetch('/api/schedules', { signal, cache: 'no-store' })
  return readRun<ScheduleEntry[]>(response)
}

/** "Run the routine now": expands the schedule's prompt, runs it, and delivers like a timed fire. */
export async function runScheduleNow(teamPath: string): Promise<RunRecord> {
  const response = await daemonFetch('/api/schedules/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamPath }),
    cache: 'no-store',
  })
  return readRun<RunRecord>(response)
}

export async function fetchRuns(signal?: AbortSignal): Promise<RunRecord[]> {
  const response = await daemonFetch('/api/runs', { signal, cache: 'no-store' })
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

/**
 * Instructions as they are on disk **now**, with the fingerprint of what was actually read.
 *
 * A run archives the fingerprint of the instructions it supplied, not their bytes, so reading
 * them back can only ever return the current file. `sha256` is what makes that honest: compare it
 * to the fingerprint the run recorded and the reader knows whether they are looking at what ran.
 */
export interface InstructionFile {
  path: string
  sha256: string
  chars: number
  content: string
}

export async function fetchInstructions(path: string, signal?: AbortSignal): Promise<InstructionFile> {
  const response = await daemonFetch(`/api/instructions?path=${encodeURIComponent(path)}`, { signal })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch { /* the status text is still useful when the body is not JSON */ }
    throw new RunApiError(message, response.status)
  }
  return (await response.json()) as InstructionFile
}
