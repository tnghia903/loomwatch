/** A graph widget's geometry (ADR 0114): its ticks and its bars. */

/** A bar from the baseline `from` to `to`, its far end rounded, its base square. */
export function barPath(left: number, width: number, from: number, to: number): string {
  const radius = Math.min(4, width / 2, Math.abs(to - from))
  const up = to < from
  const end = up ? to + radius : to - radius
  const turn = up ? -radius : radius
  return `M${left},${from} L${left},${end} Q${left},${end + turn} ${left + radius},${end + turn} L${left + width - radius},${end + turn} Q${left + width},${end + turn} ${left + width},${end} L${left + width},${from} Z`
}

/** Round ticks from at most `low` to at least `high`, three to six of them. */
export function niceTicks(low: number, high: number): number[] {
  if (low === high) return [low, low + 1]
  const rough = (high - low) / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((times) => times * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude
  const first = Math.floor(low / step) * step
  const ticks: number[] = []
  for (let tick = first; tick < high + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)))
  return ticks
}
