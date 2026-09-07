// docs/CANVAS_SPEC.md §7.2: snapGrid = [8, 8]. Also the drop-target snap in §4.5 step 2.
export const GRID_SIZE = 8

export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE
}
