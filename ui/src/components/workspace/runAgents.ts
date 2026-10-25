import { useMemo } from 'react'

import type { CapabilityEdgeConfig, CapabilityNodeConfig } from '../../lib/composer-layout/types'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { WaitingOn } from '../../lib/runs/client'
import { helperPositions, historicalRunPositions } from '../../lib/runs/runOverlay'
import { settleAfterRun } from '../../lib/runs/settle'
import type { useRunSession } from '../../lib/runs/useRunSession'
import type { AgentConfig, AgentStatus } from '../../lib/team-file/types'
import type { useTeamDocument } from '../../lib/team-file/useTeamDocument'
import type { RunPhase, RunProjection, TaskState } from '../../lib/watch/events'

type TeamDocument = ReturnType<typeof useTeamDocument>
type RunSession = ReturnType<typeof useRunSession>
type Point = { x: number; y: number }

function syntheticAgent(id: string, name = id): AgentConfig {
  return { id, name, role: 'Observed agent', spawn: { cmd: '', args: [], env: {}, cwd: '.' }, model: '' }
}

/** Everything the agents a run's Details lists are worked out from. */
export interface RunAgentsInput {
  doc: Pick<TeamDocument, 'nodes' | 'edges' | 'mode' | 'entrypoint'>
  session: Pick<RunSession, 'mode' | 'cursor'>
  projection: RunProjection
  record: RunSession['record']
  phase: RunPhase
  /** The agents in causal order, then the document's remaining agents. */
  orderedAgentIds: readonly string[]
  evidenceByAgent: ReadonlyMap<string, string[]>
  leadId: string | null
  waiting: WaitingOn | null
  packetAgentIds: ReadonlySet<string>
  synthMeasurements: Readonly<Record<string, { width: number; height: number }>>
  capabilityCards: readonly CapabilityNodeConfig[]
  allWiringEdges: readonly CapabilityEdgeConfig[]
  /** The person's other agents a run may bring in from My agents, by `mine+<id>` (ADR 0092). */
  guestNames?: ReadonlyMap<string, string>
}

/**
 * The agents of the run on screen, each carrying the run's projected state (`data.runtime`), for
 * Details and the agent panel opened from it.
 *
 * An agent is listed once it has a place: the team file's own agents always, and the helpers a run
 * revealed that the document has no node for, placed by the seeded layout around the entrypoint
 * (§15.2.6) or, in a replay, by the run's own layout.
 */
export function runAgentNodes(input: RunAgentsInput & { helperPlacements: Readonly<Record<string, Point>>; historicalPositions: Readonly<Record<string, Point>> | null }): AgentNode[] {
  const { doc, session, projection, record, phase, orderedAgentIds, evidenceByAgent, leadId, waiting, packetAgentIds, helperPlacements, historicalPositions } = input
  const docNodeById = new Map(doc.nodes.map((node) => [node.id, node]))
  const projectedById = new Map(projection.agents.map((agent) => [agent.id, agent]))
  const pipeline = (record?.mode ?? doc.mode) === 'pipeline'
  return orderedAgentIds.flatMap((id): AgentNode[] => {
    const docNode = docNodeById.get(id)
    const position = historicalPositions?.[id] ?? docNode?.position ?? helperPlacements[id]
    if (!position) return []
    const agent = docNode?.data.agent ?? syntheticAgent(id, input.guestNames?.get(id))
    const base: AgentNode = docNode ?? { id, type: 'agent', position, selected: false, data: { label: agent.name, agent } }
    const projected = projectedById.get(id)
    const eventCount = evidenceByAgent.get(id)?.length ?? 0
    const runtime = projected
      ? { status: projected.status, taskState: projected.taskState, task: projected.task, busUnavailable: projected.busUnavailable, received: projected.received, eventCount, openCalls: projected.openCalls, hasPacket: packetAgentIds.has(id) }
      : { status: 'idle' as AgentStatus, taskState: (phase === 'queued' || phase === 'starting' ? 'QUEUED' : 'READY') as TaskState, task: phase === 'queued' || phase === 'starting' ? 'Waiting for the run to start' : 'Awaiting a task', eventCount, hasPacket: packetAgentIds.has(id) }
    if (session.cursor === null && waiting) {
      if (waiting.node === id) Object.assign(runtime, { status: 'waiting', taskState: 'WAITING', task: waiting.question })
      else if (waiting.handoverFrom === id) Object.assign(runtime, { status: 'succeeded', taskState: 'SUCCEEDED', task: 'Handover ready' })
    } else if (session.cursor === null) {
      const index = orderedAgentIds.indexOf(id)
      const laterStageStarted = pipeline && index >= 0 && orderedAgentIds.slice(index + 1).some((later) => projectedById.has(later))
      const settled = settleAfterRun(runtime.status, { phase, operator: agent.kind === 'operator', laterStageStarted })
      if (settled) Object.assign(runtime, settled)
    }
    return [{ ...base, position, data: { ...base.data, label: agent.name, agent, isEntrypoint: id === (doc.entrypoint ?? leadId), fieldProblems: docNode?.data.fieldProblems, runtime } }]
  })
}

