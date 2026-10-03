/** The add panel's width as CSS draws it before anyone resizes it (`--lw-palette-w`). */
export const PALETTE_WIDTH = { min: 200, default: 210, max: 520, step: 16 }

export function clampPaletteWidth(width: number): number {
  return Math.round(Math.min(PALETTE_WIDTH.max, Math.max(PALETTE_WIDTH.min, width)))
}
