import { MarkerType, type Edge, type Node } from '@xyflow/react'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { CAPABILITY_CARD, RELATION, type CapabilityEdgeConfig, type CapabilityNodeConfig } from '../../lib/composer-layout/types'
import type { WaitingOn } from '../../lib/runs/client'
import { plainRunError } from '../../lib/runs/errors'
import { settleAfterRun } from '../../lib/runs/settle'
import type { EvidenceNode, MoreNode, OutputNode, PromptNode, RunNode, WeftEdge } from '../../lib/runs/graph'
import { DOCK, dockAnchors, fanEvidence } from '../../lib/runs/runOverlay'
import { assignPorts } from '../../lib/canvas/ports'
import type { useRunSession } from '../../lib/runs/useRunSession'
import { SCHEDULE_CARD } from '../../lib/team-file/schedule'
import type { AgentConfig, AgentStatus } from '../../lib/team-file/types'
import type { useTeamDocument } from '../../lib/team-file/useTeamDocument'
import type { ProjectedAgent, RunPhase, RunProjection, TaskState } from '../../lib/watch/events'
import type { CapabilityNode } from '../canvas/capabilityNode'
import type { ScheduleNode } from '../canvas/ScheduleNodeCard'

type TeamDocument = ReturnType<typeof useTeamDocument>
type RunSession = ReturnType<typeof useRunSession>
type Point = { x: number; y: number }

// Planned capability wiring: the same quiet neutral stroke as a story edge, carrying the one
// relationship word the typed matrix allows for that target kind (TNG-122 §4).
const PLAN_MARKER = { type: MarkerType.Arrow, color: 'var(--color-warp)', width: 13, height: 13 }
const WARP_MARKER = { type: MarkerType.ArrowClosed, color: 'var(--color-warp)', width: 14, height: 14 }
const WEFT_MARKER = { type: MarkerType.Arrow, color: 'var(--color-accent)', width: 16, height: 16 }
const PROV_MARKER = { type: MarkerType.Arrow, color: 'var(--color-warp)', width: 14, height: 14 }
const LIVE_MARKER = { type: MarkerType.Arrow, color: 'var(--color-live)', width: 14, height: 14 }

export function capabilityEdgeId(from: string, to: string): string {
  return `capability:${from}->${to}`
}

function syntheticAgent(id: string): AgentConfig {
  return { id, name: id, role: 'Observed agent', spawn: { cmd: '', args: [], env: {}, cwd: '.' }, model: '' }
}

/** Everything the canvas is drawn from. The builder reads nothing else, so this is its whole contract. */
export interface CanvasGraphInput {
  /** A run is on screen; otherwise this is Build. */
  runView: boolean
  doc: Pick<TeamDocument, 'nodes' | 'edges' | 'mode' | 'entrypoint'>
  session: Pick<RunSession, 'mode' | 'cursor' | 'error' | 'lastSeq' | 'terminal'>
  nodeNames: ReadonlyMap<string, string>
  projection: RunProjection
  record: RunSession['record']
  activeRunId: string | null
  attempt: number
  retryOf: ReadonlyMap<string, string>
  phase: RunPhase
  elapsed: string
  lineageLabel: string | null
  /** Run view only: the agents in causal order, then the document's remaining agents. */
  orderedAgentIds: readonly string[]
  ownerLabels: ReadonlyMap<string, string>
  evidenceByAgent: ReadonlyMap<string, string[]>
  leadId: string | null
  live: boolean
  waiting: WaitingOn | null
  configuredPairs: ReadonlySet<string>
  /** Positions the operator dragged presentation nodes to: the anchors, the Run card, evidence. */
  overlayPositions: Readonly<Record<string, Point>>
  synthMeasurements: Readonly<Record<string, { width: number; height: number }>>
  /** Helpers a run revealed that the document has no node for, placed around the entrypoint. */
  helperPlacements: Readonly<Record<string, Point>>
  /** A replay's presentation layout; null in Build and in a live run. */
  historicalPositions: Readonly<Record<string, Point>> | null
  fannedAgentId: string | null
  inspectedEvidenceId: string | null
  packetAgentIds: ReadonlySet<string>
  givenNotes: Readonly<Record<string, number>>
  responderAgent: ProjectedAgent | undefined
  responderId: string | null
  responderFromDoc: string | null
  responseText: string
  provenanceOpen: boolean
  composerText: string
  visibleSchedule: ScheduleNode['data']['schedule'] | null
  scheduleInvalid: boolean
  scheduleEditorOpen: boolean
  onOpenSchedule: () => void
  capabilityCards: readonly CapabilityNodeConfig[]
  allWiringEdges: readonly CapabilityEdgeConfig[]
  editable: boolean
  selectedCapabilities: ReadonlySet<string>
  selectedCapabilityEdgeIds: ReadonlySet<string>
  focusComposer: () => void
  removeCapabilityEdge: (source: string, target: string) => void
}

