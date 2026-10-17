import type { RunEvent } from './events'

/**
 * Tokens and cost per turn, worked out from the archived events alone.
 *
 * LoomWatch's engine reports each turn whole when it ends: its tokens, split into fresh input,
 * cache reads and writes and output, and what OpenRouter charged for it (`turn_end`'s result,
 * `_meta.loomwatch.costUsd`). A turn the run stopped before it ended has no such report; it counts
 * the model calls its `usage` readings saw, each one call's tokens, without the split, and is
 * marked `estimated`.
 */

/** Why a turn happened. `work` is the task itself; the rest are turns LoomWatch or you asked for. */
export type TurnPurpose = 'work' | 'handover' | 'checkpoint' | 'ask' | 'note'

export interface TokenCounts {
  /** Prompt tokens processed fresh: neither read from the model's cache nor written to it. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
}

export interface TurnUsage extends TokenCounts {
  agentId: string
  purpose: TurnPurpose
  /** The turn's prompt, and its last event. */
  startSeq: number
  endSeq: number
  /** How the turn ended; `null` when it never did, because the run stopped first. */
  stopReason: string | null
  /** Counted from the turn's readings, because it never reported itself whole. */
  estimated: boolean
  /** What OpenRouter charged for the turn, in dollars, when that is known. */
  costUsd?: number
}

export interface AgentTokens extends TokenCounts {
  agentId: string
  turns: number
  estimated: boolean
  costUsd?: number
}

export interface PurposeTokens extends TokenCounts {
  purpose: TurnPurpose
  turns: number
  estimated: boolean
}

export interface TokenSummary extends TokenCounts {
  turns: number
  estimated: boolean
  /** Share of prompt tokens read back from a cache: `cacheRead / (input + cacheRead + cacheWrite)`. */
  cacheShare: number | null
  /** In the order each agent first took a turn. */
  agents: AgentTokens[]
  /** Only the purposes some turn had, in {@link PURPOSES} order. */
  purposes: PurposeTokens[]
  /** Turns the run stopped before they ended, which count only what was seen until then. */
  stoppedTurns: number
  /** What the turns whose cost is known came to. */
  costUsd?: number
  /** Every turn that used tokens has a known cost, so `costUsd` is the whole run's. */
  costComplete: boolean
}

export const PURPOSES: readonly TurnPurpose[] = ['work', 'handover', 'checkpoint', 'ask', 'note']

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const zero = (): TokenCounts => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 })

function add(into: TokenCounts, from: TokenCounts) {
  into.input += from.input
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
  into.output += from.output
  into.total += from.total
}

/** A turn's `usage` as `turn_end` records it. `null` when it says nothing. */
function reported(usage: unknown): TokenCounts | null {
  if (!object(usage)) return null
  const split = {
    input: count(usage.inputTokens),
    cacheRead: count(usage.cachedReadTokens ?? usage.cachedInputTokens),
    cacheWrite: count(usage.cachedWriteTokens),
    // Thinking is counted inside the output tokens; `reasoningTokens` is a part, not more.
    output: count(usage.outputTokens),
  }
  const total = count(usage.totalTokens) || split.input + split.cacheRead + split.cacheWrite + split.output
  return total > 0 ? { ...split, total } : null
}

