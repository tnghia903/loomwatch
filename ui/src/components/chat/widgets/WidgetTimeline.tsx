import { Fragment, useState, type CSSProperties } from 'react'

import { layOut } from '../../../lib/widgets/timeline'
import type { WidgetSpec } from '../../../lib/widgets/types'

type Timeline = Extract<WidgetSpec, { kind: 'timeline' }>

/**
 * A timeline (ADR 0114, amended 8 November): each event's date, a dot on one line down, and what
 * happened or is due beside it. The room between two events grows with the time between them, and
 * a gap worth noticing says how long it is, so the spacing is read as well as seen. When one of
 * them is still to come, today stands among them as a gold ring, or an event on today's date wears
 * it. Dates are written as your computer writes them. Nothing is kept: it is for reading.
 */
export function WidgetTimeline({ spec }: { spec: Timeline }) {
  // Today as the answer is first drawn: a timeline doesn't move under you while you read it.
  const [today] = useState(() => new Date())
  const { rows, gaps } = layOut(spec, today)
  return (
    <section className="wg wg-timeline" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <ol className="wg-when">
        {rows.map((row, at) => (
          <Fragment key={at}>
            {at > 0 && (
              <li className="wg-when-gap" aria-hidden={gaps[at - 1].words ? undefined : true} style={{ '--space': `${gaps[at - 1].space}px` } as CSSProperties}>
                <span />
                <span className="wg-when-rail" />
                <span className="wg-when-gap-words">{gaps[at - 1].words}</span>
              </li>
            )}
            {row.kind === 'event'
              ? (
                  <li className={`wg-when-row${row.today ? ' today' : ''}`}>
                    <span className="wg-when-date">{row.written}</span>
                    <span className="wg-when-rail"><i className="wg-when-dot" /></span>
                    <span className="wg-when-what">
                      <b>{row.event.label}</b>
                      {row.event.note && <span>{row.event.note}</span>}
                    </span>
                  </li>
                )
              : (
                  <li className="wg-when-row today">
                    <span className="wg-when-date">{row.written}</span>
                    <span className="wg-when-rail"><i className="wg-when-dot" /></span>
                    <span className="wg-when-what" />
                  </li>
                )}
          </Fragment>
        ))}
      </ol>
    </section>
  )
}
