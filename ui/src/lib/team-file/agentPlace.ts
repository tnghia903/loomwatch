// What an agent is told about where it sits in its team, in the operator's words.
//
// The daemon writes `## Your place in the team` into the agent's opening prompt from the same
// facts (crates/loomwatch-backend/src/orientation.rs, ADR 0034); this is the panel's one-line
// mirror of it. Pure and framework-free like pipelineOrder.ts.

import type { EdgeEndpoints, PipelineStep } from './pipelineOrder'

export interface PlaceNode {
  id: string
  name: string
  kind?: 'harness' | 'operator'
}

export interface AgentPlaceInput {
  agentId: string
  nodes: readonly PlaceNode[]
  edges: readonly EdgeEndpoints[]
  steps: readonly PipelineStep[]
  entrypoint: string | null
  responder: string | null
  pipeline: boolean
}

export interface AgentPlace {
  /** One sentence: where this agent sits and what it hands on. */
  summary: string
  /** Its answer is the team's output. */
  final: boolean
  /** It can be made the team's starting agent without breaking the pipeline's edges. */
  canStart: boolean
}

export function agentPlace({ agentId, nodes, edges, steps, entrypoint, responder, pipeline }: AgentPlaceInput): AgentPlace {
  const name = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id)
    return node?.kind === 'operator' ? 'your review' : node?.name ?? id
  }
  const isStart = agentId === entrypoint
  const final = agentId === responder
  const agents = nodes.filter((node) => node.kind !== 'operator')

  if (!pipeline) {
    if (agents.length <= 1) return { summary: 'The only agent: it receives your request and writes the answer.', final: true, canStart: false }
    if (isStart) return { summary: 'Leads the team: it receives your request first, and its answer is the team’s output.', final, canStart: false }
    const lead = entrypoint ? name(entrypoint) : 'the lead'
    return { summary: `Helps when ${lead} hands it part of the work.`, final, canStart: true }
  }

  const before = edges.filter((edge) => edge.to === agentId).map((edge) => name(edge.from))
  const after = edges.filter((edge) => edge.from === agentId).map((edge) => name(edge.to))
  const step = steps.find((candidate) => candidate.id === agentId)
  // A pipeline's entrypoint must be a source: an agent with an incoming edge cannot start it.
  const canStart = !isStart && before.length === 0
  if (!step || (before.length === 0 && after.length === 0 && !isStart)) {
    return { summary: 'Not one of the steps yet. Connect it to put it in the order.', final, canStart }
  }
  const parts = [`Step ${step.step} of ${steps.length}`]
  parts.push(before.length === 0 ? 'receives your request first' : `after ${list(before)}`)
  if (after.length > 0) parts.push(`hands its work to ${list(after)}`)
  return { summary: `${parts.join(' · ')}.${final ? ' Its answer is the team’s output.' : ''}`, final, canStart }
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
