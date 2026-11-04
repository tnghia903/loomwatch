// The model the picker suggests for one agent, with why in one sentence or two.
//
// The same tiers a built-in job is placed on (ADR 0057, modelIds.ts), at the person's priority
// (ADR 0112: Saving, Balance or Highest quality), read off what the agent is now: its job from its
// name and instructions (checkup.ts `jobFor`), and, in a team, its place in it. A gatherer runs on
// the tier its priority gives gathering unless its reply is the team's answer; a check step reads on
// another maker's model than the work it checks (ADR 0062); the rest decide the result and get the
// strongest the priority gives. When the operator has reading on and the name and keywords can't
// place an agent, a reading of its whole setup (agentSetup.ts) says what kind of work it does
// instead, and that kind's tier comes from the same table; the team's shape still applies after it.
// Its thinking effort is the one the same table gives that kind of work (ADR 0062), as Ask and the
// templates give it: a check step thinks as the checker does, a built-in job as its own, and any
// other agent as a new one. Pure, so every case is testable without a picker.

import { type Effort, type ModelSource, type ModelTier, type Priority, NEW_AGENT, PRIORITY_NAMES, canonicalModel, currentPriority, currentSources, effortFor, jobFirstModel, jobKind, jobNeeds, jobTier, kindTier, makerSlug, modelForJobId, modelForTier, modelNameFromId, tierModel } from '../ai/modelIds'
import { isCheckerRole } from '../library/checker'
import { type SetupReading, type SuggestedAgent, trustedKind } from './agentSetup'
import { jobFor } from './checkup'
import type { AgentConfig } from './types'

export interface ModelSuggestion {
  model: string
  why: string
  /** The tier it is from (ADR 0057), which names the first-choice model before who pays for it. */
  tier: ModelTier
  /** The first-choice model, as an OpenRouter id, before who pays for it: a job's own pick at the priority (ADR 0112), else its tier's. */
  first: string
  /** How hard it thinks, from the same table as its tier, for a model that reasons. */
  effort: Effort
  /** Decided by reading the agent's whole setup, not its name and keywords. */
  read?: boolean
}

type Agent = Pick<AgentConfig, 'id' | 'name' | 'role' | 'model' | 'checks'>

export interface ModelSuggestionInput {
  agent: SuggestedAgent
  /** The team it sits in. Absent while it is built on its own, when its job decides alone. */
  team?: {
    agents: readonly Agent[]
    /** The agent whose reply is the team's answer. */
    responder: string | null
  }
  /** What reading its whole setup found, when that was on and needed. */
  reading?: SetupReading | null
  /**
   * The sources an agent can run on now (ADR 0073): each tier's model is paid by a connected plan
   * that offers it, else OpenRouter (modelForTier). Those last known when absent.
   */
  sources?: readonly ModelSource[]
  /** What agents' models lean to (ADR 0112). The person's, as last known, when absent. */
  priority?: Priority
}

const READ = 'Its configuration says'

export function suggestModel(input: ModelSuggestionInput): ModelSuggestion {
  const priority = input.priority ?? currentPriority()
  const suggestion = suggest({ ...input, priority })
  return { ...suggestion, first: suggestion.first ?? tierModel(suggestion.tier, priority) }
}

