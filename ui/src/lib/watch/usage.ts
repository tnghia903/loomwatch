import type { RunEvent } from './events'

/**
 * Tokens per turn, right for each AI app, worked out from the archived events alone — so a run
 * archived before this existed reads the same as one recorded today.
 *
 * No app reports every turn whole, and each falls short differently:
 *
 * - **codex-acp** (2.x) puts only the turn's *last* model call in its `session/prompt` usage, and
 *   each `usage_update.used` is one call's total, sent as the call ends. A turn is the sum of its
 *   distinct readings — for every Codex session archived when this was written, exactly the total
 *   Codex logged itself. The last call's split is reported; an earlier call's cache read is
 *   estimated from how the context grew (each call re-reads the context the call before it ended
 *   with).
 * - **claude-agent-acp** (0.85) sums the turn's main loop in `usage`, and lists every model the
 *   turn ran — Haiku side calls, subagents, compaction — in `_meta.quota.model_usage`. The rows are
 *   the whole turn. Mid-turn it sends two readings per model call (as the call starts and as it
 *   ends), and its `usage_update.cost.amount` is the session's running total, so a turn's cost is
 *   what it added to the reading before it.
 * - A turn the run stopped before it ended has no response at all. It counts what its readings
 *   saw up to the stop.
 *
 * Anything worked out rather than reported is marked `estimated`.
 */

/** Why a turn happened. `work` is the task itself; the rest are turns LoomWatch or you asked for. */
export type TurnPurpose = 'work' | 'handover' | 'checkpoint' | 'ask' | 'note'
export type UsageApp = 'claude' | 'codex' | 'other'

export interface TokenCounts {
  /** Prompt tokens processed fresh: neither read from the app's cache nor written to it. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
}

export interface TurnUsage extends TokenCounts {
  agentId: string
  app: UsageApp
  purpose: TurnPurpose
  /** The turn's prompt, and its last event. */
  startSeq: number
  endSeq: number
  /** How the app ended the turn; `null` when it never did, because the run stopped first. */
  stopReason: string | null
  /** Some of these counts were worked out from the app's readings rather than reported whole. */
  estimated: boolean
  /** What the app priced the turn at, when it prices turns at all (Claude does; Codex does not). */
  costUsd?: number
}

export interface AgentTokens extends TokenCounts {
  agentId: string
  app: UsageApp
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
  /** Apps whose finished turns had to be added up from their readings. */
  estimatedApps: UsageApp[]
  /** Turns the run stopped before they ended, which count only what was seen until then. */
  stoppedTurns: number
  /** Only when every turn that used tokens was priced by its app. */
  costUsd?: number
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

/** One `token_count` row of `_meta.quota`, or an ACP `usage`: the two spell cache reads differently. */
function counts(usage: Record<string, unknown>): TokenCounts {
  const split = {
    input: count(usage.inputTokens),
    cacheRead: count(usage.cachedReadTokens ?? usage.cachedInputTokens),
    cacheWrite: count(usage.cachedWriteTokens),
    // Both apps count thinking inside their output tokens; `thoughtTokens` is a part, not more.
    output: count(usage.outputTokens),
  }
  const total = count(usage.totalTokens) || split.input + split.cacheRead + split.cacheWrite + split.output
  return { ...split, total }
}

/**
 * What a `session/prompt` result says it spent: every model's row from `_meta.quota.model_usage`
 * when the app lists them — Claude's rows include the side calls its `usage` leaves out — else its
 * ACP `usage`. `null` when it says nothing.
 */
function reportedUsage(usage: unknown, meta: unknown): TokenCounts | null {
  const quota = object(meta) && object(meta.quota) ? meta.quota : null
  const rows = quota && Array.isArray(quota.model_usage) ? quota.model_usage.filter(object) : []
  if (rows.length > 0) {
    const total = zero()
    for (const row of rows) if (object(row.token_count)) add(total, counts(row.token_count))
    return total
  }
  return object(usage) ? counts(usage) : null
}

/** The app that answered `initialize`, by the name it gave. */
function appOf(event: RunEvent): UsageApp {
  const raw = object(event.raw) ? event.raw : {}
  const result = object(event.payload.result) ? event.payload.result : object(raw.result) ? raw.result : {}
  const name = object(result.agentInfo) && typeof result.agentInfo.name === 'string' ? result.agentInfo.name.toLowerCase() : ''
  return name.includes('codex') ? 'codex' : name.includes('claude') ? 'claude' : 'other'
}

/** One model call, as its readings saw it: the context it started with and the total it ended on. */
interface Call { start: number; final: number }

/**
 * The readings of one part of a turn: from a prompt to the app's response, or to the stop. A turn
 * cut by its app and carried on (ADR 0046) has one part per prompt.
 */
class Part {
  readonly calls: Call[] = []
  private last: number | null = null
  private wroteSince = false
  /** Codex sends one reading per call; Claude one as a call starts and one as it ends. */
  private readonly onePerCall: boolean

