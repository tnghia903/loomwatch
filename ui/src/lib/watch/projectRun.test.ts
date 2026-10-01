import { describe, expect, it } from 'vitest'
import { formatOffset, projectRun, toolDisplayName, type RunEvent } from './events'

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'lead', seconds = seq): RunEvent =>
  ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seconds), kind, payload })

const pipeline: RunEvent[] = [
  event(0, 'process', { phase: 'spawned', pid: 1 }),
  event(1, 'message', { role: 'user', content: { type: 'text', text: 'Compare the two strategies.' } }),
  event(2, 'thought', { role: 'thought', content: { type: 'text', text: 'Let me look.' } }),
  event(3, 'tool_call', { callId: 'c1', title: '$ cargo test', name: 'terminal', toolKind: 'execute', status: 'in_progress', rawInput: { command: 'cargo test' } }),
  event(4, 'tool_update', { callId: 'c1', status: 'completed', rawOutput: { exit_code: 0 } }),
  event(5, 'tool_call', { callId: 'c2', title: 'Read docs/LAUNCH.md', name: 'read_file', toolKind: 'read', status: 'pending', locations: [{ path: 'docs/LAUNCH.md', line: 42 }] }),
  event(6, 'tool_update', { callId: 'c2', status: 'completed' }),
  event(7, 'tool_call', { callId: 'c3', title: 'mcp__notion__search', name: 'mcp__notion__search', toolKind: 'other', status: 'in_progress', rawInput: { query: 'launch brief' } }),
  event(8, 'tool_update', { callId: 'c3', status: 'failed', rawOutput: { error: 'unauthorized' } }),
  event(9, 'message', { role: 'agent', content: { type: 'text', text: 'Lead reply ' } }),
  event(10, 'message', { role: 'agent', content: { type: 'text', text: 'done.' } }),
  event(11, 'turn_end', { stopReason: 'end_turn', usage: { costUsd: 0.25, totalTokens: 1200 } }),
  event(12, 'process', { phase: 'exited', exitCode: 0 }),
  event(13, 'process', { phase: 'spawned', pid: 2 }, 'reviewer'),
  event(14, 'message', { role: 'user', content: { type: 'text', text: 'Compare…\n\n## Results from preceding stages' } }, 'reviewer'),
  event(15, 'message', { role: 'agent', content: { type: 'text', text: 'Review: strategy B.' } }, 'reviewer'),
  event(16, 'turn_end', { stopReason: 'end_turn' }, 'reviewer'),
  event(17, 'process', { phase: 'exited', exitCode: 0 }, 'reviewer'),
]

