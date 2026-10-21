import type { Edge, Node } from '@xyflow/react'

import type { TaskState } from '../watch/events'
import type { AgentStatus } from '../team-file/types'

/** Runtime facts merged onto an agent while a run is shown in Details. Never written to YAML. */
export interface AgentRuntime {
  status: AgentStatus
  taskState: TaskState
  task: string
  busUnavailable?: boolean
  /** Set when this stage was handed the preceding stages' replies, so Details can offer to show them. */
  received?: string | null
  /** The calls this agent made in the run so far. */
  eventCount?: number
  /** Calls opened but not yet paired to a terminal update — the honest "· open" on the count. */
  openCalls?: number
  /**
   * True when the run stored a context packet for this agent, so the packet inspector has an
   * entry point even for the entrypoint, which was handed nothing (docs/TEAM_MEMORY.md ledger).
   */
  hasPacket?: boolean
}

/**
 * The permanent Prompt node on the Workflow canvas: it mirrors the composer's text as the
 * operator types and focuses the composer when clicked. One editor, seen in two places (§15.2.2).
 */
export type PromptNodeData = { text: string }
/** The permanent Output node on the Workflow canvas: the configured promise of who will answer. */
export type OutputNodeData = {
  outputName?: string
  outputFormat?: string
  /** Where every answer also goes, e.g. `Notion` (ADR 0038). */
  sendsTo?: string | null
  /** The agent that will answer, by name. */
  producerLabel: string
  /** An agent may connect here to become the configured responder. */
  configurable?: boolean
  /** What the card says it is waiting for, for a screen reader. */
  placeholder?: string | null
}

export type PromptNode = Node<PromptNodeData, 'prompt'>
// Not 'output': React Flow ships built-in `input`/`default`/`output`/`group` types, and its
// stylesheet paints `.react-flow__node-output` as a 150 px bordered box — which showed through
// around this card as a stray empty rectangle.
export type OutputNode = Node<OutputNodeData, 'response'>

export type ProvEdgeData = {
  label?: string
  story?: boolean
  resource?: boolean
  /** Present only on editable capability wiring. */
  onRemove?: () => void
  removeLabel?: string
}

export type ProvEdge = Edge<ProvEdgeData, 'prov'>

/**
 * Who did something in a run, as the operator named them: "Researcher · lead", "Writer · final
 * answer". It used to be "Agent A · lead" / "Agent C · responder" — anonymous letters the operator
 * had to map back to their own team, and "responder", a word nobody uses for "wrote the answer".
 */
export function ownerLabelFor(index: number, count: number, id: string, names: ReadonlyMap<string, string>): string {
  const role = index === 0 ? 'lead' : index === count - 1 && count > 1 ? 'final answer' : 'helper'
  return `${names.get(id) ?? id} · ${role}`
}
