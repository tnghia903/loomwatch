import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchLayout, saveLayout } from './client'
import {
  EMPTY_LAYOUT,
  capabilityNodeId,
  migrateLayout,
  type CapabilityDragPayload,
  type CapabilityEdgeConfig,
  type CapabilityNodeConfig,
  type ComposerLayout,
} from './types'

/** Long enough that a drag settles into one write, short enough that nothing is lost on a reload. */
const AUTOSAVE_MS = 600

export interface ComposerLayoutState {
  output?: { name: string; format: string }
  setOutput: (output: { name: string; format: string }) => void
  nodes: CapabilityNodeConfig[]
  edges: CapabilityEdgeConfig[]
  /** Saved agent positions, by agent id. Empty until the sidecar has been read. */
  agents: Record<string, { x: number; y: number }>
  error: string | null
  /** True while an autosave is in flight, so the canvas can say "saving wiring…". */
  saving: boolean
  /**
   * The path whose sidecar is in hand, or `null` while one is loading or could not be read.
   *
   * The canvas needs this to know when to hydrate positions: applying `agents` before the answer
   * arrives would move every card to the auto-layout and then move it again, and applying it after
   * a *failed* read would overwrite the operator's arrangement with nothing.
   */
  loadedFor: string | null
  place: (payload: CapabilityDragPayload, position: { x: number; y: number }) => string
  move: (id: string, position: { x: number; y: number }) => void
  remove: (ids: readonly string[]) => void
  connect: (agentId: string, capabilityId: string) => void
  disconnect: (agentId: string, capabilityId: string) => void
  /**
   * Replace the saved agent positions.
   *
   * A whole-map write rather than a per-agent one, because that is what makes pruning fall out:
   * the caller writes the positions of the agents that exist *now*, so an agent removed from the
   * team file loses its entry without anything having to remember to delete it. A no-op when the
   * map is unchanged, so the canvas can call it on every render.
   */
  setAgentPositions: (positions: Record<string, { x: number; y: number }>) => void
  arrange: (agents: Record<string, { x: number; y: number }>, nodes: CapabilityNodeConfig[]) => void
  dismissError: () => void
}

/**
 * The `<team>.layout.json` sidecar as React state. Unlike the team file this autosaves: it holds no
 * executable contract and has no validation gate that could block a write, and
 * docs/TNG122_FREEFORM_CAPABILITY_COMPOSER.md §9 calls losing unsaved planned work a blocking
 * failure. The team YAML keeps its explicit save semantics.
 */
/**
 * `persist` is false while the team file itself does not exist yet (a new, unsaved team): the
 * sidecar sits next to the team file and the daemon refuses to write one for a file it cannot find.
 * Edits made meanwhile are kept in memory and written by the first autosave after the team is saved.
 */
