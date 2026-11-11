import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { asked, clock, held, lasting, layOut, offered, overlap, STEP, summed, week, written, type Day, type Piece } from '../../../lib/widgets/calendar'
import type { WidgetSpec } from '../../../lib/widgets/types'

type Calendar = Extract<WidgetSpec, { kind: 'calendar' }>
type Free = Extract<Piece, { kind: 'free' }>

/** Pixels an hour of bookings takes; a booking longer than `LONGEST` hours keeps that height and
 *  says how long it is. */
const HOUR = 38
const LONGEST = 2.2
/** Free time of two hours or more folds to a band this tall; shorter free time keeps its size. */
const FOLD = 46
const FOLDS_FROM = 120
/** Pixels an hour takes in free time opened to hold some of it. */
const OPEN_HOUR = 30
const GAP = 6

/**
 * A calendar (ADR 0114, amended 11 November), as a calendar app has it and made to use: a week of
 * dates along the top, each ringed by how much of it is free and what that comes to under it, and
 * the day picked below as a column of its hours. Its bookings stand at their times, side by side
 * where they overlap; free time of two hours or more folds to a band that says how long it is, so
 * the day fits the card. Tap free time and it opens into its hours with an hour to hold in it,
 * which you move and stretch (drag, or the arrow keys); then hold it on your calendar or ask the
 * agent to book something in it, which goes as your message, as choices do. Days are written as
 * your computer writes them.
 */
export function WidgetCalendar({ spec, onChoose, by }: { spec: Calendar; onChoose?: (text: string) => Promise<boolean> | void; by?: string }) {
  const days = layOut(spec)
  const strip = week(spec, days)
  const [picked, setPicked] = useState(days[0]?.day ?? '')
  const day = days.find((one) => one.day === picked) ?? days[0]
  const [open, setOpen] = useState<{ free: Free; from: number; to: number } | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  if (!day) return null
  const pick = (next: string) => {
    setPicked(next)
    setOpen(null)
  }
  const send = (what: 'hold' | 'book') => {
    if (!open || !onChoose) return
    const text = asked(what, day.day, open.from, open.to)
    setSent(text)
    void Promise.resolve(onChoose(text)).then((ok) => {
      if (ok === false) setSent(null)
    })
  }
  return (
    <section className="wg wg-calendar" aria-label={spec.title}>
      <div className="wg-cal-top">
        <p className="wg-title">{spec.title}</p>
        {spec.zone && <span className="wg-cal-zone">{spec.zone}</span>}
      </div>
      <div className="wg-cal-week" role="tablist" aria-label="Days">
        {strip.map((one) => (
          <button
            key={one.day}
            type="button"
            role="tab"
            className={`wg-cal-date${one.shown ? '' : ' quiet'}${one.day === day.day ? ' on' : ''}`}
            aria-selected={one.day === day.day}
            aria-label={one.shown ? `${written(one.day)}: ${one.shown.allDay.length ? 'booked all day' : `${lasting(one.shown.freeLength)} free`}` : written(one.day)}
            disabled={!one.shown}
            onClick={() => pick(one.day)}
          >
            <small>{one.weekday}</small>
            <Ring free={one.free} known={one.shown !== null} date={one.date} on={one.day === day.day} />
            <em className={one.shown && one.free > 0 ? 'open' : ''}>{one.shown ? summed(one.shown) : ''}</em>
          </button>
        ))}
      </div>
      <div className="wg-cal-dayline">
        <b>{written(day.day)}</b>
        {day.allDay.length === 0 && <span>{lasting(day.freeLength)} free</span>}
      </div>
      {day.allDay.map((booking, at) => (
        <p key={at} className="wg-cal-allday"><b>{booking.label}</b><span>{booking.place ? ` · ${booking.place}` : ''} · all day</span></p>
      ))}
      {day.allDay.length === 0 && (
        <DayGrid
          day={day}
          open={open}
          onOpen={(free) => { setSent(null); setOpen(open?.free.from === free.from ? null : { free, ...offered(free) }) }}
          onHold={(from, to) => open && setOpen({ ...open, ...held(open.free, from, to) })}
        />
      )}
      {open && (
        <div className="wg-cal-acts">
          {sent
            ? <p className="wg-cal-sent">Sent: {sent}</p>
            : (
                <>
                  <button type="button" className="go" disabled={!onChoose} title={onChoose ? undefined : 'Works on the newest answer, once nothing is at work'} onClick={() => send('hold')}>Hold it</button>
                  <button type="button" disabled={!onChoose} title={onChoose ? undefined : 'Works on the newest answer, once nothing is at work'} onClick={() => send('book')}>{by ? `Ask ${by} to book` : 'Ask to book'}</button>
                  <button type="button" className="quiet" onClick={() => setOpen(null)}>Close</button>
                </>
              )}
        </div>
      )}
    </section>
  )
}

/** The ring round a date: its free share in the ready green, the rest booked; none for a day the
 *  calendar doesn't show. */
function Ring({ free, known, date, on }: { free: number; known: boolean; date: number; on: boolean }) {
  const r = 16
  const around = 2 * Math.PI * r
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
      {known && <circle cx="20" cy="20" r={r} className="booked" />}
      {known && free > 0 && <circle cx="20" cy="20" r={r} className="free" strokeDasharray={`${free * around} ${around}`} transform="rotate(-90 20 20)" />}
      {on && <circle cx="20" cy="20" r="12.5" className="on" />}
      <text x="20" y="25" textAnchor="middle">{date}</text>
    </svg>
  )
}

