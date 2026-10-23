import { useEffect, useState } from 'react'
import { parse } from 'yaml'

import { fetchTeamFile } from '../lib/team-file/client'

/** What one run of the team at `path` may spend, from its file: `null` when it sets no limit,
    `undefined` until read, and for no team. */
export function useRunLimit(path: string | null): number | null | undefined {
  const [limit, setLimit] = useState<{ path: string; perRun: number | null } | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    fetchTeamFile(path).then((file) => {
      const perRun = (parse(file.yaml) as { spend?: { perRun?: unknown } } | null)?.spend?.perRun
      if (live) setLimit({ path, perRun: typeof perRun === 'number' && perRun > 0 ? perRun : null })
    }, () => {})
    return () => { live = false }
  }, [path])
  return limit?.path === path ? limit.perRun : undefined
}
