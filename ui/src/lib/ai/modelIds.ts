// Which model an agent runs on, and how hard it thinks.
//
// Every agent runs on LoomWatch's own engine through OpenRouter, so a `model` is an OpenRouter id
// (`anthropic/claude-opus-5.5`). Team files written for an AI app hold that app's names (`sonnet`,
// `gpt-5.5`); `openRouterId` reads them the way the daemon does (`crates/loomwatch-backend/src/ai/
// models.rs`, `openrouter_id`), with the same test cases, because the app reads team files itself.

/** The model new agents get. */
export const DEFAULT_MODEL = 'anthropic/claude-opus-5.5'
/** The step down from it, for work that only gathers for another agent (ADR 0057). */
export const FAST_MODEL = 'anthropic/claude-sonnet-5.5'
/**
 * What a check step runs on (ADR 0062): another maker's model, so the work is read by a model that
 * did not write it and does not share its blind spots.
 */
export const CHECK_MODEL = 'openai/gpt-6.1-sol'
/** The offline demo: answers with fixed text and calls no model. */
export const OFFLINE_MODEL = 'fake/offline'

/** How hard a model may be asked to think, least first. */
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Effort = (typeof EFFORTS)[number]

/** Efforts so high they mostly buy overthinking: Anthropic's guidance says max often overthinks. */
export const OVERTHINKING_EFFORTS: ReadonlySet<string> = new Set(['xhigh', 'max', 'ultra'])

/** The OpenRouter id for a team file's `model`. */
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
  const name = (id.split('/').pop() ?? id).replace(/:free$/, ' (free)')
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
  return tier === 'light' ? 'low' : tier === 'standard' ? 'medium' : tier === 'deep' ? 'high' : undefined
}

/** The model a tier runs on. */
export function modelForTier(tier: ModelTier | undefined): string {
  return tier === 'fast' ? FAST_MODEL : tier === 'check' ? CHECK_MODEL : DEFAULT_MODEL
}

/** The model and effort a built-in job starts on. */
export function modelForJob(job: JobNeeds): { model: string; thinkingEffort?: Effort } {
  const thinkingEffort = effortFor(job.effort)
  return { model: modelForTier(job.tier), ...(thinkingEffort ? { thinkingEffort } : {}) }
}
