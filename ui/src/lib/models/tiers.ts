import type { HarnessModel, HarnessModels } from '../harnesses'
import { splitModelSelector } from '../models'

// Model tiers by job (ADR 0057). The agent that writes the piece runs on the app's strongest model;
// an agent that only gathers for it runs on the app's faster one. Anthropic's research system pairs
// an Opus lead with Sonnet workers; OpenAI's advice is to keep the best model where quality is
// decided and a smaller one where it holds.
//
// Built only from the app's own catalog: an app rejects a model id it does not know, so a tier is
// always an id the app listed, or the app's current model when it lists nothing cheaper. The faster
// model is found, in order:
//   1. by the vendor's family name one step down in the same id: fable → opus → sonnet → haiku;
//      pro or max → the plain model or its flash; a plain model → its mini or flash. This is what
//      makes it work through OpenRouter, whose ids keep the vendor's names and say nothing else;
//   2. by the app's own words: a model it describes as fast or affordable, not as older (Codex
//      lists no mini, but calls one model "Fast and affordable … for easier tasks");
//   3. else the same model at the lowest-but-one thinking effort it lists, when that is below what
//      the app runs by default.
// Otherwise the fast tier is the strong one, and nothing changes.

export type ModelTier = 'strong' | 'fast'

/** A model the app listed, and the effort to run it at when the tier sets one. */
export interface TierChoice {
  model: string
  thinkingEffort?: string
}

export type ModelTiers = Record<ModelTier, TierChoice>

/** What a tier is read from: one app's catalog (`GET /api/harnesses/{id}/models`). */
export type ModelCatalog = Pick<HarnessModels, 'models' | 'currentModelId' | 'currentThinkingEffort'>

/** Efforts from least to most thinking; `default` is no level, and an id not here is never ranked. */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const SEP = '[-/:._~]'
const token = (words: string) => new RegExp(`(^|${SEP})(${words})(?=$|${SEP})`, 'i')

/** Anthropic's families, strongest first. */
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']
const FAMILY = token(FAMILIES.join('|'))
/** A bigger-than-plain variant: `gpt-6.1-sol-pro`, `deepseek-v4-pro`, `gpt-5.1-codex-max`. */
const BIG = token('pro|max')
/** Already a small, fast model by its name. */
const SMALL = token('mini|nano|flash|flashx|lite|haiku|small|tiny|fast|instant|lightning')

const FAST_WORDS = /\b(fast|fastest|faster|quick|quicker|affordable|efficient|lightweight|cheap|cheaper|economical|low[- ]cost)\b/i
const OLD_WORDS = /\b(older|legacy|deprecated|previous|outdated)\b/i

const describedFast = (model: HarnessModel) => FAST_WORDS.test(model.description ?? '') && !OLD_WORDS.test(model.description ?? '')

/**
 * The listed model an id stands for. An alias names its model in its description: Claude's
 * `default` says "Opus 5.5", which is the name of `opus`. A `model[effort]` selector is its model.
 */
export function resolveModel(id: string, models: readonly HarnessModel[]): string {
  const { modelId } = splitModelSelector(id)
  const entry = models.find((model) => model.id === modelId)
  const named = entry?.description && models.find((model) => model.id !== modelId && model.name === entry.description?.trim())
  return named ? named.id : modelId
}

/** Two ids for the same model, an alias and a `[effort]` suffix aside. */
export function sameModel(a: string, b: string, models: readonly HarnessModel[]): boolean {
  return resolveModel(a, models) === resolveModel(b, models)
}

/** Ids one family down from `id`, in the order to try them. Only listed ones are ever used. */
function smallerByName(id: string): string[] {
  const family = FAMILY.exec(id)
  if (family) {
    const next = FAMILIES[FAMILIES.indexOf(family[2].toLowerCase()) + 1]
    return next ? [id.replace(FAMILY, `$1${next}`)] : []
  }
  if (BIG.test(id)) return [id.replace(BIG, '$1flash'), id.replace(BIG, '')]
  if (SMALL.test(id)) return []
  return [`${id}-mini`, `${id}-flash`]
}

const rank = (effort: string | undefined) => (effort ? EFFORT_ORDER.indexOf(effort) : -1)

/** The lowest-but-one effort this model lists, when it is less than what the app runs by default. */
function lighterEffort(model: HarnessModel | undefined, appDefault: string | undefined): string | undefined {
  const listed = (model?.thinkingEfforts ?? []).map((effort) => effort.id).filter((id) => rank(id) >= 0).sort((a, b) => rank(a) - rank(b))
  const candidate = listed[1]
  if (!candidate) return undefined
  return rank(appDefault) >= 0 && rank(appDefault) <= rank(candidate) ? undefined : candidate
}

/**
 * The tiers of one app, with `current` as its strong model (the app's current model unless given).
 * `null` when the app listed no model at all.
 */
export function modelTiers(catalog: ModelCatalog, current = catalog.currentModelId ?? catalog.models[0]?.id): ModelTiers | null {
  if (!current) return null
  const { models } = catalog
  const strong: TierChoice = { model: current }
  const base = resolveModel(current, models)
  const listed = new Set(models.map((model) => model.id))
  const byName = smallerByName(base).find((id) => listed.has(id) && id !== base)
  if (byName) return { strong, fast: { model: byName } }

  const entry = models.find((model) => model.id === base)
  if (!(entry && describedFast(entry)) && !SMALL.test(base)) {
    const byWords = models.find((model) => model.id !== base && model.id !== current && describedFast(model) && resolveModel(model.id, models) !== base)
    if (byWords) return { strong, fast: { model: byWords.id } }
  }

  const effort = lighterEffort(models.find((model) => model.id === current) ?? entry, catalog.currentThinkingEffort)
  return { strong, fast: effort ? { model: current, thinkingEffort: effort } : strong }
}

/** The app lists something cheaper than its strong tier. */
export function hasFastTier(tiers: ModelTiers): boolean {
  return tiers.fast.model !== tiers.strong.model || tiers.fast.thinkingEffort !== tiers.strong.thinkingEffort
}

/**
 * Whether an agent on `model` at `thinkingEffort` runs on the strong tier while a faster one exists:
 * the strong model, at an effort above the fast tier's when the fast tier is only a lighter effort.
 * An effort that cannot be known (none set, and the app did not say its default) is not counted.
 */
export function onStrongTier(agent: { model?: string; thinkingEffort?: string }, tiers: ModelTiers, catalog: ModelCatalog): boolean {
  if (!agent.model || !hasFastTier(tiers) || !sameModel(agent.model, tiers.strong.model, catalog.models)) return false
  if (!sameModel(tiers.fast.model, tiers.strong.model, catalog.models)) return true
  const effort = agent.thinkingEffort ?? splitModelSelector(agent.model).thinkingEffort ?? catalog.currentThinkingEffort
  return rank(effort) > rank(tiers.fast.thinkingEffort)
}

/** A model's name as its app lists it, else its id. */
export function modelName(id: string, catalog: ModelCatalog): string {
  return catalog.models.find((model) => model.id === id)?.name ?? id
}

/** An effort's name as the model lists it, else its id. */
export function effortName(model: string, effort: string, catalog: ModelCatalog): string {
  return catalog.models.find((entry) => entry.id === model)?.thinkingEfforts.find((item) => item.id === effort)?.name ?? effort
}