interface GraphAccumulator {
  edges: Edge[]
  /** Adds a node with its remembered measurement, which React Flow needs to show a synthetic node. */
  addNode: (node: Node) => void
}

interface GraphFrame {
  docNodeById: ReadonlyMap<string, AgentNode>
  entryId: string | null
  terminalId: string | null
  terminalName: string
  docked: ReturnType<typeof dockAnchors> | null
  projectedById: ReadonlyMap<string, ProjectedAgent>
  delegationCounts: ReadonlyMap<string, number>
}

/**
 * One canvas — TNG89_INTERACTION.md §15.
 *
 *   > The configured graph never moves; a run is drawn onto it.
 *
 * One builder, not a compose branch and a run branch. The same agent cards sit at the same
 * `doc.nodes` positions in every state and gain runtime facts — status rail, live perimeter,
 * task, event count, the packet route — when a run is shown. The Prompt and Output nodes
 * are permanent and docked to the ends of the configured graph, which is what guarantees rows
 * 23/24/42 (Prompt first, Output last) now that no column computes it.
 *
 * The sections run in DOM order, so the order of these calls is the order React Flow renders.
 */
export function buildCanvasGraph(input: CanvasGraphInput): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const addNode = (node: Node) => {
    const measured = input.synthMeasurements[node.id]
    nodes.push(measured ? { ...node, measured } : node)
  }
  const graph: GraphAccumulator = { edges, addNode }
  const frame = frameGraph(input)
  addPromptAndRun(graph, input, frame)
  addSchedule(graph, input, frame)
  addAgents(graph, input, frame)
  addEvidenceFan(graph, input, frame)
  addSequenceEdges(graph, input, frame)
  addObservedDelegations(graph, input, frame)
  addCapabilityWiring(graph, input, frame)
  addOutput(graph, input, frame)
  // Which side of each card a line meets is decided once, from where the cards are, for every
  // edge alike (lib/canvas/ports.ts) — never by the section that created the edge.
  return { nodes, edges: assignPorts(edges, nodes) }
}

