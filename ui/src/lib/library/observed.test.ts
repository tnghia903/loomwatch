import { describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from '../watch/events'
import { connectedServersByAgent, outwardCalls, usedInRun } from './observed'

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
  // What LoomWatch connected to the writer, as the daemon records it before the prompt (ADR 0029).
  { ...event(49, 'writer', 'session_meta', { phase: 'prompt_sections', sections: [], requiredSkills: [], tools: [{ name: 'Notion', server: 'notion', provider: 'Claude Code', transport: 'stdio' }] }), raw: { source: 'loomwatch', phase: 'prompt_sections' } },
  event(50, 'writer', 'tool_call', { callId: 'n1', name: 'mcp__notion__search', title: 'mcp__notion__search', toolKind: 'other', status: 'in_progress', rawInput: {} }),
  event(51, 'writer', 'tool_call', { callId: 'b1', name: 'Bash', title: '$ ls', toolKind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } }),
  event(52, 'writer', 'permission', { options: [{ kind: 'allow_once', optionId: 'allow-once' }], toolCall: { kind: 'execute', name: 'Bash', title: '$ ls', toolCallId: 'b1' } }),
  event(53, 'writer', 'permission', { outcome: { optionId: 'allow-once', outcome: 'selected' } }),
]

describe('usedInRun', () => {
  const projection = projectRun(run)
  const rows = usedInRun(projection.evidence, connectedServersByAgent(projection.agents))
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

// ADR 0044: a demo Writer on Claude Code published its brief to the operator's claude.ai account
// twice, with no permission request, and the run's record showed only a row named "Artifact".
describe('an outward tool used without asking', () => {
  const published = (seq: number, callId: string, status: 'completed' | 'failed'): RunEvent[] => [
    event(seq, 'writer', 'tool_call', { callId, name: 'Artifact', title: 'Artifact', toolKind: 'other', status: 'pending', rawInput: { action: 'publish', file_path: 'brief.html' } }),
    event(seq + 1, 'writer', 'tool_update', { callId, status, content: status === 'completed' ? 'Published brief.html at https://claude.ai/artifact/0123' : 'Rate limited' }),
  ]
  const rows = usedInRun(projectRun([
    ...published(1, 'a1', 'completed'),
    ...published(3, 'a2', 'completed'),
    event(5, 'writer', 'tool_call', { callId: 'd1', name: 'ArtifactData', title: 'ArtifactData', toolKind: 'other', status: 'pending', rawInput: {} }),
    event(6, 'writer', 'tool_update', { callId: 'd1', status: 'failed' }),
    event(7, 'writer', 'tool_call', { callId: 'r1', name: 'Read', title: 'Read brief.md', toolKind: 'read', status: 'pending', rawInput: {}, locations: [{ path: 'brief.md' }] }),
    event(8, 'writer', 'tool_update', { callId: 'r1', status: 'completed' }),
  ]).evidence)

  it('says what the tool did past the run on its row', () => {
    expect(rows.find((row) => row.name === 'Artifact')).toMatchObject({ origin: 'app', calls: 2, outward: 'publishes to your claude.ai account' })
  })

  it('says nothing for a call that failed, or for a tool that stays on the machine', () => {
    expect(rows.find((row) => row.name === 'ArtifactData')).toMatchObject({ failed: 1, outward: null })
    expect(rows.find((row) => row.name === 'Read files')).toMatchObject({ outward: null })
  })

  it('lists, per tool, only the calls that did not fail', () => {
    const calls = outwardCalls(projectRun([...published(1, 'a1', 'completed'), ...published(3, 'a2', 'failed')]).evidence)
    expect([...calls.keys()]).toEqual(['Artifact'])
    expect(calls.get('Artifact')?.calls.map((item) => item.callId)).toEqual(['a1'])
  })
})

// ADR 0047, run 4bb918c5: a scheduled Gatherer on Codex called the ChatGPT app's `cua_repl`, a
// plugin LoomWatch never connected, to open a browser tab. Codex asked nobody, since the tool calls
// itself read-only. The call failed, and the record listed it as a connected tool.
describe('an MCP server LoomWatch did not connect, used without asking', () => {
  const gatherer = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload']) => event(seq, 'gatherer', kind, payload)
  const mcp = (seq: number, callId: string, server: string, tool: string, status: 'completed' | 'failed'): RunEvent[] => [
    gatherer(seq, 'tool_call', { callId, title: `mcp.${server}.${tool}`, toolKind: 'execute', status: 'in_progress', rawInput: { tool, server, arguments: {} } }),
    gatherer(seq + 1, 'tool_update', { callId, status }),
  ]
  const asked = (seq: number, callId: string): RunEvent[] => [
    gatherer(seq, 'permission', { _meta: { is_mcp_tool_approval: true }, options: [{ kind: 'allow_once', optionId: 'allow_once' }, { kind: 'reject_once', optionId: 'cancel' }], toolCall: { kind: 'execute', toolCallId: callId } }),
    gatherer(seq + 1, 'permission', { outcome: { optionId: 'allow_once', outcome: 'selected' } }),
  ]
  const evidence = projectRun([
    ...mcp(1, 'c1', 'cua_repl', 'js', 'failed'),
    ...mcp(3, 'm1', 'agentmemory', 'memory_recall', 'completed'),
    ...mcp(5, 'r1', 'loomwatch-team-bus', 'roster', 'completed'),
    ...mcp(7, 's1', 'agentmemory', 'memory_save', 'completed'),
    ...asked(9, 's1'),
  ]).evidence
  const rowOf = (rows: ReturnType<typeof usedInRun>, name: string) => rows.find((candidate) => candidate.name === name)

  it('says what the server does past the run, even when the call failed, and that it came with the app', () => {
    const rows = usedInRun(evidence)
    expect(rowOf(rows, 'cua_repl · js')).toMatchObject({ origin: 'app', failed: 1, outward: 'controls the browser and apps on your computer' })
    expect(rowOf(rows, 'agentmemory · memory recall')).toMatchObject({ origin: 'app', outward: 'came with the app, not from LoomWatch' })
    expect(rowOf(rows, 'Team Bus · roster')).toMatchObject({ origin: 'team', outward: null })
  })

  it('says nothing for a call its app asked about first, or for a server LoomWatch connected', () => {
    expect(rowOf(usedInRun(evidence), 'agentmemory · memory save')).toMatchObject({ origin: 'app', outward: null })
    expect(rowOf(usedInRun(evidence, new Map([['gatherer', ['agentmemory']]])), 'agentmemory · memory recall')).toMatchObject({ origin: 'connected', outward: null })
  })

  it('lists each server once, with every call that ran, and whether any finished', () => {
    const calls = outwardCalls(evidence)
    expect([...calls.keys()]).toEqual(['cua_repl', 'agentmemory'])
    expect(calls.get('cua_repl')).toMatchObject({ does: 'controls the browser and apps on your computer', completed: false })
    expect(calls.get('agentmemory')).toMatchObject({ does: null, completed: true })
    expect(calls.get('agentmemory')?.calls.map((item) => item.callId)).toEqual(['m1'])
    expect(outwardCalls(evidence, ['agentmemory', 'cua_repl']).size).toBe(0)
  })
})
