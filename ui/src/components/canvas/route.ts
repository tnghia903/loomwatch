import { getSmoothStepPath, Position, type EdgeProps } from '@xyflow/react'

import { bridgeLift } from '../../lib/canvas/ports'

/**
 * How a line is drawn once `lib/canvas/ports.ts` has chosen which sides of the two cards it meets
 * (ADR 0024). The shape follows from the sides alone:
 *
 * - right → left: a **relay**, an orthogonal step (straight when the rows line up);
 * - bottom → top: a **drop**, labelled beside the line;
 * - top → top: a **bridge** over the row, higher the longer it is so several nest;
 * - left → left: a **tree** branch off a trunk to the left of a stack of cards.
 */
export interface Route { path: string; labelX: number; labelY: number; kind: 'forward' | 'return' | 'drop' | 'bridge' | 'tree' }

const RETURN_LIFT = 84

export function routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: Pick<EdgeProps, 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>, lift = RETURN_LIFT): Route {
  if (sourcePosition === Position.Top && targetPosition === Position.Top) {
    // A bridge: up out of one card's top, over the row, down into the other's. Used for calls that
    // skip over or run against the spine, so they never cross a card.
    // Longer bridges fly higher, so several of them nest instead of crossing (same rise the port
    // chooser tested for obstacles).
    const top = Math.min(sourceY, targetY) - bridgeLift(targetX - sourceX)
    return {
      path: `M ${sourceX} ${sourceY} C ${sourceX} ${top}, ${targetX} ${top}, ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: 0.125 * sourceY + 0.75 * top + 0.125 * targetY,
      kind: 'bridge',
    }
  }
  if (sourcePosition === Position.Bottom && targetPosition === Position.Bottom) {
    // The same bridge, under the row, for when going over would cross a card.
    const base = Math.max(sourceY, targetY) + bridgeLift(targetX - sourceX)
    return {
      path: `M ${sourceX} ${sourceY} C ${sourceX} ${base}, ${targetX} ${base}, ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: 0.125 * sourceY + 0.75 * base + 0.125 * targetY,
      kind: 'bridge',
    }
  }
  if (sourcePosition === Position.Left && targetPosition === Position.Left) {
    const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10, offset: 20 })
    // The word sits left of the trunk, level with its own branch.
    return { path, labelX: Math.min(sourceX, targetX) - 26, labelY: targetY, kind: 'tree' }
  }
  const sideways = sourcePosition === Position.Right && targetPosition === Position.Left
  if (sideways && targetX < sourceX + 16) {
    const top = Math.min(sourceY, targetY) - lift
    const midX = (sourceX + targetX) / 2
    const reach = Math.max(40, Math.min(90, Math.abs(sourceX - targetX) / 3))
    return {
      path: `M ${sourceX} ${sourceY} C ${sourceX + reach} ${sourceY}, ${sourceX + reach} ${top}, ${midX} ${top} C ${targetX - reach} ${top}, ${targetX - reach} ${targetY}, ${targetX} ${targetY}`,
      labelX: midX,
      labelY: top,
      kind: 'return',
    }
  }
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 14, offset: 22 })
  return { path, labelX, labelY, kind: sourcePosition === Position.Bottom && targetPosition === Position.Top ? 'drop' : 'forward' }
}
