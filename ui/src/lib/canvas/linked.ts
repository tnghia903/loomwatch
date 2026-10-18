import type { Edge, EdgeMarkerType, Node } from '@xyflow/react'

/**
 * A selected card's own lines marked to glow, and everything else marked to step back: the other
 * lines, and the cards with no line to a selected card. A line's word lives outside the line's SVG,
 * so the mark also rides in its data (`linkOf`).
 */
export type Link = 'linked' | 'faded'

export function linkOf(data: unknown): Link | undefined {
  return (data as { link?: Link } | undefined)?.link
}

const LINKED_COLOR = 'var(--color-accent)'

const join = (...classes: Array<string | undefined>) => classes.filter(Boolean).join(' ')

/** The same arrowhead in the selection's gold, or the marker as it was when it is only an id. */
const gold = (marker: EdgeMarkerType | undefined) => (marker && typeof marker === 'object' ? { ...marker, color: LINKED_COLOR } : marker)

/**
 * Nodes and edges with the selection's lines marked. With nothing selected, the same arrays come
 * back; the selected cards and the cards they connect to keep their objects, so React Flow redraws
 * only the cards that step back.
 */
export function markLinked<N extends Node, E extends Edge>(nodes: N[], edges: E[]): { nodes: N[]; edges: E[] } {
  const selected = new Set(nodes.filter((node) => node.selected).map((node) => node.id))
  if (selected.size === 0) return { nodes, edges }
  const ends = new Set<string>()
  const marked = edges.map((edge) => {
    const link: Link = selected.has(edge.source) || selected.has(edge.target) ? 'linked' : 'faded'
    if (link === 'faded') return { ...edge, className: join(edge.className, link), data: { ...edge.data, link } }
    ends.add(edge.source)
    ends.add(edge.target)
    return { ...edge, className: join(edge.className, link), data: { ...edge.data, link }, markerEnd: gold(edge.markerEnd), markerStart: gold(edge.markerStart) }
  })
  return {
    nodes: nodes.map((node) => (ends.has(node.id) || selected.has(node.id) ? node : { ...node, className: join(node.className, 'faded') })),
    edges: marked,
  }
}
