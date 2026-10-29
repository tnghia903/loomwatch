import { useEffect, useState } from 'react'

import { fetchUsage, type UsageReport } from '../usage/client'

/** How often Home and a room read what this month cost again. */
const EVERY_MS = 60_000

/**
 * What the model calls of this month used, by where they were paid (ADR 0073), read again every
 * minute; `null` until read, and while it can't be (an older daemon), when the tiles count from the
 * runs instead.
 */
export function useMonthUsage(): UsageReport | null {
  const [report, setReport] = useState<UsageReport | null>(null)
  useEffect(() => {
    let live = true
    const read = () => {
      // Every day of this month so far: the report counts whole days back from today.
      // Only a report of the shape it should have: anything else counts as none, and the tiles
      // count from the runs.
      fetchUsage(new Date().getDate()).then((next) => { if (live && Array.isArray(next?.sources) && Array.isArray(next?.agents)) setReport(next) }, () => {})
    }
    read()
    const timer = window.setInterval(read, EVERY_MS)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  return report
}
