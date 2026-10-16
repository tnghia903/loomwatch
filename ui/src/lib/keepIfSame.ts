/**
 * `previous` when `next` reads the same, so a poll that brought nothing new leaves state alone and
 * React draws nothing again. For JSON from the daemon: plain data, so comparing its text is exact.
 */
export function keepIfSame<T>(previous: T, next: T): T {
  return previous === next || JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}
