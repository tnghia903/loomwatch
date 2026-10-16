/** Each value's text, made once: the value kept from one poll is compared again on the next. */
const texts = new WeakMap<object, string>()

function text(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  let known = texts.get(value)
  if (known === undefined) {
    known = JSON.stringify(value)
    texts.set(value, known)
  }
  return known
}

/**
 * `previous` when `next` reads the same, so a poll that brought nothing new leaves state alone and
 * React draws nothing again. For JSON from the daemon: plain data, so comparing its text is exact.
 * Values are never changed in place, so each one's text is worked out once.
 */
export function keepIfSame<T>(previous: T, next: T): T {
  return previous === next || text(previous) === text(next) ? previous : next
}
