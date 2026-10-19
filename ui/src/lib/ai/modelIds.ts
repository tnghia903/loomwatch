// Which model an agent runs on, who pays for it, and how hard it thinks.
//
// Every agent runs on LoomWatch's own engine. A `model` also says who pays (ADR 0073): the
// person's ChatGPT plan (`chatgpt:gpt-6.1-sol`), their Claude API credit
// (`anthropic:claude-opus-5-5`), or OpenRouter (`anthropic/claude-opus-5.5`). Team files written for
// an AI app hold that app's names (`sonnet`, `gpt-5.5`), read as OpenRouter's. `parseModelRef` reads
// them the way the daemon does (`crates/loomwatch-backend/src/ai/models.rs`, `ModelRef::parse`),
// with the same test cases, because the app reads team files itself.

import tiers from '../../../../schemas/model-tiers.json'

// `schemas/model-tiers.json` is the one table of which model and effort each kind of agent starts
// on. The daemon reads the same file for Ask, so templates, the builder, new agents and the teams
// Ask writes all choose alike.

/** The strong tier's model, and the model an agent falls back to (ADR 0057). */
export const DEFAULT_MODEL: string = tiers.models.strong
/** The step down from it, for work that only gathers for another agent (ADR 0057). */
export const FAST_MODEL: string = tiers.models.fast
/**
 * What a check step runs on (ADR 0062): another maker's model, so the work is read by a model that
 * did not write it and does not share its blind spots.
 */
export const CHECK_MODEL: string = tiers.models.check
/** The offline demo: answers with fixed text and calls no model. */
export const OFFLINE_MODEL = 'fake/offline'

/** How hard a model may be asked to think, least first. */
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Effort = (typeof EFFORTS)[number]

/** Efforts so high they mostly buy overthinking: Anthropic's guidance says max often overthinks. */
export const OVERTHINKING_EFFORTS: ReadonlySet<string> = new Set(['xhigh', 'max', 'ultra'])

/** Who pays for a model call: each costs differently, so a model never moves between them by itself. */
export type ModelSource = 'openrouter' | 'chatgpt' | 'anthropic'

/** Every source, in the order the model picker shows them: the plans a person already pays for first. */
export const SOURCES: readonly ModelSource[] = ['chatgpt', 'anthropic', 'openrouter']

/** A team file's `model`, read for who pays and what that source calls it. */
export interface ModelRef {
  source: ModelSource
  /** As its source names it: `gpt-6.1-sol`, `claude-opus-5-5`, or an OpenRouter id. */
  id: string
}

