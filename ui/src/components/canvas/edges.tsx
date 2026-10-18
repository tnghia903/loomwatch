import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'

import { linkOf } from '../../lib/canvas/linked'
import { trunkOf } from '../../lib/canvas/ports'
import { routeEdge } from './route'

import type { ProvEdge, WeftEdge } from '../../lib/runs/graph'
import type { ConfiguredEdge } from '../../lib/team-file/useTeamDocument'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

// DESIGN_LANGUAGE §13: configured (warp) — quiet grey solid 1.5 px, filled arrowhead, static.
// Where an observed edge coincides with it, no second line is drawn: the warp gains a 24 px
// gold shuttle per event and a ×n count badge.
export function WarpEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, selected }: EdgeProps<ConfiguredEdge>) {
  const { path, labelX, labelY } = routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, trunk: trunkOf(data) })
  const extra = data as (ConfiguredEdge['data'] & { shuttle?: boolean; count?: number; anomaly?: boolean }) | undefined
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="warp" />
      {linkOf(data) === 'linked' && <path d={path} pathLength={1} className="react-flow__edge-thread" aria-hidden="true" />}
      {extra?.shuttle && <path d={path} className="react-flow__edge-path shuttle" aria-hidden="true" />}
      {extra?.count ? (
        <EdgeLabelRenderer>
          <span className={cx('edge-label edge-badge t-mono-sm', extra.anomaly && 'alert', linkOf(data))} style={{ left: labelX, top: labelY }} title={`${extra.count} observed event${extra.count === 1 ? '' : 's'} along this configured edge`}>×{extra.count}</span>
        </EdgeLabelRenderer>
      ) : selected ? <EdgeLabelRenderer><span className={cx('edge-label edge-badge t-mono-sm', linkOf(data))} style={{ left: labelX, top: labelY }}>hands off</span></EdgeLabelRenderer> : null}
    </>
  )
}

// Observed (weft): gold, dashed, travelling. dispatch 6 4; ask 2 3 both ends; handoff 10 4 heavy.
export function WeftEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, markerStart, data }: EdgeProps<WeftEdge>) {
  // Observed calls take the same straight, rounded-corner route as the planned lines.
  const { path, labelX, labelY } = routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, trunk: trunkOf(data) })
  const kind = data?.kind ?? 'dispatch'
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={kind === 'ask' ? markerStart : undefined} className={cx('weft', kind, data?.aged && 'aged', data?.anomaly && 'anomaly')} />
      <EdgeLabelRenderer>
        <span className={cx('edge-label edge-badge t-mono-sm', data?.anomaly && 'alert', linkOf(data))} style={{ left: labelX, top: labelY }} title={data?.anomaly ? 'Observed with no configured counterpart' : `${kind} observed`}>
          {data?.count && data.count > 1 ? `${kind} ×${data.count}` : kind}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}

/** The plain word for a planned relationship, the same on the Build and Run canvases (ADR 0041). */
const PLAIN_RELATION: Readonly<Record<string, string>> = { 'uses skill': 'requires', 'responds with': 'produces', 'uses tool': 'can use' }

// Provenance / story edges: ONE neutral stroke for every relationship; only work happening
// now may use the animated blue live stroke (§12.3). The relationship word rides the edge.
export function ProvEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, selected }: EdgeProps<ProvEdge>) {
  // Every provenance line takes its shape from the sides its ports chose (lib/canvas/ports.ts).
  const { path, labelX, labelY, kind } = routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, trunk: trunkOf(data) })
  // A drop's word sits beside the line and a tree branch's left of the trunk, so lines stay unbroken.
  const beside = kind === 'drop'
  const before = kind === 'tree'
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cx('prov', data?.resource && 'resource-edge', data?.story && 'story-edge', data?.live && 'prov-live', data?.prior && 'prior-edge', data?.arc && 'arc-edge')} />
      {/* A live line already moves in blue; a selected card's other lines get the glint. */}
      {linkOf(data) === 'linked' && !data?.live && <path d={path} pathLength={1} className="react-flow__edge-thread" aria-hidden="true" />}
      {data?.label && (
        <EdgeLabelRenderer>
          <div className={cx('prov-label t-micro', data.story && 'story-label', data.live && 'prov-live-label', selected && data.onRemove && 'with-remove', beside && 'beside', before && 'before', data.arc && 'arc-label', linkOf(data))} style={{ left: labelX, top: labelY + (data.labelOffset ?? 0) }}>
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
