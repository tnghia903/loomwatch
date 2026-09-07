// Deterministic fallback layout (docs/CANVAS_SPEC.md §7.3): "the same file always opens the
// same shape on any machine" when no persisted position exists. Node-position persistence
// itself is an open backend decision (§7.3, §15.1) — this is only the seed.

const COLUMNS = 3
const CELL_WIDTH = 320
const CELL_HEIGHT = 160

export function seededLayout(agentIds: readonly string[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {}
  ;[...agentIds]
    .sort((a, b) => a.localeCompare(b))
    .forEach((id, index) => {
      const column = index % COLUMNS
      const row = Math.floor(index / COLUMNS)
      positions[id] = { x: column * CELL_WIDTH, y: row * CELL_HEIGHT }
    })
  return positions
}