/** `runAgentNodes`, memoised, with the places it reads worked out once per change. Empty in Build. */
export function useRunAgents(runView: boolean, input: RunAgentsInput): AgentNode[] {
  const { doc, session, projection, record, phase, orderedAgentIds, evidenceByAgent, leadId, waiting, packetAgentIds, synthMeasurements, capabilityCards, allWiringEdges } = input

  // §15.2.6: helpers a run reveals that the document has no node for, placed by the seeded
  // auto-layout around the entrypoint, as view state.
  const entrypointPosition = useMemo(() => {
    const entry = doc.nodes.find((node) => node.id === (doc.entrypoint ?? leadId)) ?? doc.nodes[0]
    return entry?.position ?? null
  }, [doc.nodes, doc.entrypoint, leadId])
  const helperPlacements = useMemo(() => {
    if (!entrypointPosition) return {}
    const helpers = orderedAgentIds.filter((id) => !doc.nodes.some((node) => node.id === id))
    return helperPositions(helpers, entrypointPosition)
  }, [orderedAgentIds, doc.nodes, entrypointPosition])

  /**
   * A replay may name agents the team file no longer has, so it is laid out on its own, without
   * moving the saved Workflow canvas. Observed handoffs are layout constraints, and an archived
   * lead is bridged into the current configured entrypoint when the team file has changed since.
   */
  const historicalPositions = useMemo(() => {
    if (!runView || session.mode !== 'replay') return null
    const agentIds = new Set(orderedAgentIds)
    const rank = new Map(orderedAgentIds.map((id, index) => [id, index]))
    const sequence = [
      ...doc.edges.map((edge) => ({ from: edge.source, to: edge.target })),
      // Only calls that run with the story's order shape the layout: a later stage asking an
      // earlier one would form a cycle.
      ...projection.delegations
        .filter((edge) => (rank.get(edge.from) ?? Infinity) < (rank.get(edge.to) ?? -Infinity))
        .map((edge) => ({ from: edge.from, to: edge.to })),
    ].filter(({ from, to }) => agentIds.has(from) && agentIds.has(to) && from !== to)
    return historicalRunPositions(
      orderedAgentIds.map((id) => ({ id, ...synthMeasurements[id] })),
      sequence,
      capabilityCards.map((node) => ({ id: node.id, ...synthMeasurements[node.id] })),
      allWiringEdges,
      leadId,
      doc.entrypoint,
    )
  }, [runView, session.mode, orderedAgentIds, doc.edges, doc.entrypoint, projection.delegations, synthMeasurements, capabilityCards, allWiringEdges, leadId])

  return useMemo(() => (runView ? runAgentNodes({
    doc: { nodes: doc.nodes, edges: doc.edges, mode: doc.mode, entrypoint: doc.entrypoint },
    session: { mode: session.mode, cursor: session.cursor },
    projection, record, phase, orderedAgentIds, evidenceByAgent, leadId, waiting, packetAgentIds, synthMeasurements, capabilityCards, allWiringEdges,
    helperPlacements, historicalPositions, guestNames: input.guestNames,
  }) : []), [runView, doc.nodes, doc.edges, doc.mode, doc.entrypoint, session.mode, session.cursor, projection, record, phase, orderedAgentIds, evidenceByAgent, leadId, waiting, packetAgentIds, synthMeasurements, capabilityCards, allWiringEdges, helperPlacements, historicalPositions, input.guestNames])
}
