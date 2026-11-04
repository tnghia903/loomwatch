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
// on, at each priority a person can choose (ADR 0112). The daemon reads the same file for Ask, so
// templates, the builder, new agents, model suggestions and the teams Ask writes all choose alike.

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

/** What a built-in job needs: its model tier and how hard it thinks. `id` names the job, for its own pick at a priority. */
export interface JobNeeds {
  id?: string
  tier?: ModelTier
  effort?: EffortTier
}

/** The model the built-in job `job` names first at `priority`, as an OpenRouter id: its own pick there, else its tier's. */
export function jobFirstModel(job: string | undefined, tier: ModelTier | undefined, priority: Priority = priorityNow): string {
  return (job && CHANGES[priority]?.jobModels?.[job]) || tierModel(tier ?? 'strong', priority)
}

/**
 * The model the built-in job `job` runs on at `priority` (ADR 0112): the priority's own pick for it,
 * paid as a tier's model is, when something connected can run it (or nothing is connected yet);
 * else its tier's. The daemon's `ModelTiers::job_model_on` is the same.
 */
export function modelForJobId(job: string | undefined, tier: ModelTier | undefined, sources: readonly ModelSource[] = connectedNow, offers: Offers = offeredNow, priority: Priority = priorityNow): string {
  const pick = job ? CHANGES[priority]?.jobModels?.[job] : undefined
  const placed = pick ? (sources.length === 0 ? pick : placeModel(pick, sources, offers)) : undefined
  return placed ?? modelForTier(tier, sources, offers, priority)
}

/** The kind of work the built-in job `job` does: the table names the jobs that gather or check; every other job produces. */
export function jobKind(job: string): 'gather' | 'produce' | 'check' {
  const kind = (tiers.jobs as Record<string, { kind?: string } | undefined>)[job]?.kind
  return kind === 'gather' || kind === 'check' ? kind : 'produce'
}

/** The effort an effort tier asks of a model that reasons. */
export function effortFor(tier: EffortTier | undefined): Effort | undefined {
  return tier ? (tiers.efforts[tier] as Effort) : undefined
}

/**
 * What agents' models lean to (ADR 0112): less spent, a balance, or the best answer whatever it
 * costs. The person sets it; the daemon keeps it and says it with the sources (`GET /api/ai`).
 */
export type Priority = 'saving' | 'balance' | 'quality'

/** Every priority, least spent first: the slider's stops. */
export const PRIORITIES: readonly Priority[] = ['saving', 'balance', 'quality']

/** Each priority as the slider names it. The daemon's `Priority::label` says the same to Ask. */
export const PRIORITY_NAMES: Readonly<Record<Priority, string>> = { saving: 'Saving', balance: 'Balanced', quality: 'Highest quality' }

/** What a new install starts on. */
export const DEFAULT_PRIORITY = tiers.defaultPriority as Priority

/** What a priority changes from Highest quality's table, which is the table's top. */
interface PriorityChanges {
  models?: Partial<Record<ModelTier, string>>
  bySource?: Partial<Record<'chatgpt' | 'anthropic', Partial<Record<ModelTier, string>>>>
  jobs?: Record<string, ModelTier>
  kinds?: Partial<Record<WorkKind, ModelTier>>
  /** A job's own model, where it does that work nearly as well for much less: job → OpenRouter id. */
  jobModels?: Record<string, string>
}

const CHANGES = tiers.priorities as Partial<Record<Priority, PriorityChanges>>

// The sources connected now, as the daemon last said (useKeyStatus.ts sets them), the models each
// plan offers, and what agents' models lean to. A new agent, a template and a suggestion place each
// tier's model on them.
let connectedNow: readonly ModelSource[] = []
let offeredNow: Offers = {}
let priorityNow: Priority = DEFAULT_PRIORITY

/** What `modelForTier` leans to from now on, as the daemon said or the person just chose. */
export function setPriority(priority: Priority) {
  priorityNow = priority
}

/** What agents' models lean to, as last known. */
export function currentPriority(): Priority {
  return priorityNow
}

/** The models each plan offers, as selectors (`anthropic:claude-opus-5-5`); a plan not named offers whatever its maker makes. */
export type Offers = Partial<Record<ModelSource, readonly string[]>>

/** What `modelForTier` reads: the sources an agent can run on now, and what each plan offers. */
export function setConnectedSources(sources: readonly ModelSource[], offers: Offers = {}) {
  connectedNow = sources
  offeredNow = offers
}

/** The sources an agent can run on now, as last known. */
export function currentSources(): readonly ModelSource[] {
  return connectedNow
}

/** What each connected plan offers, as last known. */
export function currentOffers(): Offers {
  return offeredNow
}

const BY_SOURCE = tiers.bySource as Record<'chatgpt' | 'anthropic', Record<ModelTier, string>>
const PREFERENCE = tiers.preference as Record<ModelTier, ModelSource[]>

/** The plans that can pay for a model of their own maker's: the Claude credit, the ChatGPT plan. */
const PLANS = ['anthropic', 'chatgpt'] as const

/** The connected plan that offers `model` (an OpenRouter id), as that plan's selector. */
export function planFor(model: string, sources: readonly ModelSource[] = connectedNow, offers: Offers = offeredNow): string | undefined {
  const reference: ModelRef = { source: 'openrouter', id: model }
  for (const plan of PLANS) {
    if (!sources.includes(plan)) continue
    const on = modelOn(reference, plan)
    if (!on) continue
    const selector = modelSelector(on)
    if (!offers[plan] || offers[plan].includes(selector)) return selector
  }
  return undefined
}

