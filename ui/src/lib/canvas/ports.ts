import type { Edge, Node } from '@xyflow/react'

/**
 * Where every canvas line attaches, decided in one place from where the two cards actually are.
 *
 * Every card exposes the same connection points (`components/canvas/CardPorts.tsx`), and no
 * section of the graph builder picks one. That used to be decided edge by edge — a resource lane
 * here, an "over the row" flag there, a fan handle for evidence — and each new kind of edge brought
 * a new way to cut through a card. The rules below are the whole policy:
 *
 * 1. **Stack** — two or more cards hanging below a card, in one column, are reached from a trunk
 *    on the source's left side, one short branch each (a tree, like a file list).
 * 2. **Drop** — a single card below is reached by a vertical line, bottom to top.
 * 3. Otherwise the line takes whichever shape crosses the fewest other cards, preferring the
 *    simpler on a tie: a **relay** (right side to left side — straight, since rows are top-aligned
 *    and both sides sit at `HANDLE_Y`), a **bridge** over the row (top to top), or one under it
 *    (bottom to bottom). A target to the left can only be bridged.
 */
export const PORT = {
  down: 'down',
  top: 'top',
  trunk: 'trunk',
  bridgeOut: 'bridge-out',
  bridgeIn: 'bridge-in',
  underOut: 'under-out',
  underIn: 'under-in',
} as const

/** How far a bridge rises above (or dips below) the cards it joins: longer bridges go further,
 *  so several nest instead of crossing. Shared with the renderer (components/canvas/route.ts). */
export function bridgeLift(span: number): number {
  return Math.max(59, 48 + Math.abs(span) * 0.16)
}

/** Where on a card's top or bottom edge a bridge leaves and lands (fractions of its width). */
export const BRIDGE_OUT_AT = 0.62
export const BRIDGE_IN_AT = 0.38

/** The height of every left and right connection point, from the card's top (`--lw-handle-y`). */
export const HANDLE_Y = 44

export interface Box { x: number; y: number; width: number; height: number }

type Ports = { sourceHandle: string | null; targetHandle: string | null }

const GAP = 8
const COLUMN = 12

const below = (s: Box, t: Box) => t.y >= s.y + s.height + GAP && t.x < s.x + s.width && t.x + t.width > s.x

const MARGIN = 4

/** Does the segment from (x1, y1) to (x2, y2) — horizontal or vertical — pass through `box`? */
function crosses(box: Box, x1: number, y1: number, x2: number, y2: number): boolean {
  const [left, right] = x1 < x2 ? [x1, x2] : [x2, x1]
  const [top, bottom] = y1 < y2 ? [y1, y2] : [y2, y1]
  return box.x - MARGIN < right && box.x + box.width + MARGIN > left && box.y - MARGIN < bottom && box.y + box.height + MARGIN > top
}

/**
 * Would the relay from `s` to `t` run through another card? Tested on the path the relay actually
 * draws — out along the source's spine height, down or up at the midpoint, in along the target's —
 * so a card merely near the line never forces a detour.
 */
type Segment = [number, number, number, number]

function relay(s: Box, t: Box): Segment[] {
  const sx = s.x + s.width
  const sy = s.y + HANDLE_Y
  const tx = t.x
  const ty = t.y + HANDLE_Y
  const mid = (sx + tx) / 2
  return [[sx, sy, mid, sy], [mid, sy, mid, ty], [mid, ty, tx, ty]]
}

function over(s: Box, t: Box): Segment[] {
  const sx = s.x + s.width * BRIDGE_OUT_AT
  const tx = t.x + t.width * BRIDGE_IN_AT
  const apex = Math.min(s.y, t.y) - bridgeLift(tx - sx)
  return [[sx, s.y, sx, apex], [sx, apex, tx, apex], [tx, apex, tx, t.y]]
}

function under(s: Box, t: Box): Segment[] {
  const sx = s.x + s.width * BRIDGE_OUT_AT
  const tx = t.x + t.width * BRIDGE_IN_AT
  const sb = s.y + s.height
  const tb = t.y + t.height
  const base = Math.max(sb, tb) + bridgeLift(tx - sx)
  return [[sx, sb, sx, base], [sx, base, tx, base], [tx, base, tx, tb]]
}

/** How many other cards a path made of these segments runs through. */
function crossings(path: readonly Segment[], others: readonly Box[]): number {
  return others.filter((box) => path.some(([x1, y1, x2, y2]) => crosses(box, x1, y1, x2, y2))).length
}

export function choosePorts(s: Box, t: Box, others: readonly Box[], stacked: boolean): Ports {
  if (stacked) return { sourceHandle: PORT.trunk, targetHandle: null }
  if (below(s, t)) return { sourceHandle: PORT.down, targetHandle: PORT.top }
  const shapes: { ports: Ports; path: Segment[] }[] = [
    ...(t.x + t.width > s.x + GAP ? [{ ports: { sourceHandle: null, targetHandle: null }, path: relay(s, t) }] : []),
    { ports: { sourceHandle: PORT.bridgeOut, targetHandle: PORT.bridgeIn }, path: over(s, t) },
    { ports: { sourceHandle: PORT.underOut, targetHandle: PORT.underIn }, path: under(s, t) },
  ]
  // Fewest cards crossed wins; on a tie the earlier (simpler) shape does.
  return shapes.reduce((best, shape) => (crossings(shape.path, others) < crossings(best.path, others) ? shape : best)).ports
}

/** A node's box from what React Flow measured, else what the builder declared. */
export function boxOf(node: Node): Box | null {
  const width = node.measured?.width ?? node.width ?? node.initialWidth
  const height = node.measured?.height ?? node.height ?? node.initialHeight
  if (!width || !height) return null
  return { x: node.position.x, y: node.position.y, width, height }
}

/** Every edge with its connection points chosen by the rules above. */
export function assignPorts<E extends Edge>(edges: readonly E[], nodes: readonly Node[]): E[] {
  const boxes = new Map<string, Box>()
  for (const node of nodes) {
    const box = boxOf(node)
    if (box) boxes.set(node.id, box)
  }
  // Rule 1 needs to see every edge leaving a card at once: a stack is a property of the group.
  const stackedEdges = new Set<string>()
  const bySource = new Map<string, E[]>()
  for (const edge of edges) bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge])
  for (const [source, group] of bySource) {
    const s = boxes.get(source)
    if (!s) continue
    const hanging = group.filter((edge) => { const t = boxes.get(edge.target); return t && below(s, t) })
    const xs = hanging.map((edge) => (boxes.get(edge.target) as Box).x)
    if (hanging.length >= 2 && Math.max(...xs) - Math.min(...xs) <= COLUMN) hanging.forEach((edge) => stackedEdges.add(edge.id))
  }
  return edges.map((edge) => {
    const s = boxes.get(edge.source)
    const t = boxes.get(edge.target)
    if (!s || !t) return edge
    const others = [...boxes].filter(([id]) => id !== edge.source && id !== edge.target).map(([, box]) => box)
    return { ...edge, ...choosePorts(s, t, others, stackedEdges.has(edge.id)) }
  })
}