const KNOWN_EFFORTS = new Set(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/** `model` without a known `[effort]` at its end, and the effort. */
function withoutEffort(model: string): { base: string; effort?: string } {
  const text = model.trim()
  const open = text.lastIndexOf('[')
  if (open >= 0 && text.endsWith(']')) {
    const effort = text.slice(open + 1, -1)
    if (KNOWN_EFFORTS.has(effort)) return { base: text.slice(0, open).trimEnd(), effort }
  }
  return { base: text }
}

/**
 * Reads a team file's `model`. `chatgpt:` and `anthropic:` name their source; anything else is read
 * as OpenRouter's, the way it always was. A prefix with nothing after it keeps its source, so the run
 * fails plainly instead of quietly running on OpenRouter.
 */
export function parseModelRef(model: string | undefined): ModelRef {
  const { base } = withoutEffort(model ?? '')
  const colon = base.indexOf(':')
  if (colon >= 0) {
    const prefix = base.slice(0, colon).toLowerCase()
    if (prefix === 'chatgpt' || prefix === 'anthropic') return { source: prefix, id: base.slice(colon + 1).trim() }
  }
  return { source: 'openrouter', id: openRouterId(base) }
}

/** A model as a team file writes it, without its effort. */
export function modelSelector(model: ModelRef): string {
  return model.source === 'openrouter' ? model.id : `${model.source}:${model.id}`
}

/** A team file's `model` as the app and the daemon name it, without its effort: `sonnet` is `anthropic/claude-sonnet-5.5`. */
export function canonicalModel(model: string | undefined): string {
  return modelSelector(parseModelRef(model))
}

/** `model` as a team file should write it, its `[effort]` kept. */
export function normalizeModel(model: string): string {
  const { effort } = withoutEffort(model)
  const selector = canonicalModel(model)
  return effort ? `${selector}[${effort}]` : selector
}

/** The same model in OpenRouter's catalog, where its context size and prices are listed. */
export function openRouterEquivalent(model: ModelRef): string {
  if (model.source === 'chatgpt') return `openai/${model.id}`
  if (model.source === 'anthropic') return openRouterId(model.id)
  return model.id
}

/** The same model through `source`, when it can be named there. Whether that source offers it is the caller's to check. */
export function modelOn(model: ModelRef, source: ModelSource): ModelRef | undefined {
  if (model.source === source) return model
  const openrouter = openRouterEquivalent(model)
  if (source === 'openrouter') return { source, id: openrouter }
  if (source === 'chatgpt') return openrouter.startsWith('openai/') ? { source, id: openrouter.slice('openai/'.length) } : undefined
  const name = openrouter.startsWith('anthropic/') ? openrouter.slice('anthropic/'.length) : undefined
  // A variant (`:thinking`) or an alias (`~anthropic/…`) has no Anthropic id.
  if (!name || name.includes(':') || !name.startsWith('claude-')) return undefined
  return { source, id: name.replaceAll('.', '-') }
}

/** The OpenRouter id for a team file's `model` written for OpenRouter or an AI app. Read a model with `parseModelRef`. */
export function openRouterId(model: string | undefined): string {
  let id = (model ?? '').trim()
  if (!id) return DEFAULT_MODEL
  if (id.startsWith('openrouter/')) id = id.slice('openrouter/'.length)
  else if (id.startsWith('openrouter:')) id = id.slice('openrouter:'.length)
  if (id.includes('/')) return id
  const lower = id.toLowerCase()
  const family = (name: string) => `anthropic/claude-${name}-5.5`
  if (lower === 'opus' || lower === 'best') return family('opus')
  if (lower === 'sonnet') return family('sonnet')
  if (lower === 'haiku') return family('haiku')
  if (lower === 'default') return DEFAULT_MODEL
  if (lower.startsWith('claude-')) {
    // `claude-sonnet-5-5` → `anthropic/claude-sonnet-5.5`; a `[1m]` context suffix goes.
    const rest = lower.slice('claude-'.length).split('[')[0]
    const parts = rest.split('-')
    let numbers = 0
    while (numbers < parts.length && /^\d+$/.test(parts[parts.length - 1 - numbers])) numbers += 1
    if (numbers === 0) return family(rest)
    const version = parts.slice(parts.length - numbers).join('.')
    return `anthropic/claude-${parts.slice(0, parts.length - numbers).join('-')}-${version}`
  }
  if (lower.startsWith('gpt-') || lower.startsWith('o3') || lower.startsWith('o4')) return `openai/${lower}`
  if (lower.startsWith('gemini-')) return `google/${lower}`
  return DEFAULT_MODEL
}

/** A model's short name from its id, for when the model list hasn't arrived: `Claude Opus 5.5`. */
export function modelNameFromId(id: string): string {
  if (id === OFFLINE_MODEL) return 'Offline demo (no AI)'
  const named = openRouterEquivalent(parseModelRef(id))
  const name = (named.split('/').pop() ?? named).replace(/:free$/, ' (free)')
  return name
    .split('-')
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
    .replace(/^Gpt /, 'GPT-')
}

/**
 * A job's model tier (ADR 0057): `fast` for a job that gathers for another, `strong` for one whose
 * work is the piece or decides it, `check` for a check step, which reads on another maker's model.
 */
export type ModelTier = 'strong' | 'fast' | 'check'

/**
 * How hard a job thinks (ADR 0062): `light` for tidying and formatting, `standard` for most work,
 * `deep` where judgement decides the result (checking, analysis, code). Thinking is paid for as
 * output, so a job that only tidies text spends little on reasoning it does not need.
 */
export type EffortTier = 'light' | 'standard' | 'deep'

/** What a built-in job needs: its model tier and how hard it thinks. */
export interface JobNeeds {
  tier?: ModelTier
  effort?: EffortTier
}

/** The effort an effort tier asks of a model that reasons. */
export function effortFor(tier: EffortTier | undefined): Effort | undefined {
  return tier ? (tiers.efforts[tier] as Effort) : undefined
}

/** The model a tier runs on. */
export function modelForTier(tier: ModelTier | undefined): string {
  return tiers.models[tier ?? 'strong']
}

/** What an agent made from nothing needs: the strong tier, at the standard effort. */
export const NEW_AGENT: JobNeeds = tiers.newAgent as JobNeeds

/** What a built-in job needs, from the table. Every built-in job is in it. */
export function jobNeeds(job: string): Required<JobNeeds> {
  const needs = (tiers.jobs as Record<string, Required<JobNeeds> | undefined>)[job]
  if (!needs) throw new Error(`schemas/model-tiers.json has no job ${job}`)
  return needs
}

/** The model and effort a built-in job starts on. */
export function modelForJob(job: JobNeeds): { model: string; thinkingEffort?: Effort } {
  const thinkingEffort = effortFor(job.effort)
  return { model: modelForTier(job.tier), ...(thinkingEffort ? { thinkingEffort } : {}) }
}
