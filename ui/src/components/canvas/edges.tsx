import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'

import { linkOf } from '../../lib/canvas/linked'
import { trunkOf } from '../../lib/canvas/ports'
import { routeEdge } from './route'

import type { ProvEdge } from '../../lib/runs/graph'
import type { ConfiguredEdge } from '../../lib/team-file/useTeamDocument'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

// DESIGN_LANGUAGE §13: configured (warp) — quiet grey solid 1.5 px, filled arrowhead, static.
export function WarpEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, selected }: EdgeProps<ConfiguredEdge>) {
  const { path, labelX, labelY } = routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, trunk: trunkOf(data) })
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="warp" />
      {linkOf(data) === 'linked' && <path d={path} pathLength={1} className="react-flow__edge-thread" aria-hidden="true" />}
      {selected ? <EdgeLabelRenderer><span className={cx('edge-label edge-badge t-mono-sm', linkOf(data))} style={{ left: labelX, top: labelY }}>hands off</span></EdgeLabelRenderer> : null}
    </>
  )
}

/** The plain word for a planned relationship (ADR 0041). */
const PLAIN_RELATION: Readonly<Record<string, string>> = { 'uses skill': 'requires', 'responds with': 'produces', 'uses tool': 'can use' }

// Provenance / story edges: ONE neutral stroke for every relationship. The relationship word
// rides the edge.
export function ProvEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, selected }: EdgeProps<ProvEdge>) {
  // Every provenance line takes its shape from the sides its ports chose (lib/canvas/ports.ts).
  const { path, labelX, labelY, kind } = routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, trunk: trunkOf(data) })
  // A drop's word sits beside the line and a tree branch's left of the trunk, so lines stay unbroken.
  const beside = kind === 'drop'
  const before = kind === 'tree'
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cx('prov', data?.resource && 'resource-edge', data?.story && 'story-edge')} />
      {/* A selected card's other lines get the glint. */}
      {linkOf(data) === 'linked' && <path d={path} pathLength={1} className="react-flow__edge-thread" aria-hidden="true" />}
      {data?.label && (
        <EdgeLabelRenderer>
          <div className={cx('prov-label t-micro', data.story && 'story-label', selected && data.onRemove && 'with-remove', beside && 'beside', before && 'before', linkOf(data))} style={{ left: labelX, top: labelY }}>
            <span>{PLAIN_RELATION[data.label.toLowerCase()] ?? data.label.toLowerCase()}</span>
            {selected && data.onRemove ? (
              <button
                type="button"
                className="prov-edge-remove nodrag nopan"
                aria-label={data.removeLabel ?? 'Remove capability edge'}
                title="Remove connection"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); data.onRemove?.() }}
              >×</button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
