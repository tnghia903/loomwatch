import type { DetectedHarness } from '../harnesses'
import { harnessIdForAgent } from '../models'
import type { AgentAllow, AgentConfig, CapabilityRef } from '../team-file/types'
import { onlyOn, savedJobPreset, versionOf, type JobSpec, type SavedJob } from './jobs'
import { harnessForRole } from './roles'

/**
 * A team's side of the versioned link to Your agents.
 *
 * A linked agent carries `from: {agent, version}` and a copy of that version's fields. What the
 * version decides is its name, instructions, app and model, skills, and what it may do without
 * asking; where it works, its knowledge and tools, and its place in the team stay the team's own.
 */

export interface AgentLinkState {
  /** The agent in Your agents, while it still exists there. */
  job: SavedJob | null
  /** The version this team copies. */
  version: number
  /** The newest version, while the agent still exists. */
  latest: number | null
  /** A newer version than this team's is ready. */
  behind: boolean
}

export function linkState(agent: AgentConfig, jobs: readonly SavedJob[]): AgentLinkState | null {
  if (!agent.from || agent.kind === 'operator') return null
  const job = jobs.find((candidate) => candidate.id === agent.from?.agent) ?? null
  const latest = job ? versionOf(job) : null
  return { job, version: agent.from.version, latest, behind: latest !== null && latest > agent.from.version }
}

/**
 * The fields to write on a team's agent to bring it to `job`'s current version. Its knowledge and
 * tools stay; its skills become the version's. Its app changes only when the version prefers an
 * installed app other than the one it runs on, and then its folder and environment stay.
 */
export function fieldsForVersion(job: SavedJob, agent: AgentConfig, harnesses: readonly DetectedHarness[]): Partial<AgentConfig> {
  const preset = savedJobPreset(job)
  const harness = harnessForRole(preset, harnesses)
  const currentApp = harnessIdForAgent(agent, harnesses)
  const own = (agent.capabilities ?? []).filter((capability) => capability.kind !== 'skill')
  const skills: CapabilityRef[] = (job.skills ?? []).map((name) => ({ kind: 'skill', name }))
  const capabilities = [...own, ...skills]
  const fields: Partial<AgentConfig> = {
    name: job.name,
    role: job.instructions,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    allow: onlyOn(job.allow),
    from: { agent: job.id, version: versionOf(job) },
  }
  if (harness && harness.id !== currentApp) {
    fields.spawn = { env: {}, cwd: '.', ...agent.spawn, cmd: harness.spawn.cmd, args: [...harness.spawn.args] }
    const ownModel = harness.id === preset.prefers[0] && Boolean(job.model)
    fields.model = ownModel ? job.model : ''
    fields.thinkingEffort = ownModel ? job.thinkingEffort : undefined
  } else if (job.model && currentApp !== null && currentApp === preset.prefers[0]) {
    // The effort goes with the model it belongs to.
    fields.model = job.model
    fields.thinkingEffort = job.thinkingEffort
  }
  return fields
}

const SWITCHES: readonly (keyof AgentAllow)[] = ['web', 'edits', 'commands']

/**
 * What this team changed on a linked agent since the version it copies, in words, or nothing. The
 * agent panel keeps those fields read-only while it is linked, but the canvas can still connect a
 * skill or retitle a card, and the panel must not claim "v3" for something that is no longer v3.
 */
export function changedHere(agent: AgentConfig, pinned: JobSpec): string[] {
  const changed: string[] = []
  if (agent.name.trim() !== pinned.name.trim()) changed.push('name')
  if (agent.role.trim() !== pinned.instructions.trim()) changed.push('instructions')
  const skills = (agent.capabilities ?? []).filter((capability) => capability.kind === 'skill').map((capability) => capability.name).sort()
  const pinnedSkills = [...(pinned.skills ?? [])].sort()
  if (skills.join('\n') !== pinnedSkills.join('\n')) changed.push('skills')
  const mine = onlyOn(agent.allow) ?? {}
  const theirs = onlyOn(pinned.allow) ?? {}
  if (SWITCHES.some((key) => Boolean(mine[key]) !== Boolean(theirs[key]))) changed.push('what it may do without asking')
  return changed
}
