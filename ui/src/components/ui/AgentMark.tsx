import { useMemo } from 'react'

import { LIVE_MARK_STATES, MARK_WORDS, markPattern, stitchCell, type MarkState } from '../../lib/story/mark'

interface AgentMarkProps {
  /** The agent's id: the weave is derived from it, so one agent always wears one swatch. */
  id: string
  /** Used for the accessible name, e.g. "Researcher". */
  name?: string
  size?: number
  state?: MarkState
  /** Recorded events so far; each new one lays a single stitch while the run is live. */
  events?: number
  /** The review step — the operator — wears a ring, not a weave. */
  operator?: boolean
  /** False for a replay or a finished run: the mark shows its state but does not move. */
  animate?: boolean
  className?: string
}

const AT = [6, 12, 18] as const
/** Half the length of one float, leaving a visible gap between neighbouring crossings. */
const FLOAT = 2.3

/**
 * An agent's mark (lib/story/mark.ts). The weave identifies the agent; the motion is the run
 * record, played back: threads pulse while it thinks, a shuttle runs while it uses a tool, rows
 * weave in while it writes, a stitch lands for each recorded event, a knot ties off when it is
 * done and a thread breaks when it fails. Nothing moves that the record does not show.
 */
export function AgentMark({ id, name, size = 24, state = 'still', events = 0, operator = false, animate = true, className = '' }: AgentMarkProps) {
  const { over, seed } = useMemo(() => markPattern(id), [id])
  const moving = animate && LIVE_MARK_STATES.has(state)
  const words = MARK_WORDS[state]
  const label = [name, words].filter(Boolean).join(', ') || undefined
  const classes = `agent-mark st-${state} ${moving ? 'moving' : 'static'} ${operator ? 'you' : ''} ${className}`
  if (operator) {
    return (
      <svg className={classes} width={size} height={size} viewBox="0 0 24 24" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
        {state === 'waiting' && <circle className="mk-halo" cx={12} cy={12} r={10.5} />}
        <circle className="mk-ring" cx={12} cy={12} r={7} />
        <circle className="mk-dot" cx={12} cy={12} r={2.4} />
      </svg>
    )
  }
  const cell = stitchCell(seed, events)
  return (
    <svg className={classes} width={size} height={size} viewBox="0 0 24 24" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {state === 'waiting' && <rect className="mk-halo" x={0.75} y={0.75} width={22.5} height={22.5} rx={6} />}
      {/* Cloth seen up close: at each of the nine crossings, either the gold weft floats on top (a
          short horizontal bar) or the grey warp does (a short vertical bar). Orientation and colour
          together make two agents' swatches tell apart at a glance. */}
      {over.map((weftOnTop, index) => {
        const x = AT[index % 3]
        const y = AT[Math.floor(index / 3)]
        const row = Math.floor(index / 3)
        return weftOnTop
          ? <line key={index} className={`mk-row r${row}`} x1={x - FLOAT} y1={y} x2={x + FLOAT} y2={y} pathLength={1} />
          : <line key={index} className="mk-float-warp" x1={x} y1={y - FLOAT} x2={x} y2={y + FLOAT} />
      })}
      {state === 'failed' && (
        <g className="mk-break">
          <rect className="mk-gap" x={8.6} y={8.6} width={6.8} height={6.8} />
          <line x1={9.4} y1={11} x2={11.2} y2={12.8} />
          <line x1={12.8} y1={11.2} x2={14.6} y2={13} />
        </g>
      )}
      {(state === 'working' || state === 'writing') && <line className="mk-shuttle" x1={3} y1={AT[1]} x2={8} y2={AT[1]} />}
      {state === 'done' && <circle className="mk-knot" cx={20.2} cy={20.2} r={2.3} />}
      {/* Keyed by the event count, so each new recorded event replays the stitch once. */}
      {moving && events > 0 && <circle key={events} className="mk-stitch" cx={AT[cell % 3]} cy={AT[Math.floor(cell / 3)]} r={2.6} />}
    </svg>
  )
}
