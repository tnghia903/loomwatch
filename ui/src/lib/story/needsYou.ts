import type { RunRecord } from '../runs/client'
import { plainRunError } from '../runs/errors'
import { permissionSentence, permissionWhat } from '../runs/permissionRequests'

/**
 * The needs-you tray: every moment, across every team, where a team is waiting on the operator.
 *
 * A team stops for four reasons — a review step, a question from an agent, an agent asking
 * permission for something its switches do not allow (ADR 0040), or a failure — and each one becomes
 * one ticket with the shortest honest set of answers. Pure: derived from the run registry, plus the
 * failures the operator already dismissed.
 */
export type TicketKind = 'review' | 'question' | 'permission' | 'failed'

export interface Ticket {
  id: string
  kind: TicketKind
  runId: string
  teamPath: string
  teamName: string
  /** Where the answer goes (the waiting node), for review and question tickets. */
  node: string | null
  /** The helper whose work a review would send back, when the daemon allows sending back. */
  sendBackTo: string | null
  asker: string
  text: string
  /** What the step before handed over, so a review can be judged without opening the run. */
  context: string | null
  since: string
  /** A permission ticket's request, which its answer names. */
  requestId?: string
}

/** Failures older than this are history, not something waiting on you. */
export const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000

export function teamLabel(path: string, names: ReadonlyMap<string, string>): string {
  return names.get(path) ?? path.replace(/\.ya?ml$/, '').split('/').at(-1) ?? path
}

export function ticketsFrom(records: readonly RunRecord[], names: ReadonlyMap<string, string>, dismissed: ReadonlySet<string>, now = Date.now()): Ticket[] {
  const tickets: Ticket[] = []
  for (const record of records) {
    const teamName = teamLabel(record.teamPath, names)
    for (const request of record.permissionRequests ?? []) {
      tickets.push({
        id: `${record.runId}:permission:${request.id}`,
        kind: 'permission',
        runId: record.runId,
        teamPath: record.teamPath,
        teamName,
        node: request.agent,
        sendBackTo: null,
        asker: request.name,
        text: permissionSentence(request),
        context: permissionWhat(request),
        since: request.since,
        requestId: request.id,
      })
    }
    const waiting = record.waitingOn
    if (record.status === 'running' && waiting) {
      tickets.push({
        id: `${record.runId}:${waiting.node}:${waiting.questionId ?? waiting.since}`,
        kind: waiting.kind === 'question' ? 'question' : 'review',
        runId: record.runId,
        teamPath: record.teamPath,
        teamName,
        node: waiting.node,
        sendBackTo: waiting.sendBackAvailable ? waiting.handoverFrom ?? null : null,
        asker: waiting.name,
        text: waiting.question,
        context: waiting.context?.trim() || null,
        since: waiting.since,
      })
    } else if (record.status === 'failed' && !dismissed.has(record.runId)) {
      const finished = Date.parse(record.finishedAt ?? record.createdAt)
      if (Number.isFinite(finished) && now - finished <= FAILED_WINDOW_MS) {
        tickets.push({
          id: `${record.runId}:failed`,
          kind: 'failed',
          runId: record.runId,
          teamPath: record.teamPath,
          teamName,
          node: null,
          sendBackTo: null,
          asker: teamName,
          text: (record.error ? plainRunError(record.error) : '').split('\n')[0] || 'The run stopped before it finished.',
          context: null,
          since: record.finishedAt ?? record.createdAt,
        })
      }
    }
  }
  // Permissions, questions and reviews block a running team, so they come before failures; oldest
  // first within.
  const weight: Record<TicketKind, number> = { permission: 0, question: 0, review: 0, failed: 1 }
  return tickets.sort((a, b) => weight[a.kind] - weight[b.kind] || Date.parse(a.since) - Date.parse(b.since))
}

/** How long ago, in the words a notification uses. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** The approval the daemon is sent when the operator approves without typing (ADR 0022). */
export const APPROVAL_TEXT = 'Approved. Continue as planned.'
