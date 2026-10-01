import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchHarnessModels, type HarnessModels } from '../../lib/harnesses'

type CatalogRead = Omit<HarnessModels, 'harnessId'> & { error: string | null }

interface ModelCatalogInput {
  /** The harness the inspected agent runs in; null when nothing is inspected or it is unknown. */
  harnessId: string | null
  /** The inspected agent, whose empty model is filled from the catalog. */
  agentId: string | null
  /** The inspected agent is not the operator and has no model yet. */
  agentNeedsModel: boolean
  editable: boolean
  updateAgentModel: (agentId: string, model: string) => void
}

/**
 * The model catalog of the inspected agent's harness, discovered from the daemon once per harness
 * per session, and the one write it drives: an agent placed without a model adopts the model the
 * harness itself would use.
 */
export function useModelCatalog({ harnessId, agentId, agentNeedsModel, editable, updateAgentModel }: ModelCatalogInput) {
  const [catalog, setCatalog] = useState<HarnessModels & { error: string | null }>({ harnessId: '', models: [], error: null })
  const cache = useRef(new Map<string, CatalogRead>())
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (!harnessId) return
    let cancelled = false
    const cached = cache.current.get(harnessId)
    if (cached) {
      void Promise.resolve().then(() => {
        if (!cancelled) setCatalog({ harnessId, ...cached })
      })
      return () => { cancelled = true }
    }
    void fetchHarnessModels(harnessId).then(
      (read) => {
        const result = { models: read.models, currentModelId: read.currentModelId, currentThinkingEffort: read.currentThinkingEffort, error: null }
        cache.current.set(harnessId, result)
        if (!cancelled) setCatalog({ harnessId, ...result })
      },
      // Only a catalog that was actually read is cached. Discovery spawns the harness over ACP,
      // and an `npx`-launched adapter can blow the daemon's discovery budget on a cold start and
      // answer in a couple of seconds on the next attempt — caching that would strand the agent
      // on an empty model list for the rest of the session, reselecting the node included.
      (caught: unknown) => {
        const result = { models: [], currentModelId: undefined, currentThinkingEffort: undefined, error: caught instanceof Error ? caught.message : String(caught) }
        if (!cancelled) setCatalog({ harnessId, ...result })
      },
    )
    return () => { cancelled = true }
  }, [harnessId, retryCount])

  // A newly placed agent has no model, and an empty model blocks the run behind a "Required" field
  // the operator did not know to look for. Once this harness's catalog is in hand, adopt the model
  // the harness itself would use — its current model — so the agent can run as soon as it is placed.
  useEffect(() => {
    if (!editable || !agentId || !agentNeedsModel) return
    if (catalog.harnessId !== harnessId || catalog.error) return
    const model = catalog.currentModelId ?? catalog.models[0]?.id
    if (model) updateAgentModel(agentId, model)
  }, [editable, agentId, agentNeedsModel, harnessId, catalog, updateAgentModel])

  const retry = useCallback(() => {
    if (harnessId) cache.current.delete(harnessId)
    setCatalog({ harnessId: '', models: [], error: null })
    setRetryCount((attempt) => attempt + 1)
  }, [harnessId])

  const current = catalog.harnessId === harnessId
  return {
    models: current ? catalog.models : [],
    defaultThinkingEffort: current ? catalog.currentThinkingEffort : undefined,
    error: current ? catalog.error : null,
    loading: Boolean(harnessId && !current),
    retry,
  }
}
