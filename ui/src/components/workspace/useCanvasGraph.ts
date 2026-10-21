import { useMemo } from 'react'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { modelLabelForAgent } from '../../lib/models'
import { buildCanvasGraph, type CanvasGraphInput } from './canvasGraph'

interface CanvasGraphHookInput extends CanvasGraphInput {
  /** The model list's own names by id, once it has arrived. */
  modelNames?: ReadonlyMap<string, string>
  /** The planned deliverable, which the Output node names. */
  outputPlan: { name: string; format: string } | undefined
  /** What LoomWatch did to an agent's instructions after a removal (ADR 0059), by agent id. */
  instructionNotes?: ReadonlyMap<string, string>
  /** Where every answer also goes (ADR 0038), named on the Output node. */
  sendsTo?: string | null
}

/**
 * The Workflow canvas, memoised on exactly what `buildCanvasGraph` reads, plus the finish React
 * Flow is handed.
 *
 * Every input is destructured before use so the dependency lists below are checked against the
 * builder's input by `react-hooks/exhaustive-deps` rather than kept in step by hand.
 */
export function useCanvasGraph(input: CanvasGraphHookInput) {
  const { doc, nodeNames, overlayPositions, synthMeasurements, responderFromDoc, composerText, visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule, capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, removeCapabilityEdge, modelNames, outputPlan, instructionNotes, sendsTo = null } = input

  const graph = useMemo(() => buildCanvasGraph({
    doc: { nodes: doc.nodes, edges: doc.edges, mode: doc.mode, entrypoint: doc.entrypoint },
    nodeNames, overlayPositions, synthMeasurements, responderFromDoc, composerText, visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule,
    capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, removeCapabilityEdge,
  }), [doc.nodes, doc.edges, doc.mode, doc.entrypoint, nodeNames, overlayPositions, synthMeasurements, responderFromDoc, composerText, visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule, capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, removeCapabilityEdge])

  // Each agent card names the model it runs on. The Prompt node shows only once something is wired
  // to it, and the Output node names the planned deliverable and where it also goes.
  const canvasNodes = useMemo(() => graph.nodes
    .filter((node) => node.id !== '__prompt' || allWiringEdges.some((edge) => edge.from === '__prompt'))
    .map((node) => node.type === 'agent'
      ? { ...node, data: { ...node.data, modelLabel: modelLabelForAgent((node as AgentNode).data.agent, modelNames), ...(instructionNotes?.has(node.id) ? { instructionNote: instructionNotes.get(node.id) } : {}) } }
      : node.type === 'response' ? { ...node, data: { ...node.data, outputName: outputPlan?.name, outputFormat: outputPlan?.format, sendsTo } }
        : node), [graph.nodes, modelNames, allWiringEdges, outputPlan, instructionNotes, sendsTo])

  return { graph, canvasNodes }
}
