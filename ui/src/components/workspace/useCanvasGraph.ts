import { useMemo } from 'react'

import type { DetectedHarness } from '../../lib/harnesses'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { appLabelForAgent } from '../../lib/models'
import { helperPositions, historicalRunPositions } from '../../lib/runs/runOverlay'
import { buildCanvasGraph, type CanvasGraphInput } from './canvasGraph'

interface CanvasGraphHookInput extends Omit<CanvasGraphInput, 'helperPlacements' | 'historicalPositions'> {
  harnesses: DetectedHarness[]
  /** The planned deliverable, which Build names on the Output node. */
  outputPlan: { name: string; format: string } | undefined
}

/**
 * The one canvas both surfaces draw (TNG89_INTERACTION.md §15), memoised on exactly what
 * `buildCanvasGraph` reads, plus the per-surface finish React Flow is handed.
 *
 * Every input is destructured before use so the dependency lists below are checked against the
 * builder's input by `react-hooks/exhaustive-deps` rather than kept in step by hand.
 */
export function useCanvasGraph(input: CanvasGraphHookInput) {
  const { runView, doc, session, nodeNames, projection, record, activeRunId, attempt, retryOf, phase, elapsed, lineageLabel, orderedAgentIds, ownerLabels, evidenceByAgent, leadId, live, waiting, configuredPairs, overlayPositions, synthMeasurements, fannedAgentId, inspectedEvidenceId, packetAgentIds, givenNotes, responderAgent, responderId, responderFromDoc, responseText, provenanceOpen, composerText, visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule, capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, focusComposer, removeCapabilityCards, removeCapabilityEdge, harnesses, outputPlan } = input

  // §15.2.6: helpers a run reveals that the document has no node for. They are placed by the
  // existing seeded auto-layout around the entrypoint, as view state — node positions are not
  // part of the team file at all, so there is nothing to offer saving them to (see the ledger).
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
   * Replays are read-only stories, so they may use a clean presentation layout without moving the
   * saved Build canvas. Include observed handoffs as layout constraints and bridge an archived lead
   * into the current configured entrypoint when the team file has changed since the run. This is
   * exactly the case that previously stranded an old `collector` beneath the current pipeline.
   */
  const historicalPositions = useMemo(() => {
    if (!runView || session.mode !== 'replay') return null
    const agentIds = new Set(orderedAgentIds)
    const sequence = [
      ...doc.edges.map((edge) => ({ from: edge.source, to: edge.target })),
      ...projection.delegations.map((edge) => ({ from: edge.from, to: edge.to })),
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

  const graph = useMemo(() => buildCanvasGraph({
    runView,
    doc: { nodes: doc.nodes, edges: doc.edges, mode: doc.mode, entrypoint: doc.entrypoint },
    session: { mode: session.mode, cursor: session.cursor, error: session.error, lastSeq: session.lastSeq, terminal: session.terminal },
    nodeNames, projection, record, activeRunId, attempt, retryOf, phase, elapsed, lineageLabel, orderedAgentIds, ownerLabels, evidenceByAgent,
    leadId, live, waiting, configuredPairs, overlayPositions, synthMeasurements, helperPlacements, historicalPositions, fannedAgentId,
    inspectedEvidenceId, packetAgentIds, givenNotes, responderAgent, responderId, responderFromDoc, responseText, provenanceOpen, composerText,
    visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule, capabilityCards, allWiringEdges, editable, selectedCapabilities,
    selectedCapabilityEdgeIds, focusComposer, removeCapabilityCards, removeCapabilityEdge,
  }), [runView, doc.nodes, doc.edges, doc.mode, doc.entrypoint, session.mode, session.cursor, session.error, session.lastSeq, session.terminal, nodeNames, projection, record, activeRunId, attempt, retryOf, phase, elapsed, lineageLabel, orderedAgentIds, ownerLabels, evidenceByAgent, leadId, live, waiting, configuredPairs, overlayPositions, synthMeasurements, helperPlacements, historicalPositions, fannedAgentId, inspectedEvidenceId, packetAgentIds, givenNotes, responderAgent, responderId, responderFromDoc, responseText, provenanceOpen, composerText, visibleSchedule, scheduleInvalid, scheduleEditorOpen, onOpenSchedule, capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, focusComposer, removeCapabilityCards, removeCapabilityEdge])

  // Both surfaces draw the same agent card, so both name the harness that card runs in — a run
  // that cannot resolve one says so rather than falling back to the generic word. The Prompt node
  // and the configured output name belong to Build alone: a run has an attempt to show instead of
  // a draft, and an answer to read instead of a promise.
  const canvasNodes = useMemo(() => {
    const named = graph.nodes.map((node) => node.type === 'agent'
      ? { ...node, data: { ...node.data, harnessLabel: appLabelForAgent((node as AgentNode).data.agent, harnesses) } }
      : node)
    if (runView) return named
    return named
      .filter((node) => node.id !== '__prompt' || allWiringEdges.some((edge) => edge.from === '__prompt'))
      .map((node) => node.type === 'response' ? { ...node, data: { ...node.data, outputName: outputPlan?.name, outputFormat: outputPlan?.format } } : node)
  }, [graph.nodes, harnesses, runView, allWiringEdges, outputPlan])

  return { graph, canvasNodes }
}
