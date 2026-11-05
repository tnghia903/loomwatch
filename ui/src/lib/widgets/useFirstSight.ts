import { useEffect, useState } from 'react'

/** Widgets drawn in this window, by what they show. */
const seen = new Set<string>()

/**
 * Whether a widget is drawn for the first time in this window: it rises in and its marks grow
 * once, not each time the chat draws it again (a page read, the kept widget taking the place of
 * the one drawn as the answer was written).
 */
export function useFirstSight(key: string): boolean {
  const [first] = useState(() => !seen.has(key))
  useEffect(() => { seen.add(key) }, [key])
  return first
}
