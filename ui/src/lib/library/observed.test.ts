import { describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from '../watch/events'
import { outwardCalls } from './observed'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, seconds)).toISOString()
const event = (seq: number, agentId: string, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent =>
  ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })

// ADR 0044: a demo Writer on Claude Code published its brief to the operator's claude.ai account
// twice, with no permission request, and the run's record showed only a row named "Artifact".
describe('an outward tool used without asking', () => {
  const published = (seq: number, callId: string, status: 'completed' | 'failed'): RunEvent[] => [
    event(seq, 'writer', 'tool_call', { callId, name: 'Artifact', title: 'Artifact', toolKind: 'other', status: 'pending', rawInput: { action: 'publish', file_path: 'brief.html' } }),
    event(seq + 1, 'writer', 'tool_update', { callId, status, content: status === 'completed' ? 'Published brief.html at https://claude.ai/artifact/0123' : 'Rate limited' }),
  ]
  const calls = outwardCalls(projectRun([
    ...published(1, 'a1', 'completed'),
    ...published(3, 'a2', 'completed'),
    event(5, 'writer', 'tool_call', { callId: 'd1', name: 'ArtifactData', title: 'ArtifactData', toolKind: 'other', status: 'pending', rawInput: {} }),
    event(6, 'writer', 'tool_update', { callId: 'd1', status: 'failed' }),
    event(7, 'writer', 'tool_call', { callId: 'r1', name: 'Read', title: 'Read brief.md', toolKind: 'read', status: 'pending', rawInput: {}, locations: [{ path: 'brief.md' }] }),
    event(8, 'writer', 'tool_update', { callId: 'r1', status: 'completed' }),
  ]).evidence)

  it('says what the tool did past the run', () => {
    expect(calls.get('Artifact')).toMatchObject({ does: 'publishes to your claude.ai account', completed: true })
    expect(calls.get('Artifact')?.calls).toHaveLength(2)
  })

  it('says nothing for a call that failed, or for a tool that stays on the machine', () => {
    expect([...calls.keys()]).toEqual(['Artifact'])
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
  it('lists each server once, with every call that ran, and whether any finished', () => {
    const calls = outwardCalls(evidence)
    expect([...calls.keys()]).toEqual(['cua_repl', 'agentmemory'])
    expect(calls.get('cua_repl')).toMatchObject({ does: 'controls the browser and apps on your computer', completed: false })
    expect(calls.get('agentmemory')).toMatchObject({ does: null, completed: true })
    expect(calls.get('agentmemory')?.calls.map((item) => item.callId)).toEqual(['m1'])
    expect(outwardCalls(evidence, ['agentmemory', 'cua_repl']).size).toBe(0)
  })
})

// The daemon's record of Claude's web tools running code on Anthropic's computer (the run of
// 2026-10-21): each piece of code is recorded as code it ran, never a search or a command run here,
// however its first line reads.
describe('code a provider ran for its web tools', () => {
  const ran = (seq: number, callId: string, title: string) => [
    event(seq, 'tutor', 'tool_call', { callId, title, toolKind: 'other', status: 'in_progress', rawInput: { code: title.slice(10) } }),
    event(seq + 1, 'tutor', 'tool_update', { callId, status: 'completed' }),
  ]
  const projection = projectRun([
    ...ran(1, 'c1', 'Run code: results = search_all(queries)'),
    ...ran(3, 'c2', 'Run code: import json'),
    event(5, 'tutor', 'tool_call', { callId: 'f1', title: 'Read https://arxiv.org/abs/1706.03762', toolKind: 'fetch', status: 'completed', rawInput: {} }),
  ])

  it('is ran code, not a search or a command', () => {
    const code = projection.evidence.filter((item) => item.name.startsWith('Run code'))
    expect(code.map((item) => [item.kind, item.relation])).toEqual([['tool', 'ran code'], ['tool', 'ran code']])
  })
})
