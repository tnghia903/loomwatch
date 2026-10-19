/**
 * Whether Home opens on the first run (ADR 0075), kept per browser like the getting-started guide
 * (lib/tour/store.ts).
 *
 * The first run is for someone who has never had anything made: no run in the history, and no
 * earlier answer here. Once they look around instead, or have their first answer, it is not
 * offered again. Losing the value (a private window, cleared site data) can only offer it again
 * to someone with no runs, which is the person it is for.
 */

const STORAGE_KEY = 'loomwatch:first-run'

export type FirstRunState = 'skipped' | 'done'

export function readFirstRun(): FirstRunState | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'skipped' || value === 'done' ? value : null
  } catch {
    return null
  }
}

export function markFirstRun(state: FirstRunState) {
  try { localStorage.setItem(STORAGE_KEY, state) } catch { /* the first run still ends on this page */ }
}

/**
 * Whether to open on the first run: nothing marked here, and nothing ever run. Someone who already
 * met the getting-started guide is not new. When the history can't be read, the answer is no:
 * a returning person sent back to the first run is worse than a newcomer seeing Home.
 */
export async function opensOnFirstRun(listRuns: () => Promise<readonly unknown[]>, guideSeen: boolean): Promise<boolean> {
  if (readFirstRun() || guideSeen) return false
  try {
    return (await listRuns()).length === 0
  } catch {
    return false
  }
}

/** Tests only. */
export function resetFirstRunForTests() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