  constructor(onePerCall: boolean) {
    this.onePerCall = onePerCall
  }

  /** The app streamed something of its answer: a model call is under way. */
  wrote() { this.wroteSince = true }

  read(used: number) {
    // A reading repeated — Claude's closing `result`, a rate-limit notice — is the same call.
    if (used === this.last) return
    const call = this.calls.at(-1)
    // Nothing written since the last reading: this one opens the next call, and the last one
    // closed the call before it.
    if (this.onePerCall || !call || !this.wroteSince) this.calls.push({ start: used, final: used })
    else call.final = used
    this.last = used
    this.wroteSince = false
  }
}

/**
 * Split calls the app reported only as totals. A call re-reads from cache what the call before it
 * in the same session ended on; the rest of its prompt is new — fresh input for Codex, written to
 * the cache for Claude, whose app caches each new prefix. Codex's output cannot be told from new
 * input, so it is counted with the input.
 */
function estimateCalls(calls: readonly Call[], app: UsageApp, previous: number | null): TokenCounts {
  const total = zero()
  let before = previous
  for (const call of calls) {
    const output = app === 'codex' ? 0 : Math.max(0, call.final - call.start)
    const prompt = call.final - output
    const cacheRead = before === null ? 0 : Math.min(before, prompt)
    const fresh = prompt - cacheRead
    add(total, { input: app === 'claude' ? 0 : fresh, cacheRead, cacheWrite: app === 'claude' ? fresh : 0, output, total: call.final })
    before = call.final
  }
  return total
}

interface Ask { asker: string; from: number; to: number; target: string | null; question: string | null }

/**
 * Every Team Bus `ask`, from the call to its answer. The asked agent answers inside that span —
 * a kept-alive one in a new turn, a cold one in a new session — and nothing else marks that turn.
 */
function askSpans(events: readonly RunEvent[], throughSeq: number): Ask[] {
  const asks = new Map<string, Ask>()
  for (const event of events) {
    if (event.seq > throughSeq) break
    const p = event.payload
    if (typeof p.callId !== 'string') continue
    const key = `${event.agentId}:${p.callId}`
    // Only the bus's own record of the call; the app's echo of it carries a prefixed name.
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
  part: Part
  /** The session's running cost when the turn began; `undefined` when it cannot be known. */
  costFrom: number | undefined
  /** The last running cost the turn reported. */
  costTo: number | null
}

interface AgentState {
  app: UsageApp
  /** Set by LoomWatch's `turn_purpose` note before a turn it asks for, and reset after. */
  purpose: 'work' | 'handover' | 'checkpoint'
  open: OpenTurn | null
  /** The next prompt is LoomWatch's request to carry on: the same turn, a new part. */
  resuming: boolean
  replaying: boolean
  /** You wrote to this agent since its last turn began. */
  noted: boolean
  /** The total of the session's last model call: what the next call reads back from cache. */
  previous: number | null
  /** The session's running cost: 0 for a new session, unknown for one reloaded mid-history. */
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
      state = { app: 'other', purpose: 'work', open: null, resuming: false, replaying: false, noted: false, previous: null, cost: 0 }
      agents.set(id, state)
    }
    return state
  }

  /** Close the open part: the app's own account when it gave one that covers it, else the readings. */
  const settle = (state: AgentState, open: OpenTurn, said: TokenCounts | null) => {
    const { calls } = open.part
    const counted = zero()
    let estimated = false
    const read = calls.reduce((sum, call) => sum + call.final, 0)
    const last = calls.at(-1)
    // A report of nothing, over readings that saw calls, is no report.
    const reported = said && (said.total > 0 || read === 0) ? said : null
    if (reported && (state.app !== 'codex' || reported.total >= read)) {
      add(counted, reported)
    } else if (reported && last && last.final === reported.total) {
      // Codex: the earlier calls from their readings, the last one as reported.
      add(counted, estimateCalls(calls.slice(0, -1), state.app, state.previous))
      add(counted, reported)
      estimated = calls.length > 1
    } else {
      add(counted, estimateCalls(calls, state.app, state.previous))
      estimated = calls.length > 0
    }
    if (last) state.previous = last.final
    add(open.turn, counted)
    open.turn.estimated ||= estimated
    open.part = new Part(state.app === 'codex')
  }

  const finish = (state: AgentState, stopReason: string | null, reported: TokenCounts | null) => {
    const open = state.open
    if (!open) return
    settle(state, open, reported)
    open.turn.stopReason = stopReason
    if (open.costTo !== null) {
      // A running total that fell back restarted under the turn, so the reading is all of it.
      if (open.costFrom !== undefined) open.turn.costUsd = open.costTo >= open.costFrom ? open.costTo - open.costFrom : open.costTo
      state.cost = open.costTo
    }
    turns.push(open.turn)
    state.open = null
    state.resuming = false
  }

