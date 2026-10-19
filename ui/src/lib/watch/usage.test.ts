import { describe, expect, it } from 'vitest'

import { projectRun, type RunEvent } from './events'
import { costWords, formatCost, formatTokens, summarizeUsage, turnUsage, type TurnUsage } from './usage'

/**
 * Runs as LoomWatch's engine records them (crates/loomwatch-backend/src/engine/mod.rs): a prompt,
 * one `usage` reading per model call with the session's running cost, and a `turn_end` whose
 * payload has the turn's tokens and whose result has its cost.
 */
let seq = 0
const at = () => seq++
function row(kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'agent', raw?: unknown): RunEvent {
  const n = at()
  return { id: `e${n}`, sessionId: 's', agentId, seq: n, ts: '2026-10-17T00:00:00Z', kind, payload, ...(raw === undefined ? {} : { raw }) }
}
const prompt = (text: string, agentId = 'agent') => row('message', { role: 'user', content: { type: 'text', text } }, agentId)
const reading = (used: number, cost: number, agentId = 'agent') => row('usage', { used, cost: { amount: cost, currency: 'USD' } }, agentId)
function ended(usage: Record<string, number>, costUsd: number | null, agentId = 'agent', stopReason = 'end_turn'): RunEvent {
  const totalTokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0) + (usage.outputTokens ?? 0)
  const full = { ...usage, totalTokens }
  const result = { stopReason, usage: full, ...(costUsd === null ? {} : { _meta: { loomwatch: { costUsd, reasoningTokens: 0 } } }) }
  return row('turn_end', { stopReason, usage: full }, agentId, { jsonrpc: '2.0', result })
}

const of = (turns: TurnUsage[], agentId: string) => turns.filter((turn) => turn.agentId === agentId)

describe('a turn the engine reported whole', () => {
  it('takes its tokens and its split as reported, and its cost from the result', () => {
    seq = 0
    const turns = turnUsage([
      prompt('Go'),
      reading(1_200, 0.002),
      reading(1_900, 0.0035),
      ended({ inputTokens: 300, cachedReadTokens: 2_600, outputTokens: 200 }, 0.0035),
    ])
    expect(turns).toEqual([expect.objectContaining({ input: 300, cacheRead: 2_600, cacheWrite: 0, output: 200, total: 3_100, estimated: false, stopReason: 'end_turn', costUsd: 0.0035 })])
  })

  it('prices each turn by its own report, so a resumed session keeps every turn’s cost', () => {
    seq = 0
    const turns = turnUsage([
      prompt('First'),
      reading(1_000, 0.01),
      ended({ inputTokens: 900, outputTokens: 100 }, 0.01),
      // Parked between turns, then resumed: the running cost is not known from here.
      row('session_meta', { phase: 'session_loaded' }),
      row('session_meta', { phase: 'session_replayed', frames: 0 }),
      prompt('Second'),
      reading(2_000, 0.03),
      ended({ inputTokens: 100, cachedReadTokens: 1_800, outputTokens: 100 }, 0.02),
    ])
    expect(turns.map((turn) => turn.costUsd)).toEqual([0.01, 0.02])
    expect(summarizeUsage(turns)).toMatchObject({ costUsd: 0.03, costComplete: true })
  })

  it('counts nothing for the Demo’s turns, which call no model', () => {
    seq = 0
    expect(turnUsage([prompt('Go'), ended({ totalTokens: 0 }, 0)])[0]).toMatchObject({ total: 0, estimated: false })
  })
})

describe('a turn the run stopped before it ended', () => {
  it('counts the model calls its readings saw, without a split, and marks itself estimated', () => {
    seq = 0
    const turns = turnUsage([prompt('Go'), reading(1_000, 0.004), reading(1_500, 0.009)])
    expect(turns).toEqual([expect.objectContaining({ total: 2_500, input: 2_500, stopReason: null, estimated: true })])
    expect(turns[0].costUsd).toBeCloseTo(0.009, 9)
    expect(summarizeUsage(turns).stoppedTurns).toBe(1)
  })

  it('has no cost after a resume, and the run says its cost is at least what is known', () => {
    seq = 0
    const turns = turnUsage([
      prompt('First'),
      reading(1_000, 0.01),
      ended({ inputTokens: 1_000 }, 0.01),
      row('session_meta', { phase: 'session_loaded' }),
      row('session_meta', { phase: 'session_replayed', frames: 0 }),
      prompt('Second'),
      reading(1_200, 0.025),
    ])
    expect(turns.map((turn) => turn.costUsd)).toEqual([0.01, undefined])
    expect(summarizeUsage(turns)).toMatchObject({ costUsd: 0.01, costComplete: false })
  })
})

