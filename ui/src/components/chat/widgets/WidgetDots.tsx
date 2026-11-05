import type { CSSProperties, ReactNode } from 'react'

import { dotsOf } from '../../../lib/widgets/dots'

/**
 * A figure that counts whole things, drawn as dots (ADR 0114, `counted`): one for each `each`
 * things, in tens, and part of one more for what is left over. `perRow` lays them out as a block
 * (a comparison's side); without it, one line (a chart's row). For the eye only: the figure is
 * written beside it.
 */
export function WidgetDots({ value, each, perRow, delay = 0 }: { value: number; each: number; perRow?: 10 | 20 | 30; delay?: number }) {
  const { whole, part } = dotsOf(value, each)
  const dots: ReactNode[] = []
  for (let at = 0; at < whole; at += 1) {
    const inRow = perRow ? at % perRow : at
    if (inRow > 0 && inRow % 10 === 0) dots.push(<b key={`ten-${at}`} />)
    dots.push(<i key={at} style={{ '--i': at } as CSSProperties} />)
  }
  if (part > 0) {
    const inRow = perRow ? whole % perRow : whole
    if (inRow > 0 && inRow % 10 === 0) dots.push(<b key="ten-part" />)
    dots.push(<i key="part" className="part" style={{ '--i': whole, '--part': part } as CSSProperties} />)
  }
  return (
    <span
      className={`wg-dots${perRow ? ` block by${perRow}` : ''}`}
      style={{ '--k': delay } as CSSProperties}
      aria-hidden="true"
      data-testid="wg-dots"
      data-dots={whole + (part > 0 ? part : 0)}
    >
      {dots}
    </span>
  )
}
