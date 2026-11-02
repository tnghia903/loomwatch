/**
 * How far a picture or a video in the reader is zoomed: a share of its own pixels, so 1 is its
 * real size. Fitted to the pane, it is drawn at whatever share fits; − and + step on from there,
 * and a pinch goes between the steps.
 */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const

const LEAST = ZOOM_STEPS[0]
const MOST = ZOOM_STEPS[ZOOM_STEPS.length - 1]
/** Within this of a step is at it: a pinch that ends at 49.6% steps in to 67%, not to 50%. */
export const ZOOM_NEAR = 0.01

/** The next step in from `now` (`way` 1) or out (-1), or `now` itself past the last one. */
export function zoomStep(now: number, way: 1 | -1): number {
  const next = way > 0 ? ZOOM_STEPS.find((step) => step > now + ZOOM_NEAR) : [...ZOOM_STEPS].reverse().find((step) => step < now - ZOOM_NEAR)
  return next ?? now
}

/** A scale kept between the first and last steps. */
export function zoomWithin(scale: number): number {
  return Math.min(MOST, Math.max(LEAST, scale))
}

/** Whether there is a step further in (`way` 1) or out (-1) from `now`. */
export function canZoom(now: number, way: 1 | -1): boolean {
  return zoomStep(now, way) !== now
}

/** The zoom as people read it: "50%". */
export function zoomWords(scale: number): string {
  return `${Math.round(scale * 100)}%`
}
