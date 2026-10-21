import { MarkerType, type Edge, type Node } from '@xyflow/react'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { CAPABILITY_CARD, RELATION, type CapabilityEdgeConfig, type CapabilityNodeConfig } from '../../lib/composer-layout/types'
import type { OutputNode, PromptNode } from '../../lib/runs/graph'
import { DOCK, dockAnchors } from '../../lib/runs/runOverlay'
import { assignPorts } from '../../lib/canvas/ports'
import { SCHEDULE_CARD } from '../../lib/team-file/schedule'
import type { useTeamDocument } from '../../lib/team-file/useTeamDocument'
import type { CapabilityNode } from '../canvas/capabilityNode'
import type { ScheduleNode } from '../canvas/ScheduleNodeCard'

type TeamDocument = ReturnType<typeof useTeamDocument>

// Planned capability wiring: the same quiet neutral stroke as a story edge, carrying the one
// relationship word the typed matrix allows for that target kind (TNG-122 §4).
const PLAN_MARKER = { type: MarkerType.Arrow, color: 'var(--color-warp)', width: 13, height: 13 }
const WARP_MARKER = { type: MarkerType.ArrowClosed, color: 'var(--color-warp)', width: 14, height: 14 }
const PROV_MARKER = { type: MarkerType.Arrow, color: 'var(--color-warp)', width: 14, height: 14 }

export function capabilityEdgeId(from: string, to: string): string {
  return `capability:${from}->${to}`
}

/** Everything the Workflow canvas is drawn from. The builder reads nothing else, so this is its whole contract. */
export interface CanvasGraphInput {
  doc: Pick<TeamDocument, 'nodes' | 'edges' | 'mode' | 'entrypoint'>
  nodeNames: ReadonlyMap<string, string>
  /** Positions the operator dragged the docked Prompt and Output cards to. */
  overlayPositions: Readonly<Record<string, { x: number; y: number }>>
  synthMeasurements: Readonly<Record<string, { width: number; height: number }>>
  responderFromDoc: string | null
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
  removeCapabilityEdge: (source: string, target: string) => void
}

interface GraphAccumulator {
  edges: Edge[]
  /** Adds a node with its remembered measurement, which React Flow needs to show a synthetic node. */
  addNode: (node: Node) => void
}

interface GraphFrame {
  entryId: string | null
  terminalId: string | null
  terminalName: string
  docked: ReturnType<typeof dockAnchors> | null
}

/**
 * The Workflow canvas: the team as it is configured. The agent cards sit at the `doc.nodes`
 * positions, and the Prompt and Output nodes are docked to the ends of the configured graph,
 * which is what keeps the Prompt first and the Output last. A run is never drawn here: it is
 * read in the team's chat and its Details.
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
  addPrompt(graph, input, frame)
  addSchedule(graph, input, frame)
  addAgents(graph, input)
  addSequenceEdges(graph, input)
  addCapabilityWiring(graph, input, frame)
  addOutput(graph, input, frame)
  // Which side of each card a line meets is decided once, from where the cards are, for every
  // edge alike (lib/canvas/ports.ts) — never by the section that created the edge.
  return { nodes, edges: assignPorts(edges, nodes) }
}

/** Where the graph docks its two permanent anchors. */
function frameGraph(input: CanvasGraphInput): GraphFrame {
  const { doc, nodeNames, responderFromDoc } = input
  const docNodeById = new Map(doc.nodes.map((node) => [node.id, node]))
  const entryId = doc.entrypoint ?? doc.nodes[0]?.id ?? null
  // Pipeline mode docks the Output right of the terminal stage; team mode has no configured
  // order, so the entrypoint — the only stage the file names — carries both anchors.
  const terminalId = doc.mode === 'pipeline' ? responderFromDoc : entryId
  const pointFor = (id: string | null) => (id ? docNodeById.get(id)?.position : undefined)
  const entryPoint = pointFor(entryId)
  const configuredTerminalPoint = pointFor(terminalId) ?? entryPoint
  // The responder can be any stage. Its output must still sit beyond the entire team,
  // rather than overlap a later card when the first agent owns the response.
  const terminalPoint = configuredTerminalPoint
    ? { ...configuredTerminalPoint, x: Math.max(configuredTerminalPoint.x, ...doc.nodes.map((node) => node.position.x)) }
    : configuredTerminalPoint
  const docked = entryPoint ? dockAnchors(entryPoint, terminalPoint ?? entryPoint) : null
  const terminalName = terminalId ? nodeNames.get(terminalId) ?? terminalId : 'the last stage'
  return { entryId, terminalId, terminalName, docked }
}

