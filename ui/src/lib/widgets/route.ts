/** A flow's or steps' route (ADR 0114): whether its stops run across or down. */

/** A stop's label at its widest (a picked step is semibold), as widgets.css draws it. */
const LABEL_FONT = '600 13px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
/** About how wide a character of that label is, where nothing can measure it (tests). */
const CHAR = 7.5

let measurer: OffscreenCanvasRenderingContext2D | null | undefined

/** How wide `word` is in a stop's label, measured in the label's own font where the page can. */
function wordWidth(word: string): number {
  if (measurer === undefined) measurer = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
  if (!measurer) return [...word].length * CHAR
  measurer.font = LABEL_FONT
  return measurer.measureText(word).width
}

/**
 * Whether `stops` stops fit across `width` px: each has at least `least` px, and the longest word
 * of any label fits on a line of its own beside the stop's `padding`, so no word is broken in the
 * middle. Otherwise the route runs down.
 */
export function fitsAcross(width: number, labels: readonly string[], stops: number, least: number, padding: number): boolean {
  const longest = Math.max(0, ...labels.flatMap((label) => label.split(/\s+/u)).map(wordWidth))
  return width / Math.max(1, stops) >= Math.max(least, longest + padding)
}
