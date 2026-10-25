import type { BoxAt } from '../chat/client'

/**
 * Parts of a file that aren't words (ADR 0091): a box on a picture, kept as where it is
 * (`chat::PartAt::Box`), named in plain words for the chat's quote, and sent as the picture inside it so
 * the agent sees what was marked.
 */

/** The whole of a picture's width or height, in the ten-thousandths a place is kept in. */
export const WHOLE = 10_000

/** The longest side of a part's picture sent to the agent; the daemon shrinks larger ones anyway. */
const PICTURE_MOST = 2_048

/** A place on a picture as fractions of it, 0 to 1 from its top left. */
export interface Point { x: number; y: number }

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
const unit = (value: number) => Math.round(clamp(value) * WHOLE)

/** The box between two corners dragged on a picture; never thinner than one ten-thousandth. */
export function boxBetween(from: Point, to: Point, page?: number): BoxAt {
  const left = unit(Math.min(from.x, to.x))
  const top = unit(Math.min(from.y, to.y))
  const w = Math.max(1, Math.min(WHOLE - left, unit(Math.max(from.x, to.x)) - left))
  const h = Math.max(1, Math.min(WHOLE - top, unit(Math.max(from.y, to.y)) - top))
  return { kind: 'box', x: left, y: top, w, h, ...(page ? { page } : {}) }
}

/** The whole picture, or the whole of page `page`, as a box. */
export function wholeBox(page?: number): BoxAt {
  return { kind: 'box', x: 0, y: 0, w: WHOLE, h: WHOLE, ...(page ? { page } : {}) }
}

/**
 * What a box is called in the chat's quote: where it is, in the words a person points with ("The top
 * right of the picture"). The agent is told its exact place as well, by the daemon.
 */
export function boxLabel(at: BoxAt, of = 'the picture'): string {
  if (at.w >= WHOLE * 0.9 && at.h >= WHOLE * 0.9) return of === 'the picture' ? 'The whole picture' : `The whole of ${of}`
  if (at.w * at.h >= (WHOLE * WHOLE) / 2) return `Most of ${of}`
  const across = at.x + at.w / 2
  const down = at.y + at.h / 2
  const row = down < WHOLE / 3 ? 'top' : down > (WHOLE * 2) / 3 ? 'bottom' : 'middle'
  const column = across < WHOLE / 3 ? 'left' : across > (WHOLE * 2) / 3 ? 'right' : 'centre'
  const where = row === 'middle' && column === 'centre' ? 'middle' : row === 'middle' ? `${column} side` : column === 'centre' ? row : `${row} ${column}`
  return `The ${where} of ${of}`
}

/** Where a box is on screen over a picture drawn at `shown`. */
export function boxOnScreen(at: BoxAt, shown: { top: number; left: number; width: number; height: number }) {
  const left = shown.left + (shown.width * at.x) / WHOLE
  const top = shown.top + (shown.height * at.y) / WHOLE
  return { top, left, right: left + (shown.width * at.w) / WHOLE, bottom: top + (shown.height * at.h) / WHOLE }
}

/** A box as CSS places it over its picture, in percent. */
export function boxStyle(at: BoxAt): { left: string; top: string; width: string; height: string } {
  const percent = (value: number) => `${(value / WHOLE) * 100}%`
  return { left: percent(at.x), top: percent(at.y), width: percent(at.w), height: percent(at.h) }
}

/**
 * The part of a picture inside a box, as a PNG file to send with the question, no longer than
 * `PICTURE_MOST` on its long side; `null` where the picture can't be drawn (not loaded yet).
 */
export async function pictureInside(image: HTMLImageElement, at: BoxAt, name: string): Promise<File | null> {
  // A picture with no size of its own (an SVG without one) is taken as drawn, at twice the size.
  const width = image.naturalWidth || image.width * 2
  const height = image.naturalHeight || image.height * 2
  if (!width || !height) return null
  const sx = (width * at.x) / WHOLE
  const sy = (height * at.y) / WHOLE
  const sw = Math.max(1, (width * at.w) / WHOLE)
  const sh = Math.max(1, (height * at.h) / WHOLE)
  const scale = Math.min(1, PICTURE_MOST / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  try {
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  } catch {
    return null
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, 'image/png')
    } catch {
      resolve(null)
    }
  })
  return blob ? new File([blob], name, { type: 'image/png' }) : null
}

/** The name a part's picture is sent under: `chart part.png` for a part of `chart.svg`. */
export function partPictureName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '') || 'picture'
  return `${stem} part.png`
}
