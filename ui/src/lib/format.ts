// docs/CANVAS_SPEC.md §5.1: "Model middle-truncates (kimi-for-…/k3-256k) because both ends
// carry meaning."
export function middleTruncate(value: string, max = 24): string {
  if (value.length <= max) {
    return value
  }
  const keep = max - 1
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

// §5.1: "Budget shows $ + limitUsd formatted to 2 dp."
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`
}
