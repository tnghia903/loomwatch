import type { AgentAllow, AgentConfig } from '../team-file/types'
import { onlyOn, toolAllowOf, versionOf, type JobSpec, type SavedJob } from './jobs'
import { capabilitiesOf } from './roles'
import { sameAllow } from '../tools/allow'

/**
 * A team's side of the versioned link to Your agents.
 *
 * A linked agent carries `from: {agent, version}` and a copy of that version's fields. What the
 * version decides is its name, instructions, model, skills and tools, and what it may do
 * without asking; where it works, what it reads, and its place in the team stay the team's own.
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
 * The fields to write on a team's agent to bring it to `job`'s current version. What it reads and
 * where it works stay; its skills and tools become the version's, and the canvas draws each tool
 * as a card. Its model becomes the version's when the version names one.
 */
export function fieldsForVersion(job: SavedJob, agent: AgentConfig): Partial<AgentConfig> {
  const own = (agent.capabilities ?? []).filter((capability) => capability.kind === 'knowledge')
  const capabilities = [...own, ...capabilitiesOf(job.skills ?? [], job.tools ?? [], job.toolAllow ?? {})]
  const fields: Partial<AgentConfig> = {
    name: job.name,
    role: job.instructions,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    doneWhen: job.doneWhen?.length ? [...job.doneWhen] : undefined,
    allow: onlyOn(job.allow),
    from: { agent: job.id, version: versionOf(job) },
  }
  if (job.model) {
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
  const tools = [...new Set((agent.capabilities ?? []).filter((capability) => capability.kind === 'tool').map((capability) => capability.name))].sort()
  if (tools.join('\n') !== [...(pinned.tools ?? [])].sort().join('\n')) changed.push('tools')
  if ((agent.doneWhen ?? []).join('\n') !== (pinned.doneWhen ?? []).join('\n')) changed.push('done when')
  const mine = onlyOn(agent.allow) ?? {}
  const theirs = onlyOn(pinned.allow) ?? {}
  if (SWITCHES.some((key) => Boolean(mine[key]) !== Boolean(theirs[key])) || !sameAllow(toolAllowOf(agent), pinned.toolAllow ?? {}, tools)) changed.push('what it may do without asking')
  return changed
}
