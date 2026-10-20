import { uniqueLabel } from '../composer-layout/types'
import type { AgentAllow, AgentConfig, CapabilityRef } from '../team-file/types'
import { onlyOn, toolAllowOf, versionOf, type JobSpec, type SavedJob } from './jobs'
import { knowledgeOf, readKey } from './reads'
import { capabilitiesOf } from './roles'
import { sameAllow } from '../tools/allow'

/**
 * A team's side of the versioned link to Your agents.
 *
 * A linked agent carries `from: {agent, version}` and a copy of that version's fields. What the
 * version decides is its name, instructions, model, skills and tools, what it reads in every team,
 * and what it may do without asking; where it works, what else the team gives it to read, and its
 * place in the team stay the team's own.
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
 * The fields to write on a team's agent to bring it to `job`'s current version. Where it works
 * stays; its skills and tools become the version's, and the canvas draws each tool as a card. What
 * the version reads is added to what the team gives it, and what `previous` (the version it
 * leaves, when known) read and this one doesn't is taken away; everything else the team gave it
 * stays. Its model becomes the version's when the version names one.
 */
export function fieldsForVersion(job: SavedJob, agent: AgentConfig, previous?: Pick<JobSpec, 'reads'> | null): Partial<AgentConfig> {
  const reads = knowledgeOf(job.reads ?? [])
  const leaving = new Set((previous?.reads ?? []).map(readKey))
  const coming = new Set(reads.map(readKey))
  const teams = (agent.capabilities ?? []).filter((capability) => capability.kind === 'knowledge' && !coming.has(readKey(capability)) && !leaving.has(readKey(capability)))
  // Each label once, as the team's cards are named: a version's read takes another if the team uses it.
  const taken = new Set(teams.map((capability) => capability.name))
  const added: CapabilityRef[] = reads.map((capability) => ({ ...capability, name: uniqueLabel(capability.name, taken) }))
  const capabilities = [...teams, ...added, ...capabilitiesOf(job.skills ?? [], job.tools ?? [], job.toolAllow ?? {})]
  const fields: Partial<AgentConfig> = {
    name: job.name,
    role: job.instructions,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    doneWhen: job.doneWhen?.length ? [...job.doneWhen] : undefined,
    allow: onlyOn(job.allow),
    allowRecruiting: job.helpers !== false,
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
  // The team may give it more to read; only something its version reads going missing is a change.
  const reads = new Set((agent.capabilities ?? []).filter((capability) => capability.kind === 'knowledge').map(readKey))
  if ((pinned.reads ?? []).some((read) => !reads.has(readKey(read)))) changed.push('what it reads')
  if ((agent.doneWhen ?? []).join('\n') !== (pinned.doneWhen ?? []).join('\n')) changed.push('done when')
  if ((agent.allowRecruiting !== false) !== (pinned.helpers !== false)) changed.push('helpers')
  const mine = onlyOn(agent.allow) ?? {}
  const theirs = onlyOn(pinned.allow) ?? {}
  if (SWITCHES.some((key) => Boolean(mine[key]) !== Boolean(theirs[key])) || !sameAllow(toolAllowOf(agent), pinned.toolAllow ?? {}, tools)) changed.push('what it may do without asking')
  return changed
}

/**
 * What a newer copy of an agent in My agents changes from the copy a team has, in the panel's
 * words, so Update says what it will bring. Its face is not here: a team never copies it.
 */
export function changedBetween(older: JobSpec, newer: JobSpec): string[] {
  const same = (a: readonly string[] = [], b: readonly string[] = []) => [...a].sort().join('\n') === [...b].sort().join('\n')
  const changed: string[] = []
  if (older.name.trim() !== newer.name.trim()) changed.push('name')
  if (older.instructions.trim() !== newer.instructions.trim()) changed.push('instructions')
  if ((older.model ?? '') !== (newer.model ?? '') || (older.thinkingEffort ?? '') !== (newer.thinkingEffort ?? '')) changed.push('model')
  if (!same(older.skills, newer.skills)) changed.push('skills')
  if (!same(older.tools, newer.tools)) changed.push('tools')
  if (!same((older.reads ?? []).map(readKey), (newer.reads ?? []).map(readKey))) changed.push('what it reads')
  if ((older.doneWhen ?? []).join('\n') !== (newer.doneWhen ?? []).join('\n')) changed.push('done when')
  const before = onlyOn(older.allow) ?? {}
  const after = onlyOn(newer.allow) ?? {}
  const tools = [...new Set([...(older.tools ?? []), ...(newer.tools ?? [])])]
  if (SWITCHES.some((key) => Boolean(before[key]) !== Boolean(after[key])) || !sameAllow(older.toolAllow ?? {}, newer.toolAllow ?? {}, tools)) changed.push('what it may do without asking')
  return changed
}