/** The model a tier names first at `priority`, as an OpenRouter id, before who pays for it is settled. */
export function tierModel(tier: ModelTier, priority: Priority = priorityNow): string {
  return CHANGES[priority]?.models?.[tier] ?? tiers.models[tier]
}

/** A plan's own model for `tier` at `priority`, standing in when nothing connected can run the tier's first choice. */
function standIn(plan: 'anthropic' | 'chatgpt', tier: ModelTier, priority: Priority): string {
  return CHANGES[priority]?.bySource?.[plan]?.[tier] ?? BY_SOURCE[plan][tier]
}

/** The plan that could pay for `model` (an OpenRouter id) if it were connected: its maker's. */
export function coveringPlan(model: string): 'anthropic' | 'chatgpt' | undefined {
  return PLANS.find((plan) => modelOn({ source: 'openrouter', id: model }, plan) !== undefined)
}

/**
 * Who pays for `model`, an OpenRouter id (ADR 0073, ruled 2026-10-19): a connected plan that offers
 * it (the Claude credit for Anthropic's models, the ChatGPT plan for OpenAI's), else OpenRouter when
 * its key is in. Undefined when neither can run it.
 */
export function placeModel(model: string, sources: readonly ModelSource[] = connectedNow, offers: Offers = offeredNow): string | undefined {
  return planFor(model, sources, offers) ?? (sources.includes('openrouter') ? model : undefined)
}

/**
 * The model a tier runs on at `priority`. The tier names the model first (the table's `models`, as
 * the priority changes them), and then who pays: a connected plan that offers it, else OpenRouter.
 * Only when neither can run it does the tier take a connected plan's own model for it (`bySource`),
 * so an agent made with just a ChatGPT plan still runs. With nothing connected it is the OpenRouter
 * model, as it always was. The daemon's `ModelTiers::model_on_at` is the same.
 */
export function modelForTier(tier: ModelTier | undefined, sources: readonly ModelSource[] = connectedNow, offers: Offers = offeredNow, priority: Priority = priorityNow): string {
  const wanted = tier ?? 'strong'
  const model = tierModel(wanted, priority)
  const placed = placeModel(model, sources, offers)
  if (placed) return placed
  const plan = PREFERENCE[wanted].find((source): source is 'anthropic' | 'chatgpt' => source !== 'openrouter' && sources.includes(source))
  return plan ? standIn(plan, wanted, priority) : model
}

/** The tier whose model `model` is at `priority` on any source, if it is one of the table's. */
export function tierOfModel(model: string, priority: Priority = priorityNow): ModelTier | null {
  const selector = canonicalModel(model)
  for (const tier of ['strong', 'fast', 'check'] as const) {
    if (tierModel(tier, priority) === selector) return tier
    if (standIn('chatgpt', tier, priority) === selector || standIn('anthropic', tier, priority) === selector) return tier
  }
  return null
}

/**
 * The kinds of work a model suggestion tells apart (lib/team-file/agentSetup.ts): `gather` for an
 * agent that only collects for another, `produce` for one that makes or decides the result,
 * `check` for a check step.
 */
export type WorkKind = 'gather' | 'produce' | 'check'

/** The tier a kind of work runs on at `priority`. */
export function kindTier(kind: WorkKind, priority: Priority = priorityNow): ModelTier {
  return CHANGES[priority]?.kinds?.[kind] ?? (tiers.kinds[kind] as ModelTier)
}

/**
 * The tier the built-in job `job` runs on at `priority`: what the priority changes, else `base`,
 * the job's tier as Highest quality has it (a placed job's own `tier`).
 */
export function jobTier(job: string, base: ModelTier | undefined, priority: Priority = priorityNow): ModelTier | undefined {
  return CHANGES[priority]?.jobs?.[job] ?? base
}

/** Who made `model`, as OpenRouter names the maker: `anthropic`, `openai`. */
export function makerSlug(model: string): string {
  return (openRouterEquivalent(parseModelRef(model)).split('/')[0] ?? '').replace(/^~/, '')
}

/** What an agent made from nothing needs: the strong tier, at the standard effort. */
export const NEW_AGENT: JobNeeds = tiers.newAgent as JobNeeds

/** What a built-in job needs at `priority`, from the table. Every built-in job is in it. */
export function jobNeeds(job: string, priority: Priority = priorityNow): Required<Omit<JobNeeds, 'id'>> {
  const needs = (tiers.jobs as Record<string, Required<Omit<JobNeeds, 'id'>> | undefined>)[job]
  if (!needs) throw new Error(`schemas/model-tiers.json has no job ${job}`)
  return { tier: jobTier(job, needs.tier, priority) as ModelTier, effort: needs.effort }
}

/** The model and effort a built-in job starts on, at the person's priority: its own pick there when `id` names one. */
export function modelForJob(job: JobNeeds): { model: string; thinkingEffort?: Effort } {
  const thinkingEffort = effortFor(job.effort)
  return { model: modelForJobId(job.id, job.tier), ...(thinkingEffort ? { thinkingEffort } : {}) }
}
