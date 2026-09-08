import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import type { Connection, Edge, EdgeChange, NodeChange } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentNode } from '../library/nodeFromDrop'
import { nodeFromDrop } from '../library/nodeFromDrop'
import { fetchTeamFile, saveTeamFile, TeamFileApiError } from './client'
import { TeamFileModel, TeamFileParseError } from './document'
import { type EdgeRefusal, validateConfiguredEdge } from './edgeRules'
import { seededLayout } from './layout'
import { pipelineOrder, type PipelineStep } from './pipelineOrder'
import type { AgentConfig, BudgetConfig, EdgeConfig, GuardsConfig, SpawnConfig } from './types'

export type ConfiguredEdge = Edge<{ kind: EdgeConfig['kind'] }>

export type SaveState = 'no-file' | 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'

/** docs/CANVAS_SPEC.md §8: a consequence of `edges`, never a setting the UI can flip directly. */
export type ExecutionMode = 'team' | 'pipeline'

/** §8.3: the last-edge deletion is applied immediately, then offered a 5s undo window. */
export interface PendingEdgeRemoval {
  edges: EdgeConfig[]
}

const EXTERNAL_CHANGE_MESSAGE =
  'This team file changed on disk while you had unsaved edits. Reload it before saving.'

async function hashTeamYaml(yaml: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(yaml))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Keep the weak Phase 04 detection behind one function so a daemon revision token can replace
// this GET/hash check when docs/CANVAS_SPEC.md §15.4 lands.
async function teamFileChangedOnDisk(path: string, loadedRevision: string): Promise<boolean> {
  const { yaml } = await fetchTeamFile(path)
  return (await hashTeamYaml(yaml)) !== loadedRevision
}

/**
 * Blocks `Save` per §5.4/§10.2: no candidate agent to promote means no automatic entrypoint,
 * and an empty canvas means no agent at all. `candidates` is empty in the latter case — there
 * is nothing to offer, per §10.2's "the canvas is simply empty".
 */
export interface EntrypointProblem {
  message: string
  candidates: { id: string; name: string }[]
}

function edgeId(from: string, to: string): string {
  return `${from}->${to}`
}

function edgeFromConfig(edge: EdgeConfig): ConfiguredEdge {
  return {
    id: edgeId(edge.from, edge.to),
    type: 'configured',
    source: edge.from,
    target: edge.to,
    data: { kind: edge.kind },
  }
}

function nodeFromAgent(
  agent: AgentConfig,
  position: { x: number; y: number },
  isEntrypoint: boolean,
): AgentNode {
  return {
    id: agent.id,
    type: 'agent',
    position,
    data: { label: agent.name, agent, isEntrypoint },
    selected: false,
  }
}

/**
 * Owns the canvas's document lifecycle: load a team file named by `?path=`, keep React Flow
 * node/edge state and the CST-preserving `TeamFileModel` (TNG-53) in sync on every edit, and
 * save. Node positions are not part of the team file (docs/CANVAS_SPEC.md §7.3 — flagged, not
 * decided), so drags never touch the model; only agent/edge/entrypoint content does.
 *
 * There is no "create a new team" flow yet — that needs a teams-directory/create endpoint the
 * backend does not have (§15.4). Without `?path=` the canvas still works against local state
 * (matching TNG-54's baseline), it just has nothing to save to.
 */
