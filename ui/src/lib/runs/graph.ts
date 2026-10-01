import type { Edge, Node } from '@xyflow/react'

import type { Evidence, RunPhase, TaskState } from '../watch/events'
import type { AgentStatus } from '../team-file/types'

/** Runtime facts merged onto an agent card while a run is shown. Never written to YAML. */
export interface AgentRuntime {
  status: AgentStatus
  taskState: TaskState
  task: string
  /** `Agent A · lead`, `Agent B · responder`, `Agent · helper` — presentation labels (§12.6). */
  ownerLabel: string
  costUsd: number | null
  spentPct: number | null
  live: boolean
  busUnavailable?: boolean
  /** Set when this stage was handed the preceding stages' replies, so the card can offer to show them. */
  received?: string | null
  /**
   * §15.2.3: evidence folds to a count on the card. `fanned` is true for the one agent whose
   * evidence is currently fanned out beside it, and mirrors the chip's `aria-expanded`.
   */
  eventCount?: number
  /** Calls opened but not yet paired to a terminal update — the honest "· open" on the count. */
  openCalls?: number
  fanned?: boolean
  /**
   * True when the run stored a context packet for this agent, so the packet inspector has an
   * entry point even for the entrypoint, which was handed nothing (docs/TEAM_MEMORY.md ledger).
   */
  hasPacket?: boolean
  /**
   * Notebook entries this agent was **supplied**, counted from the stored packet's notebook
   * section — not from the notes that exist.
   *
   * Read from the packet because that is the only honest source: the notebook grows during a run,
   * and an agent was given what its own packet recorded at the moment its session opened. The
   * card's word is "given N notes", one of the four the copy rules allow.
   */
  givenNotes?: number
}

/**
 * `draft` is the permanent Prompt node before a run: it mirrors the composer's text as the
 * operator types and focuses the composer when clicked. One editor, seen in two places (§15.2.2).
 * `attempt` is null in that state, because no attempt exists yet.
 */
export type PromptNodeData = {
  text: string
  attempt: number | null
  runId: string
  draft?: boolean
  /**
   * What this attempt follows, between attempts: "Follow-up of Run 03" or "Retry of Run 03".
   *
   * §15.2.2: "Between attempts, the node shows which run it belongs to and what it follows." Two
   * words, not one, because they are different actions: a follow-up replays the earlier stages, a
   * retry runs from zero. A run that is both — "Start a new run from this checkpoint" — reads as a
   * follow-up, which is what it mechanically is.
   */
  lineage?: string | null
}
export type RunNodeData = { attempt: number; phase: RunPhase; runId: string; mode: 'live' | 'replay'; branch: string; elapsed: string; trigger?: 'manual' | 'schedule' }
export type EvidenceNodeData = { evidence: Evidence; ownerLabel: string; live: boolean; selected: boolean }
export type OutputNodeData = {
  outputName?: string
  outputFormat?: string
  text: string
  phase: RunPhase
  phaseText: string
  producer: string | null
  producerLabel: string
  mode: 'live' | 'replay'
  streaming: boolean
  pending: boolean
  strip: { tone: 'halt' | 'alert' | 'ok'; message: string; watermark: string; href?: string } | null
  compact: boolean
  expanded: boolean
  terminal: boolean
  /** Compose-view affordance: an agent may connect here to become the configured responder. */
  configurable?: boolean
  /**
   * §15.2.2: the Output node is permanent, so it is on the canvas before any run has been shown.
   * `awaiting` is that state — no attempt, so no phase word, no live/replay badge, and nothing to
   * credit a producer with. `placeholder` is the copy shown while the node has no content; it is
   * null for a terminal state that can no longer answer, because a placeholder is a promise.
   */
  awaiting?: boolean
  placeholder?: string | null
}

export type MoreNodeData = { agentId: string; ownerLabel: string; hidden: number; total: number }
export type MoreNode = Node<MoreNodeData, 'more'>
export type PromptNode = Node<PromptNodeData, 'prompt'>
export type RunNode = Node<RunNodeData, 'run'>
export type EvidenceNode = Node<EvidenceNodeData, 'evidence'>
// Not 'output': React Flow ships built-in `input`/`default`/`output`/`group` types, and its
// stylesheet paints `.react-flow__node-output` as a 150 px bordered box — which showed through
// around this card as a stray empty rectangle.
export type OutputNode = Node<OutputNodeData, 'response'>

export type ProvEdgeData = {
  label?: string
  live?: boolean
  story?: boolean
  prior?: boolean
  labelOffset?: number
  arc?: boolean
  resource?: boolean
  /** Present only on editable capability wiring, never on run provenance. */
  onRemove?: () => void
  removeLabel?: string
}
export type WeftEdgeData = { kind: 'dispatch' | 'ask' | 'handoff'; aged?: boolean; anomaly?: boolean; count?: number }
export type WarpEdgeData = { kind: 'sequence'; ts: string; shuttle?: boolean; count?: number; anomaly?: boolean }

export type ProvEdge = Edge<ProvEdgeData, 'prov'>
export type WeftEdge = Edge<WeftEdgeData, 'weft'>

export const RUN_PHASE_STATUS: Record<RunPhase, AgentStatus> = {
  queued: 'idle', starting: 'starting', running: 'running', succeeded: 'succeeded', partial: 'failed', failed: 'failed', cancelled: 'stopped',
}

export function ownerLabelFor(index: number, count: number, id: string, names: ReadonlyMap<string, string>): string {
  const letter = String.fromCharCode(65 + Math.min(index, 25))
  const role = index === 0 ? 'lead' : index === count - 1 && count > 1 ? 'responder' : 'helper'
  const name = names.get(id) ?? id
  return count > 1 ? `Agent ${letter} · ${role}` : `${name} · lead`
}
