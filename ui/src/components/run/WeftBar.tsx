import { BookOpen, ChevronLeft, ChevronRight, FileSearch, MessagesSquare, Radio } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { clock, momentAt, narrate, weave, type WeftAgent, type WeftKnot } from '../../lib/story/weft'
import { markState } from '../../lib/story/mark'
import type { AgentStatus } from '../../lib/team-file/types'
import type { TaskState } from '../../lib/watch/events'
import { AgentMark } from '../ui/AgentMark'
import type { RunProjection } from '../../lib/watch/events'

interface WeftBarProps {
  projection: RunProjection
  order: readonly WeftAgent[]
  /** A pipeline hands work along in order; team mode only knows the handoffs it recorded. */
  relay: boolean
  onInspectEvidence: (id: string) => void
  /** The message a change of hands carried, when the run recorded one (lib/watch/messages.ts). */
  messageFor?: (knot: WeftKnot) => string | null
  onReadMessage?: (id: string) => void
}

const ROW = 30

/**
 * The run as woven cloth (lib/story/weft.ts): one lane per helper, a thread where it worked, a
 * stitch per recorded call and a knot per handoff. Dragging across it reads the run back; the
 * caption says the moment in a sentence and, for an expert, the event kind and sequence number.
 */
export function WeftBar({ projection, order, relay, onInspectEvidence, messageFor, onReadMessage }: WeftBarProps) {
  const [now, setNow] = useState(() => Date.now())
  const weft = useMemo(() => weave(projection, order, now, relay), [projection, order, now, relay])
  // A live run's threads grow with the clock, not only when an event arrives.
  useEffect(() => {
    if (!weft.live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [weft.live])
  // `null` follows the latest moment, so a live run keeps the playhead at its edge.
  const [at, setAt] = useState<number | null>(null)
  const [reading, setReading] = useState(false)
  const beats = useMemo(() => (reading ? narrate(weft) : []), [reading, weft])
  const position = Math.min(at ?? weft.duration, weft.duration)
  const moment = momentAt(weft, position)
  const said = moment.knot && messageFor ? messageFor(moment.knot) : null
  const tracks = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const pct = (value: number) => `${Math.max(0, Math.min(100, (value / weft.duration) * 100))}%`
  const marks = useMemo(() => [...new Set([0, ...weft.stitches.map((item) => item.at), ...weft.knots.map((item) => item.at), weft.duration])].sort((a, b) => a - b), [weft])
  const laneIndex = new Map(weft.lanes.map((lane, index) => [lane.id, index]))

  const seek = (clientX: number) => {
    const rect = tracks.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    setAt(ratio >= 0.995 ? null : ratio * weft.duration)
  }
  const step = (direction: 1 | -1) => {
    const next = direction > 0 ? marks.find((mark) => mark > position + 1) : [...marks].reverse().find((mark) => mark < position - 1)
    if (next === undefined) return
    setAt(next >= weft.duration ? null : next)
  }

  if (weft.lanes.length === 0) return null
  return (
    <section className="weft" aria-label="Run timeline">
      <div className="weft-head">
        <h2>Timeline</h2>
        <span>{weft.live ? 'Live. Drag back to replay what already happened.' : 'Drag across it to replay what happened, and when.'}</span>
        <span className="weft-head-acts">
          {at !== null && <button type="button" className="delivery-link" onClick={() => setAt(null)}><Radio size={13} aria-hidden="true" />{weft.live ? 'Back to live' : 'Jump to the end'}</button>}
          <button type="button" className="delivery-link" aria-pressed={reading} onClick={() => setReading((value) => !value)}><BookOpen size={13} aria-hidden="true" />{reading ? 'Hide the story' : 'Read it as a story'}</button>
        </span>
      </div>
      {reading && (
        // The same run, told in sentences; each one moves the playhead to its moment.
        <ol className="weft-story" aria-label="The run as a story">
          {beats.map((beat, index) => (
            <li key={index} className={beat.bad ? 'bad' : ''}>
              <button type="button" onClick={() => setAt(beat.at >= weft.duration ? null : beat.at)}><time>{clock(beat.at)}</time><span>{beat.text}</span></button>
            </li>
          ))}
        </ol>
      )}
      <div className="weft-cloth" style={{ ['--weft-rows' as string]: weft.lanes.length }}>
        <div className="weft-names" aria-hidden="true">
          {weft.lanes.map((lane) => <span key={lane.id} className={lane.operator ? 'you' : ''}><AgentMark id={lane.id} size={14} operator={lane.operator} state={lane.start === null ? 'turn' : markState({ status: lane.status as AgentStatus, taskState: lane.taskState as TaskState | undefined })} animate={weft.live} />{lane.operator ? 'You' : lane.name}</span>)}
        </div>
        <div
          ref={tracks}
          className="weft-tracks"
          onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); seek(event.clientX) }}
          onPointerMove={(event) => { if (dragging.current) seek(event.clientX) }}
          onPointerUp={() => { dragging.current = false }}
          onPointerCancel={() => { dragging.current = false }}
        >
          {weft.lanes.map((lane, index) => (
            <div key={lane.id} className="weft-lane" style={{ top: index * ROW }}>
              <i className="weft-warp" />
              {lane.start !== null && lane.end !== null && (
                <i className={`weft-thread ${lane.operator ? 'you' : ''} ${lane.live ? 'live' : ''} ${lane.status === 'failed' ? 'bad' : ''}`} title={lane.operator ? 'The team waited for your decision' : undefined} style={{ left: pct(lane.start), width: `max(4px, ${pct(lane.end - lane.start)})` }} />
              )}
            </div>
          ))}
          {weft.knots.map((knot, index) => {
            const from = laneIndex.get(knot.from) ?? 0
            const to = laneIndex.get(knot.to) ?? 0
            return <i key={`k${index}`} className="weft-knot" style={{ left: pct(knot.at), top: Math.min(from, to) * ROW + ROW / 2, height: Math.abs(to - from) * ROW }} />
          })}
          {/* A failed call the agent put right is darned to the call that mended it. */}
          {weft.stitches.filter((stitch) => stitch.mended).map((stitch) => {
            const mended = stitch.mended as NonNullable<typeof stitch.mended>
            return <i key={`d${stitch.evidenceId}`} className="weft-darn" style={{ left: pct(Math.min(stitch.at, mended.at)), width: `max(6px, ${pct(Math.abs(mended.at - stitch.at))})`, top: (laneIndex.get(stitch.laneId) ?? 0) * ROW + ROW / 2 }} />
          })}
          {weft.stitches.map((stitch) => (
            <i key={stitch.evidenceId} className={`weft-stitch ${stitch.bad ? 'bad' : stitch.mended ? 'mended' : ''}`} title={stitch.sentence} style={{ left: pct(stitch.at), top: (laneIndex.get(stitch.laneId) ?? 0) * ROW + ROW / 2 }} />
          ))}
          <i className="weft-unwoven" style={{ left: pct(position) }} />
          <i className="weft-playhead" style={{ left: pct(position) }} />
        </div>
      </div>
      <div className="weft-ctl">
        <button type="button" className="iconbtn" aria-label="Previous moment" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <input
          type="range"
          aria-label="Replay position"
          aria-valuetext={`${clock(position)}: ${moment.sentence}`}
          min={0}
          max={weft.duration}
          step={100}
          value={position}
          onChange={(event) => { const value = Number(event.target.value); setAt(value >= weft.duration ? null : value) }}
        />
        <button type="button" className="iconbtn" aria-label="Next moment" onClick={() => step(1)}><ChevronRight size={16} /></button>
      </div>
      <p className={`weft-cap ${moment.bad ? 'bad' : ''}`} aria-live="polite">
        <time>{clock(position)}</time>
        <span className="weft-sentence">{moment.sentence}</span>
        {moment.code && <code>{moment.code}</code>}
        {moment.evidenceId && <button type="button" className="delivery-link" onClick={() => onInspectEvidence(moment.evidenceId as string)}><FileSearch size={13} aria-hidden="true" />Open the record</button>}
        {said && onReadMessage && <button type="button" className="delivery-link" onClick={() => onReadMessage(said)}><MessagesSquare size={13} aria-hidden="true" />Read the message</button>}
      </p>
    </section>
  )
}