describe('why each turn happened', () => {
  it('reads handovers and checkpoints from LoomWatch’s own note', () => {
    seq = 0
    const turns = turnUsage([
      prompt('Work'),
      ended({ inputTokens: 100 }, 0.001),
      row('session_meta', { phase: 'turn_purpose', purpose: 'handover' }),
      prompt('Hand it over'),
      ended({ inputTokens: 40 }, 0.0004),
      row('session_meta', { phase: 'turn_purpose', purpose: 'checkpoint' }),
      prompt('Checkpoint'),
      ended({ inputTokens: 30 }, 0.0003),
      row('session_meta', { phase: 'turn_purpose', purpose: 'work' }),
    ])
    expect(turns.map((turn) => turn.purpose)).toEqual(['work', 'handover', 'checkpoint'])
  })

  it('reads a teammate’s question from the Team Bus ask it answers', () => {
    seq = 0
    const turns = turnUsage([
      prompt('Check the lesson', 'checker'),
      row('tool_call', { callId: 'c1', name: 'ask', title: 'Team Bus: ask', rawInput: { agent: 'teacher', question: 'Which year?' } }, 'checker'),
      prompt('Checker asks: Which year?', 'teacher'),
      ended({ inputTokens: 500 }, 0.002, 'teacher'),
      row('tool_update', { callId: 'c1', status: 'completed', rawOutput: { agent: 'teacher' } }, 'checker'),
      ended({ inputTokens: 900 }, 0.004, 'checker'),
    ])
    expect(of(turns, 'teacher').map((turn) => turn.purpose)).toEqual(['ask'])
    expect(of(turns, 'checker').map((turn) => turn.purpose)).toEqual(['work'])
  })

  it('reads a turn that follows your note to the agent as yours, and only that turn', () => {
    seq = 0
    const events: RunEvent[] = [
      prompt('Write it', 'writer'),
      ended({ totalTokens: 50 }, null, 'writer', 'cancelled'),
      row('message', { role: 'user', content: { type: 'text', text: 'Shorter, please' } }, 'operator', { source: 'loomwatch', phase: 'operator_answer', to: 'writer' }),
      prompt('## A note from you…', 'writer'),
      ended({ totalTokens: 70 }, null, 'writer'),
      prompt('Again', 'writer'),
      ended({ totalTokens: 90 }, null, 'writer'),
    ]
    expect(turnUsage(events).map((turn) => [turn.agentId, turn.purpose, turn.total])).toEqual([['writer', 'work', 50], ['writer', 'note', 70], ['writer', 'work', 90]])
  })

  it('sums the run by agent and by purpose, in a fixed order, with its cache share and cost', () => {
    seq = 0
    const turns = turnUsage([
      prompt('Research', 'researcher'),
      ended({ inputTokens: 200, cachedReadTokens: 600, outputTokens: 200 }, 0.01, 'researcher'),
      row('session_meta', { phase: 'turn_purpose', purpose: 'handover' }, 'researcher'),
      prompt('Hand it over', 'researcher'),
      ended({ inputTokens: 50, cachedReadTokens: 900, outputTokens: 50 }, 0.002, 'researcher'),
      prompt('Write', 'writer'),
      ended({ inputTokens: 1_000, outputTokens: 500 }, 0.03, 'writer'),
    ])
    const summary = summarizeUsage(turns)
    expect(summary.agents.map((agent) => [agent.agentId, agent.total, agent.costUsd])).toEqual([['researcher', 2_000, 0.012], ['writer', 1_500, 0.03]])
    expect(summary.purposes.map((purpose) => purpose.purpose)).toEqual(['work', 'handover'])
    expect(summary.total).toBe(3_500)
    expect(summary.cacheShare).toBeCloseTo(1_500 / 2_750, 9)
    expect(summary.costUsd).toBeCloseTo(0.042, 9)
    expect(summary.costComplete).toBe(true)
  })
})

describe('the projection', () => {
  it('gives each agent its counted tokens, and the run’s once its evidence is all in', () => {
    seq = 0
    const events = [prompt('Go'), ended({ inputTokens: 700, outputTokens: 300 }, 0.01)]
    expect(projectRun(events).agents.find((agent) => agent.id === 'agent')?.tokens).toBe(1_000)
    expect(projectRun(events, Infinity, { status: 'succeeded' }).tokens).toBeNull()
    expect(projectRun(events, Infinity, { status: 'succeeded', evidenceComplete: true }).tokens?.total).toBe(1_000)
  })
})

it('writes counts in three figures', () => {
  expect([950, 9512, 44_268, 172_862, 999_600, 2_245_301].map(formatTokens)).toEqual(['950', '9.51k', '44.3k', '173k', '1M', '2.25M'])
})

it('writes a cost the way the receipt prints it', () => {
  expect([0, 0.00004, 0.0123456, 0.5, 1.237].map(formatCost)).toEqual(['$0', 'less than $0.0001', '$0.0123', '$0.5', '$1.24'])
})

describe('costWords', () => {
  it('says who paid: dollars, worked out, the ChatGPT plan, or both', () => {
    expect(costWords({ costUsd: 0.0123, costComplete: true })).toBe('$0.0123')
    expect(costWords({ costUsd: 0.12, costComplete: true, costEstimated: true })).toBe('≈ $0.12')
    expect(costWords({ costUsd: 0, costComplete: true, onPlan: true })).toBe('ChatGPT plan')
    expect(costWords({ costUsd: 0.12, costComplete: true, onPlan: true })).toBe('$0.12 + ChatGPT plan')
    expect(costWords({ costUsd: 0.12, costComplete: false })).toBe('at least $0.12')
    expect(costWords({ costComplete: true })).toBeNull()
  })
})
