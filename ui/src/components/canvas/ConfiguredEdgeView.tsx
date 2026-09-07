import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

import type { ConfiguredEdge } from '../../lib/team-file/useTeamDocument'

// docs/CANVAS_SPEC.md §6.2: configured · sequence — 1.5px solid `stroke`, filled arrowhead,
// the direct smoothstep path (§6.1's geometry row), no motion. Selection widens the stroke
// and the spec's iris ring glow (§6.2 "Selected edge") is approximated with a soft halo.
export function ConfiguredEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  markerEnd,
}: EdgeProps<ConfiguredEdge>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke: 'var(--color-stroke)',
        strokeWidth: selected ? 2.5 : 1.5,
        filter: selected ? 'drop-shadow(0 0 2px var(--color-iris))' : undefined,
      }}
    />
  )
}
