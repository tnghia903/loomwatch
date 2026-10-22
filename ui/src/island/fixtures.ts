// Run records for the island's tests: a team at work, asking, done or stopped.
import type { PermissionRequest, RunRecord, WaitingOn } from '../lib/runs/client'

const T0 = Date.parse('2026-10-22T10:00:00Z')

export const at = (minutes: number) => T0 + minutes * 60_000
export const iso = (minutes: number) => new Date(at(minutes)).toISOString()

export function run(id: string, changes: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: id,
    sessionId: id,
    teamPath: 'trip.yaml',
    teamName: 'Trip planner',
    prompt: 'Plan five days in Kyoto',
    status: 'running',
    mode: 'pipeline',
    entrypoint: 'researcher',
    responder: 'writer',
    agentIds: ['researcher', 'writer'],
    agentNames: { researcher: 'Researcher', writer: 'Writer' },
    createdAt: iso(0),
    startedAt: iso(0),
    finishedAt: null,
    error: null,
    exitCode: null,
    eventCount: null,
    reply: null,
    ...changes,
  }
}

export function permission(id: string, agent = 'writer', changes: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id,
    agent,
    name: agent === 'writer' ? 'Writer' : 'Researcher',
    title: 'Web search',
    kind: 'fetch',
    switch: 'web',
    detail: 'kyoto hotels under 150',
    since: iso(1),
    expiresAt: iso(11),
    ...changes,
  }
}

export function question(node = 'writer', text = 'Which city should the trip start from?'): WaitingOn {
  return { node, name: 'Writer', kind: 'question', since: iso(2), question: text, park: 'none', parkNote: '', sendBackAvailable: false, questionId: 'q1' }
}