/** The day as a column of its pieces under a time gutter: each piece's height, and where it starts. */
function DayGrid({ day, open, onOpen, onHold }: {
  day: Day
  open: { free: Free; from: number; to: number } | null
  onOpen: (free: Free) => void
  onHold: (from: number, to: number) => void
}) {
  const marks: { at: number; y: number }[] = []
  const drawn: ReactNode[] = []
  let y = 0
  for (const piece of day.pieces) {
    marks.push({ at: piece.from, y })
    if (piece.kind === 'free' && open?.free.from === piece.from) {
      const height = (piece.length / 60) * OPEN_HOUR + 16
      for (let hour = Math.ceil(piece.from / 60) * 60; hour < piece.to; hour += 60) {
        if (hour > piece.from) marks.push({ at: hour, y: y + 8 + ((hour - piece.from) / 60) * OPEN_HOUR })
      }
      drawn.push(<Opened key={`o${piece.from}`} free={piece} top={y} height={height} from={open.from} to={open.to} onHold={onHold} />)
      y += height + GAP
    } else if (piece.kind === 'free') {
      const folded = piece.length >= FOLDS_FROM
      const height = folded ? FOLD : Math.max(28, (piece.length / 60) * HOUR)
      drawn.push(
        <button key={`f${piece.from}`} type="button" className={`wg-cal-fold${folded ? '' : ' small'}`} style={{ top: y, height }} onClick={() => onOpen(piece)} aria-label={`Free ${clock(piece.from)} to ${clock(piece.to)}, ${lasting(piece.length)}: choose a time to hold`}>
          <b>Free · {lasting(piece.length)}</b>
          <span>{clock(piece.from)}–{clock(piece.to)}</span>
          {folded && <i>tap to use</i>}
        </button>,
      )
      y += height + GAP
    } else {
      const height = Math.min(LONGEST * HOUR, Math.max(44, ((piece.to - piece.from) / 60) * HOUR))
      const scale = height / (piece.to - piece.from)
      for (const item of piece.items) {
        const top = y + (item.from - piece.from) * scale
        const style: CSSProperties = { top, height: Math.max(40, (item.to - item.from) * scale - 3), '--lane': item.lane, '--lanes': piece.lanes } as CSSProperties
        const over = overlap(piece, item)
        drawn.push(
          <div key={`b${item.from}-${item.lane}`} className={`wg-cal-event${piece.lanes > 1 ? ' laned' : ''}`} style={style}>
            <b>{item.booking.label}</b>
            <span>{clock(item.from)}–{clock(item.to)}{item.booking.place ? ` · ${item.booking.place}` : ''}{item.to - item.from > LONGEST * 60 ? ` · ${lasting(item.to - item.from)}` : ''}</span>
            {over > 0 && <span className="wg-cal-over">overlaps {lasting(over)}</span>}
          </div>,
        )
      }
      y += height + GAP
    }
  }
  const total = Math.max(0, y - GAP)
  marks.push({ at: day.to, y: total })
  return (
    <div className="wg-cal-grid" style={{ height: total }}>
      <ol className="wg-cal-gutter" aria-hidden>
        {marks.map((mark) => <li key={`${mark.at}-${mark.y}`} style={{ top: mark.y }}>{clock(mark.at)}</li>)}
      </ol>
      <div className="wg-cal-column">{drawn}</div>
    </div>
  )
}

/** Free time opened into its hours, with the time to hold in it: drag it to move it, its handle to
 *  stretch it, or move it with the arrow keys (with Shift, its end). Its words keep to one line, so a
 *  quarter hour's block still shows all of them. */
function Opened({ free, top, height, from, to, onHold }: { free: Free; top: number; height: number; from: number; to: number; onHold: (from: number, to: number) => void }) {
  const drag = useRef<{ y: number; from: number; to: number; stretch: boolean } | null>(null)
  const perPixel = 60 / OPEN_HOUR
  const down = (stretch: boolean) => (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, from, to, stretch }
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const at = drag.current
    if (!at) return
    const by = (event.clientY - at.y) * perPixel
    if (at.stretch) onHold(at.from, at.to + by)
    else onHold(at.from + by, at.to + by)
  }
  const key = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowUp' ? -STEP : event.key === 'ArrowDown' ? STEP : 0
    if (!step) return
    event.preventDefault()
    if (event.shiftKey) onHold(from, to + step)
    else onHold(from + step, to + step)
  }
  const lines: number[] = []
  for (let hour = Math.ceil(free.from / 60) * 60; hour < free.to; hour += 60) if (hour > free.from) lines.push(hour)
  return (
    <div className="wg-cal-open" style={{ top, height }}>
      {lines.map((hour) => <i key={hour} style={{ top: 8 + ((hour - free.from) / 60) * OPEN_HOUR }} />)}
      <div
        className="wg-cal-hold"
        role="slider"
        tabIndex={0}
        aria-label={`Time to hold, ${clock(from)} to ${clock(to)}. Up and down arrows move it; with Shift, they change its end.`}
        aria-valuemin={free.from}
        aria-valuemax={free.to}
        aria-valuenow={from}
        aria-valuetext={`${clock(from)} to ${clock(to)}`}
        style={{ top: 8 + ((from - free.from) / 60) * OPEN_HOUR, height: Math.max(30, ((to - from) / 60) * OPEN_HOUR) }}
        onPointerDown={down(false)}
        onPointerMove={move}
        onPointerUp={() => { drag.current = null }}
        onKeyDown={key}
      >
        <b>Hold {clock(from)}–{clock(to)}</b>
        <span>{lasting(to - from)}</span>
        <i className="wg-cal-grip" onPointerDown={down(true)} onPointerMove={move} onPointerUp={() => { drag.current = null }} />
      </div>
    </div>
  )
}
