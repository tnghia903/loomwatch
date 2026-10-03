import { describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from '../watch/events'
import { buildReceipt } from './receipt'
import { findingsOf } from './verdict'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent =>
  ({ id: `event-${seq}`, sessionId: 'run-1', agentId: 'writer', seq, ts: at(seq), kind, payload })

/** One Claude Code `Artifact` call and how it ended, as the archive records it. */
const artifact = (seq: number, callId: string, status: 'completed' | 'failed'): RunEvent[] => [
  event(seq, 'tool_call', { callId, name: 'Artifact', title: 'Artifact', toolKind: 'other', status: 'pending', rawInput: { action: 'publish', file_path: 'brief.html' } }),
  event(seq + 1, 'tool_update', { callId, status, content: status === 'completed' ? 'Published brief.html at https://claude.ai/artifact/0123' : 'Rate limited' }),
]

function receiptFor(events: RunEvent[]) {
  const projection = projectRun([event(0, 'process', { phase: 'spawned', pid: 7 }), ...events, event(98, 'turn_end', { stopReason: 'end_turn' }), event(99, 'process', { phase: 'exited', exitCode: 0 })])
  return buildReceipt({
    attempt: 1,
    prompt: 'Write the brief for the leadership team.',
    phase: 'succeeded',
    elapsed: '1m',
    agents: [{ id: 'writer', name: 'Writer', operator: false, runtime: { status: 'succeeded' } }],
    projection,
    evidenceByAgent: new Map([['writer', projection.evidence.filter((item) => item.agentId === 'writer')]]),
    harnessLabels: new Map([['writer', 'Claude Code']]),
    answered: true,
  })
}

// ADR 0044: a Writer on Claude Code published its brief to the operator's claude.ai account twice
// with no permission request, and the receipt said only "Writer finished".
describe('a tool that reaches past the run', () => {
  it('is a finding when it ran without asking, once per tool, pointing at its first call', () => {
    const receipt = receiptFor([...artifact(1, 'a1', 'completed'), ...artifact(3, 'a2', 'completed')])
    const line = receipt.checks.find((check) => check.text.includes('Artifact'))
    expect(line).toEqual({ tone: 'bad', text: 'Writer used Artifact, which publishes to your claude.ai account, without asking you (2 times)', agentId: 'writer', evidenceId: 'writer:a1' })
    expect(findingsOf(receipt)).toContain(line)
  })

  // The answer's badge counts these findings, so this is what turns "Nothing flagged" into
  // "1 thing to check" and leads its detail.
  it('is the only finding of an otherwise clean run', () => {
    expect(findingsOf(receiptFor(artifact(1, 'a1', 'completed'))).map((line) => line.text))
      .toEqual(['Writer used Artifact, which publishes to your claude.ai account, without asking you'])
  })

  it('is not a finding when the call failed, since nothing left the run', () => {
    expect(receiptFor(artifact(1, 'a1', 'failed')).checks.some((check) => check.text.includes('without asking you'))).toBe(false)
  })
})
