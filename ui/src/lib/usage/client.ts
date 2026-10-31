// What LoomWatch's model calls used, by source, day and agent (ADR 0073), as `GET /api/usage`
// serves it from the run archive (`crates/loomwatch-backend/src/archive/usage.rs`). Nothing here
// comes from a provider: a ChatGPT plan tells an app nothing of its limits, an Anthropic key nothing
// of its balance. The Usage page says what LoomWatch itself sent and links to each source for the rest.
// Every call is the agents' work or LoomWatch's own help (ADR 0106): each source and day says how
// much was LoomWatch's, and its help is listed by what it did.

import type { ModelSource } from '../ai/modelIds'

/** Calls, tokens and dollars. */
export interface Tally {
  calls: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  /** Dollars, for OpenRouter and the Claude credit. Always 0 for the ChatGPT plan. */
  costUsd: number
  /** Some of it was worked out from list prices. */
  costEstimated: boolean
}

export interface SourceUsage {
  source: ModelSource
  total: Tally
  /** How much of `total` was LoomWatch's own help; the rest was the agents' work. */
  loomwatch: Tally
  lastFiveHours: Tally
  lastSevenDays: Tally
  activeDays: number
  peakDayTokens: number
  /** The last time a call through it stopped at a limit or ran out of credit, if one did. */
  lastProblem?: { kind: string; at: string }
}

export interface DayUsage extends Tally {
  /** `2026-10-19`, a UTC date. */
  day: string
  source: ModelSource
  /** How much of the day's was LoomWatch's own help. */
  loomwatch: Tally
}

/** What LoomWatch did with a model itself, besides the agents' work. */
export type Feature = 'ask' | 'reading' | 'checking' | 'learning' | 'next_steps' | 'choosing_models'

export interface FeatureUsage extends Tally {
  feature: Feature
  source: ModelSource
}

export interface AgentUsage extends Tally {
  team?: string
  agentId: string
  agentName?: string
  source: ModelSource
  runs: number
}

export interface UsageReport {
  since: string
  sources: SourceUsage[]
  days: DayUsage[]
  /** The agents' work only. */
  agents: AgentUsage[]
  /** LoomWatch's own help, by feature and source, the costliest first. */
  features: FeatureUsage[]
}

/** Nothing used: what an older LoomWatch, which didn't tell its own help apart, says for it. */
export const NO_USE: Tally = { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, costEstimated: false }

export async function fetchUsage(days = 30): Promise<UsageReport> {
  const response = await fetch(`/api/usage?days=${days}`, { cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? 'LoomWatch couldn’t read its usage. Restart LoomWatch and try again.')
  const report = body as UsageReport
  return {
    ...report,
    sources: report.sources.map((source) => ({ ...source, loomwatch: source.loomwatch ?? NO_USE })),
    days: report.days.map((day) => ({ ...day, loomwatch: day.loomwatch ?? NO_USE })),
    features: report.features ?? [],
  }
}

/** Whether LoomWatch writes next-step suggestions under the notch's box, and what they have cost. */
export interface NextSteps {
  on: boolean
  written: number
  spent: number
}

async function nextStepsCall(init?: RequestInit): Promise<NextSteps | null> {
  const response = await fetch('/api/next-steps', { cache: 'no-store', ...init })
  // An older LoomWatch writes none.
  if (response.status === 404) return null
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? 'LoomWatch couldn’t change that. Restart LoomWatch and try again.')
  return body as NextSteps
}

export const fetchNextSteps = () => nextStepsCall()
export const saveNextSteps = (on: boolean) => nextStepsCall({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
  body: JSON.stringify({ on }),
})

/** Every token, read or written. */
export function tokensOf(tally: Pick<Tally, 'inputTokens' | 'cachedTokens' | 'outputTokens'>): number {
  return tally.inputTokens + tally.cachedTokens + tally.outputTokens
}

/** What a Claude plan gives each month, as the person set it on the Usage page. */
export interface ClaudePlan {
  /** Dollars of API credit a month; `null` when they bought their own credits instead. */
  monthly: number | null
  /** The day of the month the plan renews, 1–31. The 1st when not set. */
  renewsOn?: number
}

const CLAUDE_PLAN = 'loomwatch.usage.claudePlan'

/** The Claude plan the person set, if they did. Kept in this browser only. */
export function readClaudePlan(): ClaudePlan | null {
  try {
    const text = window.localStorage.getItem(CLAUDE_PLAN)
    if (!text) return null
    const plan = JSON.parse(text) as ClaudePlan
    return typeof plan === 'object' && plan !== null ? plan : null
  } catch {
    return null
  }
}

export function keepClaudePlan(plan: ClaudePlan | null) {
  try {
    if (plan) window.localStorage.setItem(CLAUDE_PLAN, JSON.stringify(plan))
    else window.localStorage.removeItem(CLAUDE_PLAN)
  } catch { /* set again next time */ }
}

/** The start of the plan's current month: the last `renewsOn` day on or before `now`, as a UTC date. */
export function cycleStart(now: Date, renewsOn = 1): string {
  const day = Math.min(Math.max(Math.round(renewsOn), 1), 28)
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day))
  if (start > now) start.setUTCMonth(start.getUTCMonth() - 1)
  return start.toISOString().slice(0, 10)
}

/** Dollars a source's days spent from `since` (a UTC date) on. */
export function spentSince(days: readonly DayUsage[], source: ModelSource, since: string): number {
  return days.filter((day) => day.source === source && day.day >= since).reduce((sum, day) => sum + day.costUsd, 0)
}
