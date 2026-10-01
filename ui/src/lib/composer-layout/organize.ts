import dagre from '@dagrejs/dagre'

export interface LayoutCard { id: string; width?: number; height?: number }
export interface LayoutLink { from: string; to: string }
export type Positions = Record<string, { x: number; y: number }>

/** Lay out execution stages first. Resources occupy a separate lane below their owner. */
export function organizePipeline(
  agents: readonly LayoutCard[],
  steps: readonly LayoutLink[],
  resources: readonly LayoutCard[],
  wiring: readonly LayoutLink[],
): Positions {
  if (!agents.length) return {}
  const ordered = [...agents].sort((a, b) => a.id.localeCompare(b.id))
  const ids = new Set(ordered.map(({ id }) => id))
  const owned = new Map(ordered.map(({ id }) => [id, [] as LayoutCard[]]))
  const unassigned: LayoutCard[] = []
  for (const resource of [...resources].sort((a, b) => a.id.localeCompare(b.id))) {
    // Shared resources get one card and retain every edge. Deterministic ownership prevents
    // reshuffling when the same graph arrives in a different serialization order.
    const owner = wiring.filter((edge) => edge.to === resource.id && ids.has(edge.from))
      .map((edge) => edge.from).sort()[0]
    if (owner) owned.get(owner)!.push(resource)
    else unassigned.push(resource)
  }
  const width = Math.max(280, ...[...agents, ...resources].map((card) => card.width ?? 280))
  const agentHeight = Math.max(150, ...agents.map((card) => card.height ?? 150))
  const resourceHeight = (card: LayoutCard) => Math.max(88, card.height ?? 88)
  // Equal group heights keep a linear pipeline on one horizontal spine, even when one stage
  // uses more resources. Branches get separate lanes with room for their entire resource stack.
  const groupHeight = agentHeight + 64 + Math.max(0, ...[...owned.values()].map((cards) => cards.reduce((height, card) => height + resourceHeight(card) + 32, 0)))
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', ranksep: 150, nodesep: 100 })
  ordered.forEach(({ id }) => graph.setNode(id, { width, height: groupHeight }))
  steps.filter(({ from, to }) => ids.has(from) && ids.has(to) && from !== to)
    .sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`))
    .forEach(({ from, to }) => graph.setEdge(from, to))
  dagre.layout(graph)
  const positions: Positions = {}
  for (const { id } of ordered) {
    const point = graph.node(id)
    const x = point.x - width / 2
    const y = point.y - groupHeight / 2
    positions[id] = { x, y }
    let resourceY = y + agentHeight + 64
    for (const resource of owned.get(id)!) {
      positions[resource.id] = { x, y: resourceY }
      resourceY += resourceHeight(resource) + 32
    }
  }
  // Unwired resources and team-wide memory have their own shelf, below all execution lanes.
  const bottom = Math.max(...ordered.map(({ id }) => positions[id].y + groupHeight)) + 100
  unassigned.forEach(({ id }, index) => { positions[id] = { x: index * (width + 80), y: bottom } })
  return positions
}