/** What a turn cost, from its `turn_end` result. */
function reportedCost(result: Record<string, unknown>): number | undefined {
  const meta = object(result._meta) && object(result._meta.loomwatch) ? result._meta.loomwatch : null
  const cost = meta?.costUsd
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

interface Ask { asker: string; from: number; to: number; target: string | null; question: string | null }

/**
 * Every Team Bus `ask`, from the call to its answer. The asked agent answers inside that span —
 * a parked one in a new turn, a new one in a new session — and nothing else marks that turn.
 */
function askSpans(events: readonly RunEvent[], throughSeq: number): Ask[] {
  const asks = new Map<string, Ask>()
  for (const event of events) {
    if (event.seq > throughSeq) break
    const p = event.payload
    if (typeof p.callId !== 'string') continue
    const key = `${event.agentId}:${p.callId}`
    if (event.kind === 'tool_call' && p.name === 'ask' && p.title === 'Team Bus: ask') {
      const input = object(p.rawInput) ? p.rawInput : {}
      asks.set(key, {
        asker: event.agentId, from: event.seq, to: Infinity,
        target: typeof input.agent === 'string' ? input.agent : null,
        question: typeof input.question === 'string' && input.question ? input.question : null,
      })
    } else if (event.kind === 'tool_update' && (p.status === 'completed' || p.status === 'failed')) {
      const ask = asks.get(key)
      if (!ask) continue
      ask.to = event.seq
      // The model may have named the agent; the bus's answer names the id it resolved.
      const output = object(p.rawOutput) ? p.rawOutput : {}
      if (typeof output.agent === 'string' && output.agent) ask.target = output.agent
    }
  }
  return [...asks.values()]
}

interface OpenTurn {
  turn: TurnUsage
  /** Each model call's tokens, as the `usage` readings reported them. */
  calls: number[]
  /** The session's running cost when the turn began; `undefined` when it cannot be known. */
  costFrom: number | undefined
  /** The last running cost the turn reported. */
  costTo: number | null
}

interface AgentState {
  /** Set by LoomWatch's `turn_purpose` note before a turn it asks for, and reset after. */
  purpose: 'work' | 'handover' | 'checkpoint'
  open: OpenTurn | null
  replaying: boolean
  /** You wrote to this agent since its last turn began. */
  noted: boolean
  /** The session's running cost: 0 for a new session, unknown for one resumed from earlier. */
  cost: number | undefined
}

/**
 * Every turn's tokens, through `throughSeq`, in the order the turns began. A turn still open at the
 * cut — the run stopped, or is still going — counts what its readings saw and has no stop reason.
 */
export function turnUsage(events: readonly RunEvent[], throughSeq = Infinity): TurnUsage[] {
  const asks = askSpans(events, throughSeq)
  const agents = new Map<string, AgentState>()
  const turns: TurnUsage[] = []

  const stateOf = (id: string): AgentState => {
    let state = agents.get(id)
    if (!state) {
      state = { purpose: 'work', open: null, replaying: false, noted: false, cost: 0 }
      agents.set(id, state)
    }
    return state
  }

  /** Close the open turn: its own report when it ended with one, else what its readings saw. */
  const finish = (state: AgentState, stopReason: string | null, result: Record<string, unknown> | null) => {
    const open = state.open
    if (!open) return
    const whole = result ? reported(result.usage) : null
    if (whole) add(open.turn, whole)
    else {
      const seen = open.calls.reduce((sum, tokens) => sum + tokens, 0)
      add(open.turn, { input: seen, cacheRead: 0, cacheWrite: 0, output: 0, total: seen })
      open.turn.estimated = seen > 0
    }
    open.turn.stopReason = stopReason
    const cost = result ? reportedCost(result) : undefined
    if (cost !== undefined) open.turn.costUsd = cost
    else if (open.costTo !== null && open.costFrom !== undefined) {
      // A running total that fell back restarted under the turn, so the reading is all of it.
      open.turn.costUsd = open.costTo >= open.costFrom ? open.costTo - open.costFrom : open.costTo
    }
    if (open.costTo !== null) state.cost = open.costTo
    else if (cost !== undefined && state.cost !== undefined) state.cost += cost
    turns.push(open.turn)
    state.open = null
  }

  /** A turn begins at its prompt — or, where the archive holds no prompt, at its end. */
  const begin = (state: AgentState, event: RunEvent, text: string): OpenTurn => {
    const asked = asks.some((ask) => ask.asker !== event.agentId && ask.from < event.seq && event.seq < ask.to
      && (ask.target === event.agentId || (ask.question !== null && text.includes(ask.question))))
    const purpose: TurnPurpose = state.purpose !== 'work' ? state.purpose : asked ? 'ask' : state.noted ? 'note' : 'work'
    state.noted = false
    state.open = {
      turn: { agentId: event.agentId, purpose, startSeq: event.seq, endSeq: event.seq, stopReason: null, estimated: false, ...zero() },
      calls: [],
      costFrom: state.cost,
      costTo: null,
    }
    return state.open
  }

  for (const event of events) {
    if (event.seq > throughSeq) break
    const p = event.payload
    const raw = object(event.raw) ? event.raw : {}
    // Your notes and answers are archived under the operator's id, addressed `to` their agent.
    if (event.kind === 'message' && p.role === 'user' && raw.phase === 'operator_answer') {
      if (typeof raw.to === 'string' && raw.to) stateOf(raw.to).noted = true
      continue
    }
    const state = stateOf(event.agentId)
    // A resumed session may replay its history: those turns were spent before, not now. Its
    // running cost carries on from then, so it is not known here; each turn's own report is.
    if (event.kind === 'session_meta' && p.phase === 'session_loaded') { state.replaying = true; state.cost = undefined; continue }
    if (event.kind === 'session_meta' && p.phase === 'session_replayed') { state.replaying = false; continue }
    if (state.replaying) continue
    const open = state.open

    switch (event.kind) {
      case 'process':
        if (p.phase === 'spawned') {
          finish(state, null, null)
          state.cost = 0
        }
        break
      case 'session_meta':
        if (p.phase === 'session_new') state.cost = 0
        else if (p.phase === 'turn_purpose') state.purpose = p.purpose === 'handover' || p.purpose === 'checkpoint' ? p.purpose : 'work'
        break
      case 'message':
        if (p.role === 'user') {
          // A new prompt before the last one was answered: that one never will be.
          finish(state, null, null)
          const content = object(p.content) ? p.content : {}
          begin(state, event, typeof content.text === 'string' ? content.text : '')
        }
        break
      case 'usage': {
        if (typeof p.used === 'number' && open) open.calls.push(count(p.used))
        const amount = object(p.cost) ? p.cost.amount : undefined
        if (typeof amount === 'number' && Number.isFinite(amount)) {
          if (open) open.costTo = amount
          // The first reading after a resume gives the running cost to measure the next turn from.
          else state.cost = amount
        }
        break
      }
      case 'turn_end': {
        const result = object(raw.result) ? raw.result : {}
        if (!open) begin(state, event, '')
        finish(state, typeof p.stopReason === 'string' ? p.stopReason : 'end_turn', { ...result, usage: p.usage ?? result.usage })
        break
      }
      default:
        break
    }
    if (state.open) state.open.turn.endSeq = event.seq
  }
  for (const state of agents.values()) finish(state, null, null)
  return turns.sort((a, b) => a.startSeq - b.startSeq)
}

/** What the turns in `group` whose cost is known came to, and whether that is all of them. */
function priced(group: readonly TurnUsage[]): { costUsd?: number; costComplete: boolean } {
  const spent = group.filter((turn) => turn.total > 0)
  const known = spent.filter((turn) => turn.costUsd !== undefined)
  return {
    ...(known.length > 0 ? { costUsd: known.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0) } : {}),
    costComplete: known.length === spent.length,
  }
}

