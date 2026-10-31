import { useId, useState } from 'react'

export interface DayValue {
  /** `2026-10-19`. */
  day: string
  value: number
  /** How much of `value` was LoomWatch's own help, drawn striped at the bar's foot. */
  part?: number
  /** What the bar's readout says about that day. */
  said: string
}

const WIDTH = 300
const HEIGHT = 64
const GAP = 2
const RADIUS = 2
/** The space between a bar's two parts, so they are told apart by more than their tone. */
const SPLIT = 1

/** "Oct 18". */
function dayName(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** A bar from `top` down to `bottom`, rounded at its top only when `rounded`. */
function barPath(x: number, w: number, top: number, bottom: number, rounded: boolean): string {
  const r = rounded ? Math.min(RADIUS, w / 2, bottom - top) : 0
  return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${bottom} Z`
}

/**
 * One source's days as thin bars on a shared baseline in the accent ink, so its title names it.
 * LoomWatch's own share of a day stands at its bar's foot, striped in the ink's quiet tone and set
 * apart by a gap, so tone is never the only cue; the card's line above names both in words, and the
 * readout says each day's share. Pointing at or focusing a bar says that day's figures in the
 * readout above, and the readout says the busiest day when nothing is pointed at. Units never mix:
 * each source has its own chart.
 */
export function DailyBars({ days, title, summary }: { days: readonly DayValue[]; title: string; summary: string }) {
  const [pointed, setPointed] = useState<number | null>(null)
  const id = useId()
  // An id `url(#…)` can name in every browser.
  const stripes = `usage-stripes-${id.replace(/[^\w-]/g, '')}`
  const peak = Math.max(0, ...days.map((day) => day.value))
  const width = days.length > 0 ? WIDTH / days.length : WIDTH
  const shown = pointed === null ? null : days[pointed]
  const parted = days.some((day) => (day.part ?? 0) > 0)
  return (
    <figure className="usage-bars" aria-labelledby={`${id}-title`}>
      <figcaption className="usage-bars-head">
        <span className="t-meta usage-bars-title" id={`${id}-title`}>{title}</span>
        <span className="t-meta usage-bars-readout" aria-live="polite">{shown ? `${dayName(shown.day)}: ${shown.said}` : summary}</span>
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${title}. ${summary}${parted ? '. LoomWatch’s help is striped at the foot of each day' : ''}`} onMouseLeave={() => setPointed(null)}>
        {/* Horizontal, so stretching the chart sideways never slants them. */}
        <defs>
          <pattern id={stripes} patternUnits="userSpaceOnUse" width={WIDTH} height={3}>
            <rect className="usage-bar-stripe" width={WIDTH} height={1.5} />
          </pattern>
        </defs>
        <line className="usage-bars-base" x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
        {days.map((day, index) => {
          const tall = peak > 0 ? Math.max(day.value > 0 ? 2 : 0, (day.value / peak) * (HEIGHT - 4)) : 0
          const x = index * width + GAP / 2
          const w = Math.max(1, width - GAP)
          // LoomWatch's own share, at the bar's foot: at least a sliver when there is any.
          const part = day.part && day.value > 0 ? Math.min(tall, Math.max(1, (day.part / day.value) * tall)) : 0
          // The agents' share above it, after the gap; a day that was all help is the striped part alone.
          const whole = part > 0 ? tall - part - SPLIT : tall
          return (
            <g key={day.day} className={pointed === index ? 'pointed' : undefined}>
              {whole > 0 && <path className="usage-bar" d={barPath(x, w, HEIGHT - tall, HEIGHT - (part > 0 ? part + SPLIT : 0), true)} />}
              {part > 0 && <path className="usage-bar-part" d={barPath(x, w, HEIGHT - part, HEIGHT, whole <= 0)} fill={`url(#${stripes})`} />}
              {/* A target the whole column tall, bigger than the bar, for the pointer and the keyboard. */}
              <rect className="usage-bar-hit" x={index * width} y={0} width={width} height={HEIGHT} tabIndex={0} aria-label={`${dayName(day.day)}: ${day.said}`} onMouseEnter={() => setPointed(index)} onFocus={() => setPointed(index)} onBlur={() => setPointed(null)} />
            </g>
          )
        })}
      </svg>
      <div className="usage-bars-axis t-micro" aria-hidden="true">
        <span>{days[0] ? dayName(days[0].day) : ''}</span>
        <span>{days.at(-1) ? dayName(days.at(-1)!.day) : ''}</span>
      </div>
    </figure>
  )
}
