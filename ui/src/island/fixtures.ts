// Run records for the island's tests: a team at work, asking, done or stopped; and a message its
// agents answer in the chat.
import type { NoteAnswering } from '../lib/chat/client'
import type { SavedJob } from '../lib/library/jobs'
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

/** A message the writer is answering in the chat; `said` makes it answered, at `finishedAt`. */
export function answering(id: string, changes: Partial<NoteAnswering> = {}): NoteAnswering {
  return {
    messageId: id,
    teamPath: 'trip.yaml',
    teamName: 'Trip planner',
    agentNames: { writer: 'Writer' },
    answers: { waiting: ['writer'], said: [] },
    createdAt: iso(0),
    finishedAt: null,
    ...changes,
  }
}

export function said(text: string, from = 'writer', minutes = 1) {
  return { from, text, at: iso(minutes) }
}

/** An agent that could not answer a message in the chat, and why. */
export function failed(error: string, from = 'writer', minutes = 1) {
  return { from, error, at: iso(minutes) }
}

/** What a run that stopped for used-up OpenRouter credit says (`agent::AgentError`). */
export const OUT_OF_CREDITS = 'Your OpenRouter account is out of credits. Add credits at openrouter.ai, then try again.'

/** Maya, one of My agents, pinned to the notch in the tests that pin one. */
export const maya: SavedJob = {
  id: 'maya',
  file: '.jobs/maya.yaml',
  name: 'Maya',
  instructions: 'Help me with my day.',
  model: 'anthropic/claude-sonnet-4.5',
  figure: { kind: 'spool', color: 'sage' },
}

/** A run in Maya's own chat. */
export function pinnedChat(id: string, changes: Partial<RunRecord> = {}): RunRecord {
  return run(id, {
    teamPath: '.jobs/.bench/maya.yaml',
    teamName: 'Maya · chat',
    entrypoint: 'maya',
    responder: 'maya',
    agentIds: ['maya'],
    agentNames: { maya: 'Maya' },
    ...changes,
  })
}