/** Where the graph docks its two permanent anchors, and the lookups every section shares. */
function frameGraph(input: CanvasGraphInput): GraphFrame {
  const { doc, nodeNames, projection, record, orderedAgentIds, leadId, helperPlacements, historicalPositions, responderId, responderFromDoc } = input
  const docNodeById = new Map(doc.nodes.map((node) => [node.id, node]))
  // A replay's archived lead is the story's entrypoint even when the team file has changed.
  // Build and live views continue to use the current document as their source of truth.
  const entryId = historicalPositions ? leadId ?? doc.entrypoint ?? doc.nodes[0]?.id ?? null : doc.entrypoint ?? leadId ?? doc.nodes[0]?.id ?? null
  // Pipeline mode docks the Output right of the terminal stage; team mode has no configured
  // order, so the entrypoint — the only stage the file names — carries both anchors.
  const historicalMode = historicalPositions ? record?.mode ?? doc.mode : doc.mode
  const terminalId = historicalPositions
    ? responderId ?? (historicalMode === 'team' ? entryId : responderFromDoc)
    : doc.mode === 'pipeline'
      ? (responderId && docNodeById.has(responderId) ? responderId : responderFromDoc)
      : entryId
  const pointFor = (id: string | null | undefined) => id ? historicalPositions?.[id] ?? docNodeById.get(id)?.position ?? helperPlacements[id] : null
  const entryPoint = pointFor(entryId)
  const configuredTerminalPoint = pointFor(terminalId) ?? entryPoint
  // The responder can be any stage. Its output must still sit beyond the entire team,
  // rather than overlap a later card when the first agent owns the response.
  const storyPoints = historicalPositions
    ? orderedAgentIds.map((id) => historicalPositions[id]).filter((point): point is { x: number; y: number } => Boolean(point))
    : doc.nodes.map((node) => node.position)
  const terminalPoint = configuredTerminalPoint
    ? { ...configuredTerminalPoint, x: Math.max(configuredTerminalPoint.x, ...storyPoints.map((point) => point.x)) }
    : configuredTerminalPoint
  const docked = entryPoint ? dockAnchors(entryPoint, terminalPoint ?? entryPoint) : null
  const terminalName = terminalId ? nodeNames.get(terminalId) ?? terminalId : 'the last stage'
  const projectedById = new Map(projection.agents.map((agent) => [agent.id, agent]))
  const delegationCounts = new Map<string, number>()
  projection.delegations.forEach((delegation) => { const key = `${delegation.from}->${delegation.to}`; delegationCounts.set(key, (delegationCounts.get(key) ?? 0) + 1) })
  return { docNodeById, entryId, terminalId, terminalName, docked, projectedById, delegationCounts }
}

/** The permanent Prompt node and, during a run, the attempt card it starts (§15.2.2). */
function addPromptAndRun(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { runView, session, nodeNames, projection, record, activeRunId, attempt, retryOf, phase, elapsed, lineageLabel, leadId, overlayPositions, synthMeasurements, helperPlacements, composerText } = input
  const { docNodeById, entryId, docked } = frame
  if (docked) {
    const prompt: PromptNode = {
      id: '__prompt',
      type: 'prompt',
      position: overlayPositions.__prompt ?? docked.prompt,
      initialWidth: DOCK.promptW,
      initialHeight: DOCK.promptH,
      data: runView
        ? { text: (record?.prompt ?? projection.prompt ?? '') || '(prompt not archived)', attempt, runId: activeRunId ?? '', lineage: lineageLabel }
        // Before a run it mirrors the composer's draft and focuses it when clicked: one editor
        // seen in two places, never two editors.
        : { text: composerText, attempt: null, runId: '', draft: true },
      draggable: true,
      selectable: false,
      connectable: false,
    }
    addNode(prompt)
  }
  if (docked && runView) {
    const runId = activeRunId ?? ''
    const parent = retryOf.get(runId)
    const promptHeight = synthMeasurements.__prompt?.height ?? DOCK.promptH
    // Centred under the Prompt, so "starts" drops straight down between them.
    const runPosition = overlayPositions.__run ?? {
      x: docked.run.x + (DOCK.promptW - DOCK.runW) / 2,
      y: docked.prompt.y + Math.max(DOCK.runOffsetY, promptHeight + 32),
    }
    // §12.2 requires the attempt card to stay visible; §15 shrinks it into the Prompt's dock
    // column rather than giving it a column of its own.
    const run: RunNode = {
      id: '__run',
      type: 'run',
      position: runPosition,
      initialWidth: DOCK.runW,
      initialHeight: DOCK.runH,
      data: { attempt, phase, runId, mode: session.mode, branch: lineageLabel ?? (parent ? 'Retry of an earlier run' : 'Initiating branch'), elapsed, trigger: record?.trigger },
      draggable: true,
      selectable: false,
      connectable: false,
    }
    addNode(run)
    edges.push({ id: '__prompt->__run', source: '__prompt', target: '__run', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'starts', story: true }, selectable: false, focusable: false })
    const lead = leadId && (docNodeById.has(leadId) || helperPlacements[leadId]) ? leadId : entryId
    if (lead) edges.push({ id: '__run->lead', source: '__run', target: lead, type: 'prov', markerEnd: PROV_MARKER, data: { label: 'assigns lead', story: true }, selectable: false, focusable: false })
  } else if (docked && entryId) {
    // Before a run the same arrow names the same configured relationship: this prompt starts here.
    edges.push({ id: '__prompt->entry', source: '__prompt', target: entryId, type: 'prov', markerEnd: PROV_MARKER, data: { label: 'starts', story: true }, selectable: false, focusable: false, ariaLabel: `starts from your prompt to ${nodeNames.get(entryId) ?? entryId}` })
  }
}

