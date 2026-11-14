import { guestOf } from '../chat/guests'
import { withAllowed, type AlwaysAllowed } from '../tools/allow'
import { fetchJobs, saveJob, versionOf, type JobSpec, type SavedJob } from './jobs'

/**
 * Bringing in another of My agents (ADR 0092): a team's starting agent, or an agent working alone,
 * may bring in one of the person's other agents for a part no one on the team does.
 *
 * How many of them a team lists when its file says nothing (`guards.myAgents`): the daemon's
 * `GuardsConfig::my_agents` default. It stays `0`, off, until the bench shows bringing in helps;
 * the change that turns it on changes both.
 */
export const MY_AGENTS_LISTED_BY_DEFAULT = 0

/** Whether bringing in is on unless a team turns it off, so the agent's own switch means something. */
export const BRINGING_IN_SHIPPED: boolean = MY_AGENTS_LISTED_BY_DEFAULT > 0

/**
 * "Always allow" for one of the person's agents a run brought in (`mine+<id>`): what it may do is
 * its own (ADR 0094), so the switch is turned on, or the call always allowed, on the agent in My
 * agents, for every team it works in. `null` when `agentId` isn't a guest; throws when the agent
 * is gone from My agents or the save is refused.
 */
export async function alwaysAllowGuest(agentId: string, what: AlwaysAllowed): Promise<SavedJob | null> {
  return changeGuest(agentId, (spec) => (typeof what === 'string'
    ? { ...spec, allow: { ...spec.allow, [what]: true } }
    : { ...spec, toolAllow: Object.fromEntries(Object.entries(withAllowed(spec.toolAllow ?? {}, what.tool, what.call)).map(([tool, calls]) => [tool, [...calls]])) }))
}

/**
 * A tool it suggested connecting, given to one of the person's agents a run brought in (ADR 0126):
 * what it is given is its own (ADR 0094), so the tool is added to the agent in My agents, for every
 * team it works in. `null` when `agentId` isn't a guest; throws when the agent is gone from My
 * agents or the save is refused.
 */
export async function giveToolToGuest(agentId: string, tool: string): Promise<SavedJob | null> {
  return changeGuest(agentId, (spec) => {
    const tools = spec.tools ?? []
    return tools.some((name) => name.toLowerCase() === tool.toLowerCase()) ? spec : { ...spec, tools: [...tools, tool] }
  })
}

/** Guest `agentId`'s agent in My agents, changed by `change` and saved over the version read. */
async function changeGuest(agentId: string, change: (spec: JobSpec) => JobSpec): Promise<SavedJob | null> {
  const id = guestOf(agentId)
  if (!id) return null
  const job = (await fetchJobs())?.jobs.find((candidate) => candidate.id === id)
  if (!job) throw new Error('That agent isn’t in My agents any more.')
  const { id: _id, file: _file, ...spec } = job
  const next = change(spec)
  // Nothing to change: no new version.
  if (next === spec) return job
  return saveJob(id, next, { replace: true, expectedVersion: versionOf(job) })
}