describe('projectRun', () => {
  it('reads the prompt from the first user message and the reply from the responder', () => {
    const projection = projectRun(pipeline, Infinity, { responder: 'reviewer' })
    expect(projection.prompt).toBe('Compare the two strategies.')
    expect(projection.agents.map((agent) => agent.id)).toEqual(['lead', 'reviewer'])
    expect(projection.agents[0]).toMatchObject({ status: 'succeeded', taskState: 'DONE', reply: 'Lead reply done.', costUsd: 0.25, tokens: 1200, thoughts: 1, toolCalls: 3 })
    expect(projection.agents[1].reply).toBe('Review: strategy B.')
    expect(projection.phase).toBe('succeeded')
  })

  it('classifies evidence by ACP tool kind and keeps owner, order, relation and status', () => {
    const { evidence } = projectRun(pipeline)
    expect(evidence.map((item) => [item.kind, item.relation, item.status, item.agentId, item.order])).toEqual([
      ['command', 'ran command', 'succeeded', 'lead', 1],
      ['file', 'read file', 'succeeded', 'lead', 2],
      ['tool', 'invoked tool', 'failed', 'lead', 3],
    ])
    expect(evidence[0].detail).toBe('cargo test')
    expect(evidence[1].detail).toBe('docs/LAUNCH.md:42')
    expect(evidence[2].name).toBe('notion · search')
    expect(evidence[0].offsetMs).toBe(3000)
  })

  it('derives the live phases and task words from the cut-off point', () => {
    expect(projectRun(pipeline, 0).phase).toBe('starting')
    expect(projectRun(pipeline, 0).agents[0].taskState).toBe('STARTING')
    const thinking = projectRun(pipeline, 2)
    expect(thinking.phase).toBe('running')
    expect(thinking.agents[0].taskState).toBe('THINKING')
    const midCall = projectRun(pipeline, 3)
    expect(midCall.agents[0]).toMatchObject({ taskState: 'RUNNING', task: '$ cargo test' })
    expect(midCall.evidence[0].status).toBe('running')
    const streaming = projectRun(pipeline, 9)
    expect(streaming.agents[0].taskState).toBe('STREAMING')
    expect(streaming.agents[0].reply).toBe('Lead reply ')
    expect(projectRun(pipeline, 12, { responder: 'reviewer' }).phase).toBe('partial')
  })

  it('treats a crash as failed, or partial when the responder already answered', () => {
    const crashed = [...pipeline.slice(0, 12), event(12, 'process', { phase: 'crashed', message: 'boom' })]
    const projection = projectRun(crashed, Infinity, { responder: 'lead' })
    expect(projection.phase).toBe('partial')
    expect(projection.attention.map((alert) => alert.message)).toEqual(['boom'])
    const silent = [event(0, 'process', { phase: 'spawned' }), event(1, 'process', { phase: 'crashed', message: 'boom' })]
    expect(projectRun(silent, Infinity, { responder: 'lead' }).phase).toBe('failed')
    expect(projectRun(crashed, Infinity, { responder: 'lead' }).errorCode).toBeNull()
  })

  it('names a terminal run with no canonical response instead of calling it partial (CONTRACT §4)', () => {
    // The lead finished cleanly and exited; the canonical responder (reviewer) never spoke.
    const noAnswer = pipeline.slice(0, 13)
    const settled = { responder: 'reviewer', status: 'succeeded', evidenceComplete: true } as const
    const projection = projectRun(noAnswer, Infinity, settled)
    expect(projection.phase).toBe('failed')
    expect(projection.errorCode).toBe('missing_canonical_response')
    // The daemon no longer knows the run (restart): the evidence alone decides.
    const replayed = projectRun(noAnswer, Infinity, { responder: 'reviewer', evidenceComplete: true })
    expect(replayed.phase).toBe('failed')
    expect(replayed.errorCode).toBe('missing_canonical_response')
    // A quiet moment before the last archived event arrives is not a finished run: the
    // classification waits, and the pre-parity phase survives unchanged.
    expect(projectRun(noAnswer, Infinity, { responder: 'reviewer', status: 'succeeded' }).phase).toBe('succeeded')
    expect(projectRun(noAnswer, Infinity, { responder: 'reviewer' }).phase).toBe('partial')
    // A cut short of the end is never terminal, evidenceComplete or not.
    expect(projectRun(noAnswer, 12, { responder: 'reviewer', evidenceComplete: true }).phase).toBe('failed')
    expect(projectRun(pipeline, 12, { responder: 'reviewer', evidenceComplete: true }).phase).toBe('partial')
  })

  it('honours the registry status for queued, cancelled and failed runs', () => {
    expect(projectRun([], Infinity, { status: 'queued' }).phase).toBe('queued')
    expect(projectRun(pipeline, Infinity, { status: 'cancelled' }).phase).toBe('cancelled')
    expect(projectRun([event(0, 'process', { phase: 'spawned' })], Infinity, { status: 'failed', error: 'spawn failed' }).phase).toBe('failed')
  })

  it('projects Team Bus delegations as evidence, edges and waiting targets, ignoring harness echoes', () => {
    const events = [
      event(0, 'process', { phase: 'spawned' }),
      event(1, 'tool_call', { callId: 'echo', title: 'MCP dispatch', name: 'mcp__team-bus__dispatch', rawInput: { agent: 'ghost' } }),
      event(2, 'tool_call', { callId: 'bus', title: 'Team Bus: dispatch', name: 'dispatch', rawInput: { agent: 'helper', task: 'Check the docs' } }),
      event(3, 'tool_update', { callId: 'bus', status: 'completed', rawOutput: { accepted: true } }),
    ]
    const projection = projectRun(events)
    expect(projection.evidence).toHaveLength(1)
    expect(projection.evidence[0]).toMatchObject({ kind: 'delegation', relation: 'dispatched', target: 'helper', name: 'dispatch → helper' })
    expect(projection.delegations[0]).toMatchObject({ from: 'lead', to: 'helper', kind: 'dispatch' })
    expect(projection.agents.find((agent) => agent.id === 'helper')).toMatchObject({ status: 'waiting', taskState: 'QUEUED' })
    expect(projection.phase).toBe('running')
  })

  it('publishes per-category coverage levels, not counts (TNG-162 B3/B4/B5)', () => {
    const projection = projectRun(pipeline, Infinity, { responder: 'reviewer' })
    expect(projection.coverage.agents).toMatchObject({ level: 'complete', reason: 'observed', observed: 2 })
    expect(projection.coverage.reasoning).toMatchObject({ level: 'complete', observed: 1 })
    expect(projection.coverage.skills).toMatchObject({ level: 'unavailable', reason: 'none_recorded', observed: 0 })
    expect(projection.coverage.tools).toMatchObject({ level: 'complete', reason: 'observed', observed: 1 })
    expect(projection.coverage.commands).toMatchObject({ level: 'complete', observed: 1 })
    expect(projection.coverage.sources).toMatchObject({ level: 'complete', observed: 1 })

    // Mid-run the same events cannot read complete: the agent has not reached terminal
    // evidence, and an in-flight call is unpaired (c3 is the tool-kind call).
    expect(projectRun(pipeline, 2).coverage.agents).toMatchObject({ level: 'partial', reason: 'agents_awaiting_terminal_evidence' })
    expect(projectRun(pipeline, 7).coverage.tools).toMatchObject({ level: 'partial', reason: 'unpaired_calls' })
  })

  it('reads tools partial when an archived update has no call to pair to (CONTRACT §11)', () => {
    const events = [
      event(0, 'process', { phase: 'spawned', pid: 1 }),
      event(1, 'tool_call', { callId: 'c1', title: 'mcp__notion__search', name: 'mcp__notion__search', toolKind: 'other', status: 'in_progress' }),
      event(2, 'tool_update', { callId: 'c1', status: 'completed' }),
      event(3, 'tool_update', { callId: 'ghost', status: 'completed' }),
    ]
    const projection = projectRun(events)
    expect(projection.coverage.tools).toMatchObject({ level: 'partial', reason: 'unprojectable_events', observed: 1 })
  })

  it('lets a daemon-published level override the derived one (CONTRACT §10 projection_limit)', () => {
    const projection = projectRun(pipeline, Infinity, { responder: 'reviewer', publishedCoverage: { tools: { level: 'partial', reason: 'projection_limit' } } })
    expect(projection.coverage.tools).toMatchObject({ level: 'partial', reason: 'projection_limit' })
    expect(projection.coverage.agents).toMatchObject({ level: 'complete' })
  })

  it('classifies the Claude adapter\'s web search as a search even though it reports kind fetch', () => {
    const events = [
      event(0, 'process', { phase: 'spawned' }),
      event(1, 'tool_call', { callId: 'w1', title: 'Web search', toolKind: 'fetch', status: 'pending' }),
      event(2, 'tool_update', { callId: 'w1', title: 'Search "AI news today"', status: 'completed' }),
    ]
    const { evidence } = projectRun(events)
    expect(evidence[0]).toMatchObject({ kind: 'search', relation: 'searched', status: 'succeeded' })
    expect(evidence[0].name).toBe('Search "AI news today"')
  })

  it('formats helpers', () => {
    expect(toolDisplayName('mcp__github__list_issues', 'mcp__github__list_issues')).toBe('github · list issues')
    expect(toolDisplayName(null, '$ ls')).toBe('$ ls')
    expect(formatOffset(2100)).toBe('02.1s')
    expect(formatOffset(64_000)).toBe('1m 04s')
  })
})
