import { describe, expect, it } from 'vitest'

import { projectRun, recordedReplyText, type RunEvent } from '../watch/events'
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

// ADR 0046, run f806a330: a scheduled Gatherer on Codex asked to `curl` a feed. Nobody could be
// asked, so LoomWatch chose Codex's only rejection, `cancel`, and Codex ended the work turn. The
// receipt said "Turn ended: cancelled" and nothing about what was declined.
describe('a request an app declined by its own option', () => {
  const gather = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], raw?: unknown): RunEvent =>
    ({ id: `gather-${seq}`, sessionId: 'run-2', agentId: 'gatherer', seq, ts: at(seq), kind, payload, ...(raw ? { raw } : {}) })
  const asked = [
    gather(0, 'process', { phase: 'spawned', pid: 7 }),
    gather(1, 'message', { role: 'agent', content: { type: 'text', text: 'Checking the GitHub changelog feed.' }, messageId: 'm1', phase: 'commentary' }),
    gather(2, 'permission', {
      options: [
        { kind: 'allow_once', name: 'Yes, proceed', optionId: 'allow_once' },
        { kind: 'allow_always', name: 'Yes, and don’t ask again for commands that start with `curl -sS`', optionId: 'accept_execpolicy_amendment' },
        { kind: 'reject_once', name: 'No, and tell Codex what to do differently', optionId: 'cancel' },
      ],
      toolCall: { kind: 'execute', rawInput: { command: 'curl -sS https://github.blog/changelog/feed/' }, status: 'pending', title: 'Run command', toolCallId: 'exec-b8f052d4' },
    }),
    gather(3, 'permission', { outcome: { optionId: 'cancel', outcome: 'selected' } }),
  ]
  const answer = '- GitHub: Copilot code review is generally available'
  const carriedOn = [
    gather(4, 'session_meta', {
      phase: 'turn_resumed', stopReason: 'cancelled', usage: { totalTokens: 115060 },
      declined: [{ title: 'Run command', kind: 'execute', detail: 'curl -sS https://github.blog/changelog/feed/', outcome: 'not_asked' }],
    }, { source: 'loomwatch', phase: 'turn_resumed', response: { jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } } }),
    gather(5, 'message', { role: 'user', messageId: null, content: { type: 'text', text: 'Your request was declined: …' } }),
    gather(6, 'message', { role: 'agent', content: { type: 'text', text: answer }, messageId: 'm2', phase: 'final_answer' }),
    gather(7, 'turn_end', { stopReason: 'end_turn', usage: { totalTokens: 1200 } }),
  ]
  const exited = gather(99, 'process', { phase: 'exited', exitCode: 0 })
  const receiptOf = (events: RunEvent[]) => {
    const projection = projectRun(events)
    return buildReceipt({
      attempt: 1,
      prompt: 'Today’s tech news digest',
      phase: 'succeeded',
      elapsed: '5m',
      agents: [{ id: 'gatherer', name: 'Gatherer', operator: false, runtime: { status: 'succeeded' }, allow: { web: true } }],
      projection,
      evidenceByAgent: new Map([['gatherer', projection.evidence.filter((item) => item.agentId === 'gatherer')]]),
      harnessLabels: new Map([['gatherer', 'Codex']]),
      answered: true,
    })
  }

  it('is a refusal, though LoomWatch declined it by selecting one of the app’s options', () => {
    const projection = projectRun([...asked, gather(4, 'turn_end', { stopReason: 'cancelled' }), exited])
    expect(projection.evidence.find((item) => item.kind === 'permission')).toMatchObject({ status: 'rejected', detail: 'declined (No, and tell Codex what to do differently)' })
    expect(receiptOf([...asked, gather(4, 'turn_end', { stopReason: 'cancelled' }), exited]).lines)
      .toContainEqual(expect.objectContaining({ text: 'Gatherer wasn’t allowed to run commands, and carried on without it', allow: 'commands', allowed: false }))
  })

  it('still reads an allowed request as allowed', () => {
    const allowed = [...asked.slice(0, 3), gather(3, 'permission', { outcome: { optionId: 'allow_once', outcome: 'selected' } })]
    expect(projectRun(allowed).evidence.find((item) => item.kind === 'permission')).toMatchObject({ status: 'succeeded', detail: 'answered allow_once' })
  })

  it('reads one turn once Codex is asked to carry on: its answer, its whole cost, and why', () => {
    const events = [...asked, ...carriedOn, exited]
    const gatherer = projectRun(events).agents[0]
    expect(gatherer.reply).toBe(answer)
    expect(recordedReplyText(events, 'gatherer', answer)).toBe(answer)
    expect(gatherer.tokens).toBe(116260)
    expect(gatherer.resumedTurns).toBe(1)
    expect(gatherer.turns).toBe(1)

    const receipt = receiptOf(events)
    expect(receipt.checks.map((line) => line.text)).not.toContain('Turn ended: cancelled')
    const aside = receipt.checks.find((line) => line.text.startsWith('Codex ends'))
    expect(aside).toEqual({ tone: 'warn', text: 'Codex ends Gatherer’s turn when a request is declined, so LoomWatch asked Gatherer to carry on without it', agentId: 'gatherer', aside: true })
    expect(findingsOf(receipt)).not.toContain(aside)
    expect(findingsOf(receipt).map((line) => line.text)).toEqual(['Gatherer wasn’t allowed to run commands, and carried on without it'])
  })
})