function tally(group: readonly TurnUsage[]): TokenCounts & { turns: number; estimated: boolean } {
  const total = zero()
  for (const turn of group) add(total, turn)
  return { ...total, turns: group.length, estimated: group.some((turn) => turn.estimated && turn.total > 0) }
}

/** The run's tokens and cost: in all, by agent and by why each turn happened. */
export function summarizeUsage(turns: readonly TurnUsage[]): TokenSummary {
  const all = tally(turns)
  const byAgent = new Map<string, TurnUsage[]>()
  for (const turn of turns) byAgent.set(turn.agentId, [...(byAgent.get(turn.agentId) ?? []), turn])
  const prompt = all.input + all.cacheRead + all.cacheWrite
  return {
    ...all,
    // A stopped turn's tokens are counted without their split, so they read as fresh input.
    cacheShare: prompt > 0 ? all.cacheRead / prompt : null,
    agents: [...byAgent].map(([agentId, group]) => {
      const { costUsd } = priced(group)
      return { agentId, ...tally(group), ...(costUsd === undefined ? {} : { costUsd }) }
    }),
    purposes: PURPOSES.flatMap((purpose) => {
      const group = turns.filter((turn) => turn.purpose === purpose)
      return group.length > 0 ? [{ purpose, ...tally(group) }] : []
    }),
    stoppedTurns: turns.filter((turn) => turn.stopReason === null && turn.total > 0).length,
    ...priced(turns),
  }
}

/** "950", "44.3k", "173k", "2.25M": three significant figures, so a change between runs shows. */
export function formatTokens(tokens: number): string {
  let value = Math.round(tokens)
  if (value < 1000) return String(value)
  const units = ['k', 'M', 'B']
  let unit = -1
  while (value >= 999.5 && unit < units.length - 1) { value /= 1000; unit += 1 }
  return `${Number(value.toPrecision(3))}${units[unit]}`
}

/** "$0.0123", "$1.24", "less than $0.0001": what OpenRouter charged, as the receipt prints it. */
export function formatCost(dollars: number): string {
  if (dollars <= 0) return '$0'
  if (dollars < 0.0001) return 'less than $0.0001'
  if (dollars < 1) return `$${Number(dollars.toPrecision(3))}`
  return `$${dollars.toFixed(2)}`
}