/** The schedule card, docked above the Prompt, and the edge to the stage it starts. */
function addSchedule(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { nodeNames, visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule, runView, allWiringEdges } = input
  const { entryId, docked } = frame
  if (visibleSchedule && docked) {
    // Build hides the Prompt unless something is wired to it, so the schedule takes the Prompt's
    // slot: level with the stage it starts, which makes "starts" a straight line into the spine.
    const promptShown = runView || allWiringEdges.some((edge) => edge.from === '__prompt')
    const scheduleNode: ScheduleNode = {
      id: '__schedule',
      type: 'schedule',
      position: promptShown ? docked.schedule : { x: docked.prompt.x + DOCK.promptW - SCHEDULE_CARD.width, y: docked.prompt.y },
      initialWidth: SCHEDULE_CARD.width,
      initialHeight: SCHEDULE_CARD.height,
      draggable: false,
      selectable: true,
      selected: scheduleEditorOpen,
      connectable: false,
      data: {
        schedule: visibleSchedule,
        invalid: scheduleInvalid,
        editorOpen: scheduleEditorOpen,
        onOpen: onOpenSchedule,
      },
    }
    addNode(scheduleNode)
    if (entryId) edges.push({ id: '__schedule->entrypoint', source: '__schedule', target: entryId, type: 'warp', markerEnd: WARP_MARKER, selectable: false, focusable: false, ariaLabel: `schedule starts ${nodeNames.get(entryId) ?? entryId}` })
  }
}

