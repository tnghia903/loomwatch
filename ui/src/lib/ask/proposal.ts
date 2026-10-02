// What a proposed team file changes, in the words the panel and the canvas use for it. The
// proposal is a whole file; the person reads the difference from what they have now.
import { TeamFileModel } from '../team-file/document'
import { pipelineOrder } from '../team-file/pipelineOrder'
import { summarizeSchedule } from '../team-file/schedule'
import type { AgentConfig, TeamDocument } from '../team-file/types'

export interface ProposalChanges {
  /** Agent ids the proposal adds, in the order the team runs them. */
  added: string[]
  /** Agent ids whose job, app, model or kind the proposal changes. */
  changed: string[]
  /** Names of the agents the proposal takes away (they are no longer on the canvas to name). */
  removed: string[]
  /** Plain sentences, most important first. */
  lines: string[]
  /** The proposed team's agents in run order, by name. */
  order: string[]
}

function parse(yaml: string | null | undefined): TeamDocument | null {
  if (!yaml) return null
  try {
    return TeamFileModel.parse(yaml).snapshot()
  } catch {
    return null
  }
}

function agentsOf(team: TeamDocument | null): AgentConfig[] {
  return Array.isArray(team?.agents) ? team.agents : []
}

function nameOf(agent: AgentConfig): string {
  return agent.kind === 'operator' ? `${agent.name || 'You'} (review)` : agent.name || agent.id
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function runOrder(team: TeamDocument | null): AgentConfig[] {
  const agents = agentsOf(team)
  const edges = Array.isArray(team?.edges) ? team.edges.filter((edge) => edge.layer !== 'observed').map((edge) => ({ from: edge.from, to: edge.to })) : []
  const steps = pipelineOrder(agents.map((agent) => agent.id), edges, team?.entrypoint || null)
  // With no connections there is no pipeline order: the first agent leads and the rest follow
  // in the order the file lists them.
  const ids = steps.length > 0 ? steps.map((step) => step.id)
    : [...agents.filter((agent) => agent.id === team?.entrypoint), ...agents.filter((agent) => agent.id !== team?.entrypoint)].map((agent) => agent.id)
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  return ids.map((id) => byId.get(id)).filter((agent): agent is AgentConfig => Boolean(agent))
}

/**
 * The difference between the team as it is (`currentYaml`, null for a new team) and the proposal.
 * Only what a person would notice is reported: who joins, who leaves, whose job changes, the order,
 * and the schedule.
 */
export function proposalChanges(currentYaml: string | null, proposedYaml: string): ProposalChanges {
  const before = parse(currentYaml)
  const after = parse(proposedYaml)
  const ordered = runOrder(after)
  const order = ordered.map(nameOf)
  const was = new Map(agentsOf(before).map((agent) => [agent.id, agent]))
  const now = new Map(agentsOf(after).map((agent) => [agent.id, agent]))
  const added = ordered.filter((agent) => !was.has(agent.id)).map((agent) => agent.id)
  const removed = agentsOf(before).filter((agent) => !now.has(agent.id)).map(nameOf)
  const changed: string[] = []
  const lines: string[] = []

  if (!before) {
    if (order.length > 0) lines.push(`${order.length} step${order.length === 1 ? '' : 's'}: ${order.join(' → ')}`)
  } else {
    if (added.length > 0) lines.push(`Adds ${list(added.map((id) => nameOf(now.get(id) as AgentConfig)))}`)
    for (const agent of ordered) {
      const previous = was.get(agent.id)
      if (!previous) continue
      const what: string[] = []
      if ((previous.name || '') !== (agent.name || '')) what.push('name')
      if ((previous.role || '') !== (agent.role || '')) what.push(agent.kind === 'operator' ? 'question' : 'job')
      if (!same(previous.spawn, agent.spawn)) what.push('AI app')
      if ((previous.model || '') !== (agent.model || '')) what.push('model')
      if ((previous.kind || 'harness') !== (agent.kind || 'harness')) what.push('kind')
      if (what.length > 0) {
        changed.push(agent.id)
        lines.push(`Changes ${nameOf(agent)}’s ${list(what)}`)
      }
    }
    if (removed.length > 0) lines.push(`Removes ${list(removed)}`)
    const orderBefore = runOrder(before).map((agent) => agent.id)
    const orderAfter = ordered.map((agent) => agent.id)
    const kept = orderAfter.filter((id) => orderBefore.includes(id))
    if (!same(kept, orderBefore.filter((id) => orderAfter.includes(id)))) lines.push(`New order: ${order.join(' → ')}`)
  }
  if (!same(before?.schedule, after?.schedule)) {
    if (after?.schedule) lines.push(`Runs on its own: ${summarizeSchedule(after.schedule).toLowerCase()}`)
    else if (before?.schedule) lines.push('Stops running on a schedule')
  }
  if (before && lines.length === 0) lines.push('Small changes to the team file')
  return { added, changed, removed, lines, order }
}
