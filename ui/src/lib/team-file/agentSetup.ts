// An agent's whole setup, as the model suggestion reads it, and whether reading it is worth a call.
//
// The suggestion reads an agent's job off its name and a few words of its instructions for free
// (checkup.ts `jobFor`). That misreads instructions such as "Do not write the digest": the word
// "write" makes a gatherer a writer. With the operator's say-so, the daemon can have a small model
// on OpenRouter read the whole setup instead (`crates/loomwatch-backend/src/ai/reading.rs`), which
// costs a little of their credit each time. `needsReading` keeps that to the agents the free
// reading can't place: a fact in the team file, a built-in job's own instructions, or a name that
// says the job plainly answers for free. Pure, so every case is testable.

import { OFFLINE_MODEL } from '../ai/modelIds'
import { baseName } from '../files/paths'
import { isCheckerRole } from '../library/checker'
import type { AgentDraft } from '../library/draft'
import { THIN_WORDS, jobByName, keptJob, words } from './checkup'
import type { AgentConfig } from './types'

/** An agent as the suggestion sees it: a team's, or one of Your agents being built. */
export type SuggestedAgent = Pick<AgentConfig, 'id' | 'name' | 'role' | 'checks'>
  & Partial<Pick<AgentConfig, 'model' | 'doneWhen' | 'capabilities' | 'allow' | 'allowRecruiting'>>

/**
 * What is sent to be read: the agent's own setup, by name only. Never a skill's text, a file, the
 * team's Brief or who its teammates are; the team's shape is applied after, by rules.
 */
export interface AgentSetup {
  name: string
  instructions: string
  doneWhen: string[]
  skills: string[]
  tools: string[]
  /** The folders, files and Notion pages it reads, by their labels. */
  reads: string[]
  /** What it may do without asking: `web`, `edits`, `commands`. */
  allow: string[]
  /** It may hand work to helpers it takes on during a run. */
  recruits: boolean
}

/** One of Your agents being built, as the suggestion sees it. */
export function suggestedOfDraft(draft: Pick<AgentDraft, 'name' | 'instructions' | 'model' | 'doneWhen' | 'skills' | 'tools' | 'reads' | 'allow'>): SuggestedAgent {
  return {
    id: '', name: draft.name, role: draft.instructions, model: draft.model, doneWhen: draft.doneWhen, allow: draft.allow,
    capabilities: [
      ...draft.skills.map((name) => ({ kind: 'skill' as const, name })),
      ...draft.tools.map((name) => ({ kind: 'tool' as const, name })),
      ...draft.reads.map((read) => ({ kind: 'knowledge' as const, name: read.name })),
    ],
  }
}

export function setupOf(agent: SuggestedAgent): AgentSetup {
  const named = (kind: 'skill' | 'tool' | 'knowledge') => (agent.capabilities ?? []).filter((capability) => capability.kind === kind).map((capability) => capability.name.trim()).filter(Boolean)
  return {
    name: agent.name.trim(),
    instructions: agent.role.trim(),
    doneWhen: (agent.doneWhen ?? []).map((item) => item.trim()).filter(Boolean),
    skills: named('skill'),
    tools: named('tool'),
    // A label is a name, but a team file can hold any text there: one that is a path goes as its
    // last name, so no folder's path leaves this computer.
    reads: named('knowledge').map((label) => (/[\\/]/.test(label) ? baseName(label) : label)),
    allow: Object.entries(agent.allow ?? {}).filter(([, on]) => on === true).map(([key]) => key).sort(),
    recruits: agent.allowRecruiting === true,
  }
}

/** The kinds of work a reading tells apart, the same tiers a built-in job is placed on (ADR 0057). */
export const JOB_KINDS = ['gather', 'produce', 'check'] as const
export type JobKind = (typeof JOB_KINDS)[number]

/** What reading an agent's whole setup found: the kind of work it does, and how sure it is of each. */
export interface SetupReading {
  kind: JobKind
  /** Each kind's probability; together about 1. */
  probabilities: Partial<Record<JobKind, number>>
  /** How sure the reading is overall, 0 to 1, when it says. */
  confidence?: number
}

/** How sure a reading must be before it changes a suggestion. Moving an agent to the faster model
    risks the result, so that takes more than keeping it on the strongest. */
export const READING_MIN = 0.6
export const GATHER_MIN = 0.75

/** The kind a reading is sure enough of to act on; undefined when it is not. */
export function trustedKind(reading: SetupReading | null | undefined): JobKind | undefined {
  if (!reading) return undefined
  // The Decisions API may leave the probabilities out; then how sure it is overall stands in.
  const probability = reading.probabilities[reading.kind] ?? reading.confidence ?? 0
  if (probability < (reading.kind === 'gather' ? GATHER_MIN : READING_MIN)) return undefined
  if (reading.confidence !== undefined && reading.confidence < 0.5) return undefined
  return reading.kind
}

/** "Do not write them", "never judge": a job named only to say it isn't this agent's. */
const NOT_MY_JOB = /\b(do not|don['’]t|never|not)\b[^.\n]{0,40}\b(research|writ|edit|review|critic|cod|develop|design|analy|lead|teach|judge|check)/i

/**
 * Whether the free reading can't place this agent, so reading its whole setup could change the
 * suggestion. False whenever a fact decides: it is a check step, it holds a built-in job's own
 * instructions, it has too few words to read, it runs the offline demo, or its name names a job
 * and its instructions never say the job is someone else's.
 */
export function needsReading(agent: SuggestedAgent): boolean {
  if (agent.model === OFFLINE_MODEL) return false
  if (agent.checks || isCheckerRole(agent.role)) return false
  if (keptJob(agent.role)) return false
  if (words(agent.role).length < THIN_WORDS) return false
  return !jobByName(agent.name) || NOT_MY_JOB.test(agent.role)
}
