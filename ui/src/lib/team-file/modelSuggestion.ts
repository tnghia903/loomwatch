// The model the picker suggests for one agent, with why in one sentence or two.
//
// The same tiers a built-in job is placed on (ADR 0057, modelIds.ts), read off what the agent is
// now: its job from its name and instructions (checkup.ts `jobFor`), and, in a team, its place in
// it. A gatherer runs on the faster model unless its reply is the team's answer; a check step reads
// on another maker's model than the work it checks (ADR 0062); the rest decide the result and get
// the strongest. When the operator has reading on and the name and keywords can't place an agent,
// a reading of its whole setup (agentSetup.ts) says what kind of work it does instead; the team's
// shape still applies after it. Pure, so every case is testable without a picker.

import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL, modelNameFromId, canonicalModel } from '../ai/modelIds'
import { isCheckerRole } from '../library/checker'
import { type SetupReading, type SuggestedAgent, trustedKind } from './agentSetup'
import { jobFor } from './checkup'
import type { AgentConfig } from './types'

export interface ModelSuggestion {
  model: string
  why: string
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
}

const maker = (id: string) => id.split('/')[0] ?? ''
const READ = 'Its configuration says'

export function suggestModel({ agent, team, reading }: ModelSuggestionInput): ModelSuggestion {
  const named = modelNameFromId
  const job = jobFor(agent)
  const read = trustedKind(reading)

  if (agent.checks || isCheckerRole(agent.role) || (read ? read === 'check' : job?.tier === 'check')) {
    const checked = agent.checks ? team?.agents.find((other) => other.id === agent.checks) : undefined
    if (checked) {
      const theirs = canonicalModel(checked.model)
      const model = maker(theirs) === maker(CHECK_MODEL) ? DEFAULT_MODEL : CHECK_MODEL
      return { model, why: `It checks ${checked.name}’s work, written on ${named(theirs)}. A model from another maker reads it without sharing its blind spots.` }
    }
    if (read === 'check' && !agent.checks && !isCheckerRole(agent.role)) {
      return { model: CHECK_MODEL, why: `${READ} it checks other agents’ work. A model from another maker reads it without sharing the blind spots of the one that wrote it.`, read: true }
    }
    return { model: CHECK_MODEL, why: 'It checks other agents’ work. A model from another maker reads it without sharing the blind spots of the one that wrote it.' }
  }

  if (read ? read === 'gather' : job?.tier === 'fast') {
    if (team && team.responder === agent.id) {
      return { model: DEFAULT_MODEL, why: `Its reply is the team’s answer, so it gets the strongest model. If it only gathered for another agent, ${named(FAST_MODEL)} would do for less.` }
    }
    const writer = team?.responder ? team.agents.find((other) => other.id === team.responder)?.name : undefined
    if (read) {
      return { model: FAST_MODEL, why: `${READ} it gathers for ${writer ?? 'another agent'} rather than writing the answer. A faster model does that well, for less, and leaves the strongest one for the step that writes.`, read: true }
    }
    return { model: FAST_MODEL, why: `It gathers facts for ${writer ?? 'another agent'} to write up. A faster model does that well, for less, and leaves the strongest one for the step that writes.` }
  }

  if (read === 'produce') {
    return { model: DEFAULT_MODEL, why: `${READ} it makes or decides the result itself rather than gathering for another agent. That work decides the result, so it gets the strongest model.`, read: true }
  }

  if (job) {
    const label = job.label.toLowerCase()
    const does = job.does.charAt(0).toLowerCase() + job.does.slice(1)
    return { model: DEFAULT_MODEL, why: `${/^[aeiou]/.test(label) ? 'An' : 'A'} ${label} ${does}. That work decides the result, so it gets the strongest model.` }
  }

  return { model: DEFAULT_MODEL, why: 'Its name and instructions don’t say what kind of work it does, so the strongest all-rounder is the safe choice.' }
}
