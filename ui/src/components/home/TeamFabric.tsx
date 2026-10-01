import type { Fabric } from '../../lib/story/fabric'

const PITCH = 11

/** A team's recent runs, woven (lib/story/fabric.ts). Decorative to pointer users, described to screen readers. */
export function TeamFabric({ fabric }: { fabric: Fabric }) {
  if (fabric.threads.length === 0) return <span className="team-fabric empty">No runs yet — the first one starts the cloth.</span>
  const width = fabric.threads.length * PITCH + 2
  return (
    <span className="team-fabric">
      <svg width={width} height={24} viewBox={`0 0 ${width} 24`} role="img" aria-label={fabric.summary}>
        {/* The weft passes under every other thread and over the rest. */}
        <line className="fabric-weft" x1={0} y1={12} x2={width} y2={12} />
        {fabric.threads.map((thread, index) => (
          <rect key={thread.runId} className={`fabric-thread st-${thread.state}`} x={index * PITCH + 2} y={2} width={7} height={20} rx={3}>
            <title>{thread.label}</title>
          </rect>
        ))}
        {fabric.threads.map((thread, index) => index % 2 === 1 && <line key={`o${thread.runId}`} className="fabric-weft" x1={index * PITCH + 1} y1={12} x2={index * PITCH + 10} y2={12} />)}
      </svg>
      {fabric.caption && <span className="team-fabric-caption">{fabric.caption}</span>}
    </span>
  )
}