  /** A turn begins at its prompt — or, where the archive holds no prompt, at the app's answer. */
  const begin = (state: AgentState, event: RunEvent, text: string): OpenTurn => {
    const asked = asks.some((ask) => ask.asker !== event.agentId && ask.from < event.seq && event.seq < ask.to
      && (ask.target === event.agentId || (ask.question !== null && text.includes(ask.question))))
    const purpose: TurnPurpose = state.purpose !== 'work' ? state.purpose : asked ? 'ask' : state.noted ? 'note' : 'work'
    state.noted = false
    state.open = {
      turn: { agentId: event.agentId, app: state.app, purpose, startSeq: event.seq, endSeq: event.seq, stopReason: null, estimated: false, ...zero() },
      part: new Part(state.app === 'codex'),
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
    // A reloaded session replays its history: those readings were spent before, not now.
    if (event.kind === 'session_meta' && p.phase === 'session_loaded') { state.replaying = true; state.cost = undefined; continue }
    if (event.kind === 'session_meta' && p.phase === 'session_replayed') { state.replaying = false; continue }
    if (state.replaying) continue
    const open = state.open

    switch (event.kind) {
      case 'process':
        if (p.phase === 'spawned') {
          finish(state, null, null)
          state.previous = null
          state.cost = 0
        }
        break
      case 'session_meta':
        if (p.phase === 'initialize') state.app = appOf(event)
        else if (p.phase === 'session_new') { state.previous = null; state.cost = 0 }
        else if (p.phase === 'turn_purpose') state.purpose = p.purpose === 'handover' || p.purpose === 'checkpoint' ? p.purpose : 'work'
        else if (p.phase === 'turn_resumed' && raw.source === 'loomwatch') {
          const response = object(raw.response) && object(raw.response.result) ? raw.response.result : {}
          settle(state, open ?? begin(state, event, ''), reportedUsage(p.usage, response._meta))
          state.resuming = true
        }
        break
      case 'message':
        if (p.role === 'user') {
          if (state.resuming && open) { state.resuming = false; break }
          // A new prompt before the last one was answered: that one never will be.
          finish(state, null, null)
          const content = object(p.content) ? p.content : {}
          begin(state, event, typeof content.text === 'string' ? content.text : '')
        } else if (p.role === 'agent') open?.part.wrote()
        break
      case 'thought':
      case 'tool_call':
        open?.part.wrote()
        break
      case 'usage': {
        if (typeof p.used === 'number') open?.part.read(p.used)
        const amount = object(p.cost) ? p.cost.amount : undefined
        if (typeof amount === 'number' && Number.isFinite(amount)) {
          if (open) open.costTo = amount
          else state.cost = amount
        }
        break
      }
      case 'turn_end': {
        const result = object(raw.result) ? raw.result : {}
        if (!open) begin(state, event, '')
        finish(state, typeof p.stopReason === 'string' ? p.stopReason : 'end_turn', reportedUsage(p.usage, result._meta))
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

/** Whether every turn in `group` that used tokens was priced, and what that came to. */
function priced(group: readonly TurnUsage[]): number | undefined {
  const spent = group.filter((turn) => turn.total > 0)
  if (spent.length === 0 || spent.some((turn) => turn.costUsd === undefined)) return undefined
  return spent.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0)
}

function tally(group: readonly TurnUsage[]): TokenCounts & { turns: number; estimated: boolean } {
  const total = zero()
  for (const turn of group) add(total, turn)
  return { ...total, turns: group.length, estimated: group.some((turn) => turn.estimated && turn.total > 0) }
}

/** The run's tokens: in all, by agent and by why each turn happened. */
export function summarizeUsage(turns: readonly TurnUsage[]): TokenSummary {
  const all = tally(turns)
  const byAgent = new Map<string, TurnUsage[]>()
  for (const turn of turns) byAgent.set(turn.agentId, [...(byAgent.get(turn.agentId) ?? []), turn])
  const prompt = all.input + all.cacheRead + all.cacheWrite
  const cost = priced(turns)
  return {
    ...all,
    cacheShare: prompt > 0 ? all.cacheRead / prompt : null,
    agents: [...byAgent].map(([agentId, group]) => {
      const agentCost = priced(group)
      return { agentId, app: group[0].app, ...tally(group), ...(agentCost === undefined ? {} : { costUsd: agentCost }) }
    }),
    purposes: PURPOSES.flatMap((purpose) => {
      const group = turns.filter((turn) => turn.purpose === purpose)
      return group.length > 0 ? [{ purpose, ...tally(group) }] : []
    }),
    estimatedApps: [...new Set(turns.filter((turn) => turn.estimated && turn.stopReason !== null && turn.total > 0).map((turn) => turn.app))],
    stoppedTurns: turns.filter((turn) => turn.stopReason === null && turn.total > 0).length,
    ...(cost === undefined ? {} : { costUsd: cost }),
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
