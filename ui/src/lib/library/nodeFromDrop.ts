import type { Node } from '@xyflow/react'

import { snapToGrid } from '../grid'
import { offsetCollision } from '../team-file/layout'
import type { WaitingOn } from '../runs/client'
import type { AgentRuntime } from '../runs/graph'
import type { AgentConfig } from '../team-file/types'
import type { AgentFieldProblems } from '../team-file/validation'
import { buildAgentFromSource } from './createAgent'
import type { LibrarySource } from './types'

export type AgentNode = Node<{
  label: string
  harnessLabel?: string
  agent: AgentConfig
  isEntrypoint?: boolean
  waiting?: WaitingOn | null
  onAnswer?: () => void
  /** docs/CANVAS_SPEC.md §5.2/§5.4: live per-field problems, already reveal-gated. */
  fieldProblems?: AgentFieldProblems
  /** TNG-113: runtime task state while a run is shown. View state only. */
  runtime?: AgentRuntime
}>

/**
 * Parsing/positioning logic for drag-to-instantiate (docs/CANVAS_SPEC.md §4.5), split out from
 * the React drop handler so it is unit-testable without a real DragEvent/DataTransfer.
 */
export function nodeFromDrop(
  rawPayload: string,
  dropPosition: { x: number; y: number },
  existingNodes: readonly AgentNode[],
): AgentNode | null {
  let source: LibrarySource
  try {
    source = JSON.parse(rawPayload) as LibrarySource
  } catch {
    return null
  }

  const existingAgents = existingNodes.map((node) => node.data.agent)
  const agent = buildAgentFromSource(source, existingAgents)

  return {
    id: agent.id,
    type: 'agent',
    position: offsetCollision(
      { x: snapToGrid(dropPosition.x), y: snapToGrid(dropPosition.y) },
      existingNodes.map((node) => node.position),
    ),
    data: { label: agent.name, agent },
    selected: true,
  }
}
