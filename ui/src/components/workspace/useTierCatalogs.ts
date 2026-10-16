import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchHarnessModels, isHarnessRunnable, type DetectedHarness } from '../../lib/harnesses'
import { harnessIdForAgent } from '../../lib/models'
import type { ModelCatalog } from '../../lib/models/tiers'
import { jobFor } from '../../lib/team-file/checkup'
import type { AgentConfig } from '../../lib/team-file/types'

/** Lists read this page load, by app. Reading one starts the app, so each is read once; a failed read is not kept. */
const reads = new Map<string, Promise<ModelCatalog>>()

function readCatalog(harnessId: string): Promise<ModelCatalog> {
  let pending = reads.get(harnessId)
  if (!pending) {
    pending = fetchHarnessModels(harnessId)
    reads.set(harnessId, pending)
    pending.catch(() => { reads.delete(harnessId) })
  }
  return pending
}

/**
 * The model list of each app a gatherer in the team runs on, for the checkup's tier rule (ADR 0057).
 * Only those apps are asked, and only ones that can start: reading a list starts the app.
 */
export function useTierCatalogs(agents: readonly AgentConfig[], harnesses: readonly DetectedHarness[]) {
  const needed = useMemo(() => {
    const ids = agents
      .filter((agent) => agent.kind !== 'operator' && jobFor(agent)?.tier === 'fast')
      .flatMap((agent) => harnessIdForAgent(agent, harnesses) ?? [])
      .filter((id) => harnesses.some((harness) => harness.id === id && isHarnessRunnable(harness)))
    return [...new Set(ids)].sort().join(' ')
  }, [agents, harnesses])
  const [catalogs, setCatalogs] = useState<ReadonlyMap<string, ModelCatalog>>(() => new Map())

  useEffect(() => {
    let cancelled = false
    for (const id of needed ? needed.split(' ') : []) {
      readCatalog(id).then(
        (catalog) => { if (!cancelled) setCatalogs((current) => (current.get(id) === catalog ? current : new Map(current).set(id, catalog))) },
        () => { /* no list, no tier to judge: the rule stays silent */ },
      )
    }
    return () => { cancelled = true }
  }, [needed])

  return useCallback((agent: AgentConfig) => {
    const id = harnessIdForAgent(agent, harnesses)
    return id ? catalogs.get(id) : undefined
  }, [catalogs, harnesses])
}
