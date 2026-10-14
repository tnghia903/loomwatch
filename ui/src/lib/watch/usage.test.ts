import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from './events'
import { formatTokens, summarizeUsage, turnUsage, type TurnUsage } from './usage'

/**
 * Two real runs, archived 2026-10-03 and trimmed to what the derivation reads: every prompt, reply,
 * tool title and input is blanked, and each stretch of an agent's output is one marker. The
 * numbers are untouched.
 *
 * - `usage-digest-run.json`: a daily tech digest. Gatherer on codex-acp 2.1.1 (a turn its app cut at
 *   a declined command and LoomWatch carried on), Reader and Writer on claude-agent-acp 0.85.1.
 * - `usage-ask-run.json`: a lesson. Mapper and Teacher on Claude, Checker on Codex, and Checker asks
 *   the kept-alive Teacher a question over the Team Bus.
 *
 * The expected Codex totals are not this code's output: they are what Codex logged itself for the
 * same sessions (`~/.codex/sessions/…/rollout-*.jsonl`, the last `token_count.total_token_usage`).
 */
const fixture = (name: string): RunEvent[] =>
  JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')) as RunEvent[]
const digest = fixture('usage-digest-run.json')
const lesson = fixture('usage-ask-run.json')

const of = (turns: TurnUsage[], agentId: string) => turns.filter((turn) => turn.agentId === agentId)
const sum = (turns: TurnUsage[]) => turns.reduce((total, turn) => total + turn.total, 0)

describe('Codex: every model call, not only the last', () => {
  it('adds up each call, matching what Codex logged for the session to the token', () => {
    const gatherer = of(turnUsage(digest), 'gatherer')
    // What the archive's own `turn_end` usage adds up to: the last call of each turn only.
    expect(101_804 + 173_320 + 174_767 + 175_030).toBe(624_921)
    expect(sum(gatherer)).toBe(2_245_301)
    expect(sum(of(turnUsage(lesson), 'checker'))).toBe(464_308)
  })

  it('keeps one turn whole across the cut its app made, and marks only the added-up turns estimated', () => {
    const gatherer = of(turnUsage(digest), 'gatherer')
    expect(gatherer.map(({ purpose, total, estimated, stopReason }) => ({ purpose, total, estimated, stopReason }))).toEqual([
      // 19 calls: 10 before the declined command, 9 after LoomWatch asked it to carry on.
      { purpose: 'work', total: 1_895_504, estimated: true, stopReason: 'end_turn' },
      // One call each: the app's report is the whole turn.
      { purpose: 'handover', total: 174_767, estimated: false, stopReason: 'end_turn' },
      { purpose: 'checkpoint', total: 175_030, estimated: false, stopReason: 'end_turn' },
    ])
  })

  it('takes the last call’s split as reported and estimates the earlier calls’ cache reads closely', () => {
    const [work, handover] = of(turnUsage(digest), 'gatherer')
    expect(handover).toMatchObject({ input: 1704, cacheRead: 171_776, output: 1287, cacheWrite: 0 })
    expect(work.input + work.cacheRead + work.cacheWrite + work.output).toBe(work.total)
    // Codex logged 2,073,344 cached tokens for the session; its turns as reported hold all but the
    // earlier calls' share, which is read from how the context grew.
    const cached = of(turnUsage(digest), 'gatherer').reduce((total, turn) => total + turn.cacheRead, 0)
    expect(Math.abs(cached - 2_073_344) / 2_073_344).toBeLessThan(0.01)
  })

  it('trusts the app once it reports more than its readings add up to', () => {
    const events: RunEvent[] = [
      row(0, 'session_meta', { phase: 'initialize', result: { agentInfo: { name: '@agentclientprotocol/codex-acp' } } }),
      row(1, 'message', { role: 'user', content: { type: 'text', text: 'Go' } }),
      row(2, 'usage', { used: 1000 }),
      row(3, 'usage', { used: 1500 }),
      row(4, 'turn_end', { stopReason: 'end_turn', usage: { totalTokens: 2600, inputTokens: 100, cachedReadTokens: 2400, outputTokens: 100 } }),
    ]
    expect(turnUsage(events)).toEqual([expect.objectContaining({ total: 2600, cacheRead: 2400, estimated: false })])
  })
})

