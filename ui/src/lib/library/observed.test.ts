import { describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from '../watch/events'
import { usedInRun } from './observed'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, seconds)).toISOString()
const event = (seq: number, agentId: string, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent =>
  ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })

/** A Claude web search LoomWatch refused: the call, its permission request and the answer. */
function refusedSearch(seq: number, callId: string, query: string): RunEvent[] {
  return [
    event(seq, 'researcher', 'tool_call', { callId, name: 'WebSearch', title: 'Web search', toolKind: 'fetch', status: 'pending', rawInput: {} }),
    event(seq + 1, 'researcher', 'permission', {
      options: [{ kind: 'allow_once', optionId: 'allow-once' }, { kind: 'reject_once', optionId: 'reject' }],
      toolCall: { kind: 'fetch', name: 'WebSearch', title: `Search "${query}"`, toolCallId: callId },
    }),
    event(seq + 2, 'researcher', 'permission', { outcome: { optionId: 'reject', outcome: 'selected' } }),
    event(seq + 3, 'researcher', 'tool_update', { callId, status: 'failed', rawOutput: 'User refused permission to run tool' }),
  ]
}

// The shape of the research team's run on 2026-10-03: a Claude researcher whose five searches were
// refused (it had no "Search the web" switch), and a Codex fact-checker whose own searches ran.
const run: RunEvent[] = [
  event(1, 'researcher', 'tool_call', { callId: 'ts', name: 'ToolSearch', title: 'ToolSearch', toolKind: 'other', status: 'pending', rawInput: {} }),
  event(2, 'researcher', 'tool_update', { callId: 'ts', status: 'completed' }),
  ...refusedSearch(10, 's1', 'Model Cards for Model Reporting'),
  ...refusedSearch(20, 's2', 'Datasheets for Datasets'),
  event(30, 'critic', 'tool_call', { callId: 'w1', title: 'Web search', toolKind: 'search', status: 'in_progress', rawInput: { type: 'webSearch' } }),
  event(31, 'critic', 'tool_update', { callId: 'w1', status: 'completed' }),
  event(32, 'critic', 'tool_call', { callId: 'w2', title: 'Web search', toolKind: 'search', status: 'in_progress', rawInput: { type: 'webSearch' } }),
  event(33, 'critic', 'tool_update', { callId: 'w2', status: 'completed' }),
  event(40, 'critic', 'tool_call', { callId: 'r1', title: 'mcp.loomwatch-team-bus.roster', toolKind: 'execute', status: 'in_progress', rawInput: {} }),
  event(41, 'critic', 'permission', { options: [{ kind: 'allow_once', optionId: 'allow_once' }, { kind: 'reject_once', optionId: 'cancel' }], toolCall: { kind: 'execute', toolCallId: 'r1' } }),
  event(42, 'critic', 'permission', { outcome: { optionId: 'cancel', outcome: 'selected' } }),
  event(50, 'writer', 'tool_call', { callId: 'n1', name: 'mcp__notion__search', title: 'mcp__notion__search', toolKind: 'other', status: 'in_progress', rawInput: {} }),
  event(51, 'writer', 'tool_call', { callId: 'b1', name: 'Bash', title: '$ ls', toolKind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } }),
  event(52, 'writer', 'permission', { options: [{ kind: 'allow_once', optionId: 'allow-once' }], toolCall: { kind: 'execute', name: 'Bash', title: '$ ls', toolCallId: 'b1' } }),
  event(53, 'writer', 'permission', { outcome: { optionId: 'allow-once', outcome: 'selected' } }),
]

describe('usedInRun', () => {
  const rows = usedInRun(projectRun(run).evidence)
  const row = (name: string) => rows.find((candidate) => candidate.name === name)

  it('lists a tool once however many times it was called, never one row per call or per permission answer', () => {
    expect(rows.map((candidate) => candidate.name)).toEqual(['Tool search', 'Web search', 'Team Bus · roster', 'notion · search', 'Commands'])
    expect(rows.some((candidate) => /^Search "/.test(candidate.name))).toBe(false)
  })

  it('merges one app tool across apps that name it differently', () => {
    // Claude records `WebSearch`; Codex records no name, only the kind `search` and a title.
    expect(row('Web search')).toMatchObject({ origin: 'app', allow: 'web', calls: 4, agents: [{ id: 'researcher', calls: 2 }, { id: 'critic', calls: 2 }] })
  })

  it('counts a refusal against the agent that was refused, and only refusals', () => {
    expect(row('Web search')).toMatchObject({ refused: 2, refusedBy: ['researcher'] })
    expect(row('Commands')).toMatchObject({ allow: 'commands', calls: 1, refused: 0 })
  })

  it('says where a tool comes from: the app, a connected server, or LoomWatch itself', () => {
    expect(row('Tool search')).toMatchObject({ origin: 'app', allow: null })
    expect(row('notion · search')).toMatchObject({ origin: 'connected', allow: null })
    expect(row('Team Bus · roster')).toMatchObject({ origin: 'team', refused: 1, refusedBy: ['critic'] })
  })

  it('reveals the first recorded card for a row', () => {
    expect(row('Web search')?.evidenceId).toBe('researcher:s1')
  })
})
