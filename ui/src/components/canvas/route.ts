import { getSmoothStepPath, Position, type EdgeProps } from '@xyflow/react'

import { bridgeLift } from '../../lib/canvas/ports'

/**
 * How a line is drawn once `lib/canvas/ports.ts` has chosen which sides of the two cards it meets
 * (ADR 0024). Every line is straight runs joined by rounded corners, never a curve. The shape
 * follows from the sides alone:
 *
 * - right → left: a **relay**, an orthogonal step (straight when the rows line up);
 * - bottom → top: a **drop**, labelled beside the line;
 * - top → top: a **bridge** over the row, higher the longer it is so several nest;
 * - left → left: a **tree** branch off a trunk to the left of a stack of cards.
 */
export interface Route { path: string; labelX: number; labelY: number; kind: 'forward' | 'return' | 'drop' | 'bridge' | 'tree' }

const RETURN_LIFT = 84
/** How far a line going back to an earlier card runs out of one side and into the other. */
const RETURN_REACH = 24
const CORNER = 14

type Point = readonly [number, number]

/**
 * A path along horizontal and vertical runs through `points`, each corner rounded. A corner never
 * takes more than half of either run beside it, so short runs stay square-ish instead of looping.
 */
export function roundedPath(points: readonly Point[], radius = CORNER): string {
  const distinct = points.filter((point, i) => i === 0 || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1])
  // A point in the middle of a straight run is no corner.
  const corners = distinct.filter((point, i) => {
    if (i === 0 || i === distinct.length - 1) return true
    const [before, after] = [distinct[i - 1], distinct[i + 1]]
    return !((before[0] === point[0] && point[0] === after[0]) || (before[1] === point[1] && point[1] === after[1]))
  })
  const [first] = corners
  if (!first) return ''
  let path = `M ${first[0]} ${first[1]}`
  for (let i = 1; i < corners.length - 1; i += 1) {
    const [before, at, after] = [corners[i - 1], corners[i], corners[i + 1]]
    const into = Math.hypot(at[0] - before[0], at[1] - before[1])
    const out = Math.hypot(after[0] - at[0], after[1] - at[1])
    const r = Math.min(radius, into / 2, out / 2)
    const start: Point = [at[0] - ((at[0] - before[0]) / into) * r, at[1] - ((at[1] - before[1]) / into) * r]
    const end: Point = [at[0] + ((after[0] - at[0]) / out) * r, at[1] + ((after[1] - at[1]) / out) * r]
    path += ` L ${start[0]} ${start[1]} Q ${at[0]} ${at[1]} ${end[0]} ${end[1]}`
  }
  const last = corners[corners.length - 1]
  if (corners.length > 1) path += ` L ${last[0]} ${last[1]}`
  return path
}

export function routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: Pick<EdgeProps, 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>, lift = RETURN_LIFT): Route {
  if (sourcePosition === Position.Top && targetPosition === Position.Top) {
    // A bridge: up out of one card's top, over the row, down into the other's. Used for calls that
    // skip over or run against the spine, so they never cross a card.
    // Longer bridges fly higher, so several of them nest instead of crossing (same rise the port
    // chooser tested for obstacles).
    const top = Math.min(sourceY, targetY) - bridgeLift(targetX - sourceX)
    return {
      path: roundedPath([[sourceX, sourceY], [sourceX, top], [targetX, top], [targetX, targetY]]),
      labelX: (sourceX + targetX) / 2,
      labelY: top,
      kind: 'bridge',
    }
  }
  if (sourcePosition === Position.Bottom && targetPosition === Position.Bottom) {
    // The same bridge, under the row, for when going over would cross a card.
    const base = Math.max(sourceY, targetY) + bridgeLift(targetX - sourceX)
    return {
      path: roundedPath([[sourceX, sourceY], [sourceX, base], [targetX, base], [targetX, targetY]]),
      labelX: (sourceX + targetX) / 2,
      labelY: base,
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
    // Back to an earlier card: out of the source's right side, up over both, down and into the
    // target's left side.
    const top = Math.min(sourceY, targetY) - lift
    return {
      path: roundedPath([[sourceX, sourceY], [sourceX + RETURN_REACH, sourceY], [sourceX + RETURN_REACH, top], [targetX - RETURN_REACH, top], [targetX - RETURN_REACH, targetY], [targetX, targetY]]),
      labelX: (sourceX + targetX) / 2,
      labelY: top,
      kind: 'return',
    }
  }
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: CORNER, offset: 22 })
  return { path, labelX, labelY, kind: sourcePosition === Position.Bottom && targetPosition === Position.Top ? 'drop' : 'forward' }
}