function suggest({ agent, team, reading, sources = currentSources(), priority = currentPriority() }: ModelSuggestionInput): Omit<ModelSuggestion, 'first'> & { first?: string } {
  const named = modelNameFromId
  const on = (tier: ModelTier) => modelForTier(tier, sources, undefined, priority)
  const DEFAULT_MODEL = on('strong')
  const FAST_MODEL = on('fast')
  const CHECK_MODEL = on('check')
  const job = jobFor(agent)
  const read = trustedKind(reading)
  const kind = read ?? (job ? jobKind(job.id) : undefined)
  const CHECK_EFFORT = effortFor(jobNeeds('checker').effort) as Effort
  const effort = effortFor(job?.effort ?? NEW_AGENT.effort) as Effort
  // Said as the priority has it: Saving's strong model is not the strongest there is, and its fast
  // model is the same one, so "faster" and "strongest" would both be untrue there.
  const atTop = tierModel('strong', priority) === tierModel('strong', 'quality')
  const oneModel = tierModel('fast', priority) === tierModel('strong', priority)
  const setting = `With your agents’ models on ${PRIORITY_NAMES[priority]}`
  const lowerCost = `${setting}, it gets a lower-cost model, as most agents do.`
  const gets = (tier: ModelTier) => tier === 'fast' && !oneModel
    ? `${setting}, it gets a faster model, for less.`
    : atTop ? 'That work decides the result, so it gets the strongest model.' : `That work decides the result. ${lowerCost}`

  if (agent.checks || isCheckerRole(agent.role) || kind === 'check') {
    const checked = agent.checks ? team?.agents.find((other) => other.id === agent.checks) : undefined
    if (checked) {
      const theirs = canonicalModel(checked.model)
      const same = makerSlug(theirs) === makerSlug(CHECK_MODEL)
      // Whose first choice it is: the check tier's own model, unless that one is the writer's maker
      // too. A plan's model standing in for it may share the maker; the picker says so (ModelPicker).
      const tier = makerSlug(theirs) === makerSlug(tierModel('check', priority)) ? 'strong' : 'check'
      const model = same ? DEFAULT_MODEL : CHECK_MODEL
      if (makerSlug(model) === makerSlug(theirs)) {
        return { model, tier, effort: CHECK_EFFORT, why: `It checks ${checked.name}’s work, written on ${named(theirs)}. A model from another maker would read it without sharing its blind spots, but none you’ve connected is, so ${atTop ? 'the strongest one you have' : 'the one most agents get'} checks it.` }
      }
      return { model, tier, effort: CHECK_EFFORT, why: `It checks ${checked.name}’s work, written on ${named(theirs)}. A model from another maker reads it without sharing its blind spots.` }
    }
    if (read === 'check' && !agent.checks && !isCheckerRole(agent.role)) {
      return { model: CHECK_MODEL, tier: 'check', effort: CHECK_EFFORT, why: `${READ} it checks other agents’ work. A model from another maker reads it without sharing the blind spots of the one that wrote it.`, read: true }
    }
    return { model: CHECK_MODEL, tier: 'check', effort: CHECK_EFFORT, why: 'It checks other agents’ work. A model from another maker reads it without sharing the blind spots of the one that wrote it.' }
  }

  if (kind === 'gather') {
    // A gathering job's own tier, as a placed Researcher would get; a reading's, its kind's.
    const tier = (!read && job ? jobTier(job.id, job.tier, priority) : undefined) ?? kindTier('gather', priority)
    if (team && team.responder === agent.id) {
      const cheaper = tier === 'fast' && !oneModel ? ` If it only gathered for another agent, ${named(FAST_MODEL)} would do for less.` : ''
      const answer = atTop ? 'Its reply is the team’s answer, so it gets the strongest model.' : `Its reply is the team’s answer. ${lowerCost}`
      return { model: DEFAULT_MODEL, tier: 'strong', effort, why: `${answer}${cheaper}`, ...(read ? { read: true } : {}) }
    }
    const writer = team?.responder ? team.agents.find((other) => other.id === team.responder)?.name : undefined
    const does = read ? `${READ} it gathers for ${writer ?? 'another agent'} rather than writing the answer.` : `It gathers facts for ${writer ?? 'another agent'} to write up.`
    const why = tier === 'fast' && !oneModel
      ? `${does} A faster model does that well, for less, and leaves the strongest one for the step that writes.`
      : tier === 'fast' || !atTop ? `${does} ${lowerCost}` : `${does} ${setting}, it gets the strongest model too.`
    return { model: on(tier), tier, effort, why, ...(read ? { read: true } : {}) }
  }

  if (read === 'produce') {
    const tier = kindTier('produce', priority)
    return { model: on(tier), tier, effort, why: `${READ} it makes or decides the result itself rather than gathering for another agent. ${gets(tier)}`, read: true }
  }

  if (job) {
    const tier = jobTier(job.id, job.tier, priority) ?? 'strong'
    const label = job.label.toLowerCase()
    const does = job.does.charAt(0).toLowerCase() + job.does.slice(1)
    const first = jobFirstModel(job.id, tier, priority)
    const model = modelForJobId(job.id, tier, sources, undefined, priority)
    // The priority's own pick for this job, where it does that work well for what it costs.
    const own = first !== tierModel(tier, priority)
    const why = own && model !== on(tier) ? `${setting}, it gets ${named(model)}, which does this work well for what it costs.` : gets(tier)
    return { model, tier, first, effort, why: `${/^[aeiou]/.test(label) ? 'An' : 'A'} ${label} ${does}. ${why}` }
  }

  const safe = atTop ? 'so the strongest all-rounder is the safe choice' : `so it gets what most agents get with your agents’ models on ${PRIORITY_NAMES[priority]}`
  return { model: DEFAULT_MODEL, tier: 'strong', effort, why: `Its name and instructions don’t say what kind of work it does, ${safe}.` }
}