/** The agents at the positions the operator arranged, carrying a run's projected state. */
function addAgents(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode } = graph
  const { runView, doc, session, record, phase, orderedAgentIds, ownerLabels, evidenceByAgent, leadId, live, waiting, helperPlacements, historicalPositions, fannedAgentId, packetAgentIds, givenNotes, focusComposer } = input
  const { docNodeById, projectedById } = frame
  const pipeline = (record?.mode ?? doc.mode) === 'pipeline'
  const agentIdsInOrder = runView ? orderedAgentIds : doc.nodes.map((node) => node.id)
  agentIdsInOrder.forEach((id) => {
    const docNode = docNodeById.get(id)
    const position = historicalPositions?.[id] ?? docNode?.position ?? helperPlacements[id]
    if (!position) return
    const agent = docNode?.data.agent ?? syntheticAgent(id)
    const base: AgentNode = docNode ?? { id, type: 'agent', position, selected: false, data: { label: agent.name, agent } }
    const label = ownerLabels.get(id) ?? id
    const projected = projectedById.get(id)
    const eventCount = evidenceByAgent.get(id)?.length ?? 0
    const runtime = !runView
      ? undefined
      : projected
        ? { status: projected.status, taskState: projected.taskState, task: projected.task, ownerLabel: label, live: live && (projected.status === 'running' || projected.status === 'starting'), watching: live, busUnavailable: projected.busUnavailable, received: projected.received, eventCount, openCalls: projected.openCalls, fanned: fannedAgentId === id, hasPacket: packetAgentIds.has(id), givenNotes: givenNotes[id] ?? 0 }
        : { status: 'idle' as AgentStatus, taskState: (phase === 'queued' || phase === 'starting' ? 'QUEUED' : 'READY') as TaskState, task: phase === 'queued' || phase === 'starting' ? 'Waiting for the run to start' : 'Awaiting a task', ownerLabel: label, live: false, watching: live, eventCount, fanned: fannedAgentId === id, hasPacket: packetAgentIds.has(id), givenNotes: givenNotes[id] ?? 0 }
    if (runtime && session.cursor === null && waiting) {
      if (waiting.node === id) Object.assign(runtime, { status: 'waiting', taskState: 'WAITING', task: waiting.question, live: false })
      else if (waiting.handoverFrom === id) Object.assign(runtime, { status: 'succeeded', taskState: 'SUCCEEDED', task: 'Handover ready', live: false })
    } else if (runtime && session.cursor === null) {
      const index = orderedAgentIds.indexOf(id)
      const laterStageStarted = pipeline && index >= 0 && orderedAgentIds.slice(index + 1).some((later) => projectedById.has(later))
      const settled = settleAfterRun(runtime.status, { phase, operator: agent.kind === 'operator', laterStageStarted })
      if (settled) Object.assign(runtime, settled, { live: false })
    }
    addNode({
      ...base,
      position,
      data: { ...base.data, label: agent.name, agent, isEntrypoint: id === (doc.entrypoint ?? leadId), fieldProblems: docNode?.data.fieldProblems, runtime, waiting: session.cursor === null && waiting?.node === id ? waiting : null, onAnswer: focusComposer },
      ariaLabel: runtime
        ? `${agent.name}, ${label}, ${runtime.taskState}, ${runtime.task}`
        : `${agent.name}, ${agent.role || 'no role'}, ${agent.model || 'no model'}, ${agent.status ?? 'idle'}`,
      ariaRole: 'button' as const,
    })
  })
}

/** The one agent's evidence the operator fanned open (§15.2.3). */
function addEvidenceFan(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { runView, projection, ownerLabels, evidenceByAgent, live, overlayPositions, helperPlacements, historicalPositions, fannedAgentId, inspectedEvidenceId, capabilityCards, allWiringEdges } = input
  const { docNodeById } = frame
  // Folded is the default: the count lives on the card, and only the agent the operator opened
  // renders cards, so React Flow draws the agents plus one cluster instead of every event.
  if (runView && fannedAgentId) {
    const anchor = historicalPositions?.[fannedAgentId] ?? docNodeById.get(fannedAgentId)?.position ?? helperPlacements[fannedAgentId]
    const ids = evidenceByAgent.get(fannedAgentId) ?? []
    if (anchor && ids.length > 0) {
      // Start the comb below this agent's own resources, so cards never sit on top of them.
      const resourceBottom = Math.max(0, ...allWiringEdges
        .filter((edge) => edge.from === fannedAgentId)
        .map((edge) => capabilityCards.find((card) => card.id === edge.to))
        .map((card) => (card ? historicalPositions?.[card.id] ?? card.position : null))
        .filter((point): point is Point => Boolean(point) && (point as Point).y > anchor.y)
        .map((point) => point.y + CAPABILITY_CARD.height - anchor.y + 32))
      const fan = fanEvidence(anchor, ids, resourceBottom)
      projection.evidence.forEach((item) => {
        if (item.agentId !== fannedAgentId) return
        // Evidence folded into the "+N more" card has no slot and no node; the panel lists it.
        const position = overlayPositions[item.id] ?? fan.shown[item.id]
        if (!position) return
        const isLive = live && (item.status === 'running' || item.status === 'pending')
        const evidenceNode: EvidenceNode = {
          id: item.id,
          type: 'evidence',
          position,
          initialWidth: DOCK.evidenceW,
          initialHeight: DOCK.evidenceH,
          draggable: true,
          connectable: false,
          data: { evidence: item, ownerLabel: ownerLabels.get(item.agentId) ?? item.agentId, live: isLive, selected: inspectedEvidenceId === item.id },
        }
        addNode(evidenceNode)
        edges.push({ id: `ev:${item.id}`, source: item.agentId, target: item.id, type: 'prov', markerEnd: isLive ? LIVE_MARKER : PROV_MARKER, data: { live: isLive }, selectable: false, focusable: false, ariaLabel: `${ownerLabels.get(item.agentId) ?? item.agentId} ${item.relation} ${item.name}` })
      })
      if (fan.more) {
        const moreNode: MoreNode = {
          id: `__more:${fannedAgentId}`,
          type: 'more',
          position: overlayPositions[`__more:${fannedAgentId}`] ?? fan.more,
          initialWidth: DOCK.evidenceW,
          initialHeight: DOCK.evidenceH,
          draggable: true,
          selectable: false,
          connectable: false,
          data: { agentId: fannedAgentId, ownerLabel: ownerLabels.get(fannedAgentId) ?? fannedAgentId, hidden: fan.more.hidden, total: ids.length },
        }
        addNode(moreNode)
        edges.push({ id: `more:${fannedAgentId}`, source: fannedAgentId, target: moreNode.id, type: 'prov', markerEnd: PROV_MARKER, data: {}, selectable: false, focusable: false })
      }
    }
  }
}

