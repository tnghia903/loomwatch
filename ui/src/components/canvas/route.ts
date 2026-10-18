import { getSmoothStepPath, Position, type EdgeProps } from '@xyflow/react'

import { linePoints, type Point, type Trunk } from '../../lib/canvas/ports'

/**
 * How a line is drawn once `lib/canvas/ports.ts` has chosen which of the two cards' four points it
 * joins (ADR 0024). Every line is straight runs joined by rounded corners, never a curve, through
 * the corners `linePoints` gives, the same ones the port chooser tested for crossings. The shape
 * follows from the sides alone:
 *
 * - right → left: a **relay**, an orthogonal step (straight when the rows line up), and left →
 *   right the same backwards;
 * - bottom → top: a **drop**, labelled beside the line, and top → bottom the same upwards;
 * - top → top: a **bridge** over the row, higher the longer it is so several nest, and bottom →
 *   bottom the same under it;
 * - bottom → left: a **tree** branch off a trunk to the left of a stack of cards.
 */
export interface Route { path: string; labelX: number; labelY: number; kind: 'forward' | 'return' | 'drop' | 'bridge' | 'tree' }

const RETURN_LIFT = 84
/** How far a line going back to an earlier card runs out of one side and into the other. */
const RETURN_REACH = 24
const CORNER = 14

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

export function routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, trunk }: Pick<EdgeProps, 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'> & { trunk?: Trunk }, lift = RETURN_LIFT): Route {
  const sideways = sourcePosition === Position.Right && targetPosition === Position.Left
  if (sideways && targetX < sourceX + 16) {
    // Back to an earlier card: out of the source's right side, up over both, down and into the
    // target's left side. The port chooser bridges instead; this is for a line drawn before its
    // cards were measured, when it could not choose.
    const top = Math.min(sourceY, targetY) - lift
    return {
      path: roundedPath([[sourceX, sourceY], [sourceX + RETURN_REACH, sourceY], [sourceX + RETURN_REACH, top], [targetX - RETURN_REACH, top], [targetX - RETURN_REACH, targetY], [targetX, targetY]]),
      labelX: (sourceX + targetX) / 2,
      labelY: top,
      kind: 'return',
    }
  }
  const points = linePoints([sourceX, sourceY], sourcePosition, [targetX, targetY], targetPosition, trunk)
  if (points) {
    const path = roundedPath(points)
    if (sourcePosition === targetPosition) {
      // A bridge's word sits on its flat run, over (or under) the row.
      return { path, labelX: (sourceX + targetX) / 2, labelY: points[1][1], kind: 'bridge' }
    }
    if (sourcePosition === Position.Bottom && targetPosition === Position.Left) {
      // The word sits left of the trunk, level with its own branch.
      return { path, labelX: points[2][0] - 6, labelY: targetY, kind: 'tree' }
    }
    return { path, labelX: (sourceX + targetX) / 2, labelY: (sourceY + targetY) / 2, kind: sourcePosition === Position.Bottom && targetPosition === Position.Top ? 'drop' : 'forward' }
  }
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: CORNER, offset: 22 })
  return { path, labelX, labelY, kind: 'forward' }
}
