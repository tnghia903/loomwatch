import { useState, type CSSProperties } from 'react'

import type { WidgetSpec } from '../../../lib/widgets/types'
import { ChevronLeft, ChevronRight } from '../../ui/icon'

type Picture = Extract<WidgetSpec, { kind: 'picture' }>

/** The tallest a picture stands; a tall one is narrower instead. */
const MOST_HEIGHT = 440
/** What the daemon writes for a shape (ADR 0117); anything else isn't drawn. */
const PATH_DATA = /^[MLCZ0-9 .-]+$/

/**
 * A picture the agent drew (ADR 0117), in LoomWatch's own lines: every shape outlined in ink, a
 * filled one shaded, what belongs to no part fainter and finer. Its parts are numbered on it; tap one, or
 * step through them, and its shapes turn gold while its words show under the picture. Nothing is
 * kept: it is for reading.
 */
export function WidgetPicture({ spec }: { spec: Picture }) {
  const parts = spec.parts ?? []
  const [at, setAt] = useState(0)
  const count = parts.length
  const picked = count > 0 ? Math.min(at, count - 1) : -1
  const part = parts[picked]
  const step = (by: number) => setAt((picked + by + count) % count)
  const room = { '--wg-picture-width': `${(MOST_HEIGHT * spec.width) / spec.height}px`, aspectRatio: `${spec.width} / ${spec.height}` } as CSSProperties
  return (
    <section className="wg wg-picture" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <div className="wg-figure" style={room}>
        <svg viewBox={`0 0 ${spec.width} ${spec.height}`} aria-hidden="true" focusable="false">
          {spec.shapes.filter((shape) => PATH_DATA.test(shape.d)).map((shape, which) => (
            <path
              key={which}
              d={shape.d}
              className={[
                'wg-shape',
                shape.part === undefined ? 'loose' : '',
                shape.fill === 'dark' ? 'dark' : shape.fill ? 'light' : '',
                shape.dashed ? 'dashed' : '',
                shape.part !== undefined && shape.part === picked + 1 ? 'on' : '',
              ].filter(Boolean).join(' ')}
            />
          ))}
        </svg>
        {parts.map((one, which) => (
          <button
            key={which}
            type="button"
            className={`wg-part-n${which === picked ? ' on' : ''}`}
            style={{ left: `${(one.at[0] / spec.width) * 100}%`, top: `${(one.at[1] / spec.height) * 100}%`, '--k': which } as CSSProperties}
            aria-pressed={which === picked}
            aria-label={`Part ${which + 1}: ${one.label}`}
            title={one.label}
            onClick={() => setAt(which)}
          >
            <span aria-hidden="true">{which + 1}</span>
          </button>
        ))}
      </div>
      {part && (
        <div className="wg-step-text wg-picture-part" aria-live="polite">
          <div className="wg-picture-head">
            {count > 1 && <button type="button" className="iconbtn wg-picture-by" aria-label="Part before" onClick={() => step(-1)}><ChevronLeft size={16} aria-hidden="true" /></button>}
            <p className="wg-step-head">{picked + 1} of {count} · {part.label}</p>
            {count > 1 && <button type="button" className="iconbtn wg-picture-by" aria-label="Next part" onClick={() => step(1)}><ChevronRight size={16} aria-hidden="true" /></button>}
          </div>
          <p className="wg-step-body">{part.text}</p>
        </div>
      )}
    </section>
  )
}
