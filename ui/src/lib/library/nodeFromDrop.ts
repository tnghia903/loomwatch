import type { Node } from '@xyflow/react'

import { snapToGrid } from '../grid'
import { offsetCollision } from '../team-file/layout'
import type { AgentConfig } from '../team-file/types'
import type { AgentFieldProblems } from '../team-file/validation'
import { buildAgentFromSource } from './createAgent'
import type { LibrarySource } from './types'

export type AgentNode = Node<{
  label: string
  agent: AgentConfig
  isEntrypoint?: boolean
  /** docs/CANVAS_SPEC.md §5.2/§5.4: live per-field problems, already reveal-gated. */
  fieldProblems?: AgentFieldProblems
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