describe('Claude: every model the turn ran, and its cost as a difference', () => {
  it('counts Haiku side calls from the per-model rows its usage leaves out', () => {
    const reader = of(turnUsage(digest), 'reader')
    // The work turn's `usage` is Sonnet's 172,862; its rows add Haiku's 50,841.
    expect(reader.map(({ purpose, total, estimated }) => ({ purpose, total, estimated }))).toEqual([
      { purpose: 'work', total: 172_862 + 50_841, estimated: false },
      { purpose: 'handover', total: 44_268, estimated: false },
      { purpose: 'checkpoint', total: 45_190, estimated: false },
    ])
    expect(reader[0]).toMatchObject({ input: 10 + 48_035, cacheRead: 137_549, cacheWrite: 29_704, output: 5599 + 2806 })
  })

  it('prices each turn by what it added to the session’s running cost', () => {
    const reader = of(turnUsage(digest), 'reader')
    // The running readings after each turn: 0.2644008, 0.3150198, 0.3431576.
    expect(reader[0].costUsd).toBeCloseTo(0.2644008, 9)
    expect(reader[1].costUsd).toBeCloseTo(0.3150198 - 0.2644008, 9)
    expect(reader[2].costUsd).toBeCloseTo(0.3431576 - 0.3150198, 9)
    const summary = summarizeUsage(turnUsage(digest))
    expect(summary.agents.find((agent) => agent.agentId === 'reader')?.costUsd).toBeCloseTo(0.3431576, 9)
    // Codex prices nothing, so the run as a whole has no honest price.
    expect(summary.agents.find((agent) => agent.agentId === 'gatherer')?.costUsd).toBeUndefined()
    expect(summary.costUsd).toBeUndefined()
  })

  it('treats a running total that fell back as restarted, and a reloaded session’s first turn as unpriced', () => {
    const claude = row(0, 'session_meta', { phase: 'initialize', result: { agentInfo: { name: '@agentclientprotocol/claude-agent-acp' } } })
    const turn = (seq: number, cost: number): RunEvent[] => [
      row(seq, 'message', { role: 'user', content: { type: 'text', text: 'Go' } }),
      row(seq + 1, 'usage', { used: 100 + seq, cost: { amount: cost, currency: 'USD' } }),
      row(seq + 2, 'turn_end', { stopReason: 'end_turn', usage: { totalTokens: 100 } }),
    ]
    const restarted = turnUsage([claude, ...turn(1, 0.5), row(4, 'process', { phase: 'spawned' }), ...turn(5, 0.2)])
    expect(restarted.map((usage) => usage.costUsd)).toEqual([0.5, 0.2])
    const reloaded = turnUsage([claude, ...turn(1, 0.5), row(4, 'session_meta', { phase: 'session_loaded' }), row(5, 'usage', { used: 9, cost: { amount: 0.4 } }), row(6, 'session_meta', { phase: 'session_replayed' }), ...turn(7, 0.9), ...turn(10, 1.0)])
    expect(reloaded.map((usage) => usage.costUsd)).toEqual([0.5, undefined, expect.closeTo(0.1, 9)])
  })
})

describe('a turn the run stopped before it ended', () => {
  it('counts the Claude calls its readings saw, each once, though each call reads twice', () => {
    // Cut where the work turn's last call had ended but its response never came.
    const reader = of(turnUsage(digest, 4084), 'reader')
    expect(reader).toEqual([expect.objectContaining({ purpose: 'work', stopReason: null, estimated: true, total: 172_862 })])
    // The estimate's split still adds up, and none of it is invented as fresh input.
    expect(reader[0].input + reader[0].cacheRead + reader[0].cacheWrite + reader[0].output).toBe(172_862)
    expect(reader[0].output).toBeGreaterThan(0)
  })

  it('counts the Codex calls it saw: seven calls, matching Codex’s running total after the seventh', () => {
    const gatherer = of(turnUsage(digest, 182), 'gatherer')
    expect(gatherer).toEqual([expect.objectContaining({ stopReason: null, estimated: true, total: 351_505 })])
  })

  it('is reported as stopped in the summary', () => {
    expect(summarizeUsage(turnUsage(digest, 4084)).stoppedTurns).toBe(1)
  })
})

