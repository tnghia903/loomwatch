import { useId, useState } from 'react'

export interface DayValue {
  /** `2026-10-19`. */
  day: string
  value: number
  /** What the bar's readout says about that day. */
  said: string
}

const WIDTH = 300
const HEIGHT = 64
const GAP = 2
const RADIUS = 2

/** "Oct 18". */
function dayName(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * One source's days as thin bars on a shared baseline, one series in the accent ink, so its title
 * names it and no legend is needed. Pointing at or focusing a bar says that day's figures in the
 * readout above, and the readout says the busiest day when nothing is pointed at. Units never mix:
 * each source has its own chart.
 */
export function DailyBars({ days, title, summary }: { days: readonly DayValue[]; title: string; summary: string }) {
  const [pointed, setPointed] = useState<number | null>(null)
  const id = useId()
  const peak = Math.max(0, ...days.map((day) => day.value))
  const width = days.length > 0 ? WIDTH / days.length : WIDTH
  const shown = pointed === null ? null : days[pointed]
  return (
    <figure className="usage-bars" aria-labelledby={`${id}-title`}>
      <figcaption className="usage-bars-head">
        <span className="t-meta usage-bars-title" id={`${id}-title`}>{title}</span>
        <span className="t-meta usage-bars-readout" aria-live="polite">{shown ? `${dayName(shown.day)}: ${shown.said}` : summary}</span>
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${title}. ${summary}`} onMouseLeave={() => setPointed(null)}>
        <line className="usage-bars-base" x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
        {days.map((day, index) => {
          const tall = peak > 0 ? Math.max(day.value > 0 ? 2 : 0, (day.value / peak) * (HEIGHT - 4)) : 0
          const x = index * width + GAP / 2
          const w = Math.max(1, width - GAP)
          const y = HEIGHT - tall
          const r = Math.min(RADIUS, w / 2, tall)
          // A bar rounded at its top only, standing on the baseline.
          const path = tall > 0
            ? `M${x},${HEIGHT} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${HEIGHT} Z`
            : ''
          return (
            <g key={day.day}>
              {path && <path className={`usage-bar${pointed === index ? ' pointed' : ''}`} d={path} />}
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
