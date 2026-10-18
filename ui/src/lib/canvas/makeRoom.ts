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