export function useTeamDocument() {
  const modelRef = useRef<TeamFileModel | null>(null)
  const loadedRevisionRef = useRef<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [nodes, setNodes] = useState<AgentNode[]>([])
  const [edges, setEdges] = useState<ConfiguredEdge[]>([])
  const [entrypoint, setEntrypointState] = useState<string | null>(null)
  const [teamGuards, setTeamGuards] = useState<GuardsConfig | null>(null)
  const [teamBudget, setTeamBudget] = useState<BudgetConfig | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('no-file')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<EdgeRefusal | null>(null)
  const [modeSwitchBanner, setModeSwitchBanner] = useState(false)
  const [pendingEdgeRemoval, setPendingEdgeRemoval] = useState<PendingEdgeRemoval | null>(null)

  const markDirty = useCallback(() => {
    setSaveState((current) => (current === 'no-file' ? current : 'dirty'))
  }, [])

  useEffect(() => {
    const requestedPath = new URLSearchParams(window.location.search).get('path')
    if (!requestedPath) {
      return
    }
    let cancelled = false
    fetchTeamFile(requestedPath)
      .then(async ({ yaml }) => {
        const loadedRevision = await hashTeamYaml(yaml)
        if (cancelled) {
          return
        }
        const model = TeamFileModel.parse(yaml)
        const snapshot = model.snapshot()
        const positions = seededLayout(snapshot.agents.map((agent) => agent.id))
        modelRef.current = model
        loadedRevisionRef.current = loadedRevision
        setPath(requestedPath)
        setEntrypointState(snapshot.entrypoint)
        setTeamGuards(snapshot.guards ?? null)
        setTeamBudget(snapshot.budget ?? null)
        setNodes(
          snapshot.agents.map((agent) =>
            nodeFromAgent(agent, positions[agent.id] ?? { x: 0, y: 0 }, agent.id === snapshot.entrypoint),
          ),
        )
        setEdges(snapshot.edges.filter((edge) => edge.layer === 'configured').map(edgeFromConfig))
        setSaveState('clean')
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        const message =
          error instanceof TeamFileApiError || error instanceof TeamFileParseError
            ? error.message
            : String(error)
        setSaveError(message)
        setSaveState('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Batched so a multi-select delete (several 'remove' NodeChanges in one call) computes the
  // survivor set once, instead of each single-id removal racing the others over stale state.
  const removeAgents = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) {
        return
      }
      const idSet = new Set(ids)
      const remainingNodes = nodes.filter((node) => !idSet.has(node.id))
      const droppedEdges = edges.filter((edge) => idSet.has(edge.source) || idSet.has(edge.target))
      const remainingEdges = edges.filter((edge) => !idSet.has(edge.source) && !idSet.has(edge.target))

      droppedEdges.forEach((edge) => modelRef.current?.removeEdge(edge.source, edge.target))
      idSet.forEach((id) => modelRef.current?.removeAgent(id))

      let nextEntrypoint = entrypoint
      if (entrypoint !== null && idSet.has(entrypoint)) {
        // §5.4: exactly one survivor is promoted automatically; two or more (or zero) is left
        // unset — and unset must mean unset in the YAML too, not a dangling reference to the
        // agent that just left `agents`.
        nextEntrypoint = remainingNodes.length === 1 ? remainingNodes[0].id : null
        if (nextEntrypoint) {
          modelRef.current?.setEntrypoint(nextEntrypoint)
        } else {
          modelRef.current?.clearEntrypoint()
        }
      }

      setNodes(remainingNodes.map((node) => ({ ...node, data: { ...node.data, isEntrypoint: node.id === nextEntrypoint } })))
      setEdges(remainingEdges)
      setEntrypointState(nextEntrypoint)
      markDirty()
    },
    [nodes, edges, entrypoint, markDirty],
  )

  const removeAgent = useCallback((id: string) => removeAgents([id]), [removeAgents])

  const removeEdgesBetween = useCallback(
    (pairs: readonly { from: string; to: string }[]) => {
      if (pairs.length === 0) {
        return
      }
      const hadEdges = edges.length > 0
      const removed: EdgeConfig[] = []
      const remaining = edges.filter((edge) => {
        const match = pairs.some((pair) => pair.from === edge.source && pair.to === edge.target)
        if (match) {
          removed.push({ from: edge.source, to: edge.target, layer: 'configured', kind: edge.data?.kind ?? 'sequence', ts: new Date().toISOString() })
        }
        return !match
      })

      pairs.forEach((pair) => modelRef.current?.removeEdge(pair.from, pair.to))
      setEdges(remaining)
      markDirty()

      // §8.3: dropping the last edge reverts the team to self-organizing — that widens what
      // agents may do, so it gets a 5s undo window instead of taking effect silently.
      if (hadEdges && remaining.length === 0) {
        setPendingEdgeRemoval({ edges: removed })
      }
    },
    [edges, markDirty],
  )

  const removeEdgeBetween = useCallback(
    (from: string, to: string) => removeEdgesBetween([{ from, to }]),
    [removeEdgesBetween],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentNode>[]) => {
      const removedIds = changes.filter((change) => change.type === 'remove').map((change) => change.id)
      removeAgents(removedIds)
      const rest = changes.filter((change) => change.type !== 'remove')
      if (rest.length === 0) {
        return
      }
      // Position/selection/dimension changes only — none of these touch the team file.
      setNodes((current) => applyNodeChanges(rest, current))
    },
    [removeAgents],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ConfiguredEdge>[]) => {
      const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id))
      if (removedIds.size > 0) {
        removeEdgesBetween(
          edges.filter((edge) => removedIds.has(edge.id)).map((edge) => ({ from: edge.source, to: edge.target })),
        )
      }
      const rest = changes.filter((change) => change.type !== 'remove')
      if (rest.length === 0) {
        return
      }
      setEdges((current) => applyEdgeChanges(rest, current))
    },
    [edges, removeEdgesBetween],
  )

  const addAgentFromDrop = useCallback(
    (rawPayload: string, position: { x: number; y: number }) => {
      const newNode = nodeFromDrop(rawPayload, position, nodes)
      if (!newNode) {
        return
      }

      modelRef.current?.addAgent(newNode.data.agent)

      const promoteToEntrypoint = entrypoint === null
      if (promoteToEntrypoint) {
        modelRef.current?.setEntrypoint(newNode.id)
      }
      newNode.data.isEntrypoint = promoteToEntrypoint

      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        newNode,
      ])
      if (promoteToEntrypoint) {
        setEntrypointState(newNode.id)
      }
      markDirty()
    },
    [nodes, entrypoint, markDirty],
  )

  const renameAgent = useCallback(
    (id: string, field: 'name' | 'role', value: string) => {
      modelRef.current?.setAgentField(id, field, value)
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? {
                ...node,
                data: {
                  ...node.data,
                  label: field === 'name' ? value : node.data.label,
                  agent: { ...node.data.agent, [field]: value },
                },
              }
            : node,
        ),
      )
      markDirty()
    },
    [markDirty],
  )

  const updateAgentModel = useCallback(
    (id: string, value: string) => {
      modelRef.current?.setAgentField(id, 'model', value)
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, agent: { ...node.data.agent, model: value } } } : node,
        ),
      )
      markDirty()
    },
    [markDirty],
  )

  const updateAgentCwd = useCallback(
    (id: string, cwd: string) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id) {
            return node
          }
          const spawn: SpawnConfig = { ...node.data.agent.spawn, cwd }
          modelRef.current?.setAgentField(id, 'spawn', spawn)
          return { ...node, data: { ...node.data, agent: { ...node.data.agent, spawn } } }
        }),
      )
      markDirty()
    },
    [markDirty],
  )

  const updateAgentBudget = useCallback(
    (id: string, limitUsd: number) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id) {
            return node
          }
          const budget = { ...node.data.agent.budget, limitUsd }
          modelRef.current?.setAgentField(id, 'budget', budget)
          return { ...node, data: { ...node.data, agent: { ...node.data.agent, budget } } }
        }),
      )
      markDirty()
    },
    [markDirty],
  )

  const updateAgentAllowRecruiting = useCallback(
    (id: string, allowRecruiting: boolean) => {
      modelRef.current?.setAgentField(id, 'allowRecruiting', allowRecruiting)
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, agent: { ...node.data.agent, allowRecruiting } } } : node,
        ),
      )
      markDirty()
    },
    [markDirty],
  )

  const promoteEntrypoint = useCallback(
    (id: string) => {
      modelRef.current?.setEntrypoint(id)
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, isEntrypoint: node.id === id } })))
      setEntrypointState(id)
      setRefusal(null)
      markDirty()
    },
    [markDirty],
  )

  // §8.1: the mode-pill popover's edit affordance for team-level `guards`/`budget` — the only
  // home these fields have, per TEAM_CONFIG.md's default-to-8 rule when a guard is absent.
  const updateTeamGuards = useCallback(
    (field: keyof GuardsConfig, value: number) => {
      setTeamGuards((current) => {
        const next: GuardsConfig = {
          maxDispatchDepth: current?.maxDispatchDepth ?? 8,
          maxConcurrentDispatches: current?.maxConcurrentDispatches ?? 8,
          [field]: value,
        }
        modelRef.current?.setGuards(next)
        return next
      })
      markDirty()
    },
    [markDirty],
  )

  const updateTeamBudget = useCallback(
    (limitUsd: number) => {
      setTeamBudget((current) => {
        const next: BudgetConfig = { ...current, limitUsd }
        modelRef.current?.setTeamBudget(next)
        return next
      })
      markDirty()
    },
    [markDirty],
  )

  const dismissRefusal = useCallback(() => setRefusal(null), [])

  // §6.6: "The popover dismisses on the next click or after 4 s."
  useEffect(() => {
    if (!refusal) {
      return
    }
    const timer = setTimeout(() => setRefusal(null), 4000)
    return () => clearTimeout(timer)
  }, [refusal])

  // §8.3: "Keep it" (or letting it time out) accepts a deletion that already happened.
  const keepLastEdgeRemoval = useCallback(() => setPendingEdgeRemoval(null), [])

  // §8.3: "Undo restores the edge" — re-added with a fresh `ts`; nothing downstream reads it.
  const undoLastEdgeRemoval = useCallback(() => {
    setPendingEdgeRemoval((pending) => {
      if (!pending) {
        return pending
      }
      pending.edges.forEach((edge) => modelRef.current?.addEdge(edge))
      setEdges((current) => [...current, ...pending.edges.map(edgeFromConfig)])
      markDirty()
      return null
    })
  }, [markDirty])

  useEffect(() => {
    if (!pendingEdgeRemoval) {
      return
    }
    const timer = setTimeout(() => setPendingEdgeRemoval(null), 5000)
    return () => clearTimeout(timer)
  }, [pendingEdgeRemoval])

  // §8.3: drawing the first configured edge is the team → pipeline switch event.
  useEffect(() => {
    if (!modeSwitchBanner) {
      return
    }
    const timer = setTimeout(() => setModeSwitchBanner(false), 4000)
    return () => clearTimeout(timer)
  }, [modeSwitchBanner])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return
      }
      const outcome = validateConfiguredEdge(
        edges.map((edge) => ({ from: edge.source, to: edge.target })),
        connection.source,
        connection.target,
        entrypoint,
      )
      if (outcome) {
        setRefusal(outcome)
        return
      }

      const newEdge: EdgeConfig = {
        from: connection.source,
        to: connection.target,
        layer: 'configured',
        kind: 'sequence',
        ts: new Date().toISOString(),
      }
      modelRef.current?.addEdge(newEdge)
      setEdges((current) => [...current, edgeFromConfig(newEdge)])
      if (edges.length === 0) {
        setModeSwitchBanner(true)
      }
      markDirty()
    },
    [edges, entrypoint, markDirty],
  )

  // §8: a consequence of `edges`, not a setting — team when empty, pipeline otherwise.
  const mode: ExecutionMode = edges.length === 0 ? 'team' : 'pipeline'

  const pipelineSteps = useMemo<PipelineStep[]>(
    () => pipelineOrder(nodes.map((node) => node.id), edges.map((edge) => ({ from: edge.source, to: edge.target })), entrypoint),
    [nodes, edges, entrypoint],
  )

  // §5.4/§10.2: only relevant to a document that is actually open — a pathless canvas (no
  // `?path=` yet) has nothing to save, so it has no save-blocking problem either.
  const entrypointProblem = useMemo<EntrypointProblem | null>(() => {
    if (!path || entrypoint !== null) {
      return null
    }
    if (nodes.length === 0) {
      return { message: 'A team needs at least one agent.', candidates: [] }
    }
    return {
      message: 'This team has no entry point.',
      candidates: nodes.map((node) => ({ id: node.id, name: node.data.label })),
    }
  }, [path, entrypoint, nodes])

  const save = useCallback(async () => {
    if (!path || !modelRef.current || entrypointProblem) {
      return
    }
    setSaveState('saving')
    try {
      const loadedRevision = loadedRevisionRef.current
      if (!loadedRevision) {
        throw new Error('Cannot verify whether the team file changed on disk.')
      }
      const yaml = modelRef.current.toYaml()
      const nextRevision = await hashTeamYaml(yaml)
      if (await teamFileChangedOnDisk(path, loadedRevision)) {
        setSaveState('conflict')
        setSaveError(EXTERNAL_CHANGE_MESSAGE)
        return
      }

      await saveTeamFile(path, yaml)
      loadedRevisionRef.current = nextRevision
      setSaveError(null)
      if (modelRef.current.toYaml() === yaml) {
        setSaveState('saved')
        setTimeout(() => setSaveState((current) => (current === 'saved' ? 'clean' : current)), 2000)
      } else {
        setSaveState('dirty')
      }
    } catch (error) {
      setSaveState('error')
      setSaveError(error instanceof TeamFileApiError ? error.message : String(error))
    }
  }, [path, entrypointProblem])

  return {
    path,
    nodes,
    edges,
    entrypoint,
    entrypointProblem,
    teamGuards,
    teamBudget,
    saveState,
    saveError,
    refusal,
    mode,
    pipelineSteps,
    modeSwitchBanner,
    pendingEdgeRemoval,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addAgentFromDrop,
    removeAgent,
    removeEdgeBetween,
    renameAgent,
    updateAgentModel,
    updateAgentCwd,
    updateAgentBudget,
    updateAgentAllowRecruiting,
    promoteEntrypoint,
    updateTeamGuards,
    updateTeamBudget,
    dismissRefusal,
    keepLastEdgeRemoval,
    undoLastEdgeRemoval,
    save,
  }
}
