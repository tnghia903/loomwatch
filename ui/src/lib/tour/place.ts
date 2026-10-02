import type { TourSide } from './steps'

export interface Box { top: number; left: number; width: number; height: number }

export interface Placement { top: number; left: number; side: TourSide | 'center' }

const GAP = 14
const MARGIN = 12

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)))
}

/**
 * Where the guide's card goes: beside its target on the first side in `sides` with room for it,
 * else over the first side, clamped into the viewport. With `keepClear`, a card that would cover
 * its target is not placed at all (null), because the target is what the operator must use.
 */
export function placeCard(
  target: Box | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  sides: readonly TourSide[] = ['bottom', 'top', 'right', 'left'],
  keepClear = false,
): Placement | null {
  const { width: w, height: h } = card
  const maxLeft = viewport.width - MARGIN - w
  const maxTop = viewport.height - MARGIN - h
  if (!target) return { side: 'center', left: clamp((viewport.width - w) / 2, MARGIN, maxLeft), top: clamp((viewport.height - h) / 2, MARGIN, maxTop) }

  const right = target.left + target.width
  const bottom = target.top + target.height
  const centredLeft = clamp(target.left + target.width / 2 - w / 2, MARGIN, maxLeft)
  const centredTop = clamp(target.top + target.height / 2 - h / 2, MARGIN, maxTop)
  const candidates: Record<TourSide, { placement: Placement; fits: boolean }> = {
    bottom: { placement: { side: 'bottom', top: bottom + GAP, left: centredLeft }, fits: bottom + GAP + h <= viewport.height - MARGIN },
    top: { placement: { side: 'top', top: target.top - GAP - h, left: centredLeft }, fits: target.top - GAP - h >= MARGIN },
    right: { placement: { side: 'right', top: centredTop, left: right + GAP }, fits: right + GAP + w <= viewport.width - MARGIN },
    left: { placement: { side: 'left', top: centredTop, left: target.left - GAP - w }, fits: target.left - GAP - w >= MARGIN },
  }
  for (const side of sides) if (candidates[side].fits) return candidates[side].placement
  if (keepClear) return null
  const fallback = candidates[sides[0] ?? 'bottom'].placement
  return { ...fallback, top: clamp(fallback.top, MARGIN, maxTop), left: clamp(fallback.left, MARGIN, maxLeft) }
}