/** The configured sequence (the warp), counted against observed delegations during a run. */
function addSequenceEdges(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { edges } = graph
  const { runView, doc, nodeNames, live } = input
  const { projectedById, delegationCounts } = frame
  doc.edges.forEach((edge) => {
    const key = `${edge.source}->${edge.target}`
    const count = runView ? delegationCounts.get(key) ?? 0 : 0
    edges.push({ ...edge, type: 'warp', markerEnd: WARP_MARKER, data: { ...edge.data!, count: count || undefined, shuttle: count > 0 && live && projectedById.get(edge.target)?.status === 'running' }, ariaLabel: `sequence from ${nodeNames.get(edge.source) ?? edge.source} to ${nodeNames.get(edge.target) ?? edge.target}` })
  })
}

/** Delegations a run made outside the configured sequence (the weft). */
function addObservedDelegations(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { edges } = graph
  const { runView, doc, projection, live, configuredPairs } = input
  const { projectedById, delegationCounts } = frame
  if (runView) {
    const seenWeft = new Set<string>()
    projection.delegations.forEach((delegation) => {
      const key = `${delegation.from}->${delegation.to}`
      if (configuredPairs.has(key) || seenWeft.has(`${key}:${delegation.kind}`)) return
      seenWeft.add(`${key}:${delegation.kind}`)
      // DESIGN_LANGUAGE §13: the weft fades once its target is no longer live, so the
      // live frontier of the graph is the brightest thing on screen.
      const targetStatus = projectedById.get(delegation.to)?.status
      const aged = !(live && (targetStatus === 'running' || targetStatus === 'starting' || targetStatus === 'waiting'))
      const weft: WeftEdge = { id: `weft:${key}:${delegation.kind}`, source: delegation.from, target: delegation.to, type: 'weft', markerEnd: WEFT_MARKER, markerStart: delegation.kind === 'ask' ? WEFT_MARKER : undefined, data: { kind: delegation.kind, count: delegationCounts.get(key), anomaly: doc.mode === 'pipeline', aged }, selectable: false, focusable: false }
      edges.push(weft)
    })
  }
}

