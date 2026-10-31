import builtInJobs from '../../../../schemas/built-in-jobs.json'
import { jobNeeds, modelForJob, type EffortTier, type ModelTier } from '../ai/modelIds'
import type { AgentAllow, AgentLink, CapabilityRef } from '../team-file/types'
import { callsFor, type ToolAllow } from '../tools/allow'
import { knowledgeOf, type AgentRead } from './reads'
import type { LibrarySource } from './types'

/**
 * Helpers by job, for the Build palette.
 *
 * A newcomer does not know which model is good at what; they know they need a researcher. A job
 * adds an agent that already has useful instructions, on the model its kind of work suits, so the
 * first thing placed on the canvas can run. The model stays an ordinary, editable choice in the
 * agent's settings — a job is a starting point, never a lock.
 *
 * Every built-in job's instructions follow one shape (ADR 0030): who the agent is and what it does
 * not do, how to work, how it checks its work before it replies (ADR 0062), what to hand back. The
 * check is concrete (re-open the source, run the tests, recount) because a model asked only to
 * "review your answer" tends to approve it. The hand-back matters most: in a pipeline the next agent
 * receives this reply verbatim under "Results from preceding stages", so each job says exactly what
 * it returns. Each one also works as the first step, when nothing was handed to it.
 *
 * Operators save their own jobs from an agent that worked (`jobs.ts`); those arrive here as presets
 * too, and are placed exactly the same way.
 */
export type RoleIcon = 'research' | 'write' | 'edit' | 'review' | 'code' | 'design' | 'analyse' | 'slides' | 'document' | 'sheet' | 'chart' | 'dashboard' | 'video'

export type { EffortTier, ModelTier }

export const ROLE_ICON_IDS: readonly RoleIcon[] = ['research', 'write', 'edit', 'review', 'code', 'design', 'analyse', 'slides', 'document', 'sheet', 'chart', 'dashboard', 'video']

export interface RolePreset {
  id: string
  label: string
  /** What the helper does, in five words or so; shown under the name. */
  does: string
  role: string
  /** Absent on a saved job that names none; the palette draws a plain mark. */
  icon?: RoleIcon
  /** A saved job's model: the OpenRouter id it was saved with. */
  model?: string
  /** That model's thinking effort, applied with it. */
  thinkingEffort?: string
  /** A built-in job's effort tier (ADR 0062). */
  effort?: EffortTier
  /** A built-in job's model tier (ADR 0057; `modelIds.ts`). */
  tier?: ModelTier
  /** What the job's finished result must satisfy, checkable from the result alone (ADR 0062). */
  doneWhen?: readonly string[]
  /** Skill names the agent is given (ADR 0031). */
  skills?: readonly string[]
  /** Tools connected in LoomWatch, by name, the agent is given; only Your agents carry any. */
  tools?: readonly string[]
  /** Calls of those tools it may make without asking, by tool name (ADR 0069). */
  toolAllow?: ToolAllow
  /** Folders, files and Notion pages it reads in every team; only Your agents carry any. */
  reads?: readonly AgentRead[]
  /** What the agent may do without asking from the start (ADR 0037). Only what the job cannot be
      done without: a researcher that cannot search the web can only guess. */
  allow?: AgentAllow
  /** `false` on one of Your agents that brings in no helpers (ADR 0079). */
  helpers?: false
  /** `false` on one of Your agents that brings in none of My agents (ADR 0092). */
  bringsIn?: false
  /** Set on one of Your agents: the agent it places links back to this version of it. */
  from?: AgentLink
}

/** A job as `schemas/built-in-jobs.json` writes it: its role as its lines, its tiers by its id. */
interface BuiltInJob {
  id: string
  label: string
  does: string
  icon: string
  allow?: AgentAllow
  doneWhen: string[]
  role: string[]
}

const isRoleIcon = (icon: string): icon is RoleIcon => (ROLE_ICON_IDS as readonly string[]).includes(icon)

/** One built-in job as the palette places it, on its tiers from `schemas/model-tiers.json`. */
function presetOf(job: BuiltInJob): RolePreset {
  if (!isRoleIcon(job.icon)) throw new Error(`schemas/built-in-jobs.json gives ${job.id} an icon the app doesn't draw: ${job.icon}`)
  return {
    id: job.id, label: job.label, does: job.does, icon: job.icon, ...jobNeeds(job.id),
    ...(job.allow ? { allow: job.allow } : {}),
    doneWhen: job.doneWhen,
    role: job.role.join('\n'),
  }
}

/**
 * The built-in jobs, from `schemas/built-in-jobs.json`: the one list the daemon also reads, for
 * the jobs Ask LoomWatch builds teams from (ADR 0096). The Checker's role is also `CHECKER_ROLE`
 * (`checker.ts`), which tells a placed Checker apart.
 */
export const ROLE_PRESETS: readonly RolePreset[] = (builtInJobs.jobs as BuiltInJob[]).map(presetOf)

/** The model and effort a job places its agent on: a saved job's own, else its tiers'. */
export function modelForPreset(preset: RolePreset): { model: string; thinkingEffort?: string } {
  if (preset.model) return { model: preset.model, ...(preset.thinkingEffort ? { thinkingEffort: preset.thinkingEffort } : {}) }
  return modelForJob(preset)
}

/**
 * What it reads, its skills and its tools as a team agent's `capabilities`: what placing an agent,
 * or the test bench, writes. Each tool carries the calls it may make without asking (ADR 0069).
 */
export function capabilitiesOf(skills: readonly string[], tools: readonly string[], toolAllow: ToolAllow = {}, reads: readonly AgentRead[] = []): CapabilityRef[] {
  return [
    ...knowledgeOf(reads),
    ...skills.map((name) => ({ kind: 'skill' as const, name })),
    ...tools.map((name) => {
      const calls = callsFor(toolAllow, name)
      return { kind: 'tool' as const, name, ...(calls.length ? { alwaysAllow: calls } : {}) }
    }),
  ]
}

/** The Library payload that places this job as an agent. */
export function roleSource(preset: RolePreset): LibrarySource {
  return {
    group: 'presets',
    id: `role-${preset.id}`,
    label: preset.label,
    role: preset.role,
    ...modelForPreset(preset),
    ...(preset.skills?.length || preset.tools?.length || preset.reads?.length ? { capabilities: capabilitiesOf(preset.skills ?? [], preset.tools ?? [], preset.toolAllow ?? {}, preset.reads ?? []) } : {}),
    ...(preset.doneWhen?.length ? { doneWhen: [...preset.doneWhen] } : {}),
    ...(preset.allow ? { allow: { ...preset.allow } } : {}),
    ...(preset.helpers === false ? { helpers: false as const } : {}),
    ...(preset.bringsIn === false ? { bringsIn: false as const } : {}),
    ...(preset.from ? { from: { ...preset.from } } : {}),
  }
}