describe('why each turn happened', () => {
  it('reads handovers and checkpoints from LoomWatch’s own note, and a teammate’s question from the ask it answers', () => {
    const teacher = of(turnUsage(lesson), 'teacher')
    expect(teacher.map(({ purpose, total }) => ({ purpose, total }))).toEqual([
      { purpose: 'work', total: 69_323 },
      { purpose: 'handover', total: 38_985 },
      { purpose: 'checkpoint', total: 39_465 },
      // Checker's Team Bus `ask`, answered from Teacher's kept-alive session.
      { purpose: 'ask', total: 44_030 },
    ])
  })

  it('reads a turn that follows your note to the agent as yours, and only that turn', () => {
    const events: RunEvent[] = [
      row(0, 'message', { role: 'user', content: { type: 'text', text: 'Write it' } }, 'writer'),
      row(1, 'turn_end', { stopReason: 'cancelled', usage: { totalTokens: 50 } }, 'writer'),
      row(2, 'message', { role: 'user', content: { type: 'text', text: 'Shorter, please' } }, 'operator', { source: 'loomwatch', phase: 'operator_answer', to: 'writer' }),
      row(3, 'message', { role: 'user', content: { type: 'text', text: '## A note from you…' } }, 'writer'),
      row(4, 'turn_end', { stopReason: 'end_turn', usage: { totalTokens: 70 } }, 'writer'),
      row(5, 'message', { role: 'user', content: { type: 'text', text: 'Again' } }, 'writer'),
      row(6, 'turn_end', { stopReason: 'end_turn', usage: { totalTokens: 90 } }, 'writer'),
    ]
    expect(turnUsage(events).map((turn) => [turn.agentId, turn.purpose, turn.total])).toEqual([['writer', 'work', 50], ['writer', 'note', 70], ['writer', 'work', 90]])
  })

  it('sums the run by agent and by purpose, in a fixed order, with its cache share', () => {
    const summary = summarizeUsage(turnUsage(lesson))
    expect(summary.agents.map((agent) => agent.agentId)).toEqual(['mapper', 'teacher', 'checker'])
    expect(summary.purposes.map((purpose) => purpose.purpose)).toEqual(['work', 'handover', 'checkpoint', 'ask'])
    expect(summary.purposes.reduce((total, purpose) => total + purpose.total, 0)).toBe(summary.total)
    expect(summary.cacheShare).toBeGreaterThan(0.5)
    expect(summary.cacheShare).toBeLessThan(1)
    expect(summary.estimatedApps).toEqual(['codex'])
  })
})

describe('the projection', () => {
  it('gives each agent its counted tokens', () => {
    const agents = projectRun(digest).agents
    expect(agents.find((agent) => agent.id === 'gatherer')?.tokens).toBe(2_245_301)
  })

  it('holds the run’s tokens back until every page of its evidence is in', () => {
    expect(projectRun(digest, Infinity, { status: 'succeeded' }).tokens).toBeNull()
    expect(projectRun(digest, 3000, { status: 'succeeded', evidenceComplete: true }).tokens).toBeNull()
    expect(projectRun(digest, Infinity, { status: 'succeeded', evidenceComplete: true }).tokens?.total).toBe(2_245_301 + 313_161 + 70_499)
  })
})

it('writes counts in three figures', () => {
  expect([950, 9512, 44_268, 172_862, 999_600, 2_245_301].map(formatTokens)).toEqual(['950', '9.51k', '44.3k', '173k', '1M', '2.25M'])
})

function row(seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'agent', raw?: unknown): RunEvent {
  return { id: `e${seq}`, sessionId: 's', agentId, seq, ts: '2026-10-12T00:00:00Z', kind, payload, ...(raw === undefined ? {} : { raw }) }
}
