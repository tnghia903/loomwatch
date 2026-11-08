import type { CSSProperties } from 'react'

import { drawScale, namesFit, pinAnchor, pinRows, ticksThatFit } from '../../../lib/widgets/scale'
import type { WidgetSpec } from '../../../lib/widgets/types'
import { useMeasuredWidth } from '../../../lib/widgets/useMeasuredWidth'

type Scale = Extract<WidgetSpec, { kind: 'scale' }>

/** Width when the page can't measure it (tests): an answer's widget at the chat's usual width. */
const FALLBACK_WIDTH = 570

/** A share of the bar as a CSS length, to a hundredth of a per cent. */
const share = (part: number) => `${Math.round(part * 10000) / 100}%`

/**
 * A scale (ADR 0114, amended 8 November): where each figure stands, in words first ("You · 38.5 °C
 * · Fever"), then the ranges as one bar, each as wide as the stretch it covers, each figure a gold
 * line through the bar where it falls, and the figures where ranges meet under it. The range a
 * figure falls in is tinted and its name set in ink; a range is told by its name, never by its
 * colour. Names that don't fit inside their ranges are numbered there, in the gold ring question
 * numbers wear so a number reads as a name and not a value, and listed under the bar.
 * Nothing is kept: it is for reading.
 */
export function WidgetScale({ spec }: { spec: Scale }) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH)
  const { ranges, pins, ticks } = drawScale(spec)
  const named = namesFit(ranges, width)
  const rows = pinRows(pins, width)
  const tiers = Math.max(0, ...rows) + 1
  return (
    <section className="wg wg-scale" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <ul className="wg-scale-read">
        {pins.map((pin, at) => (
          <li key={at}><b>{pin.label}</b><span>{pin.figure}</span>{pin.range && <span className="wg-scale-in">{pin.range}</span>}</li>
        ))}
      </ul>
      <div ref={box} className="wg-scale-draw" aria-hidden="true" style={{ '--tiers': tiers } as CSSProperties}>
        <div className="wg-scale-pins">
          {pins.map((pin, at) => (
            <span key={at} className="wg-scale-pin" data-testid="wg-scale-pin" style={{ left: share(pin.at), '--tier': rows[at] } as CSSProperties}>
              <span className={`wg-scale-pin-label ${pinAnchor(pin, width)}`}>{pin.label}</span>
            </span>
          ))}
        </div>
        <div className="wg-scale-bar">
          {ranges.map((range, at) => (
            <span key={at} className={`wg-scale-range${range.held ? ' held' : ''}`} data-testid="wg-scale-range" style={{ left: share(range.start), width: share(range.width) }}>
              {named ? range.label : range.width * width >= 22 ? <span className="wg-q-n">{at + 1}</span> : ''}
            </span>
          ))}
        </div>
        <div className="wg-scale-ticks">
          {ticksThatFit(ticks, width).map((tick, at, all) => (
            <span key={at} className={`wg-scale-tick${at === 0 ? ' first' : at === all.length - 1 ? ' last' : ''}`} style={{ left: share(tick.at) }}>{tick.figure}</span>
          ))}
        </div>
      </div>
      {!named && (
        <ol className="wg-scale-key" aria-hidden="true">
          {ranges.map((range, at) => (
            <li key={at} className={range.held ? 'held' : undefined}><span className="wg-q-n">{at + 1}</span>{range.label}<span className="wg-scale-key-span">{range.from}–{range.to}</span></li>
          ))}
        </ol>
      )}
      <p className="visually-hidden">{ranges.map((range) => `${range.label}: ${range.from} to ${range.to}`).join('; ')}</p>
    </section>
  )
}
