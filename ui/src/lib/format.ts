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

/** Names in a sentence: "Claude", "Claude and Codex", "Claude, Codex and OpenCode". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then a date — for lists people scan. */
export function relativeTime(at: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
