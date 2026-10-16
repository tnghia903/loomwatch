import type { ImgHTMLAttributes } from 'react'

import { figureStill, wornBy, type FigureChoice } from '../../lib/library/figures'
import { WornOverlay } from './AccessoryArt'

/**
 * A figure's still with what it wears from the wardrobe drawn over it (docs/QUESTS.md). A figure
 * wearing nothing is the plain `<img>` every list drew before, so its size and place are as they
 * were; one wearing something is that image in a box of the same class, with the accessories laid
 * over it at the same scale.
 */
export function FigureStill({ figure, className = '', headOnly = false, ...image }: { figure: FigureChoice; className?: string; headOnly?: boolean } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'className'>) {
  const wear = wornBy(figure)
  if (wear.length === 0) return <img className={className || undefined} src={figureStill(figure)} {...image} />
  const { width, height, style } = image
  return (
    <span className={`figure-still${className ? ` ${className}` : ''}`} style={{ ...(width ? { width: Number(width) } : {}), ...(height ? { height: Number(height) } : {}), ...style }}>
      <img src={figureStill(figure)} {...image} style={undefined} />
      <WornOverlay kind={figure.kind} color={figure.color} wear={wear} headOnly={headOnly} />
    </span>
  )
}
