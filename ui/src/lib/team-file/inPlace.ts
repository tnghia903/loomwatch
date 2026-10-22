/**
 * What the team page needs to move between teams in place (`teamPage.ts`) and still behave as a
 * page load did.
 */

/**
 * Work on the page that leaving would lose. Held exactly while the browser would ask "Leave site?"
 * before the page goes, so a move goes as a page load instead and the browser asks, as it always has.
 */
const held = new Set<symbol>()

/** Holds the page until the returned function is called. */
export function holdPage(): () => void {
  const token = Symbol('unsaved work')
  held.add(token)
  return () => { held.delete(token) }
}

export function pageIsHeld(): boolean {
  return held.size > 0
}

let moved = false

/**
 * Whether the page has moved to another team in place. The app's own data (what waits on you, the
 * teams, your saved agents) then starts from what the page last knew, as it never unloaded, and is
 * read again at once.
 */
export function movedInPlace(): boolean {
  return moved
}

export function markMovedInPlace() {
  moved = true
}
