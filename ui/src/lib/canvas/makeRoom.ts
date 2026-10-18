import type { Edge, Node } from '@xyflow/react'

import { assignPorts } from './ports'

export interface RoomCard { id: string; x: number; y: number; width?: number; height?: number }

/** The space kept between a card and one pushed down under it, room for an edge's label. */
export const ROOM_GAP = 40

/**
 * How far down to draw each card so that no card runs over one beneath it.
 *
 * Cards are arranged at Team depth, and Trace makes an agent card three or four times as tall
 * where it stands (lib/story/depth.ts): it adds the model, what it may do, what it is given and up
 * to eight lines of instructions. Without room made for that, it covers the folder or skill placed
 * under it. Each card that shares columns with a card above it is drawn at least `gap` below that
 * card's bottom, and the push carries on to whatever sits under it, so the arrangement keeps its
 * order. A card side by side with another, or not measured yet, is left where it is.
 *
 * Returns only the cards that move, by how far; their saved positions are not touched.
 */
export function makeRoom(cards: readonly RoomCard[], gap = ROOM_GAP): Map<string, number> {
  const measured = cards.filter((card): card is Required<RoomCard> => Boolean(card.width && card.height))
  const ordered = [...measured].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  const drawn: Array<{ card: Required<RoomCard>; top: number }> = []
  const shifts = new Map<string, number>()
  for (const card of ordered) {
    let top = card.y
    for (const above of drawn) {
      if (above.card.y >= card.y) continue
      if (above.card.x >= card.x + card.width || card.x >= above.card.x + above.card.width) continue
      top = Math.max(top, above.top + above.card.height + gap)
    }
    if (top > card.y) shifts.set(card.id, top - card.y)
    drawn.push({ card, top })
  }
  return shifts
}

/**
 * The canvas as Trace draws it: each card moved down as `makeRoom` says, and each line's sides
 * chosen again from where the cards are drawn (lib/canvas/ports.ts). The builder chose them where
 * the cards are saved, and there a folder under a card that grew still sits under its foot, so its
 * line bridged up over the card and back down through it instead of dropping straight to it.
 *
 * `sizes` are the sizes measured for the cards the document does not own; the rest carry their own.
 */
export function withRoom<N extends Node, E extends Edge>(nodes: N[], edges: E[], sizes: Readonly<Record<string, { width: number; height: number }>>): { nodes: N[]; edges: E[] } {
  const shifts = makeRoom(nodes.filter((node) => !node.hidden).map((node) => ({ id: node.id, ...node.position, ...(sizes[node.id] ?? node.measured) })))
  if (shifts.size === 0) return { nodes, edges }
  const moved = nodes.map((node) => {
    const down = shifts.get(node.id)
    return down ? { ...node, position: { x: node.position.x, y: node.position.y + down } } : node
  })
  return { nodes: moved, edges: assignPorts(edges, moved) }
}
