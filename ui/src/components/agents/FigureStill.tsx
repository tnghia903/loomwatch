import { useState, type CSSProperties, type ImgHTMLAttributes } from 'react'

import { figureStill, garmentMask, signStill, signTint, wornBy, type FigureState, type FigureView } from '../../lib/library/figures'
import { isGarment } from '../../lib/quests/catalog'
import { WornOverlay } from './AccessoryArt'

/**
 * A figure's still with its job sign on its head and what it wears from the wardrobe drawn over it
 * (docs/QUESTS.md). A figure with neither is the plain `<img>` every list drew before; otherwise it is
 * that image in a box of the same class, with the layers laid over it at the same scale. The sign is
 * drawn in grey and tinted to the figure's colour, so one picture serves every colour.
 *
 * `state` picks the pose and face (step 5): the still, the sign and every layer are drawn for it, as
 * the head turns and the paws move with it. When it changes after the figure was first drawn, the new
 * pose settles in once (`data-moved`, motion.css), never on the first draw, so a page of figures
 * doesn't all move when it opens.
 *
 * A garment is fabric settled on the figure: the bare still is drawn through its mask
 * (`garmentMask`), so the fur the clothes cover doesn't stand out round them.
 */
export function FigureStill({ figure, className = '', headOnly = false, state = 'ready', ...image }: { figure: FigureView; className?: string; headOnly?: boolean; state?: FigureState } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'className'>) {
  const [was, setWas] = useState(state)
  const [moved, setMoved] = useState(false)
  if (was !== state) {
    setWas(state)
    setMoved(true)
  }
  const pose = { 'data-pose': state, ...(moved ? { 'data-moved': '' } : {}) }
  const wear = wornBy(figure)
  const sign = figure.sign
  // Keyed by the state: a change draws it anew, so its settle plays.
  if (wear.length === 0 && !sign) return <img key={state} className={className || undefined} src={figureStill(figure, state)} {...pose} {...image} />
  const { width, height, style } = image
  // In clothes, the bare figure shows only where it would in them. A head-only face (the chat's)
  // draws no clothes, so it draws the figure whole.
  const garment = headOnly ? undefined : wear.find(isGarment)
  const mask = garment ? `url("${garmentMask(figure.kind, garment, state)}")` : undefined
  const through: CSSProperties | undefined = mask ? { maskImage: mask, WebkitMaskImage: mask, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } : undefined
  return (
    <span key={state} className={`figure-still${className ? ` ${className}` : ''}`} {...pose} style={{ ...(width ? { width: Number(width) } : {}), ...(height ? { height: Number(height) } : {}), ...style }}>
      <img src={figureStill(figure, state)} {...image} style={through} />
      {sign && <span className="figure-sign" aria-hidden="true" style={{ '--sign': `url("${signStill(figure.kind, sign, state)}")`, '--tint': signTint(figure.color) } as CSSProperties} />}
      {wear.length > 0 && <WornOverlay kind={figure.kind} color={figure.color} wear={wear} headOnly={headOnly} state={state} />}
    </span>
  )
}
