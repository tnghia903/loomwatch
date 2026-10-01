import type { RunRecord } from '../runs/client'
import { ago } from './needsYou'

/**
 * A team's recent runs as a strip of woven cloth on its Home card.
 *
 * One thread per run, oldest on the left: gold finished, red failed, slate stopped, blue working,
 * a gold ring when it is waiting on you. A newcomer reads "mostly gold, one red" as the team's
 * health at a glance; an expert reads the rhythm of a schedule and where it broke.
 */
export type ThreadState = 'done' | 'failed' | 'stopped' | 'working' | 'waiting'

export interface FabricThread {
  runId: string
  state: ThreadState
  label: string
}

export interface Fabric {
  threads: FabricThread[]
  /** "Last run 2 h ago · finished", or null when the team never ran. */
  caption: string | null
  /** For screen readers: what the strip shows, counted. */
  summary: string
  waiting: boolean
}

const WORDS: Record<ThreadState, string> = { done: 'finished', failed: 'failed', stopped: 'stopped', working: 'working', waiting: 'waiting for you' }

export function threadState(record: Pick<RunRecord, 'status' | 'waitingOn'>): ThreadState {
  if (record.waitingOn && record.status === 'running') return 'waiting'
  switch (record.status) {
    case 'succeeded': return 'done'
    case 'failed': return 'failed'
    case 'cancelled': return 'stopped'
    default: return 'working'
  }
}

function took(record: RunRecord): string {
  const start = Date.parse(record.startedAt ?? record.createdAt)
  const end = Date.parse(record.finishedAt ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ''
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? ` · ${seconds}s` : ` · ${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function fabricFor(records: readonly RunRecord[], teamPath: string, limit = 14, now = Date.now()): Fabric {
  const mine = records.filter((record) => record.teamPath === teamPath).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const recent = mine.slice(-limit)
  const threads = recent.map((record) => {
    const state = threadState(record)
    const when = new Date(record.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    return { runId: record.runId, state, label: `${when} · ${WORDS[state]}${took(record)}${record.trigger === 'schedule' ? ' · on schedule' : ''}` }
  })
  const last = mine.at(-1)
  const counts = threads.reduce<Partial<Record<ThreadState, number>>>((acc, thread) => ({ ...acc, [thread.state]: (acc[thread.state] ?? 0) + 1 }), {})
  const summary = threads.length === 0
    ? 'No runs yet'
    : `Last ${threads.length} run${threads.length === 1 ? '' : 's'}: ${(Object.entries(counts) as [ThreadState, number][]).map(([state, count]) => `${count} ${WORDS[state]}`).join(', ')}`
  return {
    threads,
    caption: last ? `Last run ${ago(last.finishedAt ?? last.createdAt, now)} · ${WORDS[threadState(last)]}` : null,
    summary,
    waiting: threads.some((thread) => thread.state === 'waiting'),
  }
}