/** Capability and memory cards, and the wiring from the agents that use them. */
function addCapabilityWiring(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { nodeNames, historicalPositions, capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, removeCapabilityEdge } = input
  const { docked } = frame
  for (const capability of capabilityCards) {
    const wiredTo = allWiringEdges.filter((edge) => edge.to === capability.id).length
    const node: CapabilityNode = {
      id: capability.id,
      type: 'capability',
      position: historicalPositions?.[capability.id] ?? capability.position,
      initialWidth: CAPABILITY_CARD.width,
      initialHeight: CAPABILITY_CARD.height,
      draggable: editable,
      selectable: true,
      selected: selectedCapabilities.has(capability.id),
      data: { kind: capability.kind, name: capability.name, source: capability.source, ...(capability.path ? { path: capability.path } : {}), ...(capability.notion ? { notionPage: capability.notion.page } : {}), wiredTo, readOnly: !editable },
    }
    addNode(node)
  }
  for (const edge of allWiringEdges) {
    const capability = capabilityCards.find((node) => node.id === edge.to)
    if (!capability) continue
    // A whole-team inherit is drawn from the Prompt node, which only exists once the graph has
    // an entrypoint to dock against; without it the edge would name a node that is not there.
    if (edge.from === '__prompt' && !docked) continue
    const owner = edge.from === '__prompt' ? 'the whole team' : nodeNames.get(edge.from) ?? edge.from
    const id = capabilityEdgeId(edge.from, edge.to)
    edges.push({
      id,
      source: edge.from,
      target: edge.to,
      type: 'prov',
      markerEnd: PLAN_MARKER,
      ariaLabel: `${owner} ${RELATION[capability.kind]} ${capability.name}`,
      data: {
        label: RELATION[capability.kind],
        story: false,
        resource: true,
        onRemove: editable ? () => removeCapabilityEdge(edge.from, edge.to) : undefined,
        removeLabel: `Remove connection: ${owner} ${RELATION[capability.kind]} ${capability.name}`,
      },
      selected: selectedCapabilityEdgeIds.has(id),
      selectable: editable,
      deletable: editable,
      focusable: editable,
    })
  }
}

