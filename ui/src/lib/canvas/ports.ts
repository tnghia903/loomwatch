import { Position, type Edge, type Node } from '@xyflow/react'

/**
 * Where every canvas line attaches, decided in one place from where the two cards actually are.
 *
 * Every card has four connection points, one on each side (`components/canvas/CardPorts.tsx`): the
 * middle of its top and bottom, and on its left and right at `HANDLE_Y`, the height of the card's
 * name, so a row of top-aligned cards of different heights still draws a straight line. No section
 * of the graph builder picks one. The rules below are the whole policy:
 *
 * 1. **Stack** — two or more cards hanging below a card, in one column: the nearest is dropped to
 *    straight, bottom to top, as a lone card would be, and the ones past it, which a straight line
 *    would reach only through it, by a tree: out of the source's bottom, down a trunk to the left of
 *    the column, one short branch into each card's left side, like a file list.
 * 2. Otherwise a line joins the two points that face each other, the shape that crosses the fewest
 *    other cards winning, and the earlier on a tie: a **relay** to a card on the right (right side to
 *    left side), a **drop** to a card below (bottom to top), a **bridge** over the row (top to top)
 *    or under it (bottom to bottom), and last the two that run backwards (left side to right side,
 *    top to bottom). So a line comes out of a card's right or bottom and goes into its left or top,
 *    and one that would run back through the row bridges over it instead.
 */
export const PORT = {
  /** Top, receiving. */
  top: 'top',
  /** Top, sending. */
  topOut: 'top-out',
  /** Bottom, sending: dragging down from an agent attaches a resource below it. */
  down: 'down',
  /** Bottom, receiving. */
  bottomIn: 'bottom-in',
  /** Left, sending. The left side's receiving point is the handle with no id. */
  leftOut: 'left-out',
  /** Right, receiving. The right side's sending point is the handle with no id. */
  rightIn: 'right-in',
} as const

/** How far a bridge rises above (or dips below) the cards it joins: longer bridges go further,
 *  so several nest instead of crossing. Shared with the renderer (components/canvas/route.ts). */
export function bridgeLift(span: number): number {
  return Math.max(59, 48 + Math.abs(span) * 0.16)
}

/** The height of every left and right connection point, from the card's top (`--lw-handle-y`). */
export const HANDLE_Y = 44

export interface Box { x: number; y: number; width: number; height: number }

export type Point = readonly [number, number]

/** Where a stack's trunk runs: down at `x`, after leaving the source's bottom at height `y`. */
export interface Trunk { x: number; y: number }

type Ports = { sourceHandle: string | null; targetHandle: string | null }

const SOURCE_SIDE: Readonly<Record<string, Position>> = { '': Position.Right, [PORT.down]: Position.Bottom, [PORT.topOut]: Position.Top, [PORT.leftOut]: Position.Left }
const TARGET_SIDE: Readonly<Record<string, Position>> = { '': Position.Left, [PORT.top]: Position.Top, [PORT.bottomIn]: Position.Bottom, [PORT.rightIn]: Position.Right }

/** The side a handle sits on, and its point on `box`. */
export function portAt(box: Box, handle: string | null | undefined, type: 'source' | 'target'): { point: Point; side: Position } {
  const side = (type === 'source' ? SOURCE_SIDE : TARGET_SIDE)[handle ?? ''] ?? (type === 'source' ? Position.Right : Position.Left)
  const point: Point = side === Position.Left ? [box.x, box.y + HANDLE_Y]
    : side === Position.Right ? [box.x + box.width, box.y + HANDLE_Y]
    : side === Position.Top ? [box.x + box.width / 2, box.y]
    : [box.x + box.width / 2, box.y + box.height]
  return { point, side }
}

const TRUNK_GAP = 20
const TRUNK_DROP = 16

/**
 * The corners a line passes through, from the side it leaves by to the side it enters by: straight
 * runs only, which the renderer rounds (components/canvas/route.ts) and the chooser below tests for
 * crossings, so what is tested is what is drawn. `null` for a pair of sides no rule above produces.
 */