export function useComposerLayout(path: string | null, agentIds: readonly string[], persist = true): ComposerLayoutState {
  const [layout, setLayout] = useState<ComposerLayout>(EMPTY_LAYOUT)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Which document the state in hand belongs to, so a late response for the previous team
  // can never be written over the current one. The ref is what the autosave guard reads (inside
  // an effect); `loaded` is the same fact as state, because callers need it during render.
  const loadedPath = useRef<string | null>(null)
  // The last path whose sidecar was read successfully. Never reset on a path change: comparing it
  // to the *current* path is what makes it null while a read is in flight, with no second write.
  const [loaded, setLoaded] = useState<string | null>(null)
  const dirty = useRef(false)
  // Read by the load below without making the fetch depend on the agent list, which changes
  // identity on every render that rebuilds the canvas. Declared before the load effect so it is
  // already current when a path change triggers one.
  const agentIdsRef = useRef(agentIds)
  useEffect(() => { agentIdsRef.current = agentIds }, [agentIds])

  useEffect(() => {
    dirty.current = false
    setLayout(EMPTY_LAYOUT)
    setError(null)
    if (!path) {
      loadedPath.current = null
      return
    }
    const abort = new AbortController()
    loadedPath.current = null
    fetchLayout(path, abort.signal)
      .then((raw) => {
        // A version this build does not know is shown as an empty canvas and — crucially —
        // `loadedPath` stays unset, so the autosave below never overwrites it.
        const next = migrateLayout(raw)
        if (!next) {
          setLayout(EMPTY_LAYOUT)
          setError(`This team's canvas was saved by a newer LoomWatch (layout version ${raw.version}). It is shown empty and will not be overwritten.`)
          return
        }
        loadedPath.current = path
        setLoaded(path)
        // An agent deleted or renamed since the sidecar was written must not come back as an
        // edge drawn from nothing. Pruning at load (not only on a later change) covers the
        // common case: the team file was edited while this canvas was closed.
        const kept = next.edges.filter((edge) => agentIdsRef.current.includes(edge.from))
        if (kept.length !== next.edges.length) dirty.current = true
        setLayout({ ...next, edges: kept })
      })
      .catch((caught: unknown) => {
        if (abort.signal.aborted) return
        // Leave `loadedPath` unset: a sidecar we could not read must not be overwritten by an
        // autosave of the empty layout we are showing instead.
        setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => abort.abort()
  }, [path])

  useEffect(() => {
    if (!path || !persist || !dirty.current || loadedPath.current !== path) return
    const timer = setTimeout(() => {
      dirty.current = false
      setSaving(true)
      saveLayout(path, layout)
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
        .finally(() => setSaving(false))
    }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [layout, path, persist])

  const edit = useCallback((next: (current: ComposerLayout) => ComposerLayout) => {
    dirty.current = true
    setLayout(next)
  }, [])

  const place = useCallback((payload: CapabilityDragPayload, position: { x: number; y: number }) => {
    const id = capabilityNodeId(payload.kind, payload.name)
    edit((current) => current.nodes.some((node) => node.id === id)
      // Dropping a row that is already on the canvas moves it rather than making a second card.
      ? { ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, position } : node) }
      // `memory` travels from the Library's drag payload onto the card, because the card is what
      // gets wired and it has to know which memory it stands for before anyone connects it.
      : { ...current, nodes: [...current.nodes, { id, kind: payload.kind, name: payload.name, source: payload.source, position, ...(payload.memory ? { memory: payload.memory } : {}) }] })
    return id
  }, [edit])

  const move = useCallback((id: string, position: { x: number; y: number }) => {
    edit((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, position } : node) }))
  }, [edit])

  const remove = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    edit((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !ids.includes(node.id)),
      edges: current.edges.filter((edge) => !ids.includes(edge.to)),
    }))
  }, [edit])

  const connect = useCallback((agentId: string, capabilityId: string) => {
    edit((current) => current.edges.some((edge) => edge.from === agentId && edge.to === capabilityId)
      ? current
      : { ...current, edges: [...current.edges, { from: agentId, to: capabilityId }] })
  }, [edit])

  const disconnect = useCallback((agentId: string, capabilityId: string) => {
    edit((current) => ({ ...current, edges: current.edges.filter((edge) => !(edge.from === agentId && edge.to === capabilityId)) }))
  }, [edit])

  const setAgentPositions = useCallback((positions: Record<string, { x: number; y: number }>) => {
    setLayout((current) => {
      if (samePositions(current.agents, positions)) return current
      dirty.current = true
      return { ...current, agents: positions }
    })
  }, [])

  // An agent renamed or deleted in the team file must not leave an edge drawn from nothing — or a
  // saved position for a card that is gone, which would come back if the id were ever reused.
  const agentKey = agentIds.join('\n')
  useEffect(() => {
    if (loadedPath.current !== path) return
    setLayout((current) => {
      const live = agentKey.split('\n')
      const kept = current.edges.filter((edge) => live.includes(edge.from))
      const keptAgents = Object.fromEntries(Object.entries(current.agents).filter(([id]) => live.includes(id)))
      if (kept.length === current.edges.length
        && Object.keys(keptAgents).length === Object.keys(current.agents).length) return current
      dirty.current = true
      return { ...current, edges: kept, agents: keptAgents }
    })
  }, [agentKey, path])

  return {
    output: layout.output,
    setOutput: useCallback((output: { name: string; format: string }) => edit(current => ({ ...current, output })), [edit]),
    nodes: layout.nodes,
    edges: layout.edges,
    agents: layout.agents,
    error,
    saving,
    loadedFor: loaded === path ? path : null,
    place,
    move,
    remove,
    connect,
    disconnect,
    setAgentPositions,
    arrange: useCallback((agents: Record<string, { x: number; y: number }>, nodes: CapabilityNodeConfig[]) => {
      edit((current) => ({ ...current, agents, nodes }))
    }, [edit]),
    dismissError: useCallback(() => setError(null), []),
  }
}

/** Whether two position maps describe the same arrangement, to the pixel. */
function samePositions(
  left: Record<string, { x: number; y: number }>,
  right: Record<string, { x: number; y: number }>,
): boolean {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => left[key].x === right[key]?.x && left[key].y === right[key]?.y)
}
