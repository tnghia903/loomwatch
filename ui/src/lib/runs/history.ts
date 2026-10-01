import type { AgentStatus } from '../team-file/types'
import { legacyOperatorPrompt, type SessionSummary } from '../watch/events'
import type { RunRecord } from './client'

export interface HistoryEntry {
  id: string
  /** The team file this run executed. Archive-only legacy sessions may not have recorded one. */
  teamPath?: string | null
  prompt: string
  status: AgentStatus
  statusWord: string
  when: string
  sub: string
  live: boolean
  /** The run this one follows, when the record says so. Server-side, so it survives a reload. */
  followsRunId?: string | null
  /** The run this one is another attempt at. */
  retryOfRunId?: string | null
  /** The stage a follow-up started at; `null` for a whole-pipeline one. */
  startAt?: string | null
  /**
   * How deeply this row is indented in the thread, and what it is: 0 is a run nobody follows.
   *
   * Filled by `threadHistory`, not by `mergeHistory` — a thread is a presentation of the same
   * rows, and the list a filter searches must stay flat.
   */
  depth?: number
  lineage?: string | null
}

export function mergeHistory(records: readonly RunRecord[], sessions: readonly SessionSummary[]): HistoryEntry[] {
  const byId = new Map<string, HistoryEntry>()
  for (const session of sessions) {
    byId.set(session.sessionId, {
      id: session.sessionId,
      // A history row for an archive-only session — a run the daemon has forgotten. `task` is the
      // recorded `prompt_sections` task section, which is the operator's own words verbatim; the
      // regex split is the fallback for a session archived before phase 1 started recording them,
      // and is never used for a new run. Any session that still has a RunRecord is overwritten
      // below with `record.prompt`, which is exact either way.
      prompt: session.task?.trim()
        || (session.prompt ? legacyOperatorPrompt(session.prompt) : '')
        || `Session ${session.sessionId.slice(0, 8)}`,
      status: 'idle',
      statusWord: 'archived',
      when: session.updatedAt,
      sub: `${session.agentCount} agent${session.agentCount === 1 ? '' : 's'} · ${session.eventCount} events`,
      live: false,
    })
  }
  for (const record of records) {
    const status: AgentStatus = record.status === 'running' && record.waitingOn ? 'waiting' : record.status === 'succeeded' ? 'succeeded' : record.status === 'failed' ? 'failed' : record.status === 'cancelled' ? 'stopped' : record.status === 'queued' ? 'idle' : record.status === 'starting' ? 'starting' : 'running'
    const existing = byId.get(record.runId)
    byId.set(record.runId, {
      id: record.runId,
      teamPath: record.teamPath,
      prompt: record.prompt.trim() || existing?.prompt || record.runId,
      status,
      statusWord: status === 'waiting' ? 'waiting for you' : record.status,
      when: record.finishedAt ?? record.startedAt ?? record.createdAt,
      sub: `${record.trigger === 'schedule' ? 'routine · ' : ''}${record.teamPath}${existing ? ` · ${existing.sub}` : ''}${record.error ? ` · ${record.error}` : ''}${record.delivery?.status === 'published' ? ' · published to Notion' : record.delivery?.status === 'failed' ? ' · delivery failed' : ''}`,
      live: !['succeeded', 'failed', 'cancelled'].includes(record.status),
      followsRunId: record.followsRunId ?? null,
      retryOfRunId: record.retryOfRunId ?? null,
      startAt: record.startAt ?? null,
    })
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
}

/** Open a recorded run with the team file it actually executed, never the canvas already open. */
export function historyRunUrl(entry: Pick<HistoryEntry, 'id' | 'teamPath'>): string {
  const params = new URLSearchParams()
  if (entry.teamPath) params.set('path', entry.teamPath)
  params.set('run', entry.id)
  return `/?${params.toString()}`
}

/**
 * "The run history reads as a thread": follow-ups indented under the run they follow.
 *
 * Newest-first inside each level, so the top of the list is still the newest thing that happened;
 * a follow-up sits directly under its parent rather than at the position its timestamp would give
 * it, which is the whole point — a conversation with a run reads in order.
 *
 * Retries keep today's treatment: they are labelled, not indented. A retry is the same prompt from
 * zero, so it is a sibling attempt, not a continuation — indenting it would claim it built on
 * something it deliberately did not.
 *
 * A row whose parent is not in the list (older than the window, or never recorded) stays at the
 * top level with its label intact, rather than disappearing into a thread that is not there.
 */
export function threadHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const children = new Map<string, HistoryEntry[]>()
  const roots: HistoryEntry[] = []
  for (const entry of entries) {
    const parent = entry.followsRunId && byId.has(entry.followsRunId) ? entry.followsRunId : null
    if (parent) {
      const list = children.get(parent) ?? []
      list.push(entry)
      children.set(parent, list)
    } else {
      roots.push(entry)
    }
  }
  const label = (entry: HistoryEntry): string | null => {
    if (entry.followsRunId) return entry.startAt ? `follow-up from ${entry.startAt}` : 'follow-up'
    return entry.retryOfRunId ? 'retry' : null
  }
  const threaded: HistoryEntry[] = []
  // Depth is capped so a long chain of follow-ups cannot indent itself off the edge of the popover.
  const walk = (entry: HistoryEntry, depth: number) => {
    threaded.push({ ...entry, depth: Math.min(depth, 3), lineage: label(entry) })
    for (const child of children.get(entry.id) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return threaded
}

export function relativeTime(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  if (ms < 45_000) return 'just now'
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  if (ms < 172_800_000) return 'yesterday'
  return `${Math.round(ms / 86_400_000)}d ago`
}