/** The permanent Prompt node, and the arrow to the stage it starts (§15.2.2). */
function addPrompt(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { nodeNames, overlayPositions, composerText } = input
  const { entryId, docked } = frame
  if (!docked) return
  const prompt: PromptNode = {
    id: '__prompt',
    type: 'prompt',
    position: overlayPositions.__prompt ?? docked.prompt,
    initialWidth: DOCK.promptW,
    initialHeight: DOCK.promptH,
    // It mirrors the composer's draft and focuses it when clicked: one editor seen in two
    // places, never two editors.
    data: { text: composerText },
    draggable: true,
    selectable: false,
    connectable: false,
  }
  addNode(prompt)
  if (entryId) edges.push({ id: '__prompt->entry', source: '__prompt', target: entryId, type: 'prov', markerEnd: PROV_MARKER, data: { label: 'starts', story: true }, selectable: false, focusable: false, ariaLabel: `starts from your prompt to ${nodeNames.get(entryId) ?? entryId}` })
}

/** The schedule card, docked above the Prompt, and the edge to the stage it starts. */
function addSchedule(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { nodeNames, visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule, allWiringEdges } = input
  const { entryId, docked } = frame
  if (visibleSchedule && docked) {
    // The Prompt is hidden unless something is wired to it, so the schedule takes the Prompt's
    // slot: level with the stage it starts, which makes "starts" a straight line into the spine.
    const promptShown = allWiringEdges.some((edge) => edge.from === '__prompt')
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

/** The agents at the positions the operator arranged. */
function addAgents(graph: GraphAccumulator, input: CanvasGraphInput) {
  const { doc } = input
  doc.nodes.forEach((node: AgentNode) => {
    const { agent } = node.data
    graph.addNode({
      ...node,
      data: { ...node.data, label: agent.name, isEntrypoint: node.id === doc.entrypoint },
      ariaLabel: `${agent.name}, ${agent.role || 'no role'}, ${agent.model || 'no model'}, ${agent.status ?? 'idle'}`,
      ariaRole: 'button' as const,
    })
  })
}

/** The configured sequence (the warp). */
function addSequenceEdges(graph: GraphAccumulator, input: CanvasGraphInput) {
  const { doc, nodeNames } = input
  doc.edges.forEach((edge) => {
    graph.edges.push({ ...edge, type: 'warp', markerEnd: WARP_MARKER, ariaLabel: `sequence from ${nodeNames.get(edge.source) ?? edge.source} to ${nodeNames.get(edge.target) ?? edge.target}` })
  })
}

/** Capability and memory cards, and the wiring from the agents that use them. */
function addCapabilityWiring(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { nodeNames, capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, removeCapabilityEdge } = input
  const { docked } = frame
  for (const capability of capabilityCards) {
    const wiredTo = allWiringEdges.filter((edge) => edge.to === capability.id).length
    const node: CapabilityNode = {
      id: capability.id,
      type: 'capability',
      position: capability.position,
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

/** The permanent Output node (§15.2.2): the configured promise of who will answer. */
function addOutput(graph: GraphAccumulator, input: CanvasGraphInput, frame: GraphFrame) {
  const { addNode, edges } = graph
  const { doc, overlayPositions, editable } = input
  const { terminalId, terminalName, docked } = frame
  if (!docked) return
  const output: OutputNode = {
    id: '__output',
    type: 'response',
    position: overlayPositions.__output ?? docked.output,
    initialWidth: DOCK.outputW,
    initialHeight: DOCK.outputH,
    draggable: true,
    selectable: false,
    connectable: editable && doc.mode === 'pipeline',
    // No run exists here, so there is no producer to credit: only the configured promise of who
    // will fill it.
    data: { producerLabel: terminalName, configurable: editable && doc.mode === 'pipeline', placeholder: `The team's answer appears here when ${terminalName} replies.` },
  }
  addNode(output)
  if (terminalId) edges.push({ id: '__responds', source: terminalId, target: '__output', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'responds with', story: true }, selectable: false, focusable: false, ariaLabel: `responds with from ${terminalName} to the output` })
}