/** The permanent Output node (§15.2.2): a configured promise in Build, the answer in a run. */
function addOutput(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { runView, doc, session, nodeNames, projection, record, attempt, phase, elapsed, orderedAgentIds, leadId, live, waiting, overlayPositions, helperPlacements, responderAgent, responderId, responseText, provenanceOpen, editable } = input
  const { docNodeById, terminalId, terminalName, docked } = frame
  if (docked) {
    // The answer is credited by name alone: "Assigned to Writer", not "Writer · final answer".
    const responderLabel = responderAgent ? nodeNames.get(responderAgent.id) ?? responderAgent.id : responderId ? nodeNames.get(responderId) ?? responderId : 'the team'
    const producer = responderAgent?.id ?? responderId
    const producerName = (producer ? nodeNames.get(producer) : null) ?? terminalName
    // A follow-up "from Writer" runs Writer only, so the promise has to name the stage that will
    // actually reply — the *first executed* one when it is also the last, and the terminal stage
    // otherwise. Naming the terminal stage of a pipeline whose earlier stages are not running
    // would promise an answer from something that never starts.
    const firstExecutedName = record?.startAt ? nodeNames.get(record.startAt) ?? record.startAt : null
    if (!runView) {
      const output: OutputNode = {
        id: '__output',
        type: 'response',
        position: overlayPositions.__output ?? docked.output,
        initialWidth: DOCK.outputW,
        initialHeight: DOCK.outputH,
        draggable: true,
        selectable: false,
        connectable: editable && doc.mode === 'pipeline',
        // No attempt exists, so there is no phase word, no live/replay badge and no producer to
        // credit — only the configured promise of who will fill it.
        data: { text: '', phase: 'queued', phaseText: 'No run yet.', producer: terminalId, producerLabel: terminalName, mode: 'live', streaming: false, pending: false, strip: null, compact: false, expanded: false, terminal: false, configurable: editable && doc.mode === 'pipeline', awaiting: true, placeholder: `The team's answer appears here when ${terminalName} replies.` },
      }
      addNode(output)
      if (terminalId) edges.push({ id: '__responds', source: terminalId, target: '__output', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'responds with', story: true }, selectable: false, focusable: false, ariaLabel: `responds with from ${terminalName} to the output` })
      return
    }
    const streaming = live && phase === 'running' && responderAgent?.taskState === 'STREAMING'
    const pending = phase === 'queued' || phase === 'starting'
    const runningCount = projection.agents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length
    const phaseText = waiting && session.cursor === null ? 'Waiting for your answer.' : phase === 'queued' ? 'Queued — waiting for a supervisor.'
      : phase === 'starting' ? `Starting ${nodeNames.get(leadId ?? '') ?? leadId ?? 'the lead'}…`
      : phase === 'running' ? (streaming ? `Streaming — ${responderLabel} responding.` : `Running — ${runningCount} agent${runningCount === 1 ? '' : 's'} active.`)
      : phase === 'succeeded' ? `Answered in ${elapsed}.`
      : phase === 'partial' ? 'Partial answer.'
      : phase === 'failed' ? 'Run failed.'
      : 'Cancelled — partial answer kept.'
    const crash = projection.attention.find((alert) => /crash/i.test(alert.message))
    // §3.4 / CONTRACT §3: the strip carries the daemon's stable machine-readable code and
    // its verbatim message — never a token or a sentence manufactured here. The watermark
    // resolves the daemon's own code, then its stop reason, then the one code the contract
    // itself assigns to an evidence-derived condition (`missing_canonical_response`,
    // CONTRACT §4, via the projection), then the exit fact; when the daemon reported none
    // of these it says so instead of picking a plausible token.
    const exitFact = record?.exitCode !== null && record?.exitCode !== undefined ? `exit ${record.exitCode}` : null
    const strip = session.error && live ? { tone: 'halt' as const, message: `Live events reconnecting — answer shown to`, watermark: `seq ${session.lastSeq}` }
      : phase === 'partial' || phase === 'failed' ? {
          tone: 'alert' as const,
          message: (record?.error ? plainRunError(record.error, new Map(doc.nodes.map((node) => [node.id, { name: node.data.agent.name || node.id, command: node.data.agent.spawn?.cmd }]))) : null) ?? crash?.message
            ?? (phase === 'failed' && (record?.errorCode ?? record?.stopReason ?? projection.errorCode) === 'missing_canonical_response'
              ? 'The run finished but no agent produced an answer.'
              : 'No error message was reported.'),
          watermark: record?.errorCode ?? record?.stopReason ?? projection.errorCode ?? exitFact ?? 'no code reported',
        }
      : phase === 'cancelled' ? { tone: 'halt' as const, message: 'Cancelled by the operator. Partial answer kept.', watermark: 'cancelled' }
      : null
    // A placeholder is a promise, so it is only offered while the run can still keep it. A
    // terminal run with no answer gets the strip and `[ Reuse ]` instead (§3.4).
    const settled = phase === 'succeeded' || phase === 'partial' || phase === 'failed' || phase === 'cancelled'
    const output: OutputNode = {
      id: '__output',
      type: 'response',
      position: overlayPositions.__output ?? docked.output,
      initialWidth: DOCK.outputW,
      initialHeight: DOCK.outputH,
      draggable: true,
      selectable: false,
      connectable: false,
      data: { text: responseText, phase, phaseText, producer: responderAgent?.id ?? responderId ?? null, producerLabel: responderLabel, mode: session.mode, streaming, pending, strip, compact: provenanceOpen, expanded: provenanceOpen, terminal: session.terminal, placeholder: responseText || settled ? null : `The team's answer appears here when ${firstExecutedName && orderedAgentIds.length <= 1 ? firstExecutedName : producerName} replies.` },
    }
    addNode(output)
    if (producer && (docNodeById.has(producer) || helperPlacements[producer])) edges.push({ id: '__responds', source: producer, target: '__output', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'responds with', story: true }, selectable: false, focusable: false })
    edges.push({ id: '__completes', source: '__run', target: '__output', type: 'prov', markerEnd: PROV_MARKER, data: { label: `Run ${String(attempt).padStart(2, '0')} · completes as`, story: true, arc: true }, selectable: false, focusable: false })
  }
}