export function linePoints(from: Point, out: Position, to: Point, into: Position, trunk?: Trunk): Point[] | null {
  const [fx, fy] = from
  const [tx, ty] = to
  if ((out === Position.Right && into === Position.Left) || (out === Position.Left && into === Position.Right)) {
    const mid = (fx + tx) / 2
    return [from, [mid, fy], [mid, ty], to]
  }
  if ((out === Position.Bottom && into === Position.Top) || (out === Position.Top && into === Position.Bottom)) {
    const mid = (fy + ty) / 2
    return [from, [fx, mid], [tx, mid], to]
  }
  if (out === Position.Top && into === Position.Top) {
    const apex = Math.min(fy, ty) - bridgeLift(tx - fx)
    return [from, [fx, apex], [tx, apex], to]
  }
  if (out === Position.Bottom && into === Position.Bottom) {
    const base = Math.max(fy, ty) + bridgeLift(tx - fx)
    return [from, [fx, base], [tx, base], to]
  }
  if (out === Position.Bottom && into === Position.Left) {
    const { x, y } = trunk ?? { x: tx - TRUNK_GAP, y: fy + TRUNK_DROP }
    return [from, [fx, y], [x, y], [x, ty], to]
  }
  return null
}

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

/** How many other cards the line through these corners runs through. */
function crossings(points: readonly Point[], others: readonly Box[]): number {
  return others.filter((box) => points.some((point, i) => i > 0 && crosses(box, points[i - 1][0], points[i - 1][1], point[0], point[1]))).length
}

/** The tree's ports (rule 1). Its trunk depends on the whole column, so `assignPorts` places it. */
const STACK: Ports = { sourceHandle: PORT.down, targetHandle: null }

export function choosePorts(s: Box, t: Box, others: readonly Box[], stacked: boolean): Ports {
  if (stacked) return STACK
  const sRight = s.x + s.width
  const tRight = t.x + t.width
  const sBottom = s.y + s.height
  const tBottom = t.y + t.height
  const shapes: Ports[] = [
    ...(t.x >= sRight + GAP ? [{ sourceHandle: null, targetHandle: null }] : []),
    ...(t.y >= sBottom + GAP ? [{ sourceHandle: PORT.down, targetHandle: PORT.top }] : []),
    { sourceHandle: PORT.topOut, targetHandle: PORT.top },
    { sourceHandle: PORT.down, targetHandle: PORT.bottomIn },
    ...(tRight <= s.x - GAP ? [{ sourceHandle: PORT.leftOut, targetHandle: PORT.rightIn }] : []),
    ...(tBottom <= s.y - GAP ? [{ sourceHandle: PORT.topOut, targetHandle: PORT.bottomIn }] : []),
  ]
  const crossed = (ports: Ports) => {
    const from = portAt(s, ports.sourceHandle, 'source')
    const to = portAt(t, ports.targetHandle, 'target')
    return crossings(linePoints(from.point, from.side, to.point, to.side) ?? [], others)
  }
  // Fewest cards crossed wins; on a tie the earlier shape does.
  return shapes.reduce((best, ports) => (crossed(ports) < crossed(best) ? ports : best))
}

/** The trunk an edge's data carries when it is a branch of a stack (rule 1). */
export function trunkOf(data: unknown): Trunk | undefined {
  return (data as { trunk?: Trunk } | undefined)?.trunk
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
  // Rule 1 needs to see every edge leaving a card at once: a stack is a property of the group, and
  // so is its trunk, which runs left of the whole column and leaves the source above its top card.
  const trunks = new Map<string, Trunk>()
  const bySource = new Map<string, E[]>()
  for (const edge of edges) bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge])
  for (const [source, group] of bySource) {
    const s = boxes.get(source)
    if (!s) continue
    const hanging = group.filter((edge) => { const t = boxes.get(edge.target); return t && below(s, t) })
    const column = hanging.map((edge) => boxes.get(edge.target) as Box)
    const xs = column.map((box) => box.x)
    if (hanging.length < 2 || Math.max(...xs) - Math.min(...xs) > COLUMN) continue
    const bottom = s.y + s.height
    const nearest = column.reduce((best, box) => (box.y < best.y ? box : best))
    const trunk = { x: Math.min(...xs) - TRUNK_GAP, y: bottom + Math.min(TRUNK_DROP, (nearest.y - bottom) / 2) }
    // The nearest card gets the straight drop; only the ones past it go round, down the trunk.
    hanging.forEach((edge, i) => { if (column[i] !== nearest) trunks.set(edge.id, trunk) })
  }
  return edges.map((edge) => {
    const s = boxes.get(edge.source)
    const t = boxes.get(edge.target)
    if (!s || !t) return edge
    const trunk = trunks.get(edge.id)
    const others = [...boxes].filter(([id]) => id !== edge.source && id !== edge.target).map(([, box]) => box)
    const routed = { ...edge, ...choosePorts(s, t, others, trunk !== undefined) }
    return trunk ? { ...routed, data: { ...edge.data, trunk } } : routed
  })
}
