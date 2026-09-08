import dagre from '@dagrejs/dagre'

import type { AgentNode } from '../library/nodeFromDrop'

// docs/CANVAS_SPEC.md §7.2/§7.3. Positions are deliberately not serialized into the team
// document. These helpers make the fallback and explicit auto-layout deterministic instead.
const NODE_WIDTH = 264
const NODE_HEIGHT = 88
const NODE_SEPARATION = 48
const RANK_SEPARATION = 96

export interface LayoutEdge {
  from: string
  to: string
}

export function autoLayout(
  nodes: readonly Pick<AgentNode, 'id'>[],
  edges: readonly LayoutEdge[],
): Record<string, { x: number; y: number }> {
  if (edges.length === 0) {
    return teamConstellation(nodes.map((node) => node.id))
  }

  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', nodesep: NODE_SEPARATION, ranksep: RANK_SEPARATION })
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of [...edges].sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`))) {
    graph.setEdge(edge.from, edge.to)
  }
  dagre.layout(graph)

  return Object.fromEntries(
    nodes.map((node) => {
      const position = graph.node(node.id) as { x: number; y: number }
      return [node.id, { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 }]
    }),
  )
}

/** A centred, deterministic grid for team mode, where rank would imply false ordering. */
function teamConstellation(agentIds: readonly string[]): Record<string, { x: number; y: number }> {
  const ordered = [...agentIds].sort((a, b) => a.localeCompare(b))
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)))
  const rows = Math.max(1, Math.ceil(ordered.length / columns))
  const cellWidth = NODE_WIDTH + NODE_SEPARATION
  const cellHeight = NODE_HEIGHT + 72
  const width = (columns - 1) * cellWidth
  const height = (rows - 1) * cellHeight

  return Object.fromEntries(
    ordered.map((id, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      return [id, { x: column * cellWidth - width / 2, y: row * cellHeight - height / 2 }]
    }),
  )
}

/** Deterministic no-position fallback. The team id is the stable seed boundary. */
export function seededLayout(
  agentIds: readonly string[],
  edges: readonly LayoutEdge[] = [],
  _teamId = '',
): Record<string, { x: number; y: number }> {
  return autoLayout(agentIds.map((id) => ({ id })), edges)
}

/** §7.2: offset a fully overlapping drop by +24,+24 until its card is clear. */
export function offsetCollision(
  position: { x: number; y: number },
  occupied: readonly { x: number; y: number }[],
): { x: number; y: number } {
  let candidate = position
  while (occupied.some((other) => other.x === candidate.x && other.y === candidate.y)) {
    candidate = { x: candidate.x + 24, y: candidate.y + 24 }
  }
  return candidate
}
