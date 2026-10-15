import type { HarnessModel } from '../harnesses'
import { ROLE_PRESETS, type EffortTier } from './roles'

// How hard each built-in job thinks (ADR 0062). Thinking is paid for as output, and an app's own
// default is often its most expensive setting (Claude Code ships at xhigh), so a job that only
// tidies text or gathers links spends most of its tokens reasoning it does not need. Anthropic's
// effort guidance: low for simple tasks and subagents, medium as the balanced agentic default,
// high for complex reasoning; max often overthinks. OpenAI's: many workflows hold up at medium or
// low. So a tier names the effort the job needs, and the model's own catalog decides the id.
//
// Only an effort the model itself lists is ever chosen: an app rejects one it does not know, and a
// rejected effort fails the run. A model that lists none of a tier's ids keeps the app's default.
// Tiers never switch the model: catalogs do not say which model is the smaller one ("6 Luna",
// "5.6 Terra"), and a model switch is a quality bet the operator should make, not a default.

const IDS: Record<EffortTier, readonly string[]> = {
  light: ['low', 'minimal'],
  standard: ['medium'],
  deep: ['high'],
}

/** The effort id this model lists for the tier, or `undefined` to keep the app's default. */
export function effortFor(tier: EffortTier, model: Pick<HarnessModel, 'thinkingEfforts'> | null | undefined): string | undefined {
  const listed = new Set((model?.thinkingEfforts ?? []).map((effort) => effort.id))
  return IDS[tier].find((id) => listed.has(id))
}

/**
 * The effort for an agent placed from a built-in job, read off its instructions: a job's text is
 * copied verbatim when it is placed, so an exact match is that job and nothing else. `undefined`
 * for an agent whose instructions were written or changed by hand.
 */
export function jobEffort(role: string, model: Pick<HarnessModel, 'thinkingEfforts'> | null | undefined): string | undefined {
  const tier = ROLE_PRESETS.find((preset) => preset.role === role.trim())?.effort
  return tier ? effortFor(tier, model) : undefined
}

/** Efforts so high they mostly buy overthinking: Anthropic's guidance says max often overthinks. */
export const OVERTHINKING_EFFORTS: ReadonlySet<string> = new Set(['max', 'ultra'])
