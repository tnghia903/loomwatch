import { modelTiers, sameModel, type ModelCatalog, type TierChoice } from '../models/tiers'
import { effortFor } from './effort'
import { ROLE_PRESETS, type RolePreset } from './roles'

/**
 * The model and effort a built-in job starts on, from its app's catalog: its tier's model
 * (ADR 0057), at the effort the job needs (ADR 0062), unless the fast tier is itself a lighter
 * effort on the same model. `current` is the strong model, the app's current one unless given.
 * `null` when the app listed no model.
 *
 * The job's effort is set only on the app's current model. The efforts in a catalog are the ones
 * the app offered for the model its session started on, and an app may copy them onto every model:
 * Claude lists Low to Max on Haiku 4.5, which has no effort at all, and refuses one sent to it. A
 * smaller model runs at its own default instead.
 */
export function modelForJob(job: Pick<RolePreset, 'tier' | 'effort'>, catalog: ModelCatalog, current?: string): TierChoice | null {
  const tiers = modelTiers(catalog, current)
  if (!tiers) return null
  const choice = tiers[job.tier ?? 'strong']
  const onCurrent = sameModel(choice.model, tiers.strong.model, catalog.models)
  const thinkingEffort = choice.thinkingEffort ?? (job.effort && onCurrent ? effortFor(job.effort, catalog.models.find((model) => model.id === choice.model)) : undefined)
  return { model: choice.model, ...(thinkingEffort ? { thinkingEffort } : {}) }
}

/**
 * What an agent placed without a model starts on. A built-in job's text is copied verbatim when it
 * is placed, so an exact match is that job, and it gets the job's tier and effort; any other agent
 * gets the app's current model, as before.
 */
export function modelForRole(role: string, catalog: ModelCatalog): TierChoice | null {
  const job = ROLE_PRESETS.find((preset) => preset.role === role.trim())
  if (job) return modelForJob(job, catalog)
  const model = catalog.currentModelId ?? catalog.models[0]?.id
  return model ? { model } : null
}
